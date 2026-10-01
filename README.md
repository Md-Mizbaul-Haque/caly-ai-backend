# Caly AI Backend

Express + MongoDB (Mongoose) calorie-tracking API with JWT auth, AI food scanning, and barcode lookup. Pairs with `caly-ai-frontend`.

## Stack

Node (CommonJS) · Express 5 · Mongoose 9 · Zod 4 · `jsonwebtoken` + `bcryptjs` · `openai` SDK (Groq or OpenAI vision) · Nodemailer · `helmet`/`cors`/rate-limit logging via `morgan`.

## Quick start

```bash
cp .env.example .env   # then fill MONGO_URI + JWT_SECRET (required)
npm install
npm run dev            # http://localhost:5000/health
npm test               # node --test validation suite, 5/5
```

## Env vars (see `.env.example`)

| Var | Required | What |
|---|---|---|
| `PORT` | no (`5000`) | Listen port |
| `MONGO_URI` | yes | MongoDB connection string. Without DB the API boots but `/health` reports `db:down` and all `/api/*` return `503` |
| `JWT_SECRET` | yes | Long random string for tokens + code hashes |
| `GROQ_API_KEY` | one of the two | `gsk_...` — preferred vision provider (free tier, fast) |
| `OPENAI_API_KEY` | one of the two | `sk-...` fallback vision provider |
| `VISION_MODEL` | no | Defaults to `qwen/qwen3.8-27b` (Groq) or `gpt-4o-mini` (OpenAI) |
| `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` | no | Without `SMTP_HOST`, verification codes are logged to console instead of emailed |
| `CORS_ORIGINS` | no | Comma-separated allowed origins (empty = allow all) |
| `TRUST_PROXY` | no | Set `1` behind a proxy |
| `API_LIMIT` / `AUTH_LIMIT` | no | Rate limits per 15 min (`100` / `20`) |

## API

Base: `http://localhost:5000`. All `/api/*` (except register/login/code flows) require `Authorization: Bearer <jwt>` and a verified email — otherwise `401` / `403 {needsVerification:true}`.

**Auth** (`/api/auth`): `POST register {name,email,password}` → `201 {requiresVerification:true}` · `POST login` → `{token,user}` (unverified → `403` + code resent) · `POST verify-email {email,code}` · `POST resend-code` · `POST forgot-password` · `POST reset-password {email,code,newPassword}` · `GET me` · `PUT profile {dailyGoalKcal 500–10000}`.

**Meals** (`/api/meals`, owner-scoped): `GET ?from=YYYY-MM-DD&to=YYYY-MM-DD` · `POST {name,kcal>0,protein,carbs,fat,mealType,emoji,imageUrl?,loggedAt?}` → `201 {meal}` · `DELETE :id`.

**Weights** (`/api/weights`, owner-scoped): `GET [?from&to]` · `POST {value 20–1000,loggedAt?}` · `DELETE :id` · `GET /goal` → `{goal|null}` · `PUT /goal {value}`.

**Scan** (`/api/scan`, multipart `image`, max 10 MB): `POST /` → `{items:[{name,kcal,protein,carbs,fat}]}` (1–6 items; `503` when no vision key; `422` when no food detected) · `GET /barcode/:code` → OpenFoodFacts lookup (per-100g values).

## Notes

- Email codes: 6 digits, 10-min TTL, 5 attempts, HMAC-hashed at rest.
- `POST /api/scan` without `GROQ_API_KEY`/`OPENAI_API_KEY` returns `503` — the frontend shows a labeled placeholder estimate instead.
- Responses serialize `_id → id` and strip secrets/`__v`.

## Structure

`src/index.js` (boot) · `src/app.js` (routers+middleware) · `src/config/db.js` · `src/middleware/auth.js,error.js` · `src/models/User.js,Meal.js,Weight.js,WeightGoal.js` · `src/routes/auth|meals|weights|scan.routes.js` · `src/services/auth.js,mailer.js` · `src/utils/AppError.js`
