import { GoogleGenAI } from '@google/genai';
import { timingSafeEqual, createHash } from 'crypto';

// Worst case this tries several models with a retry each, so allow plenty of time.
export const config = { maxDuration: 60 };

const sha = (s) => createHash('sha256').update(String(s)).digest();
const passwordIsValid = (supplied, expected) =>
  !!supplied && !!expected && timingSafeEqual(sha(supplied), sha(expected));

const VALID_LAYERS = ['coats', 'tops', 'bottoms', 'shoes', 'bags'];

// Current stable Gemini models (per Google's models page, Sept 2026), in the order they are tried.
// If one is overloaded or unavailable, the next is used. The old 2.5 models are left out because
// Google now limits them to accounts that have used them before.
// Override with a comma-separated GEMINI_MODELS env var in Vercel if Google changes things again.
const DEFAULT_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash'
];
const MODELS_TO_TRY = process.env.GEMINI_MODELS
  ? process.env.GEMINI_MODELS.split(',').map((m) => m.trim()).filter(Boolean)
  : DEFAULT_MODELS;

const RETRY_DELAY_MS = 1200;
const TIME_BUDGET_MS = 50000; // stop starting new attempts after this, so we always answer before maxDuration

const PROMPT =
  'Analyze this clothing item. Return ONLY a JSON object with this exact structure (no markdown): ' +
  '{ "layer": "coats"|"tops"|"bottoms"|"shoes"|"bags", "name": "A short descriptive name", "colors": ["primary color"], ' +
  '"occasion": ["casual"|"work"|"party"], "temperature": ["hot"|"medium"|"cold"], "weather": ["sun"|"rain"|"cloudy"], ' +
  '"hiddenTags": ["fabric or style descriptor"] }';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// "High demand", rate limits, overloads: worth one quick retry on the same model before moving on.
const isBusyError = (err) => {
  const status = Number(err?.status || err?.code);
  const msg = String(err?.message || err).toLowerCase();
  return (
    [429, 500, 502, 503, 504].includes(status) ||
    /high demand|overloaded|unavailable|try again|rate limit|quota|resource_exhausted|deadline/.test(msg)
  );
};

const shortMessage = (err) => {
  const raw = String(err?.message || err).replace(/\s+/g, ' ');
  return raw.length > 110 ? raw.slice(0, 110) + '…' : raw;
};

async function tagWithModel(ai, modelName, base64Img) {
  const response = await ai.models.generateContent({
    model: modelName,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { data: base64Img, mimeType: 'image/jpeg' } },
        { text: PROMPT }
      ]
    }],
    config: { responseMimeType: 'application/json' }
  });

  const rawText = typeof response.text === 'function' ? response.text() : response.text;
  const jsonText = String(rawText || '').replace(/```json/g, '').replace(/```/g, '').trim();
  const metadata = JSON.parse(jsonText);
  if (!VALID_LAYERS.includes(metadata.layer)) metadata.layer = 'tops';
  return metadata;
}

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
    const startedAt = Date.now();
    const failures = [];
    let sawBusy = false;

    for (const modelName of MODELS_TO_TRY) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) break;
        try {
          const metadata = await tagWithModel(ai, modelName, base64Img);
          return res.status(200).json(metadata);
        } catch (err) {
          const busy = isBusyError(err);
          if (busy) sawBusy = true;
          failures.push(`${modelName}${attempt > 1 ? ' (retry)' : ''}: ${shortMessage(err)}`);
          console.warn(`Gemini ${modelName} attempt ${attempt} failed:`, err?.message || err);
          // Busy -> one quick retry on the same model. Anything else (bad model name, bad JSON) -> next model.
          if (busy && attempt === 1) {
            await sleep(RETRY_DELAY_MS);
            continue;
          }
          break;
        }
      }
    }

    console.error('All Gemini models failed:', failures);
    const friendly = sawBusy
      ? 'Gemini is very busy right now. Please try again in a minute.'
      : 'AI tagging failed.';
    const tried = [...new Set(failures.map((f) => f.split(':')[0].replace(' (retry)', '')))].length;
    return res.status(503).json({
      error: `${friendly} (tried ${tried} models. Last: ${failures[failures.length - 1] || 'no attempts made'})`
    });
  } catch (err) {
    console.error('gemini api error:', err);
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
}
