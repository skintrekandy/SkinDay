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
  'consistent with a natural-looking, tasteful result from an experienced injector, ' +
  'at the magnitude specified below.';

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
    expected: 'a natural-looking increase in lip body and a slightly more defined vermilion border, with at most a small, even amount of projection, keeping the existing lip shape, the natural upper-to-lower balance, and the position of the lip border and cupid\'s bow',
    avoid: 'do not add gloss, shine, a wet look, or any lip product; do not change the lip color, redness, or pigment, and do not add lipstick; do not over-fill, evert, shelf, or roll the lips out, and do not create a "duck" or sausage shape; do not move or reshape the vermilion border or cupid\'s bow; do not invert the natural upper-to-lower proportion; do not whiten the teeth'
  },
  cheeks: {
    expected: 'restore a little midface and cheekbone volume so the cheek apex and the curve from the lower lid down to the cheek (the ogee curve) look gently fuller and better supported, with a natural, restorative apex rather than an exaggerated or sculpted cheekbone',
    avoid: 'this is volume and contour, not a skin or youth filter: do not smooth, brighten, even out tone, or reduce pigmentation anywhere on the cheek or midface, and do not reduce apparent age; do not over-fill into round "pillow" or "chipmunk" cheeks, and do not set the apex too high or too lateral (no wind-tunnel look); do not lift, pull, or tighten the face, and do not slim the lower face or jaw to exaggerate the cheeks; do not fully erase the nasolabial fold or tear trough, and do not change the eyes, brows, or smile'
  },
  tear_trough: {
    expected: 'slightly soften the under-eye hollow so the area looks a little less shadowed',
    avoid: 'do not erase the hollow completely, do not puff or overfill under the eye, do not brighten, smooth, or retouch away dark circles'
  },
  nasolabial_folds: {
    expected: 'soften the nasolabial fold a little so it looks shallower and less shadowed, while keeping a natural crease',
    avoid: 'do not erase or completely fill the fold, do not build an overfilled ridge or sausage along the fold, do not flatten the midface or change the cheek, do not alter the lips or mouth, do not smooth, brighten, or retouch the surrounding skin'
  }
};

// ---- Filler: combined lower-face module (v2) ------------------------------
// Chin + jawline are injected together in practice, so when both are selected
// we describe ONE integrated lower-third outcome instead of concatenating two
// independent area clauses (which made the model over-treat each area).
const FILLER_CHIN_JAWLINE = {
  expected: 'a subtly restructured lower third treating the chin and jawline as one unit: ' +
            'a little more chin projection and gentle definition along the mandibular border with slight prejowl support, ' +
            'so the lower-third contour reads more supported and the chin-jaw-neck line more continuous where visible, the change coming only from added projection and structural support',
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
  rejuvenation:       'Aim only for the structural support the selected filler areas add; do not change skin texture, tone, under-eye shadows, or apparent age.'
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
      conservative: 'the just-noticeable floor of a Sculptra response: a very subtle collagen-driven firming along the LATERAL face only, a hint more support in the lateral temple and lateral cheek fat pads giving a barely-there upward and outward lift along the line of ligaments, so faint that without the before photo a viewer might not be sure anything changed. The central midface, anterior cheek, and under-eye are left unchanged, and facial proportions, apparent age, and skin are unchanged',
      expected: 'a clearly visible but still moderate Sculptra response driven by LATERAL support: subtle collagen-driven volumization of the lateral temple and lateral cheek fat pads that lifts the face upward and outward along the line of ligaments (orbital retaining, zygomatic-cutaneous, mandibular). The lower face reads more lifted, supported, and slightly more defined, and the nasolabial and marionette folds and early jowl soften secondarily from that lateral support, not from being filled. The central midface, anterior cheek, and under-eye stay essentially unchanged. Unmistakably the same person at the same age, never looking filled, puffy, or rounded in front',
      optimistic: 'the strong end of a realistic Sculptra response (the upper 20–25% of responders), still a LATERAL lift: more collagen-driven support in the lateral temple and lateral cheek fat pads producing an obvious upward and outward lift along the line of ligaments, with a cleaner jawline and a more lifted lower face. The extra strength appears as more lateral lift and support, never as central midface or under-eye volume, never as a fuller, rounder, or puffier front of the face, and never as smoothed skin or a younger look. Identity, bone structure, and natural aging are preserved'
    },
    avoid: 'this is collagen-driven SUPPORT, not filler SHAPE and not a beauty filter, so keep every feature outside soft-tissue volume identical to the original. These prohibitions are absolute and apply equally at every timeframe and every projection: a longer timeframe or stronger projection increases ONLY soft-tissue support and never relaxes any rule below. ' +
           'Eyebrows (strictest rule, most often violated): keep the brows exactly as in the original. Do not darken, thicken, fill, define, reshape, raise, sharpen, or groom them. Brow shape, density, color, and position must be identical. ' +
           'Pigment and tone: do not even out, lighten, or brighten skin, and do not fade or remove melasma, sun spots, redness, or freckles — match the original skin tone. ' +
           'Texture: do not smooth skin, do not reduce pore visibility, do not reduce fine surface texture, do not apply any cosmetic-retouching or beauty-filter effect; skin texture must remain substantially unchanged. ' +
           'Eyes: do not enlarge the eyes, do not alter eye scale or shape, do not increase iris or scleral visibility, do not raise or alter eyelid position, and do not make the eyes look larger, wider, brighter, or more youthful. ' +
           'Under-eye: do not retouch or erase under-eye hollows, bags, or dark circles — only the upper cheek may show subtle volume-driven support. ' +
           'Lips: do not change lip color, fullness, shape, definition, liner, or gloss. ' +
           'Grooming: do not add or enhance makeup, lashes, or hair grooming. ' +
           'Age: do not reduce apparent age — forehead lines, crow\'s feet, perioral lines, and the neck stay unchanged unless diffuse support naturally softens a fold. ' +
           'Symmetry: do not correct facial symmetry beyond the volume effect. ' +
           'Placement and shape: the support is LATERAL (lateral temple and lateral cheek fat pads) and produces an upward, outward lift, not central fill. Do not add volume to the central midface, anterior cheek, under-eye, or tear trough. Do not add filler-like or localized volume, do not sharpen the jawline or create a V-shaped face, do not enlarge or round the cheeks or change facial shape, do not lift, pull, or tighten like a facelift. Never make the front of the face look fuller, rounder, swollen, or puffy: support should read as firmer and lifted, and if the choice is between too much and too little, choose less. Soften folds only partially and never fully erase nasolabial folds, marionette lines, or under-eye hollows. ' +
           'Projection scaling: the ONLY thing that changes between Conservative, Expected, and Optimistic is the amount of diffuse subcutaneous soft-tissue support in the temples, midface, and prejowl — more support means more restored volume and softer folds, nothing else. Do not increase brightness, smoothness, symmetry, eye openness, brow definition, lip color, grooming, or apparent youth at any level. At 12 months or the Optimistic projection the extra strength shows as more support only, and must NOT bring back any skin smoothing, brightening, pigment or melasma fading, brow change, eye change, lip change, or de-aging that the lower settings correctly avoided. ' +
           'Volume-deficit floor (applies at every timeframe, including 12 months): if the face already shows good structural support with minimal temple, lateral cheek, and lower-face volume loss, the result should stay very close to the original — do not invent improvements just to produce a visible change, and a longer timeframe is never a reason to add more volume than the face needs. When little deficit exists, the correct output may be nearly indistinguishable from the original. ' +
           'Any firmer look or better light reflection must come from the restored support underneath, never from retouching the skin'
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
  '3':  'Timeframe: about 3 months in, very early in the collagen response. Show only a faint, first hint of the change, much subtler than the eventual mature result and easy to miss without the before photo. Most of the improvement has not developed yet, so keep it minimal.',
  '6':  'Timeframe: about 6 months in. Show a clearly developed result as the collagen response matures.',
  '12': 'Timeframe: about 12 months in. Show the fuller, settled result after the collagen response has largely completed.'
};

// Version log so we know which prompt produced which result during tuning.
const VERSIONS = {
  base: 'v3', chin: 'v1', jawline: 'v1', chin_jawline: 'v3', nose: 'v1', lips: 'v2',
  cheeks: 'v2', tear_trough: 'v1', nasolabial_folds: 'v1', sculptra: 'v7', hdr: 'v1', timeline: 'v2'
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
         `Avoid: ${avoid}. ${goal} ${mag} ` +
         `Judge the result by facial contour alone: the added projection and support must be visible in the silhouette, while skin appearance stays exactly as photographed.${note}`;
}

module.exports = { buildCorePrompt, VERSIONS };
