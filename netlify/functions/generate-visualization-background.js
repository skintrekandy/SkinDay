// Netlify BACKGROUND Function: /.netlify/functions/generate-visualization-background
// Place in netlify/functions/ alongside prompts.js.
//
// The '-background' suffix makes Netlify run this asynchronously with a
// 15-minute budget (vs the 10-26s synchronous limit). It reads the stashed job
// from Netlify Blobs, runs the SAME gpt-image-1 edit as the original
// synchronous function, and writes the result back to Blobs for the poller.
//
// HYBRID MASKING (added): if the job carries a `maskB64`, it is passed to
// images.edit as the edit mask. gpt-image-1 then edits ONLY the transparent
// areas of the mask and leaves everything else pixel-identical to the original.
// This is what physically prevents the global beautification leak: with a mask
// the model cannot smooth skin, soften the under-eye, or slim the jaw outside
// the treated region, no matter what the prompt does. No mask = today's exact
// full-image behavior (backward compatible).
//
// Required env: OPENAI_API_KEY, BETA_ACCESS_PASSWORD
// Required packages: openai, @netlify/blobs   (npm i openai @netlify/blobs)

const OpenAI = require('openai');
const { getStore, connectLambda } = require('@netlify/blobs');
const { buildCorePrompt, CHIN_JAW_SAFETY, usesChinJawSafety } = require('./prompts');
const { logGeneration } = require('./log-generation');

// === VERBATIM from generate-visualization.js. Do not diverge this copy in isolation. ===
const SERVER_SAFETY =
  " CRITICAL: this is a medical consultation photograph, not a beauty image. Apply ONLY the single localized change described above and change nothing else. " +
  "Do NOT smooth or retouch skin, remove or soften wrinkles, even out skin tone, brighten the image, raise contrast, slim the face or jaw, " +
  "enlarge the eyes, lift the brows, change the hairstyle, or apply any beautifying, younger-looking, or filter-like effect. " +
  "Keep the apparent age and ALL age-appropriate skin texture (pores, fine lines, folds) exactly as in the original. " +
  "Preserve unchanged: identity, ethnicity and ethnic features, bone structure, hair, clothing, jewellery, expression, head angle and pose, " +
  "camera framing and crop, and lighting and background. The result must read as the SAME photograph with only the treated area subtly adjusted. " +
  "Do not add text, labels, or watermarks.";

// DRIFT FLAG (resolved below): SERVER_SAFETY is still applied to filler and hdr,
// but NOT to Sculptra by default. For a masked Sculptra run the mask contains the
// folds, so the model is allowed to soften them spatially, while the SERVER_SAFETY
// text said "do NOT soften wrinkles" and "do not slim the face or jaw" - which also
// fights the v10.1 lateral-lift design. buildSculptraPrompt is Sculptra's own, more
// specific safety base, so the generic tail is dropped for it. The [safety:server]
// note hook re-appends it for staging A/B. See the prompt-assembly block below.

function checkKey(event) {
  const expected = process.env.BETA_ACCESS_PASSWORD;
  if (!expected) return false;
  const provided = event.headers['x-beta-key'] || event.headers['X-Beta-Key'] || '';
  return provided === expected;
}

// M8: refund reserved credits when a metered generation fails (errors and
// moderation rejections alike). The `<jobId>:billing` blob is written by
// start-visualization and outlives the job payload. Idempotent end to end:
// the visualize_refund_credits RPC refuses a second refund for the same job,
// so retries and double invocations are safe. Beta-key jobs have no billing
// blob and are untouched. When the Supabase env vars are absent (beta-only
// deploy), this is a clean no-op.
async function refundIfBilled(store, jobId, note) {
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY) return;
  try {
    const billing = await store.get(jobId + ':billing', { type: 'json' });
    if (!billing || !billing.userId || !(billing.cost > 0)) return;
    const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/visualize_refund_credits', {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user: billing.userId, p_cost: billing.cost, p_job: jobId, p_note: note || 'generation failed' })
    });
    if (!res.ok) console.error('refund RPC failed: HTTP ' + res.status, (await res.text()).slice(0, 200));
    else console.log('refunded ' + billing.cost + ' credit(s) for job ' + jobId + ' (' + (note || 'generation failed') + ')');
  } catch (e) {
    console.error('refundIfBilled failed:', (e && e.message) || e);
  }
}

exports.handler = async (event) => {
  connectLambda(event); // wire Blobs context into the classic handler signature
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
    if (!job) {
      await fail('Job payload not found (it may have expired).', 'not_found');
      await refundIfBilled(store, jobId, 'job payload expired');
      return { statusCode: 200 };
    }

    const f = job.params || {};

    // SERVER_SAFETY policy (M7.5). Sculptra has its own safety base (since M4)
    // and chin/jawline filler now has its own too (CHIN_JAW_SAFETY in prompts.js,
    // v7): the generic tail's "do NOT slim the face or jaw" and "subtly adjusted"
    // were contradicting the chin/jaw content and capping the anchor, which is
    // why oblique chin/jaw came out timid. All other filler areas and hdr keep
    // the generic tail. A/B hook for staging: putting [safety:server] in the
    // note forces the generic tail back on (for Sculptra or chin/jaw) so old and
    // new can be compared on the same patient. The hook is stripped before the
    // prompt is built so it never reaches the model.
    const rawNote = (f.note != null) ? String(f.note) : '';
    const forceServerSafety = /\[safety:server\]/i.test(rawNote);
    const cleanNote = rawNote.replace(/\[safety:(server|none)\]/ig, '').replace(/\s{2,}/g, ' ').trim();

    const product = (f.type === 'biostim')
      ? (['sculptra', 'hdr'].includes(f.product) ? f.product : 'sculptra')
      : null;
    const isSculptra = product === 'sculptra';

    let core;
    if (f.type) {
      core = buildCorePrompt({
        type: f.type, areas: f.areas, goal: f.goal, intensity: f.intensity,
        product: f.product, projection: f.projection, timeline: f.timeline, note: cleanNote,
        // M11.1: these fields were added to FIELD_KEYS in start-visualization.js
        // but were not forwarded here -- causing normalizeView() to always return
        // 'frontal' and isStrongPass detection to never fire in buildSculptraPrompt.
        // All Enhanced prompt work (ENHANCED_MAGNITUDE, SCULPTRA_ENHANCED_*) was
        // being bypassed silently. Fixed here.
        isStrongPass:     f.isStrongPass,
        angle:            f.angle,
        sex:              f.sex,
        view:             f.view,
        phenotype:        f.phenotype,
        sculptraPhenotype: f.sculptraPhenotype,
      });
    } else {
      core = f.prompt || 'Create a subtle, realistic aesthetic treatment visualization.';
    }

    // Tail selection: Sculptra none, chin/jaw filler its own base, others the
    // generic tail. The [safety:server] hook forces the generic tail back on.
    const isChinJaw = usesChinJawSafety(f.type, f.areas);
    let tail;
    if (forceServerSafety) tail = SERVER_SAFETY;
    else if (isSculptra) tail = '';
    else if (isChinJaw) tail = CHIN_JAW_SAFETY;
    else tail = SERVER_SAFETY;
    const prompt = core + tail;

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const buffer = Buffer.from(job.imageB64, 'base64');
    const file = await OpenAI.toFile(buffer, job.filename || 'image.png', { type: job.mime || 'image/png' });

    const modelName = 'gpt-image-1';

    const editParams = {
      model: modelName,
      image: file,
      prompt,
      size: 'auto',
      input_fidelity: 'high',
      output_format: 'jpeg',
      output_compression: 85
    };
    if (job.maskB64) {
      const maskBuf = Buffer.from(job.maskB64, 'base64');
      editParams.mask = await OpenAI.toFile(maskBuf, 'mask.png', { type: job.maskMime || 'image/png' });
    }

    const result = await client.images.edit(editParams);

    const b64 = result.data && result.data[0] && result.data[0].b64_json;
    if (!b64) throw new Error('No image returned by model');

    await store.set(jobId + ':result', 'data:image/jpeg;base64,' + b64);
    await store.setJSON(jobId + ':status', { state: 'done', updatedAt: Date.now() });
    try { await store.delete(jobId + ':job'); } catch (e) { /* free the large input payload */ }

    // Log cost for this successful generation (non-blocking).
    try {
      const billing = await store.get(jobId + ':billing', { type: 'json' }).catch(() => null);
      await logGeneration({
        jobId,
        userId:         billing ? billing.userId : null,
        betaKeyUsed:    !billing,
        treatmentType:  f.type || null,
        angle:          f.angle || null,
        isRegen:        billing ? (billing.cost === 0) : false,
        model:          modelName,
        imageSize:      editParams.size || 'auto',
        imageQuality:   editParams.input_fidelity || 'high',
        openAIUsage:    result.usage || null,
        creditsCharged: billing ? billing.cost : null,
        referenceMode:  null,
        status:         'success',
      });
    } catch (logErr) { console.error('[logGeneration] success log failed:', logErr.message); }

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
      await refundIfBilled(store, jobId, 'moderation blocked');
      await logGeneration({ jobId, status: 'blocked', failureReason: 'moderation_blocked', model: modelName }).catch(() => {});
    } else {
      await fail(msg || 'Image generation failed', code || 'error');
      await refundIfBilled(store, jobId, (code ? String(code) : 'generation failed'));
      await logGeneration({ jobId, status: 'failed', failureReason: code || msg || 'unknown', model: modelName }).catch(() => {});
    }
    return { statusCode: 200 };
  }
};
