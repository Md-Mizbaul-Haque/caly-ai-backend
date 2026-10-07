const { v2: cloudinary } = require('cloudinary');

function cloudinaryStatus() {
  const present = {
    cloudName: !!process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: !!process.env.CLOUDINARY_API_KEY,
    apiSecret: !!process.env.CLOUDINARY_API_SECRET,
  };
  const missing = Object.entries(present)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return { configured: missing.length === 0, missing, present };
}

function connectCloudinary() {
  const { configured, missing } = cloudinaryStatus();
  if (!configured) {
    throw new Error(`Cloudinary not configured — missing: ${missing.join(', ')}`);
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  return cloudinary;
}

module.exports = { cloudinary, connectCloudinary, cloudinaryStatus };
