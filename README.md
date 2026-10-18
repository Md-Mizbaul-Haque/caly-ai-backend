# Caly AI Backend

Express + MongoDB (Mongoose) calorie-tracking API with JWT auth, AI food scanning, and barcode lookup. Pairs with `caly-ai-frontend`.

## Features

- Email + password auth with 6-digit verification / password-reset codes
- JWT auth (`Authorization: Bearer <token>`), owner-scoped meals and weights
- Meal logging with kcal + macros, date-range queries
- Weight logging + weight goal tracking
- AI food photo scan (Groq or OpenAI vision) + OpenFoodFacts barcode lookup
- Server-authoritative nutrition plan calculator (`POST /api/plan/calculate`)
- Hardened defaults: `helmet`, CORS, rate limits, Zod validation, centralized error handling

## Stack

Node (CommonJS) · Express 5 · Mongoose 9 · Zod 4 · `jsonwebtoken` + `bcryptjs` · `openai` SDK (Groq or OpenAI vision) · Nodemailer · `helmet`/`cors`/rate-limit logging via `morgan`.

## Prerequisites

- Node.js 20+ and npm
- A MongoDB connection string (Atlas or local)
- One vision key for food scanning: `GROQ_API_KEY` (`gsk_...`) or `OPENAI_API_KEY` (`sk-...`)

## Quick start

```bash
cp .env.example .env   # then fill MONGO_URI + JWT_SECRET (required)
npm install
npm run dev            # http://localhost:5000/health
npm test               # node --test route validation suite
```

- Dev server runs with `nodemon src/index.js`.
- Production: `npm start` (`node src/index.js`).
- Health check: `GET /health` → `{ status: 'ok', db: 'up'|'down', uptime }`.
- API index: `GET /api` → `{ message: 'Caly AI API v1 ...' }`.

## Env vars (see `.env.example`)

| Var | Required | What |
|---|---|---|
| `PORT` | no (`5000`) | Listen port |
| `MONGO_URI` | yes | MongoDB connection string. Without DB the API boots but `/health` reports `db:down` and all `/api/*` return `503` |
| `JWT_SECRET` | yes | Long random string for tokens + code hashes |
| `GROQ_API_KEY` | one of the two | `gsk_...` — preferred vision provider (free tier, fast) |
| `OPENAI_API_KEY` | one of the two | `sk-...` fallback vision provider |
| `VISION_MODEL` | no | Defaults to `qwen/qwen3.8-27b` (Groq) or `gpt-4o-mini` (OpenAI) |
| `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` | no | Without `SMTP_HOST`, verification codes are logged to console instead of emailed. On Render free (blocks outbound 25/465/587) use a relay on an allowed port, e.g. Resend `smtp.resend.com:2587` (user `resend`, pass = `re_...` API key) |
| `CORS_ORIGINS` | no | Comma-separated allowed origins (empty = allow all) |
| `TRUST_PROXY` | no | Set `1` behind a proxy |
| `API_LIMIT` / `AUTH_LIMIT` | no | Rate limits per 15 min (`100` / `20`) |

## API

Base: `http://localhost:5000`. All `/api/*` (except register/login/code flows and `POST /api/plan/calculate`, which allows unverified JWTs) require `Authorization: Bearer <jwt>`. Most routes also require a verified email — otherwise `401` / `403 {needsVerification:true}`.

**Auth** (`/api/auth`): `POST register {name,email,password}` → `201 {requiresVerification:true}` · `POST login` → `{token,user}` (unverified → `403` + code resent) · `POST verify-email {email,code}` · `POST resend-code` · `POST forgot-password` · `POST reset-password {email,code,newPassword}` · `GET me` · `PUT profile {dailyGoalKcal 500–10000}`.

**Meals** (`/api/meals`, owner-scoped): `GET ?from=YYYY-MM-DD&to=YYYY-MM-DD` · `POST {name,kcal>0,protein,carbs,fat,mealType,emoji,imageUrl?,loggedAt?}` → `201 {meal}` · `DELETE :id`.

**Weights** (`/api/weights`, owner-scoped): `GET [?from&to]` · `POST {value 20–1000,loggedAt?}` · `DELETE :id` · `GET /goal` → `{goal|null}` · `PUT /goal {value}`.

**Scan** (`/api/scan`, multipart `image`, max 10 MB): `POST /` → `{items:[{name,kcal,protein,carbs,fat}]}` (1–6 items; `503` when no vision key; `422` when no food detected) · `GET /barcode/:code` → OpenFoodFacts lookup (per-100g values).

**Plan** (`/api/plan`): `POST /calculate` → `{plan}`. Accepts onboarding fields (`gender,birthDate,heightCm,weightKg,targetWeightKg,activityLevel`) or falls back to the JWT user's profile. Returns `400 {error,missing[],details[]}` when fields are absent — a plan is only created after ALL information is present, never partially.

## Testing

```bash
npm test   # node --test src/routes/*.test.js (auth, meals, weights validation)
```

Service-level tests (e.g. `src/services/nutritionPlan.test.js`) are not covered by `npm test`; run them explicitly with `node --test src/services/nutritionPlan.test.js`.

## Notes

- Email codes: 6 digits, 10-min TTL, 5 attempts, HMAC-hashed at rest.
- `POST /api/scan` without `GROQ_API_KEY`/`OPENAI_API_KEY` returns `503` — the frontend shows a labeled placeholder estimate instead.
- Responses serialize `_id → id` and strip secrets/`__v`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/health` shows `db:down`, `/api/*` returns `503` | `MONGO_URI` missing or unreachable. Check Atlas IP allowlist / local `mongod`. |
| `POST /api/scan` returns `503` | No vision key set. Add `GROQ_API_KEY` (or `OPENAI_API_KEY`) and restart. |
| Auth returns `403 {needsVerification:true}` | Email not verified. Call `POST /api/auth/verify-email` or `resend-code`. |
| No emails arrive | `SMTP_HOST` unset (codes are console-logged by design), **or** the host blocks outbound SMTP ports. Render free blocks 25/465/587 — use a relay on 2525/2587 (e.g. Resend `smtp.resend.com:2587`). Check `GET /health` → `smtp.lastError.class` |
| `429 Too many requests` | Hit `API_LIMIT` / `AUTH_LIMIT`. Raise the limits in `.env` or wait 15 min. |

## Deployment

1. Set `NODE_ENV=production`, `PORT`, `MONGO_URI`, `JWT_SECRET`, one vision key, SMTP, and `CORS_ORIGINS` (your frontend origin). On Render free, SMTP vars must point at a relay on a non-blocked port (e.g. Resend `smtp.resend.com:2587`), not `smtp.gmail.com:587`.
2. Set `TRUST_PROXY=1` if behind a reverse proxy / load balancer.
3. Run `npm install --omit=dev` then `npm start`.
4. Keep `/health` as the load-balancer / uptime check.

## Structure

`src/index.js` (boot) · `src/app.js` (routers+middleware) · `src/config/db.js` · `src/middleware/auth.js,error.js,validate.js` · `src/models/User.js,Meal.js,Weight.js,WeightGoal.js,PendingRegistration.js` · `src/routes/auth|meals|weights|scan|plan.routes.js` · `src/services/auth.js,mailer.js,emailTemplates.js,nutritionPlan.js` · `src/utils/AppError.js` (`src/controllers/` is currently unused/reserved).

## License

ISC (see `package.json`; no `LICENSE` file in this repo). If you publish or distribute this API, add an explicit `LICENSE` file.
