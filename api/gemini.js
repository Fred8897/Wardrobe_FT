import { GoogleGenAI } from '@google/genai';
import { timingSafeEqual, createHash } from 'crypto';

export const config = { maxDuration: 30 };

const sha = (s) => createHash('sha256').update(String(s)).digest();
const passwordIsValid = (supplied, expected) =>
  !!supplied && !!expected && timingSafeEqual(sha(supplied), sha(expected));

const VALID_LAYERS = ['coats', 'tops', 'bottoms', 'shoes', 'bags'];

// Same model fallbacks your working version used, plus 2.5 as a last resort.
const MODELS_TO_TRY = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash'
];

const PROMPT =
  'Analyze this clothing item. Return ONLY a JSON object with this exact structure (no markdown): ' +
  '{ "layer": "coats"|"tops"|"bottoms"|"shoes"|"bags", "name": "A short descriptive name", "colors": ["primary color"], ' +
  '"occasion": ["casual"|"work"|"party"], "temperature": ["hot"|"medium"|"cold"], "weather": ["sun"|"rain"|"cloudy"], ' +
  '"hiddenTags": ["fabric or style descriptor"] }';

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

    const { base64Img } = req.body || {};
    if (!base64Img) {
      return res.status(400).json({ error: 'Missing base64Img in request body' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY environment variable is not configured' });
    }

    const ai = new GoogleGenAI({ apiKey });
    const errors = [];

    for (const modelName of MODELS_TO_TRY) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: [{
            role: 'user',
            parts: [
              { inlineData: { data: base64Img, mimeType: 'image/jpeg' } },
              { text: PROMPT }
            ]
          }]
        });

        const rawText = typeof response.text === 'function' ? response.text() : response.text;
        const jsonText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const metadata = JSON.parse(jsonText);

        if (!VALID_LAYERS.includes(metadata.layer)) metadata.layer = 'tops';
        return res.status(200).json(metadata);
      } catch (err) {
        errors.push(`${modelName}: ${err?.message || err}`);
      }
    }

    console.error('All Gemini models failed:', errors);
    return res.status(500).json({ error: `AI tagging failed. ${errors[errors.length - 1] || ''}` });
  } catch (err) {
    console.error('gemini api error:', err);
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
}