const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'database unavailable' });
  }
  next();
});
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB, mirrors express.json limit
});

// Vision provider config: Groq (gsk_... key) or OpenAI (sk-... key).
// Both expose an OpenAI-compatible chat.completions API, so one client works for both.
function resolveProvider() {
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (groqKey && groqKey.length > 20) {
    return {
      apiKey: groqKey,
      baseURL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
      model: process.env.VISION_MODEL || 'qwen/qwen3.8-27b',
    };
  }
  if (openaiKey && openaiKey.length > 20) {
    return {
      apiKey: openaiKey,
      baseURL: undefined,
      model: process.env.VISION_MODEL || 'gpt-4o-mini',
    };
  }
  return null;
}

let client = null;
let clientKey = '';
function getClient() {
  const provider = resolveProvider();
  if (!provider) return null;
  if (!client || clientKey !== provider.apiKey) {
    const OpenAI = require('openai');
    client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL });
    clientKey = provider.apiKey;
  }
  return client;
}

const FOOD_SYSTEM_PROMPT =
  'You are a nutrition expert. Analyze the food in the photo. ' +
  'Identify each distinct food item you can see. For each item estimate its ' +
  'serving calories (kcal) and macronutrients in grams. ' +
  'Respond ONLY with a JSON object of shape: ' +
  '{"items":[{"name":"string","kcal":number,"protein":number,"carbs":number,"fat":number}]} ' +
  'with 1-6 items. Use realistic portion estimates. No extra text.';

const LABEL_SCHEMA = z.object({
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        kcal: z.number().min(0).max(5000),
        protein: z.number().min(0).max(500).default(0),
        carbs: z.number().min(0).max(500).default(0),
        fat: z.number().min(0).max(500).default(0),
      })
    )
    .min(1)
    .max(6),
});

function parseJsonLoose(text) {
  let raw = (text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    let parsed = JSON.parse(raw);
    // Some models double-encode the JSON object as a JSON string
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return parsed;
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      let parsed = JSON.parse(raw.slice(start, end + 1));
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      return parsed;
    }
    throw new Error('model did not return JSON');
  }
}

// POST /api/scan  (multipart field "image")
router.post('/', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'image file required (multipart field "image")' });
  }
  const aiClient = getClient();
  const model = resolveProvider()?.model;
  if (!aiClient || !model) {
    return res.status(503).json({
      error:
        'scanning unavailable — add GROQ_API_KEY (recommended, e.g. gsk_...) or OPENAI_API_KEY to caly-ai-backend/.env and restart the server',
    });
  }
  try {
    const b64 = req.file.buffer.toString('base64');
    const completion = await aiClient.chat.completions.create({
      model,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: FOOD_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What food is in this image? Estimate nutrition per serving.' },
            { type: 'image_url', image_url: { url: `data:${req.file.mimetype};base64,${b64}` } },
          ],
        },
      ],
    });
    const parsed = LABEL_SCHEMA.safeParse(parseJsonLoose(completion.choices[0]?.message?.content));
    if (!parsed.success || !parsed.data.items.length) {
      return res.status(422).json({ error: 'no food detected in this photo' });
    }
    res.json({ items: parsed.data.items });
  } catch (e) {
    if (e.name === 'ZodError') {
      return res.status(502).json({ error: 'unexpected model response' });
    }
    console.error('scan error:', e.message);
    res.status(502).json({ error: 'failed to analyze image' });
  }
});

// GET /api/scan/barcode/:code — look up a packaged food via OpenFoodFacts
router.get('/barcode/:code', async (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!/^\d{6,18}$/.test(code)) {
    return res.status(400).json({ error: 'invalid barcode' });
  }
  try {
    // OpenFoodFacts indexes EAN-13 as-is; UPC-A (12-digit) is stored with a leading 0
    const candidates = code.length === 12 ? [code, `0${code}`] : [code];
    let data = null;
    for (const candidate of candidates) {
      const offRes = await fetch(
        `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(candidate)}.json?fields=product_name,brands,nutriments,serving_quantity,serving_unit`
      );
      if (!offRes.ok) {
        return res.status(502).json({ error: 'barcode lookup failed' });
      }
      data = await offRes.json();
      if (data.status === 1 && data.product) break;
    }
    if (!data || data.status !== 1 || !data.product) {
      return res.status(404).json({ error: 'product not found' });
    }
    const p = data.product;
    const n = p.nutriments || {};
    res.json({
      item: {
        name: [p.product_name, p.brands].filter(Boolean).join(' — ').slice(0, 120) || 'Unknown product',
        kcal: Math.round(n['energy-kcal_100g'] ?? 0),
        protein: Number((n['proteins_100g'] ?? 0).toFixed(1)),
        carbs: Number((n['carbohydrates_100g'] ?? 0).toFixed(1)),
        fat: Number((n['fat_100g'] ?? 0).toFixed(1)),
      },
    });
  } catch (e) {
    console.error('barcode error:', e.message);
    res.status(502).json({ error: 'barcode lookup failed' });
  }
});

module.exports = router;
