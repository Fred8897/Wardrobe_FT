import { createClient } from '@supabase/supabase-js';
import { timingSafeEqual, createHash } from 'crypto';

// Table / bucket names. These default to the ones your working "tester" version used.
// If you created differently named ones in Supabase, set these in Vercel > Settings > Environment Variables.
const CLOTHES_TABLE = process.env.SUPABASE_CLOTHES_TABLE || 'clothes_test';
const OUTFITS_TABLE = process.env.SUPABASE_OUTFITS_TABLE || 'outfits_test';
const BUCKET = process.env.SUPABASE_BUCKET || 'wardrobe_test';

const VALID_LAYERS = ['coats', 'tops', 'bottoms', 'shoes', 'bags'];
const ALLOWED_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// Vercel rejects request bodies over ~4.5MB before this code even runs.
export const config = { maxDuration: 30 };

const sha = (s) => createHash('sha256').update(String(s)).digest();

const passwordIsValid = (supplied, expected) => {
  if (!supplied || !expected) return false;
  return timingSafeEqual(sha(supplied), sha(expected));
};

// "data:image/png;base64,AAAA..." -> { buffer, contentType, ext }
const parseDataUrl = (dataUrl) => {
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!match) throw new Error('Invalid image data (expected a base64 data URL).');
  const contentType = match[1].toLowerCase();
  const ext = ALLOWED_MIME[contentType];
  if (!ext) throw new Error(`Unsupported image type: ${contentType}`);
  return { buffer: Buffer.from(match[2], 'base64'), contentType, ext };
};

const safeName = (s) => String(s || 'file').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);

const uploadImage = async (supabase, prefix, dataUrl) => {
  const { buffer, contentType, ext } = parseDataUrl(dataUrl);
  const fileName = `${safeName(prefix)}_${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(fileName, buffer, { contentType, upsert: true });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
};

// Only pass known columns through to the database.
const pickClothFields = (item = {}) => {
  const out = {};
  for (const key of ['id', 'layer', 'name', 'colors', 'occasion', 'temperature', 'weather', 'hiddenTags', 'image']) {
    if (item[key] !== undefined) out[key] = item[key];
  }
  if (out.layer !== undefined && !VALID_LAYERS.includes(out.layer)) out.layer = 'tops';
  return out;
};

export default async function handler(req, res) {
  try {
    const expectedPassword = process.env.APP_PASSWORD;
    if (!expectedPassword) {
      return res.status(500).json({ error: 'APP_PASSWORD environment variable is not configured on the server.' });
    }
    if (!passwordIsValid(req.headers['x-app-password'], expectedPassword)) {
      return res.status(401).json({ error: 'Unauthorized: Incorrect password' });
    }

    const action = req.query?.action || req.body?.action;

    // Lets the login screen check the password without shipping it inside the website code.
    if (action === 'verify') {
      return res.status(200).json({ ok: true });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured on the server.' });
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // --- GET ---
    if (req.method === 'GET') {
      if (action === 'getClothes') {
        const { data, error } = await supabase.from(CLOTHES_TABLE).select('*');
        if (error) throw error;
        return res.status(200).json({ data });
      }
      if (action === 'getOutfits') {
        const { data, error } = await supabase.from(OUTFITS_TABLE).select('*');
        if (error) throw error;
        return res.status(200).json({ data });
      }
    }

    // --- POST ---
    if (req.method === 'POST') {
      const body = req.body || {};

      if (action === 'uploadClothing') {
        if (!body.imageFile) return res.status(400).json({ error: 'Missing imageFile' });
        const imageUrl = await uploadImage(supabase, body.item?.id || 'item', body.imageFile);
        const row = pickClothFields({ ...body.item, image: imageUrl });
        const { data, error } = await supabase.from(CLOTHES_TABLE).insert([row]).select();
        if (error) throw error;
        return res.status(200).json({ data: data[0] });
      }

      if (action === 'updateCloth') {
        const fields = pickClothFields(body.item);
        if (!fields.id) return res.status(400).json({ error: 'Missing item id' });
        const { id, ...updates } = fields;
        const { data, error } = await supabase.from(CLOTHES_TABLE).update(updates).eq('id', id).select();
        if (error) throw error;
        return res.status(200).json({ data: data?.[0] || null });
      }

      if (action === 'deleteCloth') {
        if (!body.id) return res.status(400).json({ error: 'Missing id' });
        const { error } = await supabase.from(CLOTHES_TABLE).delete().eq('id', body.id);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }

      if (action === 'saveOutfit') {
        const { id, name, item_ids, metadata, imageFile } = body;
        if (!id) return res.status(400).json({ error: 'Missing outfit id' });
        const row = { id, name, item_ids, metadata };
        if (imageFile) row.image_url = await uploadImage(supabase, 'outfit', imageFile);
        const { data, error } = await supabase.from(OUTFITS_TABLE).insert([row]).select();
        if (error) throw error;
        return res.status(200).json({ data: data[0] });
      }

      if (action === 'updateOutfit') {
        const { id, name, item_ids, metadata, imageFile } = body;
        if (!id) return res.status(400).json({ error: 'Missing outfit id' });
        const updates = { name, item_ids, metadata };
        if (imageFile) updates.image_url = await uploadImage(supabase, 'outfit', imageFile);
        const { data, error } = await supabase.from(OUTFITS_TABLE).update(updates).eq('id', id).select();
        if (error) throw error;
        return res.status(200).json({ data: data?.[0] || { id, ...updates } });
      }

      if (action === 'updateOutfitMetadata') {
        const { id, name, metadata } = body;
        if (!id) return res.status(400).json({ error: 'Missing outfit id' });
        const { data, error } = await supabase.from(OUTFITS_TABLE).update({ name, metadata }).eq('id', id).select();
        if (error) throw error;
        return res.status(200).json({ data: data?.[0] || null });
      }

      if (action === 'deleteOutfit') {
        if (!body.id) return res.status(400).json({ error: 'Missing id' });
        const { error } = await supabase.from(OUTFITS_TABLE).delete().eq('id', body.id);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }
    }

    return res.status(400).json({ error: 'Invalid action or method' });
  } catch (err) {
    console.error('supabase api error:', err);
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
}