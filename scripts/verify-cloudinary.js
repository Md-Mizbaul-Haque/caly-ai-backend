/* Verify Cloudinary account connectivity.
 * Usage: node scripts/verify-cloudinary.js
 * Pings the account (admin API) and uploads a 1px test image, then deletes it.
 * Prints exactly which env vars are missing if not fully configured.
 */
require('dotenv').config();
const { connectCloudinary, cloudinaryStatus } = require('../src/config/cloudinary');

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  const status = cloudinaryStatus();
  console.log('env present:', JSON.stringify(status.present));
  if (!status.configured) {
    console.log(`NOT CONNECTED — missing: ${status.missing.join(', ')}`);
    process.exit(1);
  }
  const cloudinary = connectCloudinary();
  const ping = await cloudinary.api.ping();
  console.log('ping:', JSON.stringify(ping));
  const up = await cloudinary.uploader.upload(PIXEL, { folder: 'caly-ai/_verify', public_id: `ping-${Date.now()}` });
  console.log('upload ok:', up.secure_url);
  await cloudinary.uploader.destroy(up.public_id);
  console.log('cleanup ok. CONNECTED as cloud:', process.env.CLOUDINARY_CLOUD_NAME);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
}
