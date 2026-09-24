import { Client, handle_file } from '@gradio/client';
import { timingSafeEqual, createHash } from 'crypto';

// Each call handles ONE garment, so this limit applies per item, not per outfit.
// 300s is the maximum on the Hobby plan with Fluid Compute enabled (Project Settings > Functions).
export const config = { maxDuration: 300 };

const sha = (s) => createHash('sha256').update(String(s)).digest();
const passwordIsValid = (supplied, expected) =>
  !!supplied && !!expected && timingSafeEqual(sha(supplied), sha(expected));

// Accepts a data: URL or an http(s) URL and returns a Blob.
async function prepareInputBlob(source) {
  if (typeof source === 'string' && (source.startsWith('data:') || /^https?:\/\//i.test(source))) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Could not load input image (HTTP ${res.status})`);
    return await res.blob();
  }
  throw new Error('Unsupported image input');
}

const extractUrl = (result) => {
  const first = result?.data?.[0];
  return first?.url || (typeof first === 'string' ? first : null);
};

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const expectedPassword = process.env.APP_PASSWORD;
    if (!expectedPassword) {
      return res.status(500).json({ error: 'APP_PASSWORD environment variable is not configured on the server.' });
    }
    if (!passwordIsValid(req.headers['x-app-password'], expectedPassword)) {
      return res.status(401).json({ error: 'Unauthorized: Incorrect password' });
    }

    const { personImage, garmentImage } = req.body || {};
    if (!personImage || !garmentImage) {
      return res.status(400).json({ error: 'Missing personImage or garmentImage' });
    }

    const hfToken = process.env.HF_TOKEN;
    const clientOptions = hfToken ? { token: hfToken } : {};

    const personBlob = await prepareInputBlob(personImage);
    const garmentBlob = await prepareInputBlob(garmentImage);

    let resultUrl = null;
    let primaryMessage = '';

    try {
      const app = await Client.connect('weshopai/weshopai-virtual-try-on', clientOptions);
      const result = await app.predict('/generate_image', [
        handle_file(garmentBlob),
        handle_file(personBlob)
      ]);
      resultUrl = extractUrl(result);
    } catch (primaryErr) {
      primaryMessage = primaryErr?.message || String(primaryErr);
      console.warn('Primary try-on space failed, using fallback:', primaryMessage);
    }

    if (!resultUrl) {
      try {
        const fallbackApp = await Client.connect('miragic-ai/miragic-virtual-try-on', clientOptions);
        const result = await fallbackApp.predict('/virtual_tryon', [
          handle_file(personBlob),
          handle_file(garmentBlob)
        ]);
        resultUrl = extractUrl(result);
      } catch (fallbackErr) {
        const fallbackMessage = fallbackErr?.message || String(fallbackErr);
        return res.status(500).json({
          error: `Virtual try-on failed. Primary: ${primaryMessage || 'no image returned'} | Fallback: ${fallbackMessage}`
        });
      }
    }

    if (!resultUrl) {
      return res.status(500).json({ error: 'Virtual try-on finished but returned no image.' });
    }

    return res.status(200).json({ resultUrl });
  } catch (err) {
    console.error('hf api error:', err);
    return res.status(500).json({ error: `Virtual try-on execution failed: ${err?.message || err}` });
  }
}