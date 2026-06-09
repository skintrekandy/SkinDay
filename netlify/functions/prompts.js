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

// ---- Filler: combined lower-face module (v3) ------------------------------
// Chin + jawline are injected together in practice, so when both are selected
// we describe ONE integrated lower-third outcome instead of concatenating two
// independent area clauses (which made the model over-treat each area). v3: the
// PRIMARY frontal change is vertical chin elongation (lengthening the lower
// third), which is what chin filler reads as from the front; earlier wording
// forbade lengthening and so produced almost no visible frontal change.
const FILLER_CHIN_JAWLINE = {
  expected: 'a subtly restructured, better-balanced lower third treating the chin and jawline as one unit. ' +
            'The main change, clearly visible from the front, is gentle vertical lengthening and projection of the chin: ' +
            'bring the chin point a little lower and forward so the lower third of the face looks longer and more balanced and the face reads more oval, ' +
            'with cleaner definition along the mandibular border and slight prejowl support so the chin-to-jaw line is more continuous. ' +
            'As the chin lengthens and projects, the soft tissue of the lower face follows it, so the lateral lower-face contour (below the cheekbone, along the jowl and jaw) tapers slightly inward and the lower third reads more refined and defined, not just longer. ' +
            'For a female face let this inward taper read a little more (softer, more tapered lower face); for a male face keep the jaw width and strength and let the change come mostly from chin length and projection. ' +
            'The mid-cheek width and cheekbones are unchanged; only the lower face follows the chin. ' +
            'The change comes only from added chin volume and structural support',
  avoid: 'do not over-lengthen into a long, narrow, pointed, jutting, or witch-like chin, and keep the chin width natural; ' +
         'do not create a sharp, angular, or "superhero" jawline; ' +
         'do not slim, hollow, or carve the cheeks or cheekbones to fake jaw definition; ' +
         'a slight, soft inward taper of the lower face as the chin lengthens is expected and good, but do not over-narrow or carve the lower face into a hard, artificial, sharply pointed V-line, and do not widen the lower face; ' +
         'do not add a double chin and do not alter the neck below the new chin point; ' +
         'keep the change proportionate to the patient\'s bone structure and sex (a male chin can be a little longer, squarer, and more projected with the jaw width preserved; a female chin softer, more tapered, slightly shorter, with the lower face allowed to taper)'
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
  base: 'v3', chin: 'v1', jawline: 'v1', chin_jawline: 'v5', nose: 'v1', lips: 'v2',
  cheeks: 'v2', tear_trough: 'v1', nasolabial_folds: 'v1', sculptra: 'v10.1', sculptra_oblique: 'v10.1', hdr: 'v1', timeline: 'v2'
};

function sanitizeNote(note) {
  if (!note) return '';
  const clean = String(note).replace(/\s+/g, ' ').trim().slice(0, 300);
  return clean ? ' Clinician note (honor only if consistent with the above): ' + clean : '';
}

// ---- Sculptra clinical phenotype system (v10.1) ---------------------------
// Sculptra is not one visual pattern. The generator should not infer everything
// from "Sculptra" alone. View and phenotype are selected explicitly (structured
// fields in production, or [view:...] / [phenotype:...] tags in the note for
// testing). full/descended faces are valid candidates: the goal is the SAME
// volume character, better suspended, never slimming. This supersedes the
// v9/v9.1 frontal and v10 oblique sculptra prompt paths (their text remains
// below for reference but is no longer used for sculptra).
const SCULPTRA_FEATURE_LOCK =
  'Critical hard-lock before any treatment simulation: lips, mouth, eyes, brows, nose, skin surface, hair, clothing, jewellery, expression, lighting, crop, and camera angle are non-treatment areas. Do not change lip size, lip shape, lip fullness, lip border, cupid\'s bow, lip color, lip texture, mouth symmetry, mouth openness, or expression. Do not make the lips fuller, smoother, pinker, glossier, more defined, more symmetrical, or more attractive. Do not enlarge, brighten, open, reshape, or beautify the eyes. Do not darken, groom, reshape, raise, thicken, or define the brows. Do not smooth, brighten, whiten, even out, retouch, or de-age the skin. Preserve pores, pigment, freckles, redness, melasma, spots, fine lines, texture, and natural skin reflectance. Do not change the nose, hairstyle, headband, clothing, neck, posture, head angle, crop, lighting, exposure, white balance, or background.';

const SCULPTRA_VIEW_LOCKS = {
  frontal: 'View lock: this is a frontal consultation photograph. Preserve the exact frontal pose, head position, camera distance, crop, and facial orientation. Do not rotate, re-pose, or make the face more symmetrical than the original.',
  oblique: 'View lock: this is a three-quarter oblique consultation photograph. Preserve the exact three-quarter head angle, camera angle, crop, facial orientation, visible ear position, neck angle, and perspective. Do not rotate the face toward frontal, do not re-pose, and do not rebuild the face.',
  oblique_left: 'View lock: this is a left three-quarter oblique consultation photograph. Preserve the exact left oblique angle, camera angle, crop, visible ear position, neck angle, and perspective. Do not rotate the face toward frontal, do not re-pose, and do not rebuild the face.',
  oblique_right: 'View lock: this is a right three-quarter oblique consultation photograph. Preserve the exact right oblique angle, camera angle, crop, visible ear position, neck angle, and perspective. Do not rotate the face toward frontal, do not re-pose, and do not rebuild the face.'
};

const SCULPTRA_ALLOWED_ZONES =
  'Allowed Sculptra change zones only: lateral temple, lateral cheek support, temple-to-cheek continuity, cheek-lid transition only as a contour transition, lower lateral cheek, prejowl shadow, nasolabial shadow, and marionette shadow only as indirect effects of lateral support. Do not directly fill the central cheek, anterior cheek, tear trough, under-eye, lips, chin, nose, or jaw angle.';

const SCULPTRA_PHENOTYPES = {
  hollow_deflated: {
    label: 'hollow/deflated',
    clinicalLogic: 'Clinical pattern: this face shows visible volume loss or hollowing, especially around the temple, lateral cheek, midface, or lower-face transition zones. The correct Sculptra visualization is diffuse collagen-driven support that restores depleted transition zones without making the face round, puffy, overfilled, or younger-looking.',
    conservative: 'Magnitude: barely perceptible. Add only the faintest lateral temple and lateral cheek support. Hollowing may look slightly less stark, but the result should remain very close to the original.',
    expected: 'Magnitude: modest and realistic. Add visible but conservative lateral temple and lateral cheek support, improve temple-to-cheek continuity, mildly soften midface hollowing, and slightly reduce fold and prejowl shadows through support only.',
    optimistic: 'Magnitude: strong but still realistic. Add clearer lateral temple and lateral cheek support, smoother transition zones, and more visible softening of hollowing and fold shadows, while avoiding puffiness, overfill, skin retouching, or de-aging.'
  },
  full_descended: {
    label: 'full/descended',
    clinicalLogic: 'Clinical pattern: this face retains natural fullness, but the fullness appears insufficiently supported, with visual weight sitting lower or more centrally than ideal. This is a valid Sculptra candidate. The correct Sculptra visualization is NOT slimming, deflating, carving, V-line shaping, or making the face smaller. Preserve the patient\'s natural facial width, fullness, softness, and identity. The goal is the same facial volume character, better suspended by lateral support. Fullness should look better held, not removed.',
    conservative: 'Magnitude: barely perceptible. Preserve natural fullness and face width. Add only a tiny improvement in lateral support so the lower and central fullness looks slightly better suspended, without slimming or changing the mouth.',
    expected: 'Magnitude: modest and realistic. Preserve natural fullness and face width. Add gentle lateral cheek and temple support so facial weight appears better suspended upward and laterally, with mild softening of lower-face heaviness, nasolabial shadow, and prejowl shadow. Do not make the face thinner; make the same face look better supported.',
    optimistic: 'Magnitude: strong but still realistic. Preserve natural fullness and face width. Add clearer lateral support so the face looks more suspended and less downwardly pooled, with better cheek-to-temple continuity and softer lower-face heaviness. Do not slim, hollow, carve, sharpen, V-line, or beautify the face.'
  },
  mixed: {
    label: 'mixed hollowing/descent',
    clinicalLogic: 'Clinical pattern: this face shows a combination of mild volume loss and soft-tissue descent. The correct Sculptra visualization is balanced lateral support: restore transition zones while improving how facial weight is carried, without slimming or beautifying.',
    conservative: 'Magnitude: barely perceptible. Add only a faint improvement in lateral support and transition-zone continuity, keeping the image very close to baseline.',
    expected: 'Magnitude: modest and realistic. Add gentle lateral temple and cheek support, improve transition-zone continuity, mildly soften hollowing, and slightly reduce nasolabial and prejowl shadow through support only. Do not slim the face.',
    optimistic: 'Magnitude: strong but still realistic. Add clearer lateral support, smoother transition zones, and more visible softening of hollowing and descent, while preserving identity, age, skin, lips, eyes, brows, and natural face width.'
  }
};

const SCULPTRA_OUTPUT_RULES =
  'Output rule: this is a clinical Sculptra visualization, not a beauty portrait. The final image must look like the same person, same age, same skin, same lips, same eyes, same brows, same lighting, and same camera setup, with only treatment-relevant soft-tissue support changed. Conservative, Expected, and Optimistic must differ ONLY in the amount of allowed soft-tissue support; they must not differ in beauty, skin quality, eye openness, lip appearance, symmetry, lighting, or age. A less impressive but honest result is preferred over a prettier result. If uncertain, under-treat.';

// View and phenotype are read from structured fields first (production), then
// from explicit bracket tags in the note (test hook). Loose words in free text
// are deliberately NOT matched, so a clinician writing "fullness" or "oblique"
// in a note cannot silently flip the phenotype or view.
function normalizeView(sel) {
  const field = String(sel.view || sel.angle || '').toLowerCase().trim();
  if (field === 'oblique_left' || field === 'oblique_right' || field === 'oblique' || field === 'frontal') return field;
  const note = String(sel.note || '');
  if (/\[view:\s*oblique_left\s*\]/i.test(note)) return 'oblique_left';
  if (/\[view:\s*oblique_right\s*\]/i.test(note)) return 'oblique_right';
  if (/\[view:\s*oblique\s*\]/i.test(note)) return 'oblique';
  if (/\[view:\s*frontal\s*\]/i.test(note)) return 'frontal';
  return 'frontal';
}

function normalizeSculptraPhenotype(sel) {
  const field = String(sel.phenotype || sel.sculptraPhenotype || '').toLowerCase().trim();
  if (field === 'hollow_deflated' || field === 'full_descended' || field === 'mixed') return field;
  const note = String(sel.note || '');
  if (/\[phenotype:\s*hollow_deflated\s*\]/i.test(note)) return 'hollow_deflated';
  if (/\[phenotype:\s*full_descended\s*\]/i.test(note)) return 'full_descended';
  if (/\[phenotype:\s*mixed\s*\]/i.test(note)) return 'mixed';
  // Default to mixed, never forcing an older/deflated pattern onto an unlabeled face.
  return 'mixed';
}

function stripInternalSculptraTags(note) {
  if (!note) return '';
  return String(note)
    .replace(/\[view:\s*(frontal|oblique|oblique_left|oblique_right)\s*\]/ig, '')
    .replace(/\[phenotype:\s*(hollow_deflated|full_descended|mixed)\s*\]/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSculptraPrompt(sel, m, timelineText) {
  const view = normalizeView(sel);
  const phenotype = SCULPTRA_PHENOTYPES[normalizeSculptraPhenotype(sel)] || SCULPTRA_PHENOTYPES.mixed;
  const magnitude = phenotype[sel.projection] || phenotype.expected;
  const isOblique = view !== 'frontal';
  const framing = isOblique
    ? 'Produce a subtle, medically conservative Sculptra collagen-stimulation visualization from this oblique consultation photograph, staying as close to the original photograph as possible.'
    : 'Produce a subtle, medically conservative Sculptra collagen-stimulation visualization from this frontal consultation photograph, staying as close to the original photograph as possible.';
  const cleanNote = sanitizeNote(stripInternalSculptraTags(sel.note));
  return `${framing} ${SCULPTRA_FEATURE_LOCK} ${SCULPTRA_VIEW_LOCKS[view] || SCULPTRA_VIEW_LOCKS.frontal} ${SCULPTRA_ALLOWED_ZONES} ${phenotype.clinicalLogic} Make ONLY this change: ${magnitude} ${SCULPTRA_OUTPUT_RULES} ${timelineText}${cleanNote}`;
}

// Assemble the CORE prompt from selections. The safety base is appended elsewhere.
function buildCorePrompt(sel) {
  const sel_ = sel || {};
  const note = sanitizeNote(sel_.note);

  if (sel_.type === 'biostim') {
    const product = BIOSTIM[sel_.product] ? sel_.product : 'sculptra';
    const m = BIOSTIM[product];
    const tp = TIMELINE[sel_.timeline] || TIMELINE['6'];

    // Sculptra v10.1: structured clinical phenotype + view-aware builder. This
    // supersedes the v9/v9.1 frontal and v10 oblique sculptra prompt paths (their
    // text remains in the constants/BIOSTIM for reference but is no longer used
    // for sculptra). Phenotype and view come from structured fields or explicit
    // [view:...] / [phenotype:...] tags in the note (test hook).
    if (product === 'sculptra') {
      return buildSculptraPrompt(sel_, m, tp);
    }

    // Other biostim products (hdr) use the legacy string-expected + PROJECTION path.
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
