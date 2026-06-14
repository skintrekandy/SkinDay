// SkinDay Visualize: Treatment Prompt Library
// ---------------------------------------------------------------------------
// This file is the clinical brain of the generator. It turns the clinician's
// selections (treatment, area, goal, intensity) into the CORE instruction sent
// to the image model. The universal safety/identity constraints live separately
// in generate-visualization.js. Filler uses the strict localized base
// (SERVER_SAFETY); biostim uses the support-aware base (BIOSTIM_SAFETY).
//
// Design rules (learned from real patient output):
//   1. Lead with PROHIBITIONS. The model is fixed by what we forbid, not by
//      describing the desired outcome; words like "mild definition" get read
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
// M11.1: split into male and female variants. The previous single prompt buried
// sex guidance in a subordinate clause; the model defaulted to female geometry
// (shorter, tapered, rounded chin) on male faces. Male chin filler has a
// fundamentally different aesthetic target: square mentum, preserved jaw width,
// taller and more projected chin, crisper border -- not a tapered V-line.
const FILLER_CHIN_JAWLINE_FEMALE = {
  expected: 'a clearly restructured, better-balanced and more defined lower third, treating the chin and jawline as one unit. ' +
            'The main change, clearly visible from the front, is a confident vertical lengthening and forward projection of the chin: ' +
            'bring the chin point clearly lower and forward so the lower third looks longer, stronger, and better balanced and the face reads distinctly more oval and defined, ' +
            'with clean definition along the mandibular border and clear prejowl support so the chin-to-jaw line is smooth and continuous. ' +
            'Where jowls or a prejowl hollow are present, fill the prejowl hollow and visibly soften the jowl shadow so it blends into a smooth, continuous jawline; the jowl itself is never enlarged. ' +
            'As the chin lengthens and projects, the soft tissue of the lower face follows it so the lateral lower-face contour tapers inward and the lower third reads more refined, elegant, and sculpted. ' +
            'Let the inward taper and softening read clearly: a softer, more tapered, more elegant lower face with a refined oval silhouette. ' +
            'The mid-cheek width and cheekbones are unchanged; only the lower face follows the chin. ' +
            'The change comes only from added chin volume and structural support',
  avoid: 'do not over-lengthen into a long, narrow, pointed, jutting, or witch-like chin, and keep the chin width natural; ' +
         'do not create a hard, angular, or square jawline; ' +
         'do not slim, hollow, or carve the cheeks or cheekbones to fake jaw definition; ' +
         'a clear but natural inward taper and refinement of the lower face as the chin lengthens is expected and good, but do not over-narrow or carve the lower face into a hard, sharply pointed V-line, and do not widen the lower face; ' +
         'do not add a double chin and do not alter the neck below the new chin point; ' +
         'keep it unmistakably the same person'
};

const FILLER_CHIN_JAWLINE_MALE = {
  expected: 'a clearly restructured, stronger, and better-balanced lower third on a male face, treating the chin and jawline as one unit. ' +
            'The main change, clearly visible from the front, is a confident forward projection and vertical strengthening of the chin: ' +
            'bring the chin point forward and slightly lower so the lower third reads stronger, more defined, and better balanced with the upper face. ' +
            'The chin should be wider and squarer at the mentum -- a male chin is broad and squared, never tapered or pointed -- with crisp, clean definition along the mandibular border and a strong, continuous chin-to-jaw arc. ' +
            'Preserve the full jaw width and gonial angle: do not narrow or taper the lower face -- the male aesthetic goal is structural definition, not an oval or V-line silhouette. ' +
            'The border from chin to gonion should read as a single, clean, confident line with clear prejowl support. ' +
            'At oblique angle: the chin projection reads as a squared, blunt chin tip advancing anteriorly, not a rounded or tapered tip; the near-side mandibular border is crisp and reads as a structural jawline; the chin tip should remain wide and squared even in three-quarter view. ' +
            'Where jowls or a prejowl hollow are present, fill the prejowl hollow so the chin-to-jaw line is smooth and continuous; the jowl itself is never enlarged. ' +
            'The change comes only from added chin volume and structural support; the cheeks, cheekbones, and mid-face are unchanged',
  avoid: 'do not produce a female or androgynous chin shape -- no tapered, pointed, rounded, soft, or V-shaped chin at any angle; ' +
         'do not narrow or slim the jaw; do not produce a long, jutting, or protruding chin; ' +
         'do not round the chin tip at oblique angle -- it must remain squared and blunt; ' +
         'do not slim, hollow, or carve the cheeks or cheekbones; ' +
         'do not create an artificial or "superhero" jawline; ' +
         'do not add a double chin and do not alter the neck below the new chin point; ' +
         'preserve the patient\'s ethnicity, facial hair, and overall identity; keep it unmistakably the same person'
};

// Legacy alias used by the overfill path (female default)
const FILLER_CHIN_JAWLINE = FILLER_CHIN_JAWLINE_FEMALE;

// ---- Filler: overfilled education anchor (M10.4) --------------------------
// Deliberately overcorrected lower-face result, fired lazily when the slider
// first enters the Overfilled zone (>= 80). The goal is to show the patient
// why more is not better: excess chin projection, a shelf-like jawline, an
// overdone look that no experienced injector would produce. The compositor
// path for this anchor is AI-heavy (outline gate loosened so the model may
// extend the silhouette; chroma lock and texture restore are retained so
// identity and skin character survive, but the border is not guarded).
// Deterministic warp is NOT applied; the AI carries the overcorrection.
const FILLER_CHIN_JAWLINE_OVERFILLED = {
  core: 'Simulate an overfilled hyaluronic acid result in the chin and jawline for patient education. ' +
        'This is INTENTIONALLY overcorrected to show why excessive filler is problematic. ' +
        'Show: a chin that projects too far forward and hangs lower than natural anatomy allows, reading as augmented and disproportionate; ' +
        'a jawline that reads as a hard, artificial shelf rather than a natural mandibular border, with the border too sharply defined and too linearly continuous from chin to gonion; ' +
        'prejowl overfill that smooths the jowl transition too aggressively so the lower face reads as swollen and unnatural; ' +
        'an overall lower third that reads as too long, too projected, too defined, and visibly filled rather than natural. ' +
        'The overcorrection should be obvious to a patient in a consultation setting and clearly read as "too much," but must remain anatomically coherent (no cartoon distortion, no grotesque result): ' +
        'the kind of overfilled outcome an inexperienced or aggressive injector might produce, not a caricature.',
  avoid: 'do not produce a natural or tasteful result; the point is that this looks overfilled and excessive. ' +
         'Do not change the eyes, brows, nose, skin texture, skin tone, hairstyle, expression, lighting, or background. ' +
         'Preserve identity, ethnicity, and apparent age; the result must be unmistakably the same person, just with too much filler in the lower face. ' +
         'Do not add text, labels, watermarks, or cartoon distortion. ' +
         'The overcorrection is confined to the chin, jawline, and lower-face contour: cheeks, midface, and upper face are unchanged.'
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
  natural:  'Magnitude: barely perceptible, the most conservative result a cautious injector would show. When in doubt, do less.',
  moderate: 'Magnitude: clearly visible but still conservative, the typical outcome most patients see.',
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
           'Pigment and tone: do not even out, lighten, or brighten skin, and do not fade or remove melasma, sun spots, redness, or freckles; match the original skin tone. ' +
           'Texture: do not smooth skin, do not reduce pore visibility, do not reduce fine surface texture, do not apply any cosmetic-retouching or beauty-filter effect; skin texture must remain substantially unchanged. ' +
           'Eyes: do not enlarge the eyes, do not alter eye scale or shape, do not increase iris or scleral visibility, do not raise or alter eyelid position, and do not make the eyes look larger, wider, brighter, or more youthful. ' +
           'Under-eye: do not retouch or erase under-eye hollows, bags, or dark circles; only the upper cheek may show subtle volume-driven support. ' +
           'Lips: do not change lip color, fullness, shape, definition, liner, or gloss. ' +
           'Grooming: do not add or enhance makeup, lashes, or hair grooming. ' +
           'Age: do not reduce apparent age; forehead lines, crow\'s feet, perioral lines, and the neck stay unchanged unless diffuse support naturally softens a fold. ' +
           'Symmetry: do not correct facial symmetry beyond the volume effect. ' +
           'Placement and shape: the support is LATERAL (lateral temple and lateral cheek fat pads) and produces an upward, outward lift, not central fill. Do not add volume to the central midface, anterior cheek, under-eye, or tear trough. Round or full front: a face that reads round, full, or heavy from the front WITH signs of descent (an older face, flattened temples and lateral cheeks, a jowl, volume slid downward and centrally) is showing deflation and descent, not excess volume, so it is a strong candidate for more lateral lift, not a reason to hold back; a young or well-supported full face with no jowl and no lateral hollowing is youthful or constitutional fullness, not descent, and must stay near baseline (do not narrow, lift, or slim it); restore lateral support so the descended central and lower-face fullness is drawn up and outward and the front becomes narrower, more lifted, and more defined. That central and lower-face fullness must DECREASE only as a consequence of the lateral lift, never from actively deflating, hollowing, slimming, carving, or skin-tightening the front. Never read a full face as needing central volume: adding central volume is the exact opposite of this treatment. Do not add filler-like or localized volume; the jowl should subtly REDUCE and the jawline read cleaner and smoother as a result of the lateral lift, but do not carve a sharp, angular, V-shaped, or superhero jawline, and never leave the jowl unchanged or make it heavier or more pronounced. Do not enlarge or round the cheeks or change facial shape, do not lift, pull, or tighten like a facelift. Never make the front of the face look fuller, rounder, swollen, or puffy: support should read as firmer and lifted, and if the choice is between too much and too little, choose less. Soften folds only partially and never fully erase nasolabial folds, marionette lines, or under-eye hollows. ' +
           'Projection scaling: the ONLY thing that changes between Early, 6 months, and Full response is the amount of diffuse subcutaneous soft-tissue support in the temples, midface, and prejowl; more support means more restored volume and softer folds, nothing else. Do not increase brightness, smoothness, symmetry, eye openness, brow definition, lip color, grooming, or apparent youth at any level. At 12 months or the Full response the extra strength shows as more support only, and must NOT bring back any skin smoothing, brightening, pigment or melasma fading, brow change, eye change, lip change, or de-aging that the lower settings correctly avoided. ' +
           'Volume-deficit floor (applies at every timeframe, including 12 months): the floor is for genuinely LEAN, well-supported faces only. If the face already shows good lateral support with minimal temple, lateral cheek, and lower-face volume loss, the result should stay very close to the original; do not invent improvements just to produce a visible change, and a longer timeframe is never a reason to add more volume than the face needs. When little deficit exists, the correct output may be nearly indistinguishable from the original, and this includes a young or well-supported full face whose fullness is youthful or constitutional rather than descended: it stays near baseline and is not narrowed or lifted. Only a full face that ALSO shows descent (jowl, lateral and temporal hollowing, an older face, volume slid downward) is the opposite case: that fullness is descent, not good support, so it is not held at baseline and instead receives more lateral lift to draw the fullness up and outward and narrow the front. ' +
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
  base: 'v3', chin: 'v1', jawline: 'v1', chin_jawline_female: 'v1', chin_jawline_male: 'v1', // M11.1: sex-branched
  nose: 'v1', lips: 'v2', cheeks: 'v2', tear_trough: 'v1', nasolabial_folds: 'v1',
  sculptra: 'v13', sculptra_oblique: 'v13', hdr: 'v1', timeline: 'v2',
  chin_jawline_overfilled: 'v1'
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
  'Allowed Sculptra change zones: the lateral temple and temporal hollow, the lateral cheek and zygomatic body, the temple-to-cheek transition, the lid-cheek junction and upper medial cheek as volume-driven support from below so the under-eye to cheek transition looks better supported, the lower lateral cheek and prejowl, and the nasolabial, marionette, and jowl shadows as they soften from restored lateral support. Project the lateral cheek and zygomatic body FORWARD as a fuller, lighter convexity: the lateral cheek and the area just in front of the ear must look filled, lifted, and supported, never darkened, hollowed, recessed, or shadowed to imitate a cheekbone. The jowl should clearly lighten and the lower mandibular border (jawline) read cleaner, firmer, and more defined as the jowl is lifted and the prejowl is supported. Do NOT carve, sharpen into a hard angular, V-line, or superhero jaw, do not directly fill the jaw angle, do not inflate the central anterior cheek into a pillow, do not paint over or fill under-eye bags or dark circles, and do not deposit filler-like volume into the tear trough: the under-eye improves only because the midface beneath it is better supported. Do not touch the lips, chin, nose, or the eye itself.';

const SCULPTRA_PHENOTYPES = {
  hollow_deflated: {
    label: 'hollow/deflated',
    clinicalLogic: 'Clinical pattern: this face shows visible volume loss or hollowing, especially around the temple, lateral cheek, midface, or lower-face transition zones. The correct Sculptra visualization is a confident, diffuse collagen-driven rebuild of the lateral scaffold that restores the depleted transition zones, without making the face round, puffy, overfilled, or younger-looking.',
    conservative: 'Magnitude: gentle but real. Add clear lateral temple and lateral cheek support that begins to fill the hollows and improve the transition zones, staying close to the original.',
    expected: 'Magnitude: a clear, confident structural restoration. Rebuild the lateral scaffold: visible lateral temple and temporal-hollow support that restores temple convexity, clear lateral cheek and zygomatic projection, a continuous temple-to-cheek-to-lid transition (a restored ogee curve) so the lid-cheek junction and under-eye look supported from below, and lower-face and prejowl suspension that lifts and clearly lightens the jowl and leaves a cleaner, more defined jawline. Nasolabial and marionette shadows soften from the support. This should read as the facial scaffold rebuilt, not as smoothed skin.',
    optimistic: 'Magnitude: a strong, fully realized Sculptra scaffold restoration at the upper end of real responders: pronounced temple convexity filling the temporal hollow, strong lateral cheek and zygomatic projection, a clearly continuous and well-supported lid-cheek-to-cheek transition, obvious lower-face and prejowl suspension with the jowl markedly lifted and lightened and a clean, defined jawline, and clearly softened folds, all from restored soft-tissue volume and never from smoothing, brightening, or de-aging the skin.'
  },
  full_descended: {
    label: 'full/descended',
    clinicalLogic: 'Clinical pattern: this face retains natural fullness, but the fullness appears insufficiently supported, with visual weight sitting lower or more centrally than ideal. This is a strong Sculptra candidate. The correct Sculptra visualization is NOT slimming, deflating, carving, V-line shaping, or making the face smaller. Preserve the patient\'s natural facial width, fullness, softness, and identity. The goal is the same facial volume character, confidently re-suspended by lateral support. Fullness should look clearly better held, not removed.',
    conservative: 'Magnitude: gentle but real. Preserve natural fullness and face width. Add clear lateral support so the lower and central fullness looks better suspended upward and laterally, without slimming or changing the mouth.',
    expected: 'Magnitude: a clear, confident re-suspension. Preserve natural fullness and face width. Rebuild lateral cheek and temple support so facial weight is visibly carried upward and laterally instead of pooling low, restore temple convexity and a continuous lid-cheek-to-cheek transition, and clearly lift and lighten the jowl with prejowl support so the lower face looks better suspended and the jawline reads cleaner and more defined. Do not make the face thinner; make the same face look distinctly better supported.',
    optimistic: 'Magnitude: a strong, fully realized re-suspension. Preserve natural fullness and face width. Add pronounced lateral support so the face looks clearly more suspended and far less downwardly pooled, with strong temple convexity, strong lateral cheek projection, a well-supported lid-cheek transition, and the jowl markedly lifted and lightened over a clean, defined jawline. Do not slim, hollow, carve, sharpen into a hard jaw, V-line, or beautify the face.'
  },
  mixed: {
    label: 'mixed hollowing/descent',
    clinicalLogic: 'Clinical pattern: this face shows a combination of volume loss and soft-tissue descent. The correct Sculptra visualization is a confident, balanced rebuild of the lateral scaffold: restore the transition zones and clearly improve how facial weight is carried, without slimming or beautifying. Preserve natural face width and identity.',
    conservative: 'Magnitude: gentle but real. Add clear lateral temple and cheek support and improved transition-zone continuity, keeping the face close to baseline.',
    expected: 'Magnitude: a clear, confident structural restoration. Rebuild the lateral scaffold: visible lateral temple and temporal-hollow support restoring temple convexity, clear lateral cheek and zygomatic projection, a continuous temple-to-cheek-to-lid transition so the lid-cheek junction and under-eye look supported from below, and lower-face and prejowl suspension that lifts and clearly lightens the jowl and leaves a cleaner, more defined jawline. Nasolabial and marionette shadows soften from the support. Read as the scaffold rebuilt, not smoothed skin. Do not slim the face.',
    optimistic: 'Magnitude: a strong, fully realized Sculptra scaffold restoration at the upper end of real responders: pronounced temple convexity, strong lateral cheek and zygomatic projection, a clearly continuous and well-supported lid-cheek-to-cheek transition, obvious lower-face and prejowl suspension with the jowl markedly lifted and lightened and a clean, defined jawline, and clearly softened folds, while preserving identity, age, skin character, and natural face width.'
  }
};

const SCULPTRA_OUTPUT_RULES =
  'Output rule: this is a clinical Sculptra visualization, not a beauty portrait, and it should show a confident, real structural result rather than a timid one. At full strength, aim for the magnitude a strong real-world Sculptra responder shows after multiple vials over several months: temples and lateral cheeks visibly re-inflated, the midface re-supported, the lid-cheek transition restored, nasolabial and marionette folds clearly softened, and the lower face re-suspended with a lighter jowl, so the face reads as structurally rebuilt. This is a visible, substantial change, not a faint one. Support must read as added volume and light (the treated areas look filled, lifted, and three-dimensional, with the natural highlight on restored convexity and the natural soft shadow beneath it), never as flat brightening, beautification, or invented brown pigment. Do not darken the skin into a muddy or discoloured patch, but the clean light-and-shadow of real restored volume is correct and expected. Per-patient conservatism is applied afterward by a separate intensity control, so at full strength restore the scaffold clearly and let that control dial it back. The image must remain unmistakably the same person, same age, same skin character, same lips, eyes, brows, lighting, and camera setup; only treatment-relevant soft-tissue support and volume change. The failure modes to avoid are beautification, skin smoothing, evening out tone, de-aging, central pillow fill, jaw carving, and identity drift, NOT insufficient volume. Early, 6-month, and Full-response levels differ ONLY in the amount of soft-tissue support, never in beauty, skin quality, or age. ' +
  'CRITICAL NASOLABIAL FOLD RULE: As lateral cheek and midface volume increases, the nasolabial fold shadow MUST soften and become shallower -- it must NEVER deepen, darken, or become more pronounced at any response level. The nasolabial fold softens as a secondary consequence of the lateral scaffold being restored: the lateral cheek tissue advances medially and the fold shadow loses depth. The shadow step between the cheek and the nasolabial region should read as less abrupt in the simulated image than in the original. If lateral cheek volume increases, the nasolabial shadow must decrease proportionally. A simulated image where the nasolabial fold is darker or deeper than the original is always wrong regardless of what else changed.';

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
    ? 'Produce a clinically realistic Sculptra collagen-stimulation visualization from this oblique consultation photograph, showing a confident structural restoration of the facial scaffold while keeping the same person, the same pose, and the same skin.'
    : 'Produce a clinically realistic Sculptra collagen-stimulation visualization from this frontal consultation photograph, showing a confident structural restoration of the facial scaffold while keeping the same person, the same pose, and the same skin.';
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

  // M10.4: overfilled education anchor. Fires when intensity is 'overfilled'
  // and the selection is chin + jawline. Returns a dedicated AI-heavy prompt
  // that deliberately shows overcorrection for patient education.
  if (sel_.intensity === 'overfilled' && areas.includes('chin') && areas.includes('jawline')) {
    const ov = FILLER_CHIN_JAWLINE_OVERFILLED;
    return `${BASE_FRAMING} ${ov.core} Avoid: ${ov.avoid}`;
  }

  // Chin + jawline are treated as a single lower-face unit when both selected.
  // M11.1: branched on sex -- male and female have different aesthetic targets.
  // Any other selected areas still append as their own clauses (full-face cases).
  let expected, avoid;
  if (areas.includes('chin') && areas.includes('jawline')) {
    const isMale = sel_.sex === 'male';
    const cjPrompt = isMale ? FILLER_CHIN_JAWLINE_MALE : FILLER_CHIN_JAWLINE_FEMALE;
    expected = cjPrompt.expected;
    avoid = cjPrompt.avoid;
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

// ---- Chin/jawline safety base (v7) -----------------------------------------
// M7.5: chin/jawline filler drops the generic SERVER_SAFETY tail the same way
// Sculptra did in M4. The generic tail says "do NOT slim the face or jaw" and
// "the result must read as the SAME photograph with only the treated area
// subtly adjusted", which directly contradicts the v6/v7 chin_jawline content
// (inward taper, jowl reduction, decisive projection) and caps the anchor at a
// conservative magnitude; on this model the prohibition voice wins, which is why
// oblique chin/jaw anchors came out timid. This base keeps every protection the
// generic tail provides (skin texture, identity, framing, no beautification)
// while making the lower-face contour change explicitly IN-SCOPE.
// v8 (M7.6): the silhouette itself is now displaced GEOMETRICALLY client-side
// (the chin/jaw projection warp in sculptra-mask.js); asking the model to
// extend the outline produced boundary artifacts in every round, so the model
// is now told the opposite: express the treatment entirely INSIDE the existing
// outline (volume, support, light, shadow) and paint nothing over the
// background. The composite discards out-of-silhouette AI pixels regardless,
// so prompt and pipeline now agree instead of fighting.
const CHIN_JAW_SAFETY =
  " CRITICAL: this is a medical consultation photograph, not a beauty image. The ONLY region that changes is the chin, jawline, and lower-face contour described above; every other pixel stays faithful to the original. " +
  "Do NOT smooth or retouch skin anywhere, remove or soften wrinkles, even out skin tone, brighten the image, raise contrast, enlarge the eyes, lift the brows, or apply any beautifying, younger-looking, or filter-like effect. " +
  "Keep ALL skin texture (pores, fine lines, blemishes) exactly as in the original, including on the treated lower face: the new contour carries the same real skin. " +
  "Do NOT change the eyes, brows, nose, lips, cheekbones, mid-face width, hairstyle, ears, clothing, jewellery, expression, head angle and pose, camera framing and crop, lighting, or background. " +
  "Reshaping the lower-face contour IS the treatment, expressed entirely INSIDE the existing face: a stronger, better-projected chin and a more defined, smoothly tapered jawline shown through volume, structural support, light, and shadow within the current outline. Do NOT paint anything outside the existing silhouette: no new tissue, glow, haze, cloud, halo, blur, or smudge over the background; the boundary between the face and the background stays exactly as photographed. " +
  "Preserve identity, ethnicity and ethnic features, and apparent age; the result must be unmistakably the same person with only the lower-face contour treated. Do not add text, labels, or watermarks.";

// True when the request is the chin+jawline lower-face unit (the client posts
// chin_jawline expanded to 'chin,jawline'). Used by the Netlify functions to
// pick the safety tail; keep this predicate in lockstep with the
// FILLER_CHIN_JAWLINE selection logic in buildCorePrompt above.
function usesChinJawSafety(type, areasField){
  if(type !== 'filler') return false;
  const areas = (Array.isArray(areasField) ? areasField : String(areasField || '').split(','))
    .map(a => a.trim());
  return areas.includes('chin') && areas.includes('jawline');
}

module.exports = { buildCorePrompt, VERSIONS, CHIN_JAW_SAFETY, usesChinJawSafety, FILLER_CHIN_JAWLINE_OVERFILLED };
