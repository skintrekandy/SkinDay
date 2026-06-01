// Netlify Function: /.netlify/functions/generate-visualization
// Required environment variables:
//   OPENAI_API_KEY        - OpenAI key with gpt-image-1 access
//   BETA_ACCESS_PASSWORD  - shared beta password (M1 access gate)
// Required package: npm install openai busboy

const OpenAI = require('openai');
const Busboy = require('busboy');
const { Readable } = require('stream');

// Non-negotiable constraints appended to EVERY prompt server-side, so a tampered
// client cannot strip identity/ethnicity preservation or push the model to over-promise.
const SERVER_SAFETY =
  " Strictly preserve the person's identity, age, ethnicity and ethnic features, bone structure, " +
  "hairstyle, age-appropriate skin texture, clothing, expression, head angle, lighting, and background. " +
  "Do not de-age the person. Do not Westernise facial features. Do not change makeup, jewellery, or pose. " +
  "Do not add any text, labels, watermarks, or arrows. Output a single clean photographic portrait. " +
  "Keep the change subtle and clinically realistic; under-promise rather than over-promise. " +
  "This is a consultation visualization, not a guaranteed result.";

function unauthorized(msg) {
  return {
    statusCode: 401,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: msg || 'Invalid beta access password', code: 'INVALID_KEY' })
  };
}

function checkKey(event) {
  const expected = process.env.BETA_ACCESS_PASSWORD;
  if (!expected) return false; // fail closed if the env var is not configured
  const provided = event.headers['x-beta-key'] || event.headers['X-Beta-Key'] || '';
  return provided === expected;
}

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = {};
    const busboy = Busboy({ headers: event.headers });

    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('file', (name, file, info) => {
      const chunks = [];
      file.on('data', chunk => chunks.push(chunk));
      file.on('end', () => {
        files[name] = {
          buffer: Buffer.concat(chunks),
          filename: info.filename || 'image.png',
          mimeType: info.mimeType || 'image/png'
        };
      });
    });
    busboy.on('error', reject);
    busboy.on('finish', () => resolve({ fields, files }));

    const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body || '');
    Readable.from(body).pipe(busboy);
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Gate everything on the beta password first.
  if (!checkKey(event)) return unauthorized();

  const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';

  // Lightweight verify call from the lock screen: { action: 'verify' }
  if (contentType.includes('application/json')) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };
  }

  try {
    const { fields, files } = await parseMultipart(event);
    const imageFile = files.image;
    if (!imageFile) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing image file' }) };
    }

    const clientPrompt = fields.prompt || 'Create a subtle, realistic aesthetic treatment visualization.';
    const prompt = clientPrompt + SERVER_SAFETY;

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const file = await OpenAI.toFile(imageFile.buffer, imageFile.filename, { type: imageFile.mimeType });

    const result = await client.images.edit({
      model: 'gpt-image-1',
      image: file,
      prompt,
      size: '1024x1024'
    });

    const b64 = result.data && result.data[0] && result.data[0].b64_json;
    if (!b64) throw new Error('No image returned by model');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: `data:image/png;base64,${b64}` })
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Image generation failed' })
    };
  }
};
