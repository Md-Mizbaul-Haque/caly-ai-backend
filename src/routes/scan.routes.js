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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB raw bytes (multipart only — not comparable to the JSON body limit)
  fileFilter: (_req, file, cb) => {
    // Non-images would burn a paid vision call just to 422 — reject early.
    if (/^image\//.test(file.mimetype || '')) return cb(null, true);
    const err = new Error('only image files are accepted');
    err.status = 400;
    cb(err);
  },
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
    // 55 s cap: the app waits 60 s, so a hung provider surfaces as a
    // catchable error instead of an eternal request.
    client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL, timeout: 55000 });
    clientKey = provider.apiKey;
  }
  return client;
}

const FOOD_SYSTEM_PROMPT =
  'You are a nutrition expert. Analyze the food in the photo. ' +
  'Identify each distinct food item you can see. For each item estimate its ' +
  'serving calories (kcal) and macronutrients in grams. ' +
  'For each item also describe the pictured portion in a short "serving" ' +
  'string (e.g. "1 slice", "whole bowl", "1 jar"). ' +
  'Respond ONLY with a JSON object of shape: ' +
  '{"items":[{"name":"string","kcal":number,"protein":number,"carbs":number,"fat":number,"serving":"string"}]} ' +
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
        // Pictured portion ("1 slice", "whole bowl") — without it a photo
        // kcal is a bare number the diary would treat as the whole meal.
        serving: z.string().trim().min(1).max(60).optional(),
      })
    )
    .min(1)
    .max(6),
});

// Magic numbers, not client mimetypes: a spoofed Content-Type must not reach
// the paid vision call (or Cloudinary). Covers JPEG/PNG/GIF/WebP.
function isImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  return (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ); // RIFF....WEBP
}

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
  // One line per scan: outcome + latency, keyed by the shared request ID.
  const t0 = Date.now();
  res.on('finish', () => {
    console.info(`[scan ${req.reqId || '-'}] POST /api/scan -> ${res.statusCode} ${Date.now() - t0}ms`);
  });
  if (!req.file) {
    return res.status(400).json({ error: 'image file required (multipart field "image")' });
  }
  const aiClient = getClient();
  const model = resolveProvider()?.model;
  if (!aiClient || !model) {
    // Generic on purpose: setup paths and key names don't belong in API errors.
    return res.status(503).json({ error: 'image scanning is temporarily unavailable — please try again later' });
  }
  if (!isImageBuffer(req.file.buffer)) {
    return res.status(400).json({ error: 'only photo files are accepted' });
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
    console.error('scan error:', e.message);
    res.status(502).json({ error: 'failed to analyze image' });
  }
});

// OpenFoodFacts numbers arrive as numbers, strings, or null — coerce to a
// safe finite value (strings like "12.5" work, garbage becomes 0).
function toNum(v, digits = 0) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// Serving size in grams from OpenFoodFacts ("40g", "40 g", "1 bar (40g)").
// A bare count ("40", "1 bar") has no unit — null means per-100g.
function servingGrams(quantity, unit) {
  const m = `${quantity ?? ''} ${unit ?? ''}`.match(/([\d.]+)\s*g/i);
  const g = m ? parseFloat(m[1]) : NaN;
  return Number.isFinite(g) && g > 0 ? g : null;
}

// Any HTTP answer (even 404) proves OpenFoodFacts is reachable; only a
// thrown fetch (network/timeout) means unreachable. Injectable fetchFn
// exists for unit tests — the route passes the global fetch.
async function lookupOffProduct(candidates, fetchFn = fetch) {
  let upstreamOk = false;
  let data = null;
  for (const candidate of candidates) {
    const offRes = await fetchFn(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(candidate)}.json?fields=product_name,brands,nutriments,serving_quantity,serving_unit`,
      { signal: AbortSignal.timeout(10000) }
    ).catch(() => null);
    if (!offRes) continue;
    upstreamOk = true;
    if (!offRes.ok) continue;
    data = await offRes.json().catch(() => null);
    if (data && data.status === 1 && data.product) break;
  }
  return { upstreamOk, data };
}

// GET /api/scan/barcode/:code — look up a packaged food via OpenFoodFacts
router.get('/barcode/:code', async (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!/^\d{6,18}$/.test(code)) {
    return res.status(400).json({ error: 'invalid barcode' });
  }
  try {
    // OpenFoodFacts indexes EAN-13 as-is; UPC-A (12-digit) is stored with a leading 0
    const candidates = code.length === 12 ? [code, `0${code}`] : [code];
    const { upstreamOk, data } = await lookupOffProduct(candidates);
    if (!upstreamOk) {
      return res.status(502).json({ error: 'barcode lookup failed' });
    }
    if (!data || data.status !== 1 || !data.product) {
      return res.status(404).json({ error: 'product not found' });
    }
    const p = data.product;
    const n = p.nutriments || {};
    // kcal field is sometimes absent while kilojoules are present.
    const kcal100 = n['energy-kcal_100g'] ?? toNum(n['energy_100g']) / 4.184;
    // Scale per-100g values to the serving when OpenFoodFacts states one;
    // otherwise flag per100g so the app can say so.
    const grams = servingGrams(p.serving_quantity, p.serving_unit);
    const scale = grams ? grams / 100 : 1;
    res.json({
      item: {
        name: [p.product_name, p.brands].filter(Boolean).join(' — ').slice(0, 120) || 'Unknown product',
        kcal: toNum(kcal100 * scale),
        protein: toNum(n['proteins_100g'] * scale, 1),
        carbs: toNum(n['carbohydrates_100g'] * scale, 1),
        fat: toNum(n['fat_100g'] * scale, 1),
        ...(grams ? { serving: `${grams}g` } : { per100g: true }),
      },
    });
  } catch (e) {
    console.error('barcode error:', e.message);
    res.status(502).json({ error: 'barcode lookup failed' });
  }
});

const { connectCloudinary, cloudinaryStatus } = require('../config/cloudinary');

// Persist a KEPT meal photo (scan-time upload would orphan every discarded
// retake). Bytes ride the same multer pipeline; the client calls this once
// at Save and stores the returned CDN URL on the meal.
function uploadBuffer(buffer) {
  const cloudinary = connectCloudinary();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'caly/meals', resource_type: 'image' },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

// POST /api/scan/image (multipart field "image") -> { imageUrl }
router.post('/image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'image file required (multipart field "image")' });
  }
  if (!isImageBuffer(req.file.buffer)) {
    return res.status(400).json({ error: 'only photo files are accepted' });
  }
  if (!cloudinaryStatus().configured) {
    return res.status(503).json({ error: 'photo storage is temporarily unavailable — saving without a photo' });
  }
  try {
    const result = await uploadBuffer(req.file.buffer);
    if (!result?.secure_url) throw new Error('upload returned no URL');
    res.json({ imageUrl: result.secure_url });
  } catch (e) {
    console.error('photo upload error:', e.message);
    res.status(502).json({ error: 'could not store the photo — saving without it' });
  }
});

module.exports = router;
module.exports.LABEL_SCHEMA = LABEL_SCHEMA;
module.exports.scanHelpers = { toNum, servingGrams, isImageBuffer, lookupOffProduct };
