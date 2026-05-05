// netlify/functions/studio-detect.js
// Server-side face detection using @vladmandic/face-api
// Returns crop fractions { t, b, l, r } for a given base64 JPEG image
//
// Install: npm install @vladmandic/face-api canvas
// Model files: download to netlify/functions/models/ from
//   https://github.com/vladmandic/face-api/tree/master/model
// Required model files:
//   - ssd_mobilenetv1_model-weights_manifest.json + shard files
//   - face_landmark_68_model-weights_manifest.json + shard files

const path = require('path');

// Lazy-load to keep cold starts fast
let faceapi, canvas, initialized = false;

async function init() {
  if (initialized) return;

  // node-canvas polyfill required by face-api in Node
  const { Canvas, Image, ImageData } = require('canvas');
  canvas = require('canvas');
  faceapi = require('@vladmandic/face-api');

  // Patch face-api to use node-canvas
  faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

  const modelsPath = path.join(__dirname, 'models');
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsPath),
    faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath),
  ]);

  initialized = true;
}

// Convert landmark bounding box → crop fractions with padding
function boxToFractions(detection, imgW, imgH, region = 'lower') {
  const box  = detection.detection.box;
  const lms  = detection.landmarks.positions; // 68 points

  // Key landmarks (68-point model)
  // Jaw: 0–16, Nose bridge: 27–30, Nose tip: 33, Chin: 8
  // Left eye outer: 36, Right eye outer: 45
  const chin    = lms[8];
  const noseTip = lms[33];
  const lEyeOut = lms[36];
  const rEyeOut = lms[45];
  const jawL    = lms[0];
  const jawR    = lms[16];

  const faceH = chin.y - lEyeOut.y;
  const cx    = (lEyeOut.x + rEyeOut.x) / 2;
  const halfW = (jawR.x - jawL.x) * 0.62;

  let top, bottom;

  if (region === 'lower') {
    top    = noseTip.y - faceH * 0.08;
    bottom = chin.y   + faceH * 0.32;
  } else if (region === 'mid') {
    top    = noseTip.y - faceH * 0.22;
    bottom = chin.y   + faceH * 0.28;
  } else {
    // full
    top    = lEyeOut.y - faceH * 0.48;
    bottom = chin.y    + faceH * 0.22;
  }

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  return {
    t: clamp(top    / imgH, 0,   0.88),
    b: clamp(bottom / imgH, 0.1, 1.0),
    l: clamp((cx - halfW) / imgW, 0,   0.58),
    r: clamp((cx + halfW) / imgW, 0.42, 1.0),
  };
}

exports.handler = async (event) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    await init();

    const { image, region = 'lower' } = JSON.parse(event.body);
    if (!image) throw new Error('No image provided');

    // Decode base64 → canvas Image
    const buf = Buffer.from(image, 'base64');
    const img = await canvas.loadImage(buf);

    // Detect face + landmarks
    const detection = await faceapi
      .detectSingleFace(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4 }))
      .withFaceLandmarks();

    if (!detection) {
      // No face detected — return null so frontend uses fallback
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ detected: false }),
      };
    }

    const crop = boxToFractions(detection, img.width, img.height, region);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ detected: true, ...crop }),
    };

  } catch (err) {
    console.error('studio-detect error:', err);
    return {
      statusCode: 200, // Return 200 with detected:false so frontend gracefully falls back
      headers,
      body: JSON.stringify({ detected: false, error: err.message }),
    };
  }
};
