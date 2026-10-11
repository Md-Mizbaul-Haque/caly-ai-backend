// One-off E2E test of the live AI scan + photo-upload flow on the running dev server:
// 1. login as the seeded test user -> token
// 2. POST /api/scan with a generated JPEG (tiny food-ish image) -> expect items JSON
// 3. POST /api/scan/image with same JPEG -> expect { imageUrl }
// Prints status + response for each. No secrets printed.
require('dotenv').config();

const API = process.env.BASE_URL || 'http://localhost:5000';

// Use a real image file so the magic-byte check and vision call see genuine bytes.
const fs = require('fs');
const path = require('path');
const imgPath = path.join(__dirname, '..', '..', 'caly-ai-frontend', 'assets', 'caly-logo.png');
const imgBytes = fs.readFileSync(imgPath);

async function main() {
  // 1. login
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@caly.ai', password: 'Test1234!' }),
  });
  const login = await loginRes.json().catch(() => ({}));
  console.log('login status:', loginRes.status, 'token?', Boolean(login.token));
  if (!login.token) {
    console.log('login body keys:', Object.keys(login), JSON.stringify(login).slice(0, 200));
    process.exit(1);
  }
  const token = login.token;

  const boundary = '----calytest' + Date.now();
  const contentType = `multipart/form-data; boundary=${boundary}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="meal.png"\r\nContent-Type: image/png\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, imgBytes, tail]);

  // 2. AI scan
  const scanRes = await fetch(`${API}/api/scan`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body,
  });
  const scanBody = await scanRes.json().catch(() => ({}));
  console.log('scan status:', scanRes.status);
  console.log('scan body:', JSON.stringify(scanBody).slice(0, 600));

  // 3. Cloudinary photo upload
  const imgRes = await fetch(`${API}/api/scan/image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body, // same bytes, multipart header set above
  });
  const imgBody = await imgRes.json().catch(() => ({}));
  console.log('image status:', imgRes.status);
  console.log('image body:', JSON.stringify(imgBody).slice(0, 300));
}

main().catch((e) => {
  console.error('test crashed:', e.message);
  process.exit(1);
});
