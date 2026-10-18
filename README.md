# Caly AI Backend

Express + MongoDB (Mongoose) calorie-tracking API with JWT auth, AI food scanning, a seeded food catalog, favorites, and a server-authoritative nutrition plan. Pairs with `caly-ai-frontend`.

## Features

- Email + password auth with 6-digit verification / password-reset codes, plus a "skip verification" path
- JWT auth (`Authorization: Bearer <token>`), owner-scoped meals, weights, and favorites
- Meal logging with kcal + macros + meal type, date-range queries, and a "my foods" most-logged aggregation
- Weight logging (one entry per local calendar day) + weight goal, which recomputes the daily calorie plan
- AI food photo scan (Groq or OpenAI vision) + OpenFoodFacts barcode lookup; scanned images hosted on Cloudinary
- Shared food catalog (`/api/foods`): browse categories, per-meal suggestions, prefix/text search — seeded from USDA FoodData Central
- Server-authoritative nutrition plan calculator (`POST /api/plan/calculate`)
- Support messages emailed to the team (`POST /api/support/message`)
- Hardened defaults: `helmet`, CORS, rate limits (general + credential + per-user scan quota), Zod validation, centralized error handling, `X-Request-Id` correlation

## Stack

Node (CommonJS) · Express 5 · Mongoose 9 · Zod 4 · `jsonwebtoken` + `bcryptjs` · `openai` SDK (Groq or OpenAI vision) · Nodemailer · Cloudinary · `multer` (multipart photos) · `helmet` / `cors` / `express-rate-limit`, request logging via `morgan`.

## Prerequisites

- Node.js 20+ and npm (`engines`: `>=18`)
- A MongoDB connection string (Atlas or local)
- One vision key for food scanning: `GROQ_API_KEY` (`gsk_...`) or `OPENAI_API_KEY` (`sk-...`)
- Cloudinary credentials to host catalog / scan images (optional — without them catalog images and `POST /api/scan/image` are unavailable)

## Quick start

```bash
cp .env.example .env   # then fill MONGO_URI + JWT_SECRET (required)
npm install
npm run dev            # http://localhost:5000/health
npm test               # node --test validation + unit suites
```

- Dev server runs with `nodemon src/index.js`.
- Production: `npm start` (`node src/index.js`).
- Health check: `GET /health` → `{ status: 'ok', db: 'up'|'down', uptime, smtp }`.
- API index: `GET /api` → `{ message: 'Caly AI API v1 ...' }`.

## Env vars (see `.env.example`)

| Var | Required | What |
|---|---|---|
| `PORT` | no (`5000`) | Listen port |
| `MONGO_URI` | yes | MongoDB connection string. Without DB the API boots but `/health` reports `db:down` and all `/api/*` return `503` |
| `MONGO_DB` | no (`caly-ai`) | Database name (when it isn't in the URI) |
| `JWT_SECRET` | yes | Long random string for tokens + code hashes |
| `GROQ_API_KEY` | one of the two | `gsk_...` — preferred vision provider (free tier, fast). `GROQ_BASE_URL` overrides only if you proxy Groq |
| `OPENAI_API_KEY` | one of the two | `sk-...` fallback vision provider |
| `VISION_MODEL` | no | Defaults to `qwen/qwen3.8-27b` (Groq) or `gpt-4o-mini` (OpenAI) |
| `SCAN_DAILY_LIMIT` | no (`50`) | Per-user paid-vision scans per UTC day (cost guard on the shared provider quota) |
| `FDC_API_KEY` | no | USDA FoodData Central key — read only by `scripts/import-fdc.js` (one-off catalog import), never by the running server |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | all three to use images | Hosts food-catalog images and `POST /api/scan/image` uploads |
| `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` | no | Without `SMTP_HOST`, verification codes are logged to console instead of emailed. On Render free (blocks outbound 25/465/587) use a relay on an allowed port, e.g. Resend `smtp.resend.com:2587` (user `resend`, pass = `re_...` API key) |
| `SUPPORT_EMAIL` | no (`support@caly-ai.app`) | Where `POST /api/support/message` forwards user messages |
| `CORS_ORIGINS` | no | Comma-separated allowed origins (empty = allow all) |
| `TRUST_PROXY` | no | Proxy hops. Defaults to `1` in production, off in dev. Set `0` only for a directly-exposed server |
| `API_LIMIT` / `AUTH_LIMIT` | no (`600` / `50`) | Per-IP per-15-min rate limits: all `/api` vs credential endpoints (auth counts failures only) |
| `CALY_TEST_INBOX` | no | Set `1` to capture sent emails in memory during tests instead of sending |

## API

Base: `http://localhost:5000`. All `/api/*` (except register/login/code flows and `POST /api/plan/calculate`, which allows unverified JWTs) require `Authorization: Bearer <jwt>`. Most routes also require a verified email — otherwise `401` / `403 {needsVerification:true}`.

**Auth** (`/api/auth`): `POST register {name,email,password}` → `201 {requiresVerification:true}` · `POST login` → `{token,user}` (unverified → `403` + code resent) · `POST verify-email {email,code}` · `POST resend-code` · `POST skip-verification {email}` → `201 {token,user}` · `POST forgot-password` → `{ok,emailSent}` · `POST reset-password {email,code,newPassword}` → `{token,user}` · `POST logout` · `GET me` → `{user}` · `PUT profile {gender,birthDate,heightCm,weightKg,targetWeightKg,activityLevel,goalPace,onboardingCompleted,timezone}` (the server owns `dailyGoalKcal` — it is recomputed, never accepted from the client).

**Meals** (`/api/meals`, owner-scoped): `GET /my-foods?limit=10` → most-logged foods with averaged macros · `GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&mealType?` (max 400 days) · `POST {name,kcal>0,protein,carbs,fat,mealType,emoji,imageUrl?,loggedAt?}` → `201 {meal}` · `DELETE :id`.

**Weights** (`/api/weights`, owner-scoped): `GET [?from&to]` · `POST {value 20–1000,loggedAt?}` → `201` (new day) / `200 {updated:true}` (same-day replace) · `DELETE :id` · `GET /goal` → `{goal|null}` · `PUT /goal {value,activityLevel?,pace?}` → `{goal,plan|null,missing[]|planError}` (recomputes the daily calorie plan).

**Foods** (`/api/foods`, shared catalog): `GET /categories` · `GET /suggestions?mealType=Breakfast|Lunch|Dinner|Snack&limit=` · `GET /search?q=&category=&limit=` (prefix + `$text`, falls back to regex when the text index is missing) · `GET /:fdcId`.

**Favorites** (`/api/favorites`, owner-scoped): `GET /` (newest first, max 100) · `POST {name,kcal>0,protein,carbs,fat,imageUrl?}` → `201 {favorite}` (idempotent per food name → `200 {existed:true}`) · `DELETE :id`.

**Scan** (`/api/scan`, multipart `image`, max 10 MB): `POST /` → `{items:[{name,kcal,protein,carbs,fat}]}` (1–6 items; `503` when no vision key; `422` when no food detected; charged against `SCAN_DAILY_LIMIT`) · `POST /image` → stores the photo on Cloudinary and returns its URL (`503` when Cloudinary is unconfigured) · `GET /barcode/:code` → OpenFoodFacts lookup (per-100g values).

**Plan** (`/api/plan`): `POST /calculate` → `{plan}`. Accepts onboarding fields (`gender,birthDate,heightCm,weightKg,targetWeightKg,activityLevel`) or falls back to the JWT user's profile. Returns `400 {error,missing[],details[]}` when fields are absent — a plan is only created after ALL information is present, never partially.

**Support** (`/api/support`): `POST /message {message 5–2000 chars, subject?}` → `202 {ok:true}` (emailed to `SUPPORT_EMAIL`).

## Testing

```bash
npm test   # node --test src/{routes,models,services,utils}/*.test.js
```

Covers route validation (auth, meals, weights, favorites, support, scan), model helpers (`Food`), and pure services/utils (`nutritionPlan`, `foodImageMatch`, `timezone`, `requestId`, `auth`, `mailer`). Run a single file with `node --test src/services/nutritionPlan.test.js`.

## Notes

- Email codes: 6 digits, 10-min TTL, 5 attempts, HMAC-hashed at rest.
- `POST /api/scan` without `GROQ_API_KEY`/`OPENAI_API_KEY` returns `503` — the frontend shows a labeled placeholder estimate instead.
- The food catalog is imported once with `node scripts/import-fdc.js` (needs `FDC_API_KEY`); the running server never calls FDC.
- Responses serialize `_id → id` and strip secrets/`__v`; every response echoes `X-Request-Id` (the app's support "Ref #").

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/health` shows `db:down`, `/api/*` returns `503` | `MONGO_URI` missing or unreachable. Check Atlas IP allowlist / local `mongod`. |
| `POST /api/scan` returns `503` | No vision key set. Add `GROQ_API_KEY` (or `OPENAI_API_KEY`) and restart. |
| `POST /api/scan/image` returns `503` | Cloudinary not configured. Set all three `CLOUDINARY_*` vars. |
| Foods search returns `fallback: true` | MongoDB has no `name` text index (Atlas/local). The server falls back to prefix regex; add the index for ranked search. |
| Auth returns `403 {needsVerification:true}` | Email not verified. Call `POST /api/auth/verify-email`, `resend-code`, or `skip-verification`. |
| No emails arrive | `SMTP_HOST` unset (codes are console-logged by design), **or** the host blocks outbound SMTP ports. Render free blocks 25/465/587 — use a relay on 2525/2587 (e.g. Resend `smtp.resend.com:2587`). Check `GET /health` → `smtp.lastError.class` |
| `429 Too many requests` | Hit `API_LIMIT` / `AUTH_LIMIT` / `SCAN_DAILY_LIMIT`. Raise the limits in `.env` or wait. |

## Deployment

1. Set `NODE_ENV=production`, `PORT`, `MONGO_URI`, `JWT_SECRET`, one vision key, SMTP, Cloudinary (for images), and `CORS_ORIGINS` (your frontend origin). On Render free, SMTP vars must point at a relay on a non-blocked port (e.g. Resend `smtp.resend.com:2587`), not `smtp.gmail.com:587`.
2. Leave `TRUST_PROXY` unset (defaults to `1` in production) or set it explicitly for your proxy topology.
3. Run `npm install --omit=dev` then `npm start`.
4. Keep `/health` as the load-balancer / uptime check.

## Structure

`src/index.js` (boot) · `src/app.js` (routers + middleware + rate limits) · `src/config/db.js,cloudinary.js` · `src/middleware/auth.js,error.js,validate.js` · `src/models/User.js,Meal.js,Weight.js,WeightGoal.js,Favorite.js,Food.js,PendingRegistration.js` · `src/routes/auth|meals|weights|foods|favorites|scan|plan|support.routes.js` · `src/services/auth.js,mailer.js,emailTemplates.js,nutritionPlan.js,commonFoods.js,fdcNormalize.js,foodImageMatch.js` · `src/utils/AppError.js,requestId.js,timezone.js` · `scripts/` (one-off helpers: `import-fdc.js`, seed/verify/cleanup — `src/controllers/` is unused/reserved).

## License

ISC (see `package.json`; no `LICENSE` file in this repo). If you publish or distribute this API, add an explicit `LICENSE` file.
