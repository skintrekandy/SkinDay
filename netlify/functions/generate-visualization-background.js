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
// M12 CLINIC LIBRARY: reference-guided generation.
//   Reference image lookup fires for every biostim (Sculptra) generation.
//   Fallback chain:
//     1. Clinic's own approved reference case matching angle (and phenotype if
//        tagged). Best match = same phenotype first, then match-any.
//     2. Global gold reference (VISUALIZE_GOLD_REF_FRONTAL / _R45 / _L45 env
//        vars), each pointing to a public URL of a clean before/after pair.
//        When a gold ref env var is set, its after-image URL is fetched and
//        passed as image[1] alongside the patient photo (image[0]).
//     3. Single-image text-only (current behavior, unchanged).
//   The reference is passed as the SECOND element of the image array. The model
//   uses it for visual grammar (volume character, lighting, skin character) only;
//   it does NOT copy the reference face, because image[0] is the patient photo
//   and the prompt explicitly locks identity. This is the foundation for Enhanced.
//   referenceMode in the generation log records which branch fired:
//   'clinic_case', 'gold_ref', or null (single-image fallback).
//
// Required env: OPENAI_API_KEY, BETA_ACCESS_PASSWORD
// Optional env for clinic library:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (already present for billing)
// Optional env for global gold refs:
//   VISUALIZE_GOLD_REF_FRONTAL  (public URL of after-image)
//   VISUALIZE_GOLD_REF_R45      (public URL of after-image)
//   VISUALIZE_GOLD_REF_L45      (public URL of after-image)
// Required packages: openai, @netlify/blobs   (npm i openai @netlify/blobs)

const OpenAI = require('openai');
const { getStore, connectLambda } = require('@netlify/blobs');
const { buildCorePrompt, CHIN_JAW_SAFETY, usesChinJawSafety, buildScenarioPrompt } = require('./prompts');
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

// M12: map the angle field (r45, l45, frontal, oblique_right, oblique_left, oblique)
// to the canonical three-token set used by the reference lookup and gold-ref env vars.
function canonicalAngle(raw) {
  const a = String(raw || '').toLowerCase().trim();
  if (a === 'r45' || a === 'right45' || a === 'oblique_right') return 'oblique_right';
  if (a === 'l45' || a === 'left45'  || a === 'oblique_left')  return 'oblique_left';
  return 'frontal'; // default
}

// M12: injected into the prompt whenever a reference image is passed.
// CRITICAL: gpt-image-1 requires explicit indexing when multiple images are
// provided -- it will ignore image[1] unless the prompt references it directly.
// The identity lock is equally critical: the reference is for treatment pattern
// only, never identity, skin, age, or ethnicity.
const REFERENCE_IDENTITY_LOCK =
  ' TWO IMAGES ARE PROVIDED. Image 1 is the patient to treat. Image 2 is a clinical reference showing a successful Sculptra biostimulator result.' +
  ' Use Image 2 ONLY to understand the visual character of the treatment result: the degree of cheek volume, midface support, lateral lift, and soft-tissue re-inflation.' +
  ' Apply that same degree and character of volume change to Image 1 (the patient).' +
  ' Do NOT copy, borrow, or be influenced by the reference patient\'s identity, face shape, skin tone, ethnicity, age, skin texture, pigmentation, hair, expression, lighting, or any personal feature.' +
  ' The output must show Image 1 (the actual patient) with the Sculptra treatment applied at the visual intensity shown in Image 2.' +
  ' Image 2 is a style and volume guide only -- never an identity donor.';

// M12: look up the best approved clinic reference case for this generation.
// Returns { beforePath, afterPath } or null.
// Match priority: (sex + phenotype) > (sex only) > (phenotype only) > untagged > any.
async function fetchClinicReferenceCase(clinicId, treatmentArea, angle, phenotype, sex) {
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY || !clinicId) return null;

  try {
    const qs = new URLSearchParams({
      select:         'id,before_path,after_path,phenotype,sex,sort_order',
      clinic_id:      'eq.' + clinicId,
      treatment_area: 'eq.' + treatmentArea,
      angle:          'eq.' + angle,
      approved:       'eq.true',
      order:          'sort_order.asc,created_at.asc',
      limit:          '10'
    });
    const res = await fetch(SUPABASE_URL + '/rest/v1/clinic_reference_cases?' + qs.toString(), {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    if (!res.ok) {
      console.warn('[M12] clinic case lookup failed: HTTP ' + res.status);
      return null;
    }
    const rows = await res.json();
    if (!rows || !rows.length) return null;

    // Match priority: sex+phenotype > sex-only > phenotype-only > untagged > any.
    const chosen =
      rows.find(r => r.sex === sex && r.phenotype === phenotype)   ||
      rows.find(r => r.sex === sex && !r.phenotype)                ||
      rows.find(r => !r.sex        && r.phenotype === phenotype)   ||
      rows.find(r => !r.sex        && !r.phenotype)                ||
      rows[0];

    console.log('[M12] clinic reference chosen: id=' + chosen.id
      + ' phenotype=' + (chosen.phenotype || 'any')
      + ' sex=' + (chosen.sex || 'any'));
    return { beforePath: chosen.before_path, afterPath: chosen.after_path };
  } catch (e) {
    console.warn('[M12] fetchClinicReferenceCase error:', (e && e.message) || e);
    return null;
  }
}

// M12: generate a signed URL for a Storage object (service role, 300-second TTL).
// The signed URL is fetched at generation time, not stored, so the path is durable
// and the URL is ephemeral. 300 s is more than enough for a single generation.
async function signedStorageUrl(path) {
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY || !path) return null;
  try {
    const res = await fetch(
      SUPABASE_URL + '/storage/v1/object/sign/reference-cases/' + encodeURIComponent(path),
      {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 300 })
      }
    );
    if (!res.ok) { console.warn('[M12] sign URL failed: HTTP ' + res.status); return null; }
    const j = await res.json();
    return (j && j.signedURL) ? (SUPABASE_URL + j.signedURL) : null;
  } catch (e) {
    console.warn('[M12] signedStorageUrl error:', (e && e.message) || e);
    return null;
  }
}

// M12: fetch an image from a URL and return an OpenAI.toFile object.
// Used for both clinic reference cases (signed Storage URLs) and gold ref URLs.
// Returns null on any failure so the caller can fall through to single-image mode.
async function fetchReferenceFile(url, filename) {
  try {
    const res = await fetch(url);
    if (!res.ok) { console.warn('[M12] reference image fetch failed: HTTP ' + res.status + ' ' + url.slice(0, 80)); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    const ct  = res.headers.get('content-type') || 'image/jpeg';
    return await OpenAI.toFile(buf, filename || 'reference.jpg', { type: ct });
  } catch (e) {
    console.warn('[M12] fetchReferenceFile error:', (e && e.message) || e);
    return null;
  }
}

// M12: resolve the reference image file for a generation.
// Returns { refFile, referenceMode } or { refFile: null, referenceMode: null }.
// referenceMode values: 'clinic_case' | 'gold_ref' | null
//
// CRITICAL SCOPE RULE: reference lookup fires ONLY for Enhanced (isStrongPass === 'true')
// Sculptra generations. Standard pass is never reference-guided -- this preserves the
// Standard pass as a known-good, reproducible baseline and ensures the reference
// mechanism is introduced only when its output has been validated.
// Gold refs (env var fallback) are also Enhanced-only for the same reason.
async function resolveReference(f, billing) {
  const isSculptra  = f.type === 'biostim' && (f.product === 'sculptra' || !f.product);
  const isEnhanced  = f.isStrongPass === 'true' || f.isStrongPass === true;
  console.log('[M12] resolveReference: isSculptra=' + isSculptra + ' isEnhanced=' + isEnhanced + ' isStrongPass=' + JSON.stringify(f.isStrongPass));
  if (!isSculptra || !isEnhanced) return { refFile: null, referenceMode: null };

  const angle         = canonicalAngle(f.angle || f.view);
  const phenotype     = f.phenotype || f.sculptraPhenotype || null;
  const sex           = f.sex || null;
  const treatmentArea = 'sculptra'; // Enhanced Sculptra is always sculptra area
  const clinicId      = billing ? billing.userId : null;

  // --- Branch 1: clinic's own library ---
  if (clinicId) {
    const caseRow = await fetchClinicReferenceCase(clinicId, treatmentArea, angle, phenotype, sex);
    if (caseRow) {
      const afterUrl = await signedStorageUrl(caseRow.afterPath);
      if (afterUrl) {
        const refFile = await fetchReferenceFile(afterUrl, 'clinic_ref_after.jpg');
        if (refFile) {
          console.log('[M12] reference mode: clinic_case (angle=' + angle + ')');
          return { refFile, referenceMode: 'clinic_case' };
        }
      }
    }
  }

  // --- Branch 2: global gold refs (Enhanced fallback only) ---
  // Gold refs are useful for testing Enhanced before a clinic has uploaded cases.
  // They are NOT used for Standard -- keeping Standard clean is the standing rule.
  const GOLD_REF_URLS = {
    frontal:       process.env.VISUALIZE_GOLD_REF_FRONTAL || '',
    oblique_right: process.env.VISUALIZE_GOLD_REF_R45     || '',
    oblique_left:  process.env.VISUALIZE_GOLD_REF_L45     || ''
  };
  const goldUrl = GOLD_REF_URLS[angle] || '';
  console.log('[M12] gold ref URL for angle=' + angle + ': ' + (goldUrl ? goldUrl.slice(0, 60) + '...' : 'NOT SET'));
  if (goldUrl) {
    const refFile = await fetchReferenceFile(goldUrl, 'gold_ref.jpg');
    if (refFile) {
      console.log('[M12] reference mode: gold_ref (angle=' + angle + ')');
      return { refFile, referenceMode: 'gold_ref' };
    }
  }

  // --- Branch 3: Enhanced without a reference --- single-image fallback.
  // Still runs Enhanced prompt (ENHANCED_MAGNITUDE) but without a reference image.
  console.log('[M12] reference mode: null (Enhanced single-image fallback)');
  return { refFile: null, referenceMode: null };
}

// M12.5: SCENARIO PLANNER
// Analyzes both the original photo and the Visualize baseline using a vision
// text model, then returns a case-specific image generation prompt tailored
// to this patient's anatomy and the selected scenario.
//
// The planner looks at the actual face and decides what this specific case
// needs -- the same judgment an experienced injector makes. This replaces the
// static scenario templates for the listed scenarios and is the key quality
// improvement that bridges the gap between a fixed prompt library and adaptive
// clinical reasoning.
//
// Provider abstraction: SCENARIO_PLANNER_PROVIDER env var controls which model
// runs the planner (default 'openai', future option 'anthropic'). Currently
// only 'openai' is implemented; the abstraction makes A/B testing easy later.
//
// The planner prompt is careful to:
//   - Lead with what MUST be preserved (identity, skin, lighting, features)
//   - Analyze what the baseline already achieved
//   - Describe only the additional change this scenario adds
//   - Return a compact, specific image prompt rather than a long generic one
//
// Falls back to the static scenario prompt on any failure.

const SCENARIO_PLANNER_SYSTEM = `You are a clinical aesthetics AI assistant helping to generate precise image-editing prompts for an aesthetic medicine consultation tool. 
You will receive two medical consultation photos of the same patient and a scenario type. Your job is to analyze the patient's face and produce a tailored, specific image prompt for the scenario.

Rules you must follow without exception:
- You write prompts for an image edit model, not for a human. Be direct and specific.
- Always lead with absolute prohibitions: what must not change. This is the most important part.
- The output image must show the exact same person: same identity, same skin tone, same apparent age, same skin texture, same pores, same asymmetry, same hair, same clothing, same expression, same head angle, same lighting, same background.
- Do not allow any brightening, smoothing, skin retouching, eye enlargement, brow lift, lip change, nose change, or any beautification.
- Describe only the structural change the scenario adds. Be specific about location and magnitude.
- Keep the prompt under 350 words. Shorter is better if precise.
- Return only the image prompt text. No preamble, no explanation, no JSON, no markdown.`;

const SCENARIO_PLANNER_USER = {
  stronger_sculptra: `TWO IMAGES:
Image 1 = the Visualize baseline (already shows a moderate Sculptra biostimulator response).
Image 2 = the original pre-treatment photo.

Scenario: Stronger Sculptra response -- upper-range lateral collagen support built on top of the baseline.

Analyze:
- What the baseline already achieved (compare Image 1 vs Image 2)
- What specific lateral support this patient's face still needs beyond the baseline
- What areas must stay completely unchanged

Then write a precise image editing prompt that:
1. Opens with absolute identity and feature preservation rules
2. Describes only the additional lateral cheek/temple/prejowl support needed for THIS face specifically
3. States that the change must be subtle and diffuse -- if the choice is between too much and too little, choose too little
4. Explicitly prohibits averaging back toward Image 2

Do not describe a "comprehensive" or "dramatic" change. This is one step beyond the baseline, not a full transformation.`,

  add_chin_jaw_filler: `TWO IMAGES:
Image 1 = the Visualize baseline (already shows a Sculptra biostimulator response).
Image 2 = the original pre-treatment photo.

Scenario: Add chin and jawline HA filler on top of the Sculptra baseline.

Analyze:
- This patient's lower-face anatomy: chin projection, mandibular border definition, prejowl support, face shape (oval, round, square)
- Whether this is a male or female face (chin shape target differs significantly)
- What specific lower-face structural improvements would be clinically appropriate

Then write a precise image editing prompt that:
1. Opens with absolute identity and feature preservation rules for all areas ABOVE the lower third
2. Describes the specific lower-face structural change: chin projection, jawline definition, prejowl support
3. States the correct chin shape goal for this patient's sex and face type
4. Prohibits any change to midface, cheeks, temples, eyes, brows, nose, lips`,

  add_temple_support: `TWO IMAGES:
Image 1 = the Visualize baseline (already shows a Sculptra biostimulator response).
Image 2 = the original pre-treatment photo.

Scenario: Add focused temple volume on top of the Sculptra baseline.

Analyze:
- Whether this patient shows temporal hollowing or flat temple contour
- The temple-to-cheek transition in the baseline vs the original
- How much improvement is appropriate without over-filling

Then write a precise image editing prompt that:
1. Opens with absolute identity and feature preservation rules
2. Describes only the temporal hollow fill and forehead-to-cheek continuity improvement
3. States the change must look like soft tissue returning, not a localized lump
4. Prohibits any change below the zygomatic arch and any change to eyes, brows, or upper eyelid`,

  combination_plan: `TWO IMAGES:
Image 1 = the Visualize baseline (already shows a Sculptra biostimulator response).
Image 2 = the original pre-treatment photo.

Scenario: Full combination treatment -- Sculptra support increase + chin/jaw HA filler + temple volume.

Analyze:
- What the baseline already achieved
- What three specific localized additions would make the strongest clinical impression for THIS patient
- What the patient's dominant concerns appear to be based on anatomy (hollowing, descent, lower-face balance, temple, etc.)

Then write a precise image editing prompt that:
1. Opens with absolute identity and feature preservation rules
2. Describes three numbered localized changes, each specific to this patient's anatomy
3. Keeps each change proportionate -- together they should read as "comprehensive support" not "different person"
4. States that identity, skin, expression, and all untreated features must be identical to Image 1
5. Prohibits skin smoothing, brightening, and global beautification`
};

async function runScenarioPlanner({ client, scenarioKey, view, sex, angle, baselineB64, baseMime, originalB64, origMime, staticFallback, provider }) {
  const userTemplate = SCENARIO_PLANNER_USER[scenarioKey];
  if (!userTemplate) {
    console.warn('[M12.5] no planner template for scenarioKey=' + scenarioKey + ', using static fallback');
    return staticFallback;
  }

  // Build vision message content
  const isOblique = (view === 'oblique_left' || view === 'oblique_right' || view === 'l45' || view === 'r45' || view === 'oblique');
  const viewNote = isOblique
    ? '\n\nVIEW NOTE: These are three-quarter oblique photos. Preserve the exact head angle, crop, and perspective. Do not rotate toward frontal.'
    : '\n\nVIEW NOTE: These are frontal photos. Preserve the exact frontal pose and head position.';

  const sexNote = sex ? ('\n\nPATIENT SEX: ' + sex + '. This affects chin shape goals and aesthetic targets.') : '';

  const userContent = [
    { type: 'text', text: userTemplate + viewNote + sexNote }
  ];

  // Attach baseline image (Image 1)
  userContent.push({
    type: 'image_url',
    image_url: { url: 'data:' + (baseMime || 'image/jpeg') + ';base64,' + baselineB64, detail: 'high' }
  });

  // Attach original image (Image 2) if available
  if (originalB64) {
    userContent.push({
      type: 'image_url',
      image_url: { url: 'data:' + (origMime || 'image/jpeg') + ';base64,' + originalB64, detail: 'high' }
    });
  }

  // Currently only OpenAI provider is implemented.
  // To add Anthropic: check provider === 'anthropic' and use Anthropic SDK here.
  if (provider !== 'openai') {
    console.warn('[M12.5] provider=' + provider + ' not implemented, falling back to openai');
  }

  const plannerModel = process.env.SCENARIO_PLANNER_MODEL || 'gpt-4o';
  const response = await client.chat.completions.create({
    model: plannerModel,
    max_tokens: 500,
    messages: [
      { role: 'system', content: SCENARIO_PLANNER_SYSTEM },
      { role: 'user', content: userContent }
    ]
  });

  const plannerPrompt = response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content;
  if (!plannerPrompt || plannerPrompt.trim().length < 50) {
    console.warn('[M12.5] planner returned empty/short response, using static fallback');
    return staticFallback;
  }

  console.log('[M12.5] planner prompt (' + plannerPrompt.length + ' chars): ' + plannerPrompt.slice(0, 120) + '…');
  return plannerPrompt.trim();
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

    // M12.2: SCENARIO MODE
    // When f.scenarioMode === 'true', bypass the standard prompt-assembly path.
    // The scenario prompt is built here from f.scenarioKey + f.view.
    // Input: TWO images -- image[0] = simulated baseline, image[1] = original photo.
    // The original photo keeps identity and skin texture anchored across the scenario.
    // No mask is applied (full-frame scenario generation). 1 credit per scenario.
    // Safety tail: none -- the scenario prompts carry their own complete safety base.
    const isScenario = (f.scenarioMode === 'true' || f.scenarioMode === true);
    if (isScenario) {
      const scenarioKey = f.scenarioKey;
      if (!scenarioKey) {
        await fail('Scenario mode missing scenarioKey', 'bad_request');
        await refundIfBilled(store, jobId, 'missing scenarioKey');
        return { statusCode: 200 };
      }

      let staticPrompt;
      try {
        staticPrompt = buildScenarioPrompt(scenarioKey, f.view || 'frontal');
      } catch (e) {
        await fail('Invalid scenario key: ' + scenarioKey, 'bad_request');
        await refundIfBilled(store, jobId, 'invalid scenarioKey');
        return { statusCode: 200 };
      }

      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      // image[0]: simulated baseline (primary edit target -- the treatment anchor)
      const baselineBuffer = Buffer.from(job.imageB64, 'base64');
      const baselineFile = await OpenAI.toFile(baselineBuffer, job.filename || 'baseline.jpg', { type: job.mime || 'image/jpeg' });

      // image[1]: original patient photo (identity + skin texture reference)
      // Stored in job.originalImageB64 by start-visualization for scenario jobs.
      let imageArray = [baselineFile];
      let origB64ForPlanner = null;
      if (job.originalImageB64) {
        try {
          const origBuffer = Buffer.from(job.originalImageB64, 'base64');
          const origFile = await OpenAI.toFile(origBuffer, 'original.jpg', { type: job.originalMime || 'image/jpeg' });
          imageArray = [baselineFile, origFile];
          origB64ForPlanner = job.originalImageB64;
          console.log('[M12.2] scenario: two-image input (baseline + original)');
        } catch (e) {
          console.warn('[M12.2] scenario: original image load failed; falling back to baseline-only.', e && e.message);
        }
      } else {
        console.log('[M12.2] scenario: no originalImageB64; single-image fallback');
      }

      // M12.5: SCENARIO PLANNER
      // Before generating the image, run a vision-capable text model to analyze
      // both images and produce a case-specific scenario prompt. This replaces the
      // static template for the specified scenarios and is the key quality improvement
      // over a fixed prompt. Falls back to staticPrompt on any error so generation
      // is never blocked. Provider is controlled by SCENARIO_PLANNER_PROVIDER env var
      // (default 'openai') so it can be swapped to 'anthropic' for A/B testing later.
      const PLANNER_SCENARIOS = ['stronger_sculptra', 'combination_plan', 'add_chin_jaw_filler', 'add_temple_support'];
      const plannerProvider = process.env.SCENARIO_PLANNER_PROVIDER || 'openai';
      let scenarioPrompt = staticPrompt;
      let plannerUsed = false;

      if (PLANNER_SCENARIOS.includes(scenarioKey) && job.imageB64) {
        try {
          scenarioPrompt = await runScenarioPlanner({
            client,
            scenarioKey,
            view: f.view || 'frontal',
            sex: f.sex || null,
            angle: f.angle || null,
            baselineB64: job.imageB64,
            baseMime: job.mime || 'image/jpeg',
            originalB64: origB64ForPlanner,
            origMime: job.originalMime || 'image/jpeg',
            staticFallback: staticPrompt,
            provider: plannerProvider
          });
          plannerUsed = true;
          console.log('[M12.5] planner succeeded for ' + scenarioKey + ' (provider=' + plannerProvider + ')');
        } catch (planErr) {
          console.warn('[M12.5] planner failed, using static prompt fallback:', (planErr && planErr.message) || planErr);
          scenarioPrompt = staticPrompt;
          plannerUsed = false;
        }
      }

      const SCENARIO_FIDELITY = {
        stronger_sculptra:   'high',
        combination_plan:    'high',
        add_chin_jaw_filler: 'high',
        add_temple_support:  'high'
      };
      const scenarioParams = {
        model: 'gpt-image-1',
        image: imageArray.length === 1 ? imageArray[0] : imageArray,
        prompt: scenarioPrompt,
        size: 'auto',
        input_fidelity: SCENARIO_FIDELITY[scenarioKey] || 'high',
        output_format: 'jpeg',
        output_compression: 85
      };
      // No mask for scenario generations.

      const billing = await store.get(jobId + ':billing', { type: 'json' }).catch(() => null);

      let scenarioResult;
      try {
        scenarioResult = await client.images.edit(scenarioParams);
      } catch (err) {
        const code = err && (err.code || (err.error && err.error.code));
        const msg = (err && err.message) || '';
        const blocked = code === 'moderation_blocked' || /safety system|moderation|not allowed/i.test(msg);
        if (blocked) {
          await fail('The AI provider blocked this scenario edit under its safety system. Try a different photo or scenario.', 'moderation_blocked');
          await refundIfBilled(store, jobId, 'moderation blocked');
          await logGeneration({ jobId, status: 'blocked', failureReason: 'moderation_blocked', model: 'gpt-image-1' }).catch(() => {});
        } else {
          await fail(msg || 'Scenario generation failed', code || 'error');
          await refundIfBilled(store, jobId, code ? String(code) : 'scenario generation failed');
          await logGeneration({ jobId, status: 'failed', failureReason: code || msg || 'unknown', model: 'gpt-image-1' }).catch(() => {});
        }
        return { statusCode: 200 };
      }

      const b64 = scenarioResult.data && scenarioResult.data[0] && scenarioResult.data[0].b64_json;
      if (!b64) {
        await fail('No image returned for scenario', 'no_image');
        await refundIfBilled(store, jobId, 'no image returned');
        return { statusCode: 200 };
      }

      await store.set(jobId + ':result', 'data:image/jpeg;base64,' + b64);
      await store.setJSON(jobId + ':status', { state: 'done', updatedAt: Date.now() });
      try { await store.delete(jobId + ':job'); } catch (e) { /* free payload */ }

      try {
        await logGeneration({
          jobId,
          userId: billing ? billing.userId : null,
          betaKeyUsed: !billing,
          treatmentType: 'scenario',
          angle: f.angle || null,
          isRegen: false,
          model: 'gpt-image-1',
          imageSize: scenarioParams.size || 'auto',
          imageQuality: scenarioParams.input_fidelity,
          scenarioKey,
          plannerUsed,
          plannerProvider: plannerUsed ? plannerProvider : null,
          rawScenarioMode: f.rawScenarioMode || null,
          openAIUsage: scenarioResult.usage || null,
          creditsCharged: billing ? billing.cost : null,
          referenceMode: null,
          status: 'success',
        });
      } catch (logErr) { console.error('[logGeneration] scenario success log failed:', logErr.message); }

      return { statusCode: 200 };
    }

    // ── Standard / Enhanced generation path (unchanged below) ──
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
        isStrongPass:     f.isStrongPass,
        angle:            f.angle,
        sex:              f.sex,
        view:             f.view,
        phenotype:        f.phenotype,
        sculptraPhenotype: f.sculptraPhenotype,
        patientAge:       f.patientAge ? parseInt(f.patientAge, 10) : null,
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
    const file   = await OpenAI.toFile(buffer, job.filename || 'image.png', { type: job.mime || 'image/png' });

    // M12: resolve reference image (clinic library > gold refs > null).
    // Fires only for Enhanced Sculptra. Standard always runs single-image.
    // Read billing now so resolveReference can use userId as clinic_id without
    // a second blob fetch in the log block below.
    const billing = await store.get(jobId + ':billing', { type: 'json' }).catch(() => null);
    const { refFile, referenceMode } = await resolveReference(f, billing);

    // M12: when a reference fires, append the identity-lock clause to the prompt.
    // This is the guardrail that prevents the reference patient's identity, age,
    // skin, and ethnicity from bleeding into the output.
    const finalPrompt = (refFile && referenceMode) ? (prompt + REFERENCE_IDENTITY_LOCK) : prompt;

    const modelName = 'gpt-image-1';

    // input_fidelity policy (M12.1):
    //   - Chin/jaw filler at OBLIQUE angles uses 'low': the structural lower-face
    //     contour change requires the model to diverge from the input geometry, and
    //     the CHIN_JAW_OBLIQUE_FRAMING prompt now leads with anti-rebuild language
    //     to compensate. Using 'high' at oblique was over-anchoring and suppressing
    //     all lower-face change.
    //   - Chin/jaw filler at FRONTAL uses 'high': frontal identity is well-preserved
    //     by the prompt and compositor; 'low' was causing the model to beautify/
    //     relight the whole face at frontal (regression introduced in M12).
    //   - All other treatments (Sculptra, HDR, other filler) use 'high'.
    const isChinJawFiller = isChinJaw && f.type === 'filler';
    const isOblique = canonicalAngle(f.angle || f.view) !== 'frontal';
    const editParams = {
      model:              modelName,
      image:              file,
      prompt:             finalPrompt,
      size:               'auto',
      input_fidelity:     (isChinJawFiller && isOblique) ? 'low' : 'high',
      output_format:      'jpeg',
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
        referenceMode,  // M12: 'clinic_case' | 'gold_ref' | null
        status:         'success',
      });
    } catch (logErr) { console.error('[logGeneration] success log failed:', logErr.message); }

    return { statusCode: 200 };
  } catch (err) {
    const code = err && (err.code || (err.error && err.error.code));
    const msg  = (err && err.message) || '';
    console.error('background generation failed:', JSON.stringify({ code, msg }));

    // Same moderation classification as the original function. The image-edit
    // endpoint is strict and cannot be turned down; lip edits are a common trigger.
    const blocked = code === 'moderation_blocked' || /safety system|moderation|not allowed/i.test(msg);
    if (blocked) {
      await fail('The AI provider blocked this specific edit under its safety system (the image-edit endpoint is strict and this cannot be turned down). Lip edits are a frequent trigger. Try a different area, or adjust the wording of the custom note.', 'moderation_blocked');
      await refundIfBilled(store, jobId, 'moderation blocked');
      await logGeneration({ jobId, status: 'blocked', failureReason: 'moderation_blocked', model: 'gpt-image-1' }).catch(() => {});
    } else {
      await fail(msg || 'Image generation failed', code || 'error');
      await refundIfBilled(store, jobId, (code ? String(code) : 'generation failed'));
      await logGeneration({ jobId, status: 'failed', failureReason: code || msg || 'unknown', model: 'gpt-image-1' }).catch(() => {});
    }
    return { statusCode: 200 };
  }
};
