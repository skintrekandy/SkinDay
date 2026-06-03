// Netlify Function (SYNCHRONOUS, fast): /.netlify/functions/start-visualization
// Place in netlify/functions/ alongside prompts.js and the others.
//
// Receives the patient photo + clinician selections, stashes them in Netlify
// Blobs under a jobId, fires the background worker, and returns immediately
// (HTTP 202). The slow gpt-image-1 call runs in generate-visualization-background.js
// where it has a 15-minute budget instead of the 10-26s synchronous limit.
// This is what removes the 504s.
//
// Required env: BETA_ACCESS_PASSWORD
// Required packages: busboy, @netlify/blobs   (npm i busboy @netlify/blobs)

const Busboy = require('busboy');
const { Readable } = require('stream');
const { getStore, connectLambda } = require('@netlify/blobs');

function checkKey(event) {
  const expected = process.env.BETA_ACCESS_PASSWORD;
  if (!expected) return false; // fail closed if not configured
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

const FIELD_KEYS = ['type', 'areas', 'goal', 'intensity', 'product', 'projection', 'timeline', 'note', 'prompt'];

exports.handler = async (event) => {
  connectLambda(event); // wire Blobs context into the classic handler signature
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!checkKey(event)) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid beta access password', code: 'INVALID_KEY' }) };
  }

  try {
    const { fields, files } = await parseMultipart(event);
    const imageFile = files.image;
    if (!imageFile) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing image file' }) };
    }

    // Use the client-supplied jobId when it looks sane, else mint one.
    const jobId = (fields.jobId && /^[A-Za-z0-9._-]{8,128}$/.test(fields.jobId))
      ? fields.jobId
      : (Date.now() + '-' + Math.random().toString(36).slice(2));

    const params = {};
    FIELD_KEYS.forEach(k => { if (fields[k] != null) params[k] = fields[k]; });

    const store = getStore('visualize-jobs');

    // Full payload for the worker (image as base64). Kept separate from the
    // small status object so the poller never has to download the image.
    await store.setJSON(jobId + ':job', {
      params,
      imageB64: imageFile.buffer.toString('base64'),
      mime: imageFile.mimeType,
      filename: imageFile.filename
    });
    await store.setJSON(jobId + ':status', { state: 'pending', createdAt: Date.now() });

    // Fire the background worker. It re-reads the job from Blobs, so we send
    // only the id (background-function request bodies are capped at 256KB,
    // which the photo would exceed).
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL ||
                 ('https://' + (event.headers.host || event.headers.Host));
    const key = event.headers['x-beta-key'] || event.headers['X-Beta-Key'] || '';
    const trigger = await fetch(base + '/.netlify/functions/generate-visualization-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-beta-key': key },
      body: JSON.stringify({ jobId })
    });
    if (!(trigger.status === 202 || trigger.ok)) {
      await store.setJSON(jobId + ':status', { state: 'error', error: 'Could not enqueue the background job (HTTP ' + trigger.status + ').', updatedAt: Date.now() });
      return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Could not start the background job. Please try again.' }) };
    }

    return { statusCode: 202, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) };
  } catch (err) {
    console.error('start-visualization failed:', (err && err.message) || err);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: (err && err.message) || 'Failed to start generation' }) };
  }
};
