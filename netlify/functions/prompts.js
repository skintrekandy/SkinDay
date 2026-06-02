// SkinDay Visualize — Treatment Prompt Library
// ---------------------------------------------------------------------------
// This file is the clinical brain of the generator. It turns the clinician's
// selections (treatment, area, goal, intensity) into the CORE instruction sent
// to the image model. The universal safety/identity constraints live separately
// in generate-visualization.js. Filler uses the strict localized base
// (SERVER_SAFETY); biostim uses the support-aware base (BIOSTIM_SAFETY).
//
// Design rules (learned from real patient output):
//   1. Lead with PROHIBITIONS. The model is fixed by what we forbid, not by
//      describing the desired outcome — words like "mild definition" get read
//      through its beautify-everything prior, so each module names the specific
//      drift to block (e.g. Sculptra over-lift, superhero jawline).
//   2. Keep the ASSEMBLED prompt tight. gpt-image-1 follows only a handful of
//      lines; a wall of text washes the important ones out.
//   3. Magnitude is set by the intensity/projection module, not by adjectives
//      scattered through the area modules. (Exception: Sculptra magnitude and
//      content co-vary, so its expected text is keyed by projection directly.)
//
// To tune a treatment: edit ONLY its entry below, bump the version note, redeploy.
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

// ---- Filler: combined lower-face module (v2) ------------------------------
// Chin + jawline are injected together in practice, so when both are selected
// we describe ONE integrated lower-third outcome instead of concatenating two
// independent area clauses (which made the model over-treat each area).
const FILLER_CHIN_JAWLINE = {
  expected: 'a subtly restructured lower third treating the chin and jawline as one unit: ' +
            'a little more chin projection and gentle definition along the mandibular border with slight prejowl support, ' +
            'so the lower face looks better balanced and more defined and the chin-jaw-neck transition reads cleaner where visible',
  avoid: 'do not lengthen the chin or make it pointed, jutting, or witch-like; ' +
         'do not create a sharp, angular, or "superhero" jawline; ' +
         'do not slim, hollow, or carve the cheeks to fake jaw definition; ' +
         'do not narrow the lower face into an unnatural V; do not change the neck; ' +
         'keep the change proportionate to the existing bone structure'
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

// ---- Biostimulation: per-product modules ----------------------------------
// SHAPE (filler) vs SUPPORT (biostim). Sculptra restores diffuse soft-tissue
// SUPPORT and works by improving facial transition zones, not by reshaping
// features. Its `expected` is keyed by projection so magnitude and content
// co-vary (the generic PROJECTION clause is skipped for Sculptra; see build).
const BIOSTIM = {
  sculptra: {
    expected: {
      conservative: 'a subtle, diffuse collagen-driven restoration of soft-tissue support: slightly softer temple and midface hollowing with a little more cheek and prejowl support, smoothing the transitions between temple, cheek, midface and jawline while keeping the existing facial proportions and apparent age',
      expected: 'a gradual, diffuse collagen-driven restoration of support that improves the facial transition zones (temple to cheek, cheek to midface and nasolabial, marionette to jawline, lower face to neck): milder temple and midface hollowing, light cheek and prejowl support, less under-eye shadowing and better oral-commissure support, so the face reads healthier, more supported and less fatigued without looking filled; folds soften only partially, from the restored volume underneath',
      optimistic: 'a strong but still physiologic collagen response: clearly improved soft-tissue support and smoother contour transitions across the temples, midface, prejowl and lower face, restoring lost volume and facial harmony while preserving identity, bone structure and natural aging characteristics'
    },
    avoid: 'this is collagen-driven SUPPORT, not filler SHAPE and not a beauty filter: do not add filler-like or localized volume, do not sharpen the jawline or create a V-shaped face, do not enlarge the cheeks or change facial shape; do not lift, pull, or tighten like a facelift; soften folds only partially and do not eliminate wrinkles or fully erase nasolabial folds, marionette lines, or under-eye hollows; do not smooth skin texture, brighten, or change skin surface quality; do not make the patient look significantly younger. Any firmer look or better light reflection must come from the restored support underneath, never from retouching the skin'
  },
  hdr: {
    expected: 'a slight, diffuse firming and improved support of the treated area (hyperdilute Radiesse)',
    avoid: 'do not lift the face, do not remove wrinkles, do not smooth or resurface skin, do not reduce apparent age'
  }
};

// ---- Biostimulation: projection = magnitude anchor (v1) -------------------
// Used for biostim products whose `expected` is a plain string (e.g. hdr).
// Skipped for Sculptra, whose expected is already projection-keyed.
const PROJECTION = {
  conservative: 'Magnitude: the conservative lower end of the response, a barely-there change.',
  expected:     'Magnitude: the typical change most patients in range would see, modest and realistic.',
  optimistic:   'Magnitude: the optimistic upper end for a strong responder, still physiologically plausible.'
};

// ---- Biostimulation: timeline = how far the collagen build has progressed (v1)
// Layered on top of projection: projection = how strong a responder, timeline = how far along.
const TIMELINE = {
  '3':  'Timeframe: about 3 months in. Collagen is still building, so show an early, partial, deliberately incomplete result, clearly less than the final outcome.',
  '6':  'Timeframe: about 6 months in. Show a clearly developed result as the collagen response matures.',
  '12': 'Timeframe: about 12 months in. Show the fuller, settled result after the collagen response has largely completed.'
};

// Version log so we know which prompt produced which result during tuning.
const VERSIONS = {
  base: 'v1', chin: 'v1', jawline: 'v1', chin_jawline: 'v2', nose: 'v1', lips: 'v1',
  cheeks: 'v1', tear_trough: 'v1', sculptra: 'v2', hdr: 'v1', timeline: 'v1'
};

function sanitizeNote(note) {
  if (!note) return '';
  const clean = String(note).replace(/\s+/g, ' ').trim().slice(0, 300);
  return clean ? ' Clinician note (honor only if consistent with the above): ' + clean : '';
}

// Assemble the CORE prompt from selections. The safety base is appended elsewhere.
function buildCorePrompt(sel) {
  const sel_ = sel || {};
  const note = sanitizeNote(sel_.note);

  if (sel_.type === 'biostim') {
    const product = BIOSTIM[sel_.product] ? sel_.product : 'sculptra';
    const m = BIOSTIM[product];
    const tp = TIMELINE[sel_.timeline] || TIMELINE['6'];

    // Sculptra: expected is keyed by projection, so the projection line is built
    // INTO expected and we do NOT append a separate generic PROJECTION clause.
    // Other biostim products (hdr) use a string expected + the PROJECTION anchor.
    let expected, mag;
    if (m.expected && typeof m.expected === 'object') {
      expected = m.expected[sel_.projection] || m.expected.expected;
      mag = '';
    } else {
      expected = m.expected;
      mag = ' ' + (PROJECTION[sel_.projection] || PROJECTION.expected);
    }
    return `${BASE_FRAMING} Make ONLY this change: ${expected}. Avoid: ${m.avoid}. ${tp}${mag}${note}`;
  }

  // default: filler
  let areas = Array.isArray(sel_.areas) ? sel_.areas : String(sel_.areas || '').split(',');
  areas = areas.map(a => a.trim()).filter(a => FILLER_AREAS[a]);
  if (!areas.length) areas = ['chin'];

  // Chin + jawline are treated as a single lower-face unit when both selected.
  // Any other selected areas still append as their own clauses (full-face cases).
  let expected, avoid;
  if (areas.includes('chin') && areas.includes('jawline')) {
    expected = FILLER_CHIN_JAWLINE.expected;
    avoid = FILLER_CHIN_JAWLINE.avoid;
    const extra = areas.filter(a => a !== 'chin' && a !== 'jawline');
    if (extra.length) {
      expected += '; ' + extra.map(a => FILLER_AREAS[a].expected).join('; ');
      avoid += '; ' + extra.map(a => FILLER_AREAS[a].avoid).join('; ');
    }
  } else {
    expected = areas.map(a => FILLER_AREAS[a].expected).join('; ');
    avoid = areas.map(a => FILLER_AREAS[a].avoid).join('; ');
  }

  const goal = GOALS[sel_.goal] || GOALS.natural_refinement;
  const mag = INTENSITY[sel_.intensity] || INTENSITY.natural;

  return `${BASE_FRAMING} Make ONLY this change: add hyaluronic acid filler to achieve ${expected}. ` +
         `Avoid: ${avoid}. ${goal} ${mag}${note}`;
}

module.exports = { buildCorePrompt, VERSIONS };
