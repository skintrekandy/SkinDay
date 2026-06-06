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

// Oblique (three-quarter) Sculptra uses a separate, restrictive framing: at this
// angle gpt-image-1 rebuilds too much of the face, so the brief leads with
// preservation and asks for the smallest possible local contour edit (v10).
const OBLIQUE_BASE_FRAMING =
  'Produce a subtle, medically conservative Sculptra collagen-stimulation ' +
  'visualization from this three-quarter (oblique) consultation photograph, ' +
  'staying as close to the original photograph as possible.';

// Frontal Sculptra v9.1: a short, high-priority feature lock injected BEFORE the
// structural language. Image models weight the first lines most, and the long v9
// avoid block placed the lip/eye prohibitions too late to hold against the strong
// lift/narrow instructions, so the mouth, eyes, and brows were being beautified
// as the model "improved" the lower face. This clamps them up front.
const SCULPTRA_FRONTAL_HARD_LOCK =
  'Critical feature lock, applies before everything below: the lips and mouth, eyes, ' +
  'eyebrows, and nose are completely outside the treatment area. Do not change lip ' +
  'size, shape, volume, color, border, cupid\'s bow, or symmetry, and do not make the ' +
  'mouth fuller, smoother, glossier, more defined, more symmetrical, or more attractive. ' +
  'Do not enlarge or open the eyes, raise the eyelids, or darken or reshape the brows. ' +
  'These features stay pixel-close to the original except for shadow that shifts as a ' +
  'natural consequence of lateral soft-tissue support. The ONLY change is lateral support.';

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
// v9: a round/full FRONT is read as deflation and descent (lost lateral support,
//      tissue slid down and pooled centrally), so it triggers MORE lateral lift that
//      draws the fullness up and out and narrows the front, never central fill. The
//      deficit floor applies to lean, well-supported faces. v9.2: the descent
//      reading is qualified by SIGNS OF DESCENT (older face, jowl, lateral/temporal
//      hollowing); a young or well-supported full face is youthful fullness, not
//      descent, so it falls to the floor and stays near baseline rather than being
//      narrowed or lifted.
const BIOSTIM = {
  sculptra: {
    expected: {
      conservative: 'the just-noticeable floor of a Sculptra response: a very subtle collagen-driven firming along the LATERAL face only, a hint more support in the lateral temple and lateral cheek fat pads giving a barely-there upward and outward lift along the line of ligaments that just begins to lift the jowl and tidy the jawline, so faint that without the before photo a viewer might not be sure anything changed. If the face looks round or full from the front WITH signs of descent (flattened temples and lateral cheeks, a jowl, an older face), that roundness is descended tissue and even this subtle lift should begin to draw it up and outward and very slightly narrow the front, never add to it; but a young, well-supported full face is youthful fullness, not descent, and stays at baseline. The central midface, anterior cheek, and under-eye are left unchanged, and facial proportions, apparent age, and skin are unchanged',
      expected: 'a clearly visible but still moderate Sculptra response driven by LATERAL support: subtle collagen-driven volumization of the lateral temple and lateral cheek fat pads that lifts the face upward and outward along the line of ligaments (orbital retaining, zygomatic-cutaneous, mandibular). A face that looks round, full, or heavy from the front WITH SIGNS OF DESCENT (an older face, flattened or hollow temples and lateral cheeks, a jowl, mid-lower-face volume slid downward and centrally) is showing deflation and descent, so the correct response is MORE lateral support that draws that central fullness up and outward: the front becomes narrower, more lifted, and more defined, and the roundness visibly decreases. A young, well-supported full face with no jowl and no lateral hollowing is youthful or constitutional fullness, NOT descent: Sculptra would barely change it, so keep it near baseline and do not narrow or lift it (see the volume-deficit floor). The lower face reads more lifted and supported, the lateral lift travels down the mandibular ligament so the jowl is lifted up and back and visibly but subtly reduced, leaving a cleaner, smoother jawline (not a sharpened or carved one), and the nasolabial and marionette folds soften secondarily from that lateral support, not from being filled. The central midface, anterior cheek, and under-eye stay essentially unchanged. Unmistakably the same person at the same age, never looking filled, puffy, or rounded in front',
      optimistic: 'the strong end of a realistic Sculptra response (the upper 20–25% of responders), still a LATERAL lift: more collagen-driven support in the lateral temple and lateral cheek fat pads producing an obvious upward and outward lift along the line of ligaments, with the jowl clearly lifted and reduced and a cleaner, smoother jawline (never sharpened or carved) and a more lifted lower face. A round or full front WITH signs of descent (jowl, lateral and temporal hollowing, an older face) is descended tissue, so at this strength the central and lower-face fullness is drawn clearly up and outward and the front reads distinctly narrower and more lifted, never fuller; a young, well-supported full face is youthful fullness and stays near baseline. The extra strength appears as more lateral lift and support, never as central midface or under-eye volume, never as a fuller, rounder, or puffier front of the face, and never as smoothed skin or a younger look. Identity, bone structure, and natural aging are preserved'
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
           'Placement and shape: the support is LATERAL (lateral temple and lateral cheek fat pads) and produces an upward, outward lift, not central fill. Do not add volume to the central midface, anterior cheek, under-eye, or tear trough. Round or full front: a face that reads round, full, or heavy from the front WITH signs of descent (an older face, flattened temples and lateral cheeks, a jowl, volume slid downward and centrally) is showing deflation and descent, not excess volume, so it is a strong candidate for more lateral lift, not a reason to hold back; a young or well-supported full face with no jowl and no lateral hollowing is youthful or constitutional fullness, not descent, and must stay near baseline (do not narrow, lift, or slim it); restore lateral support so the descended central and lower-face fullness is drawn up and outward and the front becomes narrower, more lifted, and more defined. That central and lower-face fullness must DECREASE only as a consequence of the lateral lift, never from actively deflating, hollowing, slimming, carving, or skin-tightening the front. Never read a full face as needing central volume: adding central volume is the exact opposite of this treatment. Do not add filler-like or localized volume; the jowl should subtly REDUCE and the jawline read cleaner and smoother as a result of the lateral lift, but do not carve a sharp, angular, V-shaped, or superhero jawline, and never leave the jowl unchanged or make it heavier or more pronounced. Do not enlarge or round the cheeks or change facial shape, do not lift, pull, or tighten like a facelift. Never make the front of the face look fuller, rounder, swollen, or puffy: support should read as firmer and lifted, and if the choice is between too much and too little, choose less. Soften folds only partially and never fully erase nasolabial folds, marionette lines, or under-eye hollows. ' +
           'Projection scaling: the ONLY thing that changes between Conservative, Expected, and Optimistic is the amount of diffuse subcutaneous soft-tissue support in the temples, midface, and prejowl — more support means more restored volume and softer folds, nothing else. Do not increase brightness, smoothness, symmetry, eye openness, brow definition, lip color, grooming, or apparent youth at any level. At 12 months or the Optimistic projection the extra strength shows as more support only, and must NOT bring back any skin smoothing, brightening, pigment or melasma fading, brow change, eye change, lip change, or de-aging that the lower settings correctly avoided. ' +
           'Volume-deficit floor (applies at every timeframe, including 12 months): the floor is for genuinely LEAN, well-supported faces only. If the face already shows good lateral support with minimal temple, lateral cheek, and lower-face volume loss, the result should stay very close to the original — do not invent improvements just to produce a visible change, and a longer timeframe is never a reason to add more volume than the face needs. When little deficit exists, the correct output may be nearly indistinguishable from the original, and this includes a young or well-supported full face whose fullness is youthful or constitutional rather than descended: it stays near baseline and is not narrowed or lifted. Only a full face that ALSO shows descent (jowl, lateral and temporal hollowing, an older face, volume slid downward) is the opposite case: that fullness is descent, not good support, so it is not held at baseline and instead receives more lateral lift to draw the fullness up and outward and narrow the front. ' +
           'Any firmer look or better light reflection must come from the restored support underneath, never from retouching the skin',
    // ---- Oblique (three-quarter) skin-locked, contour-only variant (v10) -----
    // The frontal expected/avoid above stay FROZEN at v9. This branch is used only
    // when the view is oblique, where the model over-reconstructs and reapplies a
    // beauty-portrait prior, so it leads with preservation and an anti-rebuild
    // instruction and permits NO skin change at any projection.
    oblique: {
      conservative: 'the just-noticeable floor of a Sculptra response at three-quarter view: a barely-there gain in lateral cheek and temple support and a slightly more continuous cheek-to-temple transition, so faint it could be missed without the before photo. Soft-tissue contour only',
      expected: 'a modest but real Sculptra response at three-quarter view, about 10 to 20 percent of contour improvement: gentle lateral cheek support, a slightly more continuous temple-to-cheek and lid-to-cheek transition (a smoother ogee curve), mild softening of midface hollowing, and a slight reduction of nasolabial and prejowl shadow. Soft-tissue contour only. The same person after gradual collagen support, not a makeover',
      optimistic: 'the strong end of a realistic Sculptra response at three-quarter view, about 20 to 35 percent of contour improvement: clearer lateral cheek and temple support, a more continuous temple-cheek-lid transition, more obvious but still natural midface support, and softer nasolabial and prejowl shadow. The extra strength is more contour support only; even here there is no skin change and no de-aging'
    },
    obliqueAvoid: 'This is a three-quarter (oblique) medical consultation photograph. At this angle the model tends to rebuild the whole face and apply a beauty-portrait look: do NOT do that. Treat the task as a minimal local contour adjustment laid over the ORIGINAL photograph, redrawing as little as possible; do not regenerate, repaint, or re-render the face or the skin. ' +
           'Skin lock, absolute at every projection and timeframe: keep pigment, melasma, sun and age spots, freckles, redness, pores, fine lines, surface texture, skin tone, brightness, and apparent age exactly as photographed. Do not smooth, brighten, whiten, even out, retouch, or de-age the skin in any way, and never apply a laser-resurfacing or beauty-filter look. A longer timeframe or stronger projection adds soft-tissue contour support ONLY, never any skin change. ' +
           'Photographic conditions: keep the original exposure, brightness, contrast, white balance, color temperature, lighting direction and softness, and the skin\'s natural sheen and reflectance unchanged; do not brighten, warm, soften, or otherwise flatter the lighting. A result can read as falsely improved from light and exposure alone even when pigment and texture survive. ' +
           'Identity and features: do not enlarge or open the eyes, raise the eyelids, darken or reshape the brows, change the lips, refine or narrow the nose, slim the face into a V-line, or alter hair, clothing, jewellery, or expression. ' +
           'Pose and framing: preserve the exact head angle, three-quarter orientation, camera angle, and crop; do not rotate the face toward frontal and do not re-pose. ' +
           'Shape: the only change is gentle lateral soft-tissue support (lateral cheek, temple-to-cheek continuity, midface hollowing, nasolabial and prejowl shadow), with no central or filler-like fill, no facelift pull, no jaw carving, and no surgery or makeup effect. If the choice is between too much and too little, choose too little: an honest, conservative, even underwhelming result is correct, and a prettier but fake-looking one is a failure'
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
  cheeks: 'v2', tear_trough: 'v1', nasolabial_folds: 'v1', sculptra: 'v9.2', sculptra_oblique: 'v10', hdr: 'v1', timeline: 'v2'
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

    // Oblique (three-quarter) Sculptra: skin-locked, contour-only branch (v10).
    // Fires on sel.angle === 'oblique' (the production path, once a view control is
    // wired through the client and server) OR on the word "oblique" appearing in the
    // clinician note. The note trigger is a deliberate zero-deploy test hook so the
    // oblique prompt can be validated by deploying ONLY this file, before any UI or
    // server change. Frontal is the default and runs the frozen v9 path below.
    // Production path: sel.angle === 'oblique'. Test hook: an explicit, unambiguous
    // sentinel "[view:oblique]" in the clinician note (precise, auditable, and not
    // tripped by a clinician naturally writing the word "oblique"). The branch keys
    // on sel.angle, so it extends to a fuller view taxonomy (left/right/profile)
    // later without a rewrite; one oblique brief already covers both L and R.
    const OBLIQUE_TAG = /\[view:\s*oblique\s*\]/i;
    const wantsOblique = product === 'sculptra' && m.oblique &&
      (sel_.angle === 'oblique' || OBLIQUE_TAG.test(String(sel_.note || '')));
    if (wantsOblique) {
      const oexp = m.oblique[sel_.projection] || m.oblique.expected;
      const obliqueNote = sanitizeNote(String(sel_.note || '').replace(OBLIQUE_TAG, '').trim());
      return `${OBLIQUE_BASE_FRAMING} Make ONLY this change: ${oexp}. Avoid: ${m.obliqueAvoid}. ${tp}${obliqueNote}`;
    }

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
    if (product === 'sculptra') {
      return `${BASE_FRAMING} ${SCULPTRA_FRONTAL_HARD_LOCK} Make ONLY this change: ${expected}. Avoid: ${m.avoid}. ${tp}${mag}${note}`;
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
