const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const User = require('../models/User');

const router = express.Router();

// Daily paid-vision quota per user. The global IP buckets alone let one
// account drain the shared provider quota; this is the cost guard.
const SCAN_DAILY_LIMIT = Math.max(parseInt(process.env.SCAN_DAILY_LIMIT, 10) || 50, 1);

// Vision-call attempts: one automatic retry for provider blips. Two 25 s
// attempts + a 500 ms gap = 50.5 s, safely under the app's 60 s read
// budget, so a slow provider surfaces as OUR dialog instead of a client
// abort. Measured while diagnosing a user 502: congested Groq ran 14-54 s
// per call and a fresh second attempt often landed where the first stalled.
const VISION_ATTEMPTS = 2;
const VISION_ATTEMPT_TIMEOUT_MS = 25000;
const VISION_RETRY_GAP_MS = 500;

// Charges one scan against today's (UTC) quota and returns the new count.
// Read-modify-write is deliberate: a rare parallel-scan race may undercount
// by a request or two — fine for a cost guard, never a security boundary.
async function chargeScanQuota(userId, UserModel = User) {
  const dayKey = new Date().toISOString().slice(0, 10);
  const user = await UserModel.findById(userId).select('scanDayKey scanCountToday');
  if (!user) return SCAN_DAILY_LIMIT + 1;
  if (user.scanDayKey !== dayKey) {
    user.scanDayKey = dayKey;
    user.scanCountToday = 0;
  }
  user.scanCountToday = (user.scanCountToday || 0) + 1;
  await user.save();
  return user.scanCountToday;
}

// Gives back one charge when the paid call FAILED (provider down, quota,
// timeout): a user must not burn their daily budget on our outages.
async function refundScanQuota(userId, UserModel = User) {
  const dayKey = new Date().toISOString().slice(0, 10);
  await UserModel.updateOne(
    { _id: userId, scanDayKey: dayKey, scanCountToday: { $gt: 0 } },
    { $inc: { scanCountToday: -1 } }
  );
}

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

// Groq answers quota exhaustion as HTTP 429 (SDK throws with status/code).
// Anything else (network, model, parse) stays a 502 — never leak provider text.
function isQuotaError(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.status === 429 || e.statusCode === 429) return true;
  const code = String(e.code || e?.error?.code || '').toLowerCase();
  if (code.includes('429') || code.includes('rate_limit') || code.includes('rate-limit')) return true;
  const msg = `${e.message || ''} ${e?.error?.message || ''}`.toLowerCase();
  return msg.includes('429')
    || msg.includes('rate limit')
    || msg.includes('rate_limit')
    || msg.includes('too many requests')
    || msg.includes('quota')
    || msg.includes('rpd')
    || msg.includes('tpd')
    || msg.includes('tokens per')
    || msg.includes('requests per day');
}

// Vision-call failure taxonomy — every provider fault used to funnel into
// one generic 502 with no retry; these three kinds deserve different answers:
//   image     - Groq rejected the bytes ("400 invalid image data"); the same
//               file always fails, so blame the file and never retry.
//   quota     - provider rate limit; the 429 branch owns it.
//   transient - 5xx, timeouts, network faults, unparseable output; one
//               fresh attempt may fix it.
function classifyVisionError(e) {
  if (isQuotaError(e)) return 'quota';
  const status = Number(e?.status ?? e?.statusCode);
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'image';
  return 'transient';
}

// Runs fn() and retries ONLY transient failures — an unreadable photo or an
// exhausted rate limit throws through on the first attempt, because the same
// bytes / the same window would only fail (and bill) again.
async function withTransientRetry(fn, { attempts = VISION_ATTEMPTS, sleep } = {}) {
  const nap = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (classifyVisionError(e) !== 'transient' || attempt === attempts) throw e;
      console.warn(`[scan] vision attempt ${attempt}/${attempts} failed: ${String(e.message || e).slice(0, 200)}`);
      await nap(VISION_RETRY_GAP_MS);
    }
  }
  throw lastErr;
}

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
  // Quota check last: rejected requests above must not consume quota.
  if ((await chargeScanQuota(req.user.id)) > SCAN_DAILY_LIMIT) {
    return res.status(429).json({ error: 'daily scan limit reached — please try again tomorrow' });
  }
  try {
    const b64 = req.file.buffer.toString('base64');
    const content = await withTransientRetry(() =>
      aiClient.chat.completions
        .create(
          {
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
          },
          // Per-attempt cap (25 s): two attempts + gap stay inside the app's
          // 60 s budget so WE answer the phone, never a mid-flight abort.
          { timeout: VISION_ATTEMPT_TIMEOUT_MS }
        )
        .then((completion) => parseJsonLoose(completion.choices[0]?.message?.content))
    );
    const parsed = LABEL_SCHEMA.safeParse(content);
    if (!parsed.success || !parsed.data.items.length) {
      return res.status(422).json({ error: 'no food detected in this photo' });
    }
    res.json({ items: parsed.data.items });
  } catch (e) {
    // Our failure, not theirs: give the quota back (a 422 "no food" keeps
    // the charge — the paid vision call did run).
    await refundScanQuota(req.user.id).catch(() => {});
    const kind = classifyVisionError(e);
    if (kind === 'quota') {
      console.warn(`[scan ${req.reqId || '-'}] quota exhausted: ${e.message}`);
      return res.status(429).json({ error: 'daily scan limit reached — please try again tomorrow' });
    }
    if (kind === 'image') {
      // The provider refused these bytes — the same file can never scan, so
      // say that plainly instead of implying a service outage. A 4xx here is
      // NOT retryable; the app shows it as a plain message (422 is reserved
      // for "no food in frame" and would wrongly open an empty result sheet).
      console.warn(`[scan ${req.reqId || '-'}] unreadable image: ${String(e.message || e).slice(0, 200)}`);
      return res.status(400).json({ error: "We couldn't read this photo. Retake it or pick a different one." });
    }
    // Transient after one retry: keep the provider detail in the server log
    // (truncated, never a key) and answer a retryable 502 — the app's
    // HTTP_5xx code now paints a Retry button for it.
    console.error(`[scan ${req.reqId || '-'}] vision failed: ${e.status || e.statusCode || e.name || 'no-status'} ${String(e.message || e).slice(0, 300)}`);
    res.status(502).json({ error: 'image analysis failed — please try again' });
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
  // Same daily budget as scans: an unmetered upload endpoint let one account
  // burn Cloudinary credits, defeating the scan quota's cost guard.
  if ((await chargeScanQuota(req.user.id)) > SCAN_DAILY_LIMIT) {
    return res.status(429).json({ error: 'daily photo limit reached — please try again tomorrow' });
  }
  try {
    const result = await uploadBuffer(req.file.buffer);
    if (!result?.secure_url) throw new Error('upload returned no URL');
    res.json({ imageUrl: result.secure_url });
  } catch (e) {
    await refundScanQuota(req.user.id).catch(() => {});
    console.error('photo upload error:', e.message);
    res.status(502).json({ error: 'could not store the photo — saving without it' });
  }
});

module.exports = router;
module.exports.LABEL_SCHEMA = LABEL_SCHEMA;
module.exports.SCAN_DAILY_LIMIT = SCAN_DAILY_LIMIT;
module.exports.chargeScanQuota = chargeScanQuota;
module.exports.refundScanQuota = refundScanQuota;
module.exports.scanHelpers = { toNum, servingGrams, isImageBuffer, isQuotaError, lookupOffProduct, classifyVisionError, withTransientRetry };
