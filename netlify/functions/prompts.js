// SkinDay Visualize — Treatment Prompt Library
// ---------------------------------------------------------------------------
// This file is the clinical brain of the generator. It turns the clinician's
// selections (treatment, area, goal, intensity) into the CORE instruction sent
// to the image model. The universal safety/identity constraints live separately
// in generate-visualization.js (SERVER_SAFETY) and are appended after this.
//
// Design rules (learned from real patient output):
//   1. Lead with PROHIBITIONS. The model is fixed by what we forbid, not by
//      describing the desired outcome — words like "mild definition" get read
//      through its beautify-everything prior, so each module names the specific
//      drift to block (e.g. Sculptra over-lift, superhero jawline).
//   2. Keep the ASSEMBLED prompt tight. gpt-image-1 follows only a handful of
//      lines; a wall of text washes the important ones out. Each module is one
//      "expected" clause + one "avoid" clause.
//   3. Magnitude is set by the intensity/projection module, not by adjectives
//      scattered through the area modules.
//
// To tune a treatment: edit ONLY its entry below, bump the version note, redeploy.
// Versions are tracked per indication so we can see what changed.
// ---------------------------------------------------------------------------

const BASE_FRAMING =
  'Simulate a realistic aesthetic-medicine outcome for this consultation photo, ' +
  'consistent with a conservative real-world result from an experienced injector.';

// ---- Filler: per-area modules (v1) ----------------------------------------
// expected: the real change this area produces.  avoid: the drift to block.
const FILLER_AREAS = {
  chin: {
    expected: 'slightly more chin projection and a better-balanced lower-face profile',
    avoid: 'do not lengthen the chin, do not make it pointed or jutting, do not alter the lips or mouth'
  },
  jawline: {
    expected: 'subtle definition along the lower mandibular border with slight prejowl support',
    avoid: 'do not create a sharp, angular, or "superhero" jawline, do not slim the cheeks, do not change the neck'
  },
  nose: {
    expected: 'smooth one small dorsal bump on the nasal bridge and slightly straighten the side profile (liquid rhinoplasty)',
    avoid: 'do not narrow the nostrils, do not shorten or rotate the tip, do not reduce overall nose size'
  },
  lips: {
    expected: 'a small, even increase in lip volume that keeps the natural lip shape and proportion',
    avoid: 'do not evert, flatten, or shelf the lip, do not create a "duck" shape, do not over-fill, do not move the lip border or cupid\'s bow'
  },
  cheeks: {
    expected: 'subtle midface and cheekbone support restoring a little natural fullness',
    avoid: 'do not create high, sharp, or overfilled "pillow" cheeks, do not lift the face, do not change the under-eye or smile'
  },
  tear_trough: {
    expected: 'slightly soften the under-eye hollow so the area looks a little less shadowed',
    avoid: 'do not erase the hollow completely, do not puff or overfill under the eye, do not brighten, smooth, or retouch away dark circles'
  }
};

// ---- Filler: goal modifiers (v1) ------------------------------------------
const GOALS = {
  natural_refinement: 'Keep the overall effect minimal and natural.',
  facial_balancing:   'Aim only for slightly improved proportion between the treated areas.',
  masculinization:    'Bias the treated areas toward a slightly more angular, defined contour.',
  feminization:       'Bias the treated areas toward a slightly softer contour.',
  rejuvenation:       'Aim for a slightly more rested look produced ONLY by the selected filler areas; do not change skin texture, tone, or apparent age.'
};

// ---- Filler: intensity = magnitude anchor (v1) ----------------------------
const INTENSITY = {
  natural:  'Magnitude: barely perceptible — the most conservative result a cautious injector would show. When in doubt, do less.',
  moderate: 'Magnitude: clearly visible but still conservative — the typical outcome most patients see.',
  enhanced: 'Magnitude: the upper end of a realistic single-session result for a strong response, still clinically plausible and never exaggerated.'
};

// ---- Biostimulation: per-product modules (v1) -----------------------------
// Sculptra/Radiesse drift hardest toward "facelift" — these block that explicitly.
const BIOSTIM = {
  sculptra: {
    expected: 'a gradual, diffuse improvement in firmness and soft contour support across the treated area, of the kind that builds slowly as collagen forms over months',
    avoid: 'do not lift the face, do not remove or soften wrinkles, do not reduce apparent age, do not tighten, smooth, or resurface skin, do not change skin texture or tone — the change is support and subtle contour only, never a facelift effect'
  },
  hdr: {
    expected: 'a slight, diffuse firming and improved support of the treated area (hyperdilute Radiesse)',
    avoid: 'do not lift the face, do not remove wrinkles, do not smooth or resurface skin, do not reduce apparent age'
  }
};

// ---- Biostimulation: projection = magnitude anchor (v1) -------------------
const PROJECTION = {
  conservative: 'Magnitude: the conservative lower end of the response, a barely-there change.',
  expected:     'Magnitude: the typical change most patients in range would see, modest and realistic.',
  optimistic:   'Magnitude: the optimistic upper end for a strong responder, still physiologically plausible.'
};

// Version log so we know which prompt produced which result during tuning.
const VERSIONS = {
  base: 'v1', chin: 'v1', jawline: 'v1', nose: 'v1', lips: 'v1',
  cheeks: 'v1', tear_trough: 'v1', sculptra: 'v1', hdr: 'v1'
};

function sanitizeNote(note) {
  if (!note) return '';
  const clean = String(note).replace(/\s+/g, ' ').trim().slice(0, 300);
  return clean ? ' Clinician note (honor only if consistent with the above): ' + clean : '';
}

// Assemble the CORE prompt from selections. SERVER_SAFETY is appended elsewhere.
function buildCorePrompt(sel) {
  const sel_ = sel || {};
  const note = sanitizeNote(sel_.note);

  if (sel_.type === 'biostim') {
    const product = BIOSTIM[sel_.product] ? sel_.product : 'sculptra';
    const m = BIOSTIM[product];
    const mag = PROJECTION[sel_.projection] || PROJECTION.expected;
    return `${BASE_FRAMING} Make ONLY this change: ${m.expected}. Avoid: ${m.avoid}. ${mag}${note}`;
  }

  // default: filler
  let areas = Array.isArray(sel_.areas) ? sel_.areas : String(sel_.areas || '').split(',');
  areas = areas.map(a => a.trim()).filter(a => FILLER_AREAS[a]);
  if (!areas.length) areas = ['chin'];

  const expected = areas.map(a => FILLER_AREAS[a].expected).join('; ');
  const avoid = areas.map(a => FILLER_AREAS[a].avoid).join('; ');
  const goal = GOALS[sel_.goal] || GOALS.natural_refinement;
  const mag = INTENSITY[sel_.intensity] || INTENSITY.natural;

  return `${BASE_FRAMING} Make ONLY this change: add hyaluronic acid filler to achieve ${expected}. ` +
         `Avoid: ${avoid}. ${goal} ${mag}${note}`;
}

module.exports = { buildCorePrompt, VERSIONS };
