// Netlify BACKGROUND Function: /.netlify/functions/generate-visualization-background
// Place in netlify/functions/ alongside prompts.js.
//
// The '-background' suffix makes Netlify run this asynchronously with a
// 15-minute budget (vs the 10-26s synchronous limit). It reads the stashed job
// from Netlify Blobs, runs the SAME gpt-image-1 edit as the original
// synchronous function, and writes the result back to Blobs for the poller.
//
// Required env: OPENAI_API_KEY, BETA_ACCESS_PASSWORD
// Required packages: openai, @netlify/blobs   (npm i openai @netlify/blobs)

const OpenAI = require('openai');
const { getStore } = require('@netlify/blobs');
const { buildCorePrompt } = require('./prompts');

// === VERBATIM from generate-visualization.js. Do not diverge this copy in isolation. ===
const SERVER_SAFETY =
  " CRITICAL: this is a medical consultation photograph, not a beauty image. Apply ONLY the single localized change described above and change nothing else. " +
  "Do NOT smooth or retouch skin, remove or soften wrinkles, even out skin tone, brighten the image, raise contrast, slim the face or jaw, " +
  "enlarge the eyes, lift the brows, change the hairstyle, or apply any beautifying, younger-looking, or filter-like effect. " +
  "Keep the apparent age and ALL age-appropriate skin texture (pores, fine lines, folds) exactly as in the original. " +
  "Preserve unchanged: identity, ethnicity and ethnic features, bone structure, hair, clothing, jewellery, expression, head angle and pose, " +
  "camera framing and crop, and lighting and background. The result must read as the SAME photograph with only the treated area subtly adjusted. " +
  "Do not add text, labels, or watermarks.";

// ⚠️ DRIFT FLAG — READ BEFORE RELYING ON SCULPTRA:
// The generate-visualization.js you sent assembles `core + SERVER_SAFETY` for ALL
// types, with no biostim branch. The believable Sculptra results depend on
// BIOSTIM_SAFETY (M2), which permits partial volume-driven fold softening that
// SERVER_SAFETY forbids. If that branch should be live, define BIOSTIM_SAFETY here
// and change the `prompt` line below to:
//   const prompt = core + (f.type === 'biostim' ? BIOSTIM_SAFETY : SERVER_SAFETY);

function checkKey(event) {
  const expected = process.env.BETA_ACCESS_PASSWORD;
  if (!expected) return false;
  const provided = event.headers['x-beta-key'] || event.headers['X-Beta-Key'] || '';
  return provided === expected;
}

exports.handler = async (event) => {
  let jobId;
  try { jobId = JSON.parse(event.body || '{}').jobId; } catch (e) { /* ignore */ }
  if (!jobId) return { statusCode: 400 };

  const store = getStore('visualize-jobs');
  const fail = async (error, code) => {
    try { await store.setJSON(jobId + ':status', { state: 'error', error, code: code || 'error', updatedAt: Date.now() }); } catch (e) { /* ignore */ }
  };

  // Background endpoints are public URLs, so re-check the key.
  if (!checkKey(event)) { await fail('Unauthorized background invocation', 'INVALID_KEY'); return { statusCode: 401 }; }

  try {
    const job = await store.get(jobId + ':job', { type: 'json' });
    if (!job) { await fail('Job payload not found (it may have expired).', 'not_found'); return { statusCode: 200 }; }

    const f = job.params || {};
    let core;
    if (f.type) {
      core = buildCorePrompt({
        type: f.type, areas: f.areas, goal: f.goal, intensity: f.intensity,
        product: f.product, projection: f.projection, timeline: f.timeline, note: f.note
      });
    } else {
      core = f.prompt || 'Create a subtle, realistic aesthetic treatment visualization.';
    }
    const prompt = core + SERVER_SAFETY;   // ← mirror of your file. See DRIFT FLAG above.

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const buffer = Buffer.from(job.imageB64, 'base64');
    const file = await OpenAI.toFile(buffer, job.filename || 'image.png', { type: job.mime || 'image/png' });

    const result = await client.images.edit({
      model: 'gpt-image-1',
      image: file,
      prompt,
      size: 'auto',
      input_fidelity: 'high',
      output_format: 'jpeg',
      output_compression: 85
    });

    const b64 = result.data && result.data[0] && result.data[0].b64_json;
    if (!b64) throw new Error('No image returned by model');

    await store.set(jobId + ':result', 'data:image/jpeg;base64,' + b64);
    await store.setJSON(jobId + ':status', { state: 'done', updatedAt: Date.now() });
    try { await store.delete(jobId + ':job'); } catch (e) { /* free the large input payload */ }
    return { statusCode: 200 };
  } catch (err) {
    const code = err && (err.code || (err.error && err.error.code));
    const msg = (err && err.message) || '';
    console.error('background generation failed:', JSON.stringify({ code, msg }));

    // Same moderation classification as the original function. The image-edit
    // endpoint is strict and cannot be turned down; lip edits are a common trigger.
    const blocked = code === 'moderation_blocked' || /safety system|moderation|not allowed/i.test(msg);
    if (blocked) {
      await fail('The AI provider blocked this specific edit under its safety system (the image-edit endpoint is strict and this cannot be turned down). Lip edits are a frequent trigger. Try a different area, or adjust the wording of the custom note.', 'moderation_blocked');
    } else {
      await fail(msg || 'Image generation failed', code || 'error');
    }
    return { statusCode: 200 };
  }
};
