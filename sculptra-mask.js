// sculptra-mask.js
// Client-side generator for the Sculptra hybrid edit mask. Given the patient
// photo, it finds the face and returns a PNG whose TRANSPARENT pixels are the
// Sculptra treatment region (lateral temple, lateral cheek, prejowl/jawline,
// and the nasolabial/marionette fold tubes) and whose OPAQUE pixels are
// everything to protect (eyes, brows, nose, lips, central face, hairline, neck,
// background). gpt-image-1's edit endpoint edits only the transparent region, so
// this physically prevents the global beautification leak.
//
// M7.9 (v31): composite-then-warp for chin_jaw. v30 proved the displacement
// fires, and also exposed the real remaining gap: the AI's light is computed in
// the ORIGINAL frame and gated to the ORIGINAL silhouette, so the tissue the
// warp moves outward arrives flat-lit on the dark neck with no form shadow
// under the new border; it reads as a pale sticker, not a projected chin. v31
// reorders the chin_jaw pipeline: build the full composite first (patient +
// the AI's jawline shading, including the under-border shadow the deep dark
// floor permits), THEN warp that finished image. Light now travels with the
// tissue: the AI's border shadow lands under the NEW border, the chin's leading
// edge carries its shading, and the moved band inherits exactly the appearance
// the model painted for "the jawline". Sculptra keeps the M6 warp-then-blend
// order untouched (calibrated and approved); this reorder is chin_jaw only.
//
// M7.8 (v30): projection axis corrected on clinical feedback. Chin filler has
// two distinct axes: vertical ELONGATION (menton travels down) and forward
// PROJECTION (pogonion travels anteriorly); v29's oblique vector was nearly
// diagonal (15px forward, 12px down), which reads as elongation, and it led
// with the menton. v30 makes the oblique vector projection-dominant (forward
// raised, drop cut to a small accompaniment) and anchors the leading capsule at
// the POGONION (estimated just above the menton on the anterior chin contour),
// with the menton following at reduced weight so the underside stays
// continuous. Frontal is untouched: head-on, vertical lengthening IS the
// correct visible expression and it is already signed off.
//
// M7.7 (v29): oblique chin/jaw pass two. (1) Warp kernels become CAPSULES:
// each anchor's displacement stays constant along a short run in the direction
// of motion before decaying, so the silhouette edge translates rigidly instead
// of stretching; the isotropic v28 Gaussians had a displacement gradient ACROSS
// the edge, which smeared the high-contrast skin-to-background boundary into
// the soft band visible on the oblique exports. (2) The outline gate stops
// trusting the landmark oval alone: at a three-quarter view MediaPipe's
// projected face oval spills past the true jaw-neck silhouette, letting AI
// paint through onto background and neck; the gate now also requires the
// ORIGINAL pixel to be plausibly lit subject (a dark-luma floor kills black
// backdrop, deep shadow, hair, and dark clothing), and the oval's lower-face
// vertices are pulled slightly inward. (3) Magnitudes up on clinical feedback:
// stronger oblique chin travel, wider jaw-out, a mid-jaw kernel for a straight
// continuous border, and a deeper chin_jaw dark floor so the AI can draw the
// sharp shadow line that makes a jawline read as defined (chroma stays locked).
//
// M7.6 (v28): chin/jaw projection moved to GEOMETRY. Three rounds of evidence
// (M5, M7.5 runway, M7.5 prompt) show the image model will not reliably extend
// a silhouette; it either under-delivers or leaves haze/blob artifacts at the
// boundary, and a decisiveness test cannot tell decisive tissue from decisive
// garbage. So the outline now moves the same way the M6 Sculptra lift does:
// a deterministic warp of the patient's own pixels (chin forward/down, near-side
// jaw outward at obliques; vertical chin lengthening frontally), with the AI
// confined to light and shading INSIDE the face. The luminance haze gate is
// replaced by a hard outline gate: for chin_jaw, zero AI contribution outside
// the original silhouette, ever. The M7.5 mask runway is reverted (no longer
// needed; it only invited the model to paint where we now discard).
//
// M7.5 (v27): HA chin/jawline oblique pass. (1) Background haze gate in the
// compositors: outside the original face silhouette the AI's pixels are kept
// only where the change is DECISIVE (real new chin/jaw tissue is an 80+ luma
// jump over the backdrop; the faint grey smudge the model sometimes paints in
// the projection runway is 10-30 and is snapped back to the exact original).
// (2) Pose-aware projection runway in the chin_jaw mask: at a three-quarter
// view the editable band extends toward the camera-side profile direction so
// the model has room to draw the new chin and jaw forward of the old outline.
//
// M7 (v26): jaw-margin feather added to the Sculptra mask (the lower-face
// alpha now dissolves over a wide band inside the jawline silhouette, fixing
// the faint tonal step at the jaw margin seen on oblique cases), and a new
// analyzePhoto() export that returns pose plus capture-quality metrics (face
// size in frame, mean luma, sharpness) for the upload gate in the M7 UI.
//
// M6.4 (v25): extrapolation retired after three calibration rounds; the gain is
// pinned at 1.0 and the slider is pure original-to-anchor interpolation. Strong
// now means the full anchor. Anchor magnitude is the upstream lever (projection
// setting / prompt), geometry is the structural lever.
//
// M6.3 (v24): the gain now shapes FORM, not brightness. Broad brightening is
// soft-capped inside the delta (SCULPTRA_BRIGHT_CAP_FULL), the glow moved out of
// the gained delta to a fixed apply-time term, the dark floor was widened for
// underside shadow, and the lift warp stepped up again. Fixes the flat waxy
// gold look of the first v23 Strong exports.
//
// M6.2 (v23): response gain added so the composite can EXCEED the AI's own
// magnitude (see SCULPTRA_DELTA_GAIN), warp and glow recalibrated against the
// first two real before/after pairs, and the lid-cheek roll opened.
//
// M6 (v22): this module now also hosts the geometry engine. The compositors
// apply a landmark-driven LIFT WARP to the frontal Sculptra base (jowl and
// midface re-drape using the patient's own pixels) before adding the AI's
// chroma-locked luminance delta. Geometry for displacement, AI for light. See
// the M6 section below for the gating (frontal + 'full' scope only) and the
// fail-safe (anything else is exactly the M5 pipeline).
//
// The PNG is generated at the SAME pixel size the client posts the photo at
// (long edge capped at maxDim), so image and mask dimensions match, which the
// edit endpoint requires.
//
// IMPORTANT: the geometry below mirrors the validator
// (skinday-visualize-hybrid-composite-test.html). If the validator's mask
// constants change, mirror them here. This file is the production source of
// truth for the mask; the validator is the calibration copy.

import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/vision_bundle.mjs";

// ---- geometry constants (mirror of the validator) ------------------------
// Sculptra full-scope coverage (v11 scaffold tuning). The earlier values gated
// the scaffold zones the real-world results depend on: a band-by-band diff of
// the oblique cases showed the temple essentially untouched and the lid-cheek
// barely moved. These open the zones the clinician expects Sculptra to rebuild:
//   - VOL_BANDS.lower_cheek lower bound dropped 0.27 -> 0.23 so prejowl / lower
//     lateral face is covered for jowl lift and jawline definition.
//   - VOL_LAT_MIN_TEMPLE 0.34 -> 0.27 so temple support reaches medially into
//     the temporal hollow instead of only the far lateral edge.
//   - CHEEK_UE_ROLL 0.7 -> 0.30 so the cheek mask climbs to the lid-cheek
//     junction (the protected eye discs still guard the lid and eyeball), giving
//     volume-driven under-eye support from below.
//   - APEX_SIGMA_CHEEK 0.15 -> 0.17 and APEX_SIGMA_TEMPLE 0.11 -> 0.135 for
//     broader, more convex lateral cheek and temple projection.
// To revert the scaffold strength, restore these six numbers; nothing else here
// changed.
const VOL_BANDS = { temple:[0.58,0.80], cheek:[0.42,0.64], lower_cheek:[0.23,0.42] };
const VOL_FB = 0.05;
const VOL_LAT_RAMP = 0.06;
const LAT_MIN = 0.12;
const VOL_LAT_MIN_CHEEK = 0.18;
const VOL_LAT_MIN_TEMPLE = 0.27;
const CHEEK_UE_LO = 0.56, CHEEK_UE_HI = 0.64, CHEEK_UE_ROLL = 0.18;
// CHEEK_UE_ROLL 0.30 -> 0.18 (M6.2 calibration): the real-case pairs show a
// clear lid-cheek junction improvement from restored midface volume that the
// sim was under-delivering; the protected eye discs still guard the lid itself.

// M7 jaw-margin feather. Along the lower-face silhouette the active band used
// to run to the same narrow (~0.02*W) oval fade as everywhere else, leaving the
// AI's luminance shift abutting the jawline with only a few pixels of falloff;
// on oblique cases that read as a faint tonal step (discoloration) at the jaw
// margin. The Sculptra scopes now additionally fade the alpha over a wide band
// inside the lower silhouette so volume shading always dissolves well before
// the jaw edge. Upper face (temple and cheek against hair) is untouched, and HA
// chin_jaw is untouched because it must reach and move the outline.
const JAW_EDGE_FEATHER = 0.055; // wide oval blur for the lower-face guard, fraction of W
const JAW_EDGE_TOP     = 0.26;  // guard fully active below this hF (chin=0)
const JAW_EDGE_FADE_TO = 0.38;  // guard fades out by this hF (mid-cheek unaffected)

// M7.6: the M7.5 "projection runway" (offset mask segments beyond the outline
// at obliques) is REVERTED. It only gave the model room to paint boundary
// artifacts we now discard; the outline is moved geometrically instead (see
// buildChinProjectionField), so the chin_jaw mask is back to its M7 footprint.

const ZYGION = { r:234, l:454 };
const TEMPLE_OVAL = { r:127, l:356 };
const CHEEK_APEX_UP = 0.03, CHEEK_APEX_IN = 0.02, TEMPLE_APEX_IN = 0.06;
const APEX_SIGMA_CHEEK = 0.20, APEX_SIGMA_TEMPLE = 0.135;

const FOLD_SIGMA = 0.026;
const COMMISSURE = { r:61, l:291 };
const ALA = { r:64, l:294 };

const FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
const LEFT_EYE = [263,249,390,373,374,380,381,382,362,466,388,387,386,385,384,398];
const RIGHT_EYE = [33,7,163,144,145,153,154,155,133,246,161,160,159,158,157,173];
const LEFT_BROW = [276,283,282,295,285,300,293,334,296,336];
const RIGHT_BROW = [46,53,52,65,55,70,63,105,66,107];
const LIPS = [61,146,91,181,84,17,314,405,321,375,291,185,40,39,37,0,267,269,270,409,78,95,88,178,87,14,317,402,318,324,308,191,80,81,82,13,312,311,310,415];
const NOSE = [1,2,98,327,168,6,197,195,5,4,45,275,440,220,134,236,3,51,281,248,419,456,344,440];
const PROTECTED = [...new Set([...LEFT_EYE,...RIGHT_EYE,...LEFT_BROW,...RIGHT_BROW,...LIPS,...NOSE])];

// ---- small helpers (mirror of the validator) ------------------------------
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const add=(a,b)=>({x:a.x+b.x,y:a.y+b.y});
const mul=(a,k)=>({x:a.x*k,y:a.y*k});
const dot=(a,b)=>a.x*b.x+a.y*b.y;
const len=a=>Math.hypot(a.x,a.y);
const norm=a=>{const L=len(a)||1;return{x:a.x/L,y:a.y/L};};
const lerp=(a,b,t)=>({x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t});
const clamp01=v=>v<0?0:v>1?1:v;
const smoothstep=(e0,e1,x)=>{ const t=clamp01((x-e0)/((e1-e0)||1e-6)); return t*t*(3-2*t); };

function distToSeg(px,py,A,B){
  const vx=B.x-A.x, vy=B.y-A.y, wx=px-A.x, wy=py-A.y;
  const c1=vx*wx+vy*wy; if(c1<=0) return Math.hypot(px-A.x,py-A.y);
  const c2=vx*vx+vy*vy; if(c2<=c1) return Math.hypot(px-B.x,py-B.y);
  const t=c1/c2; return Math.hypot(px-(A.x+t*vx), py-(A.y+t*vy));
}

// separable box blur on a Float32 alpha field, to soften the composite boundary
function blurAlpha(m,w,h,r){
  if(r<=0) return m;
  const cx=i=>i<0?0:(i>=w?w-1:i), cy=i=>i<0?0:(i>=h?h-1:i);
  const tmp=new Float32Array(m.length), out=new Float32Array(m.length), win=2*r+1;
  for(let y=0;y<h;y++){ const row=y*w; let s=0;
    for(let k=-r;k<=r;k++) s+=m[row+cx(k)];
    for(let x=0;x<w;x++){ tmp[row+x]=s/win; s+=m[row+cx(x+r+1)]-m[row+cx(x-r)]; }
  }
  for(let x=0;x<w;x++){ let s=0;
    for(let k=-r;k<=r;k++) s+=tmp[cy(k)*w+x];
    for(let y=0;y<h;y++){ out[y*w+x]=s/win; s+=tmp[cy(y+r+1)*w+x]-tmp[cy(y-r)*w+x]; }
  }
  return out;
}

// ---- M5.1 texture-restore composite ---------------------------------------
// gpt-image-1's in-mask fill is low-frequency: it lands the broad volume and
// contour but loses the skin's high-frequency texture and chroma, so at high
// intensity the treated region reads soft. The fix keeps the AI's LOW band (the
// volume) and restores the ORIGINAL's HIGH band (real pores, fine texture,
// chroma micro-detail). A moved-edge guard detects where the AI shifted the
// silhouette (chin tip, jaw) versus merely inflated stationary skin, and falls
// back to the AI's own high band only at those moved edges, so the old outline
// does not ghost through the new one.
//
// Everything collapses to out = original + alpha * delta, with delta precomputed
// once, so the live intensity slider stays a single multiply-add per channel
// (no extra cost vs the plain composite, and no regeneration).
//
// Tuning knobs (shared by HA chin/jaw and Sculptra; safe defaults below):
//   TEX_RADIUS_FRAC  frequency cutoff as a fraction of face width W. Smaller =
//                    restores finer detail only (more AI softness survives);
//                    larger = restores coarser detail (can start re-imposing the
//                    original's medium shading and fight the AI volume).
//   TEX_STRENGTH     0..1 how much original texture to swap in. 1 = full. Drop
//                    toward ~0.85 only if the result looks over-crisp/HDR.
//   GUARD_EDGE_LO/HI local low-band-difference variation (luma levels) where the
//                    moved-edge guard begins / fully falls back to AI detail.
//                    Raise both if a real moved silhouette still shows AI soft-
//                    ness; lower them if an old edge ghosts through.
//   CHROMA_LOCK      M5.2. 0..1. The AI restores volume as LUMINANCE (highlights,
//                    softened shadows), but it also invents skin COLOR inside the
//                    mask: at high intensity that surfaces as a warm brown cloud
//                    over the treated cheek/lower face. At 1.0 the composite keeps
//                    the AI luminance and locks chroma to the patient's original,
//                    so the volume shows but no pigment is invented. Mechanically
//                    this adds a single luminance delta equally to R,G,B, which
//                    cannot shift hue. Drop toward ~0.8 only if the restored
//                    volume looks flat or grey and you want a little AI warmth back.
//   LUMA_DARK_FLOOR  M5.3. Max levels the treated skin's broad tone may DARKEN.
//                    Real Sculptra lightens skin (the glow); it does not darken it,
//                    so this is 0 (treated skin is never broadly darker than the
//                    original). Skin texture and pigment spots are carried from the
//                    original separately, so they stay; only the broad tone is
//                    floored. Raise a few levels only if you want some contour
//                    shadow back under restored volume.
//   GLOW_LUMA        M5.3. Gentle luminance lift across the treated zone at full
//                    strength (the Sculptra glow), in luma levels. Chroma stays
//                    locked and texture/pigment are untouched, so this brightens
//                    without smoothing or evening out the skin. Scaled by mask and
//                    intensity, so at the 50% default it is about half this. Lower
//                    toward 0 to remove the glow, raise for a stronger one.
const TEX_RADIUS_FRAC  = 0.016;
const TEX_BLUR_PASSES  = 2;     // box passes -> approx gaussian
const TEX_STRENGTH     = 1.0;
const GUARD_RADIUS_FRAC= 0.016;
const GUARD_EDGE_LO    = 12;
const GUARD_EDGE_HI    = 40;
const CHROMA_LOCK      = 1.0;
const LUMA_DARK_FLOOR  = 0;     // treated skin never darker than original (broad tone)
const GLOW_LUMA        = 6;     // gentle lighten (glow), luma levels at full. M6.3:
                                // back to 6, and for Sculptra the glow now lives
                                // OUTSIDE the gained delta (added at apply time,
                                // never multiplied by the response gain). The gained
                                // glow was lifting the whole treated zone ~12 levels
                                // at Strong, cancelling the underside shadows and
                                // flattening the volume into the waxy gold look.
// M5.4. 0..1. How much of the AI's high-frequency DARKENING is allowed through.
// The low-band floor stops broad darkening, but where the moved-edge guard is
// active (HA chin/jaw, which needs it to project the chin), the AI can paint a
// sharp fake shadow at the jaw or gonial corner that the guard passes through as
// dark detail. At 0 the composite adds no new shadow to skin: the patient's own
// shadows stay (they live in the untouched original), the AI may brighten, but it
// cannot deepen or invent a shadow. Raise toward ~0.3 only if you want some
// natural contour shadow back under a strongly projected chin.
const HIGH_DARKEN_SCALE = 0;

// repeated separable box blur on a Float32 plane -> approximate gaussian
function blurPlane(src,w,h,r,passes){
  if(r<=0) return src.slice();
  let cur=src; const n=Math.max(1,passes|0);
  for(let k=0;k<n;k++) cur=blurAlpha(cur,w,h,r);
  return cur;
}

// Estimate face width W in pixels at (w,h) from the landmark set, using the same
// basis as buildTreatAlpha (zygion-to-zygion projected on the lateral axis), so
// the texture-restore radius scales with the face the same way the mask does.
function faceWidthPx(L,w,h){
  const a=L[10],bp=L[152],r=L[234],l=L[454];
  if(!a||!bp||!r||!l) return 0.4*w;
  const ux=(a.x-bp.x)*w, uy=(a.y-bp.y)*h; const ln=Math.hypot(ux,uy)||1;
  const nx=ux/ln, ny=uy/ln; const ox=-ny, oy=nx;
  const dx=(l.x-r.x)*w, dy=(l.y-r.y)*h;
  return Math.abs(dx*ox+dy*oy)||(0.4*w);
}

// Precompute the per-channel delta planes for the texture-restore composite.
// Given the original (b) and AI (a0) pixels as interleaved RGBA byte buffers and
// the face width W, returns {dR,dG,dB} such that, for any in-mask alpha al,
//   out_channel = original_channel + al * d_channel
// yields: low band = lerp(originalLow, aiLow, al)  (volume dials with the slider)
//         high band = original texture, except at AI-moved edges where it falls
//                     back to the AI's own high band (no ghost of the old outline).
// At al = 0 this is exactly the original; outside the mask al = 0 by construction.
function buildTextureDelta(b,a0,w,h,W,opts){
  const N=w*h;
  const r       = Math.max(2, Math.round((opts.texRadiusFrac   ?? TEX_RADIUS_FRAC )*W));
  const gr      = Math.max(2, Math.round((opts.guardRadiusFrac ?? GUARD_RADIUS_FRAC)*W));
  const passes  = opts.texPasses ?? TEX_BLUR_PASSES;
  const strength= (opts.texStrength==null ? TEX_STRENGTH : Math.max(0,Math.min(1,opts.texStrength)));
  const lo      = opts.guardLo ?? GUARD_EDGE_LO;
  const hi      = opts.guardHi ?? GUARD_EDGE_HI;
  const clock   = (opts.chromaLock==null ? CHROMA_LOCK : Math.max(0,Math.min(1,opts.chromaLock)));
  const darkFloor = (opts.darkFloor==null ? LUMA_DARK_FLOOR : Math.max(0,opts.darkFloor));
  const glow      = (opts.glowLuma==null ? GLOW_LUMA : opts.glowLuma);
  const brightCap = (opts.brightCap==null ? 0 : Math.max(0,opts.brightCap)); // 0 = uncapped
  const highDark  = (opts.highDarkenScale==null ? HIGH_DARKEN_SCALE : Math.max(0,Math.min(1,opts.highDarkenScale)));
  // For Sculptra (inflation, no moved silhouette) the moved-edge guard is not
  // needed and is actively harmful: where the AI paints a fake submalar/cheek
  // shadow, the guard reads the sharp shadow as a moved edge and passes the AI's
  // dark high-frequency through, darkening skin the low-band floor cannot catch.
  // Forcing the guard fully open (texture always from the original) means the AI
  // can no longer inject any darkening via the high band; combined with the
  // low-band dark floor, Sculptra skin can only hold or brighten. HA chin/jaw
  // keeps the guard (it has genuine moved edges) by leaving this false.
  const forceOrig = !!opts.forceOriginalTexture;

  const bR=new Float32Array(N),bG=new Float32Array(N),bB=new Float32Array(N);
  const aR=new Float32Array(N),aG=new Float32Array(N),aB=new Float32Array(N);
  for(let i=0,p=0;i<N;i++,p+=4){
    bR[i]=b[p];bG[i]=b[p+1];bB[i]=b[p+2];
    aR[i]=a0[p];aG[i]=a0[p+1];aB[i]=a0[p+2];
  }
  const bRl=blurPlane(bR,w,h,r,passes), bGl=blurPlane(bG,w,h,r,passes), bBl=blurPlane(bB,w,h,r,passes);
  const aRl=blurPlane(aR,w,h,r,passes), aGl=blurPlane(aG,w,h,r,passes), aBl=blurPlane(aB,w,h,r,passes);

  // moved-edge guard: local variation of the low-band luma difference. A moved
  // silhouette produces a sharp transition in (aiLow - origLow); a broad volume
  // brightening over stationary skin does not, so dramatic-but-stationary
  // Sculptra volume keeps full sharp texture.
  const D=new Float32Array(N);
  for(let i=0;i<N;i++){
    const al=0.299*aRl[i]+0.587*aGl[i]+0.114*aBl[i];
    const bl=0.299*bRl[i]+0.587*bGl[i]+0.114*bBl[i];
    D[i]=al-bl;
  }
  const Dl=blurPlane(D,w,h,gr,1);

  const dR=new Float32Array(N),dG=new Float32Array(N),dB=new Float32Array(N);
  for(let i=0;i<N;i++){
    const edge=Math.abs(D[i]-Dl[i]);
    const g=forceOrig ? strength : (1-smoothstep(lo,hi,edge))*strength; // 1 = stationary skin -> full original texture
    const bHr=bR[i]-bRl[i], bHg=bG[i]-bGl[i], bHb=bB[i]-bBl[i];
    const aHr=aR[i]-aRl[i], aHg=aG[i]-aGl[i], aHb=aB[i]-aBl[i];
    const detHr=aHr+(bHr-aHr)*g, detHg=aHg+(bHg-aHg)*g, detHb=aHb+(bHb-aHb)*g;
    // per-channel (M5.1) delta: AI low band + guarded original texture, per RGB
    const cdR=(aRl[i]-bRl[i])+(detHr-bHr);
    const cdG=(aGl[i]-bGl[i])+(detHg-bHg);
    const cdB=(aBl[i]-bBl[i])+(detHb-bHb);
    if(clock<=0){
      dR[i]=cdR; dG[i]=cdG; dB[i]=cdB;
    } else {
      // M5.2 chroma-locked delta: the LUMINANCE version of the same frequency-
      // separation, added equally to R,G,B. Adding an equal scalar to all three
      // channels preserves Cb/Cr exactly, so the patient's skin colour is held
      // while the AI's volume (a luminance effect) still shows. (aLowLuma -
      // bLowLuma) is exactly D[i], already computed for the guard.
      const oYl=0.299*bRl[i]+0.587*bGl[i]+0.114*bBl[i];
      const aYl=0.299*aRl[i]+0.587*aGl[i]+0.114*aBl[i];
      const oY =0.299*bR[i] +0.587*bG[i] +0.114*bB[i];
      const aY =0.299*aR[i] +0.587*aG[i] +0.114*aB[i];
      const oYh=oY-oYl, aYh=aY-aYl;
      const detY=aYh+(oYh-aYh)*g;
      // Broad tone change from the AI volume. Real Sculptra lightens skin (glow)
      // and does not darken it, so floor any darkening of the broad tone and add
      // a gentle uniform glow lift. Texture (the high-band term below) and chroma
      // are untouched, so spots, pores, and pigment all stay; only the broad
      // luminance moves, and only upward.
      let lowShift = aYl - oYl;
      if(lowShift < -darkFloor) lowShift = -darkFloor;
      // M6.3: soft-knee the broad brightening so the response gain amplifies
      // shading structure, not flat brightness (see SCULPTRA_BRIGHT_CAP_FULL).
      else if(brightCap > 0 && lowShift > 0) lowShift = brightCap*Math.tanh(lowShift/brightCap);
      lowShift += glow;
      // High-frequency band. Brightening passes; darkening (a fake shadow the
      // guard would otherwise paint at the jaw/edge) is scaled down. The
      // patient's real shadows are untouched because they live in the original
      // (b); this only governs what the AI is allowed to ADD.
      let highTerm = detY - oYh;
      if(highTerm < 0) highTerm *= highDark;
      const dY = lowShift + highTerm;  // floored+glowed low band + non-darkening high band
      dR[i]=cdR*(1-clock)+dY*clock;
      dG[i]=cdG*(1-clock)+dY*clock;
      dB[i]=cdB*(1-clock)+dY*clock;
    }
  }
  return {dR,dG,dB};
}

// ---- M6 geometry engine: frontal lift warp ---------------------------------
// First slice of the M6 warp-first geometry engine. Sculptra's most credible
// frontal change is a LIFT (reversal of descent): the jowl and lower lateral
// face re-drape upward and the midface regains support. A lift is pure 2D
// displacement, so it is done by moving the patient's OWN pixels: texture,
// pores, pigment, and the photo's real lighting travel with the tissue, which
// is the photographic credibility no painted or AI-invented shading can
// guarantee. Light and convexity (temple, glow, projection shading) remain the
// masked AI's job via the chroma-locked luminance delta; the warp only moves
// what already exists. Geometry for displacement, AI for light.
//
// Scope and gating (this slice):
//   - Sculptra 'full' scope only, FRONTAL view only (detectPose gate). Oblique
//     and HA chin/jaw keep M5 behavior untouched.
//   - Applied to the COMPOSITE BASE, not the image sent to the AI. The AI still
//     edits the unwarped photo; its smooth luminance delta is added on top. The
//     delta is low-frequency, so the few-pixel offset between the warped base
//     and the unwarped delta is invisible.
//   - The slider scales the warp and the AI delta together: one response
//     control dials geometry and light as a unit, and 0 is exactly the original.
//   - The face silhouette NEVER moves: displacement fades to zero inside the
//     face-oval edge band, so no background is ever pulled into the face and
//     the outline stays pixel-identical (M5b export alignment is preserved).
//   - Fail-safe everywhere: any error, missing landmark, or non-frontal pose
//     disables the warp and the pipeline behaves exactly as M5.
//
// Tuning (the clinical correction loop; magnitudes are at FULL strength, which
// the slider now reaches since the 70 cap was removed in M6.2):
//   WARP_JOWL_LIFT     upward jowl/prejowl re-drape, fraction of face height.
//   WARP_JOWL_IN       inward (toward midline) component at the jowl, fraction
//                      of face width: the lift-and-narrow read. Keep small.
//   WARP_MIDFACE_LIFT  upward midface/submalar re-drape, fraction of face height.
//   WARP_*_SIGMA       kernel breadth, fraction of face width.
//   WARP_EDGE_FADE     band inside the face oval over which displacement fades
//                      to zero, fraction of face width.
// M6.2 calibration pass: magnitudes roughly doubled in effective terms. The
// real before/after pairs show genuine contour change (jowl lift, midface
// re-drape) that the M6.1 values, further attenuated by the old 0.7 slider cap,
// could not reach. The slider now spans the full 0..1, so these are the true
// full-strength figures.
const WARP_JOWL_LIFT     = 0.026;
const WARP_JOWL_IN       = 0.011;
const WARP_JOWL_SIGMA    = 0.085;
const WARP_MIDFACE_LIFT  = 0.017;
const WARP_MIDFACE_SIGMA = 0.12;
const WARP_EDGE_FADE     = 0.06;

// Jowl kernel anchor landmarks: gonion and prejowl per side; the kernel sits
// between them, nudged up onto the jowl pad itself.
const GONION  = { r:172, l:397 };
const PREJOWL = { r:176, l:400 };

// Build the lift sample-offset field at FULL strength.
// Returns { sx, sy, x0, y0, x1, y1, maxPx } or null if landmarks are missing or
// the field is empty. sx/sy are BACKWARD-map offsets: the warped image at (x,y)
// samples the original at (x + sx*t, y + sy*t). Tissue moving up by v means the
// content came from below, so the offset is the inverse of the forward
// displacement (exact enough at these few-pixel magnitudes).
function buildLiftField(L, w, h){
  const lm = L.map(p=>({x:p.x*w, y:p.y*h}));
  const p10=lm[10], p152=lm[152], zr=lm[ZYGION.r], zl=lm[ZYGION.l];
  if(!p10||!p152||!zr||!zl) return null;
  const dirUp = norm(sub(p10, p152));
  const dirOut = { x:-dirUp.y, y:dirUp.x };
  const W = Math.abs(dot(sub(zl, zr), dirOut)) || 1;
  const faceH = (dot(sub(p10, p152), dirUp)) || 1;

  // Silhouette guard: filled face oval, blurred by the edge-fade band, so the
  // displacement is full in the interior and exactly zero at and beyond the
  // outline. The outline therefore cannot move.
  const fadePx = Math.max(2, WARP_EDGE_FADE*W);
  const oc=document.createElement("canvas"); oc.width=w; oc.height=h;
  const octx=oc.getContext("2d",{willReadFrequently:true});
  octx.fillStyle="#000"; octx.fillRect(0,0,w,h);
  octx.fillStyle="#fff"; octx.beginPath();
  FACE_OVAL.forEach((idx,k)=>{ const p=lm[idx]; if(!p) return; if(k===0) octx.moveTo(p.x,p.y); else octx.lineTo(p.x,p.y); });
  octx.closePath(); octx.fill();
  octx.filter="blur("+fadePx+"px)"; octx.drawImage(oc,0,0); octx.filter="none";
  const ovalA=octx.getImageData(0,0,w,h).data;

  // Feature guard: eyes, brows, nose, and lips must not be dragged by the lift.
  // Slightly larger discs and a wider blur than the mask's protection, because
  // a moved feature is worse than a slightly smaller lift footprint.
  const pc=document.createElement("canvas"); pc.width=w; pc.height=h;
  const pctx=pc.getContext("2d",{willReadFrequently:true});
  pctx.fillStyle="#000"; pctx.fillRect(0,0,w,h);
  pctx.fillStyle="#fff";
  const rDisc=0.026*W;
  for(const idx of PROTECTED){ const p=lm[idx]; if(!p) continue;
    pctx.beginPath(); pctx.arc(p.x,p.y,rDisc,0,7); pctx.fill(); }
  pctx.filter="blur("+(0.05*W)+"px)"; pctx.drawImage(pc,0,0); pctx.filter="none";
  const protA=pctx.getImageData(0,0,w,h).data;

  // Displacement kernels, both sides. Each kernel is a Gaussian bump carrying a
  // fixed displacement vector; the field is their sum, attenuated by the guards.
  const kernels=[];
  for(const s of ["r","l"]){
    const g=lm[GONION[s]], pj=lm[PREJOWL[s]], zy=lm[ZYGION[s]];
    if(!g||!pj||!zy) continue;
    const sgn=Math.sign(dot(sub(zy,p152),dirOut)) || (s==="r"?-1:1);
    const inw={ x:-sgn*dirOut.x, y:-sgn*dirOut.y };  // unit vector toward the midline
    // Jowl re-drape: up + slightly inward, centered on the jowl pad.
    const jowlC=add(lerp(g, pj, 0.45), mul(dirUp, 0.06*faceH));
    const sigJ=WARP_JOWL_SIGMA*W;
    kernels.push({ cx:jowlC.x, cy:jowlC.y, twoSig:2*sigJ*sigJ,
      vx: dirUp.x*WARP_JOWL_LIFT*faceH + inw.x*WARP_JOWL_IN*W,
      vy: dirUp.y*WARP_JOWL_LIFT*faceH + inw.y*WARP_JOWL_IN*W });
    // Midface/submalar re-drape: straight up, centered below the cheek apex.
    const midC=add(add(zy, mul(dirUp, -0.10*faceH)), mul(inw, 0.02*W));
    const sigM=WARP_MIDFACE_SIGMA*W;
    kernels.push({ cx:midC.x, cy:midC.y, twoSig:2*sigM*sigM,
      vx: dirUp.x*WARP_MIDFACE_LIFT*faceH,
      vy: dirUp.y*WARP_MIDFACE_LIFT*faceH });
  }
  if(!kernels.length) return null;

  const N=w*h;
  const sx=new Float32Array(N), sy=new Float32Array(N);
  let x0=w, y0=h, x1=-1, y1=-1, maxPx=0;
  for(let y=0,i=0;y<h;y++){
    for(let x=0;x<w;x++,i++){
      const guard=(ovalA[i*4]/255)*(1-(protA[i*4]/255));
      if(guard<=0.01) continue;
      let dx=0, dy=0;
      for(let k=0;k<kernels.length;k++){
        const K=kernels[k]; const ex=x-K.cx, ey=y-K.cy;
        const gv=Math.exp(-(ex*ex+ey*ey)/K.twoSig);
        dx+=K.vx*gv; dy+=K.vy*gv;
      }
      // (dx,dy) is the forward tissue displacement; the backward sample offset
      // is its inverse, attenuated by the guards.
      const ox=-dx*guard, oy=-dy*guard;
      const mag=Math.hypot(ox,oy);
      if(mag<0.25) continue;
      sx[i]=ox; sy[i]=oy;
      if(mag>maxPx) maxPx=mag;
      if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
    }
  }
  if(x1<0) return null;
  const pad=Math.ceil(maxPx)+2;
  x0=Math.max(0,x0-pad); y0=Math.max(0,y0-pad);
  x1=Math.min(w-1,x1+pad); y1=Math.min(h-1,y1+pad);
  return { sx, sy, x0, y0, x1, y1, maxPx };
}

// Re-sample the warped base wb from the original b inside the field's bounding
// box at strength t (0..1). wb starts as a copy of b, and every bbox pixel is
// rewritten each call (offset scaled by t, bilinear), so any t, including 0 and
// going back DOWN the slider, is exact with no residue. Pixels outside the bbox
// are untouched originals by construction.
function applyLiftWarp(wb, b, w, h, f, t){
  if(!f) return;
  const s = Math.max(0, Math.min(1, t));
  const sx=f.sx, sy=f.sy;
  for(let y=f.y0; y<=f.y1; y++){
    const row=y*w;
    for(let x=f.x0; x<=f.x1; x++){
      const i=row+x, p=i*4;
      const ox=sx[i], oy=sy[i];
      if(ox===0 && oy===0){ wb[p]=b[p]; wb[p+1]=b[p+1]; wb[p+2]=b[p+2]; continue; }
      let fx=x+ox*s, fy=y+oy*s;
      if(fx<0) fx=0; else if(fx>w-1) fx=w-1;
      if(fy<0) fy=0; else if(fy>h-1) fy=h-1;
      const xi=fx|0, yi=fy|0;
      const x2=xi+1<w?xi+1:xi, y2=yi+1<h?yi+1:yi;
      const ax=fx-xi, ay=fy-yi;
      const w00=(1-ax)*(1-ay), w10=ax*(1-ay), w01=(1-ax)*ay, w11=ax*ay;
      const p00=(yi*w+xi)*4, p10=(yi*w+x2)*4, p01=(y2*w+xi)*4, p11=(y2*w+x2)*4;
      wb[p]  =b[p00]*w00+b[p10]*w10+b[p01]*w01+b[p11]*w11;
      wb[p+1]=b[p00+1]*w00+b[p10+1]*w10+b[p01+1]*w01+b[p11+1]*w11;
      wb[p+2]=b[p00+2]*w00+b[p10+2]*w10+b[p01+2]*w01+b[p11+2]*w11;
    }
  }
}

// Gate + build the lift field for a compositor run. Frontal Sculptra 'full'
// scope only this milestone; everything else returns null (exact M5 behavior).
// opts.warp === false is the A/B escape hatch. Never throws.
async function maybeBuildLift(beforeImg, landmarks, w, h, scope, opts){
  if(scope !== 'full') return null;
  if(opts && opts.warp === false) return null;
  try {
    const pose = await detectPose(beforeImg);
    if(!pose || pose.view !== 'frontal'){
      console.log('%c[Visualize] M6 lift warp skipped: view is ' + ((pose && pose.view) || 'unknown') + ' (frontal only this milestone).', 'color:#888');
      return null;
    }
    const f = buildLiftField(landmarks, w, h);
    if(f){
      console.log('%c[Visualize] M6 lift warp ACTIVE (frontal, yaw ~' + Math.round(pose.yawDeg) + ' deg): max displacement ' + f.maxPx.toFixed(1) + 'px at full strength.', 'color:#2e7d32;font-weight:bold');
    } else {
      console.warn('[Visualize] M6 lift warp unavailable (landmarks incomplete); compositing without it.');
    }
    return f;
  } catch(e){
    console.warn('[Visualize] M6 lift warp failed to build; compositing without it.', e);
    return null;
  }
}

// ---- M7.6 chin/jaw projection warp ------------------------------------------
// Deterministic silhouette displacement for HA chin/jawline, built on the same
// field format and backward-mapping resampler as the M6 Sculptra lift. The
// decisive difference from the lift: there is NO oval guard, because moving the
// outline is the whole point. The patient's own pixels are re-draped outward,
// so the projected chin and jaw carry real skin texture with a crisp edge
// against any background by construction; backward mapping means pixels beyond
// the old outline sample from inside it (skin), never invented tissue.
//
// Magnitudes at full strength (slider = 100), as fractions of face width W or
// face height faceH. Calibrated to read as a strong 3-4 syringe lower-face
// result at typical consult framing (about 10-14 px of chin travel on a 1024px
// photo); CHINW_FWD / CHINW_DOWN are the first levers if calibration against
// real before/afters asks for more or less.
// v30 calibration (clinical: PROJECTION, not elongation, at obliques): FWD
// 0.045 -> 0.060 and DOWN 0.028 -> 0.012, so the oblique vector is ~14 degrees
// below horizontal instead of ~38, and the pogonion leads (see field builder).
// v29 had raised both axes together, which read as diagonal lengthening.
// These remain the first levers either direction.
const CHINW_FWD          = 0.060; // oblique: pogonion toward the camera-side profile direction (anterior)
const CHINW_DOWN         = 0.012; // oblique: small accompanying drop only (elongation is NOT the goal here)
const CHINW_DOWN_FRONTAL = 0.025; // frontal: pure vertical lengthening (projection is invisible head-on)
const CHINW_JAW_OUT      = 0.016; // oblique: near-side mandibular border outward (crisper border)
const CHINW_JAW_OUT_MALE = 1.4;   // male jaw-width factor on top of CHINW_JAW_OUT
const CHINW_SIG_CHIN     = 0.085; // kernel radius of the chin kernels, fraction of W
const CHINW_POGO_UP      = 0.055; // pogonion estimate: above the menton along the face axis, fraction of faceH
const CHINW_POGO_OUT     = 0.015; // and slightly toward the near-side profile line, fraction of W
const CHINW_SIG_JAW      = 0.055; // kernel radius of the jaw kernels, fraction of W
// Capsule run factor: displacement stays at full strength from the anchor along
// the motion direction for |v|*CHINW_CAPSULE before decaying, so the moved
// silhouette edge translates rigidly (sharp) instead of stretching (smear).
const CHINW_CAPSULE      = 1.25;

function buildChinProjectionField(L, w, h, pose, sex){
  const lm = L.map(p=>({x:p.x*w, y:p.y*h}));
  const p10=lm[10], p152=lm[152], zr=lm[ZYGION.r], zl=lm[ZYGION.l];
  if(!p10||!p152||!zr||!zl) return null;
  const dirUp = norm(sub(p10, p152));
  const dirOut = { x:-dirUp.y, y:dirUp.x };
  const W = Math.abs(dot(sub(zl, zr), dirOut)) || 1;
  const faceH = (dot(sub(p10, p152), dirUp)) || 1;
  const down = { x:-dirUp.x, y:-dirUp.y };
  const isMale = sex === 'male';

  // Capsule kernel: the field is exp(-d^2/twoSig) of the distance to a short
  // SEGMENT from the anchor along the displacement direction (length
  // |v|*CHINW_CAPSULE). Along the motion the displacement therefore plateaus
  // through and past the silhouette edge (rigid translation, crisp edge);
  // perpendicular to it, and back toward the lips, falloff stays Gaussian.
  function capsule(c, v, sig, scale){
    const vx=v.x*(scale==null?1:scale), vy=v.y*(scale==null?1:scale);
    const len=Math.hypot(vx,vy)||1e-6;
    const run=len*CHINW_CAPSULE;
    return { ax:c.x, ay:c.y,
             bx:c.x+(vx/len)*run, by:c.y+(vy/len)*run,
             twoSig:2*sig*sig, vx, vy };
  }
  const kernels=[];
  if(pose && pose.view === 'three_quarter' && (pose.nearSide === 'left' || pose.nearSide === 'right') && lm[454] && lm[234]){
    // Oblique: project along the camera-side profile direction plus a drop.
    const leftSign = Math.sign(dot(sub(lm[454], p152), dirOut)) || 1;
    const nearSign = (pose.nearSide === 'left') ? leftSign : -leftSign;
    const nearDir = mul(dirOut, nearSign);
    const chinV = add(mul(nearDir, CHINW_FWD*W), mul(down, CHINW_DOWN*faceH));
    const jawOut = CHINW_JAW_OUT * (isMale ? CHINW_JAW_OUT_MALE : 1);
    const paraNear = (pose.nearSide === 'right') ? lm[148] : lm[377];
    const pjNear   = (pose.nearSide === 'right') ? lm[PREJOWL.r] : lm[PREJOWL.l];
    const goNear   = (pose.nearSide === 'right') ? lm[GONION.r]  : lm[GONION.l];
    const sigC=CHINW_SIG_CHIN*W, sigJ=CHINW_SIG_JAW*W;
    // Pogonion leads the projection: anchored just above the menton on the
    // anterior chin contour. The menton follows at reduced weight (continuous
    // underside, no independent downward slide), para-menton carries the front
    // face of the chin with it.
    const pogo = add(add(p152, mul(dirUp, CHINW_POGO_UP*faceH)), mul(nearDir, CHINW_POGO_OUT*W));
    kernels.push(capsule(pogo, chinV, sigC));
    kernels.push(capsule(p152, chinV, sigC*0.9, 0.75));
    if(paraNear) kernels.push(capsule(paraNear, chinV, sigC*0.8, 0.8));
    if(pjNear){
      const v = add(mul(nearDir, jawOut*W), mul(chinV, 0.30));
      kernels.push(capsule(pjNear, v, sigJ));
    }
    // Mid-jaw kernel between prejowl and gonion: keeps the redefined border one
    // straight, continuous line instead of two bumps (the "sharp jawline" read).
    if(pjNear && goNear){
      const mid = lerp(pjNear, goNear, 0.5);
      kernels.push(capsule(mid, mul(nearDir, jawOut*0.85*W), sigJ));
    }
    if(goNear){
      kernels.push(capsule(goNear, mul(nearDir, jawOut*0.7*W), sigJ));
    }
  } else if(pose && pose.view === 'frontal'){
    // Frontal: projection toward the camera is invisible head-on; what reads is
    // vertical lengthening of the lower third. Chin point plus both para-menton
    // points travel down; jaw width is untouched (the AI taper handles shape).
    const chinV = mul(down, CHINW_DOWN_FRONTAL*faceH);
    const sigC=CHINW_SIG_CHIN*W;
    kernels.push(capsule(p152, chinV, sigC));
    for(const idx of [148, 377]){
      const p=lm[idx]; if(!p) continue;
      kernels.push(capsule(p, chinV, sigC*0.8, 0.7));
    }
  } else {
    return null; // out_of_range or no pose: no geometric projection
  }
  if(!kernels.length) return null;

  // Feature guard only (lips, nose, eyes, brows must not be dragged); NO oval
  // guard, the silhouette is supposed to move. Same disc/blur recipe as the lift.
  const pc=document.createElement("canvas"); pc.width=w; pc.height=h;
  const pctx=pc.getContext("2d",{willReadFrequently:true});
  pctx.fillStyle="#000"; pctx.fillRect(0,0,w,h);
  pctx.fillStyle="#fff";
  const rDisc=0.026*W;
  for(const idx of PROTECTED){ const p=lm[idx]; if(!p) continue;
    pctx.beginPath(); pctx.arc(p.x,p.y,rDisc,0,7); pctx.fill(); }
  pctx.filter="blur("+(0.05*W)+"px)"; pctx.drawImage(pc,0,0); pctx.filter="none";
  const protA=pctx.getImageData(0,0,w,h).data;

  // Evaluate only a window around the kernels (3.5 sigma around both capsule
  // ends + travel), not the whole frame; the field is zero elsewhere.
  let kx0=w, ky0=h, kx1=0, ky1=0, travel=0;
  for(const K of kernels){
    const r=3.5*Math.sqrt(K.twoSig/2), t=Math.hypot(K.vx,K.vy);
    if(t>travel) travel=t;
    kx0=Math.min(kx0, K.ax-r, K.bx-r); kx1=Math.max(kx1, K.ax+r, K.bx+r);
    ky0=Math.min(ky0, K.ay-r, K.by-r); ky1=Math.max(ky1, K.ay+r, K.by+r);
  }
  const padK=Math.ceil(travel)+2;
  const wx0=Math.max(0, Math.floor(kx0-padK)), wy0=Math.max(0, Math.floor(ky0-padK));
  const wx1=Math.min(w-1, Math.ceil(kx1+padK)), wy1=Math.min(h-1, Math.ceil(ky1+padK));

  const N=w*h;
  const sx=new Float32Array(N), sy=new Float32Array(N);
  let x0=w, y0=h, x1=-1, y1=-1, maxPx=0;
  for(let y=wy0;y<=wy1;y++){
    for(let x=wx0;x<=wx1;x++){
      const i=y*w+x;
      let dx=0, dy=0;
      for(let k=0;k<kernels.length;k++){
        const K=kernels[k];
        const dd=distToSeg(x, y, {x:K.ax, y:K.ay}, {x:K.bx, y:K.by});
        const gv=Math.exp(-(dd*dd)/K.twoSig);
        dx+=K.vx*gv; dy+=K.vy*gv;
      }
      const guard=1-(protA[i*4]/255);
      const ox=-dx*guard, oy=-dy*guard;
      const mag=Math.hypot(ox,oy);
      if(mag<0.25) continue;
      sx[i]=ox; sy[i]=oy;
      if(mag>maxPx) maxPx=mag;
      if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
    }
  }
  if(x1<0) return null;
  const pad=Math.ceil(maxPx)+2;
  x0=Math.max(0,x0-pad); y0=Math.max(0,y0-pad);
  x1=Math.min(w-1,x1+pad); y1=Math.min(h-1,y1+pad);
  return { sx, sy, x0, y0, x1, y1, maxPx };
}

// Gate + build the chin/jaw projection field. chin_jaw scope only; opts.warp
// === false is the same A/B escape hatch as the Sculptra lift (?warp=off).
// Never throws.
async function maybeBuildChinWarp(beforeImg, landmarks, w, h, sex, opts){
  if(opts && opts.warp === false) return null;
  try {
    const pose = await detectPose(beforeImg);
    if(!pose || !pose.view || pose.view === 'out_of_range'){
      console.log('%c[Visualize] M7.6 chin warp skipped: view is ' + ((pose && pose.view) || 'unknown') + '.', 'color:#888');
      return null;
    }
    const f = buildChinProjectionField(landmarks, w, h, pose, sex);
    if(f){
      console.log('%c[Visualize] M7.6 chin/jaw projection warp ACTIVE (' + pose.view + (pose.view === 'three_quarter' ? ', near side ' + pose.nearSide : '') + '): max displacement ' + f.maxPx.toFixed(1) + 'px at full strength.', 'color:#2e7d32;font-weight:bold');
    } else {
      console.warn('[Visualize] M7.6 chin warp unavailable (landmarks incomplete); compositing without it.');
    }
    return f;
  } catch(e){
    console.warn('[Visualize] M7.6 chin warp failed to build; compositing without it.', e);
    return null;
  }
}

// One warp per scope: Sculptra 'full' gets the frontal lift, HA chin_jaw gets
// the projection warp, everything else composites without geometry.
async function buildWarpForScope(beforeImg, landmarks, w, h, scope, sex, opts){
  if(scope === 'full') return maybeBuildLift(beforeImg, landmarks, w, h, scope, opts);
  if(scope === 'chin_jaw') return maybeBuildChinWarp(beforeImg, landmarks, w, h, sex, opts);
  return null;
}

// ---- M7.6/M7.7 outline gate ---------------------------------------------------
// chin_jaw scope only. History: M7.5 tried a luminance "decisiveness" gate here
// (keep out-of-silhouette AI pixels only where |delta luma| was large), which
// killed the faint grey haze but waved through the bright white blobs the model
// painted once the prompt demanded decisive edges; decisive garbage passes a
// decisiveness test. v28 ended the arms race: the silhouette is moved
// GEOMETRICALLY (buildChinProjectionField), so the AI has no legitimate
// business outside the face, and the gate became a hard outline lock.
// v29 hardened it further: at a three-quarter view MediaPipe's projected face
// oval spills past the true jaw-neck silhouette, so a landmark-only lock still
// let AI paint through onto background and neck in that strip. The gate now
// also requires the ORIGINAL pixel to be plausibly lit subject: a dark-luma
// floor (GATE_LUMA_LO..HI) zeroes the black backdrop, deep shadow, hair, and
// dark clothing (none of which the AI should repaint anyway), and the oval's
// lower-face vertices are pulled inward by GATE_LOWER_PULL_IN so the polygon
// hugs the real jawline. Light walls are still covered by the oval term.
const GATE_LUMA_LO = 10;       // original luma at or below this: gate 0
const GATE_LUMA_HI = 26;       // fully open above this
const GATE_LOWER_PULL_IN = 0.015; // lower-face oval vertices toward centroid, fraction of W

function buildOutlineGate(L, w, h, b){
  const lm = L.map(p=>({x:p.x*w, y:p.y*h}));
  const p152 = lm[152];
  const dirUp = norm(sub(lm[10], p152));
  const dirOut = { x:-dirUp.y, y:dirUp.x };
  const W = Math.abs(dot(sub(lm[454], lm[234]), dirOut)) || 1;
  const faceH = (dot(sub(lm[10], p152), dirUp)) || 1;

  // Oval polygon with the lower-face vertices pulled slightly inward.
  const pts = [];
  let cxm=0, cym=0, n=0;
  for(const idx of FACE_OVAL){ const p=lm[idx]; if(!p) continue; cxm+=p.x; cym+=p.y; n++; }
  cxm/=Math.max(1,n); cym/=Math.max(1,n);
  for(const idx of FACE_OVAL){
    const p=lm[idx]; if(!p) continue;
    const hF = dot(sub(p, p152), dirUp)/faceH;
    if(hF < 0.30){
      const pull = GATE_LOWER_PULL_IN*W * (1 - smoothstep(0.18, 0.30, hF));
      const d = norm(sub({x:cxm,y:cym}, p));
      pts.push(add(p, mul(d, pull)));
    } else {
      pts.push(p);
    }
  }
  const oc=document.createElement("canvas"); oc.width=w; oc.height=h;
  const octx=oc.getContext("2d",{willReadFrequently:true});
  octx.fillStyle="#000"; octx.fillRect(0,0,w,h);
  octx.fillStyle="#fff"; octx.beginPath();
  pts.forEach((p,k)=>{ if(k===0) octx.moveTo(p.x,p.y); else octx.lineTo(p.x,p.y); });
  octx.closePath(); octx.fill();
  octx.filter="blur("+(0.015*W)+"px)"; octx.drawImage(oc,0,0); octx.filter="none";
  const oval=octx.getImageData(0,0,w,h).data;

  const N=w*h, g=new Float32Array(N);
  for(let i=0,p4=0;i<N;i++,p4+=4){
    const ov=oval[p4]/255;
    if(ov<=0){ g[i]=0; continue; }
    const Y=0.299*b[p4]+0.587*b[p4+1]+0.114*b[p4+2];
    g[i]=ov*smoothstep(GATE_LUMA_LO, GATE_LUMA_HI, Y);
  }
  return g;
}

// ---- model singleton ------------------------------------------------------
let _landmarker = null;
async function ensureModel(){
  if(_landmarker) return _landmarker;
  const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm");
  _landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions:{ modelAssetPath:"https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task" },
    runningMode:"IMAGE", numFaces:1, outputFacialTransformationMatrixes:true
  });
  return _landmarker;
}

// Detect once per image element and memoize, so mask generation and the later
// composite do not run the model twice on the same photo. We also memoize the
// facial transformation matrix (column-major 4x4) for pose readout.
let _lastDetectEl = null, _lastDetect = null, _lastMatrix = null;
async function detectFace(imgEl){
  if(_lastDetectEl === imgEl && _lastDetect) return _lastDetect;
  const landmarker = await ensureModel();
  const res = landmarker.detect(imgEl);
  const out = (res && res.faceLandmarks && res.faceLandmarks.length) ? res.faceLandmarks[0] : null;
  const mtx = (res && res.facialTransformationMatrixes && res.facialTransformationMatrixes.length)
            ? res.facialTransformationMatrixes[0].data : null;
  _lastDetectEl = imgEl; _lastDetect = out; _lastMatrix = mtx;
  return out;
}

// ---- M-obl spike: head-pose readout --------------------------------------
// Classifies the view as frontal / three_quarter / out_of_range and reports the
// near (camera-facing) side, so the oblique-Sculptra shakedown can confirm pose
// and near-side detection with no change to the mask math. Shares detectFace's
// memoized result, so it adds no extra model run on a photo already masked.
//
// Yaw magnitude: primary source is the facial transformation matrix (the
// horizontal tilt of the face-forward axis, taken as a magnitude so it is robust
// to the canonical model's forward-sign convention). If the matrix is missing we
// fall back to a 2D half-width-ratio proxy. Near side: always the 2D rule (the
// wider projected half-face is the one turned toward the camera), unambiguous in
// image space; we do not trust the matrix sign for side. Both yaw figures are
// returned so the shakedown can confirm the matrix path agrees with the proxy
// before HA-oblique leans on the matrix for the projection axis.
const VIEW_FRONTAL_MAX_DEG = 15;   // |yaw| at or below this = frontal
const VIEW_TQ_MAX_DEG      = 50;   // frontal..this = three_quarter; above = out_of_range

export async function detectPose(imgEl){
  const lm = await detectFace(imgEl);
  if(!lm) return { ok:false, reason:'no_face', view:null, yawDeg:null, nearSide:null, matrixYawDeg:null, proxyYawDeg:null, source:null };

  // 2D half-width proxy + near side (normalized coords; the ratio is scale-free).
  const up = norm(sub(lm[10], lm[152]));
  const out = { x:-up.y, y:up.x };
  const latOf = p => p.x*out.x + p.y*out.y;
  const mid = latOf(lm[168]);                    // nose-bridge lateral position
  const halfR = Math.abs(latOf(lm[234]) - mid);  // right zygion to midline
  const halfL = Math.abs(latOf(lm[454]) - mid);  // left zygion to midline
  const lo = Math.min(halfR, halfL), hi = Math.max(halfR, halfL) || 1e-6;
  const proxyYawDeg = Math.acos(Math.max(0, Math.min(1, lo/hi))) * 180/Math.PI;
  const nearSide = halfL >= halfR ? 'left' : 'right'; // wider half = camera-facing

  // Matrix yaw: horizontal tilt of the rotated face-forward axis (3rd column of
  // the rotation), as a magnitude in [0,90] so the forward-sign convention does
  // not flip a frontal face to 180 degrees.
  let matrixYawDeg = null;
  if(_lastMatrix && _lastMatrix.length >= 11){
    const fx = _lastMatrix[8], fz = _lastMatrix[10];
    matrixYawDeg = Math.atan2(Math.abs(fx), Math.abs(fz)) * 180/Math.PI;
  }

  const source = (matrixYawDeg != null) ? 'matrix' : 'proxy';
  const yawDeg = (matrixYawDeg != null) ? matrixYawDeg : proxyYawDeg;
  let view;
  if(yawDeg <= VIEW_FRONTAL_MAX_DEG) view = 'frontal';
  else if(yawDeg <= VIEW_TQ_MAX_DEG) view = 'three_quarter';
  else view = 'out_of_range';

  return {
    ok: view !== 'out_of_range',
    reason: view === 'out_of_range' ? ('yaw_gt_' + VIEW_TQ_MAX_DEG) : 'ok',
    view, yawDeg, source,
    nearSide: view === 'frontal' ? 'center' : nearSide,
    matrixYawDeg, proxyYawDeg
  };
}

// ---- M7 capture-quality readout -------------------------------------------
// Pose plus capture-quality metrics for the upload gate. Shares the memoized
// face detection (no extra model run on a photo that will be masked anyway).
// Returns all detectPose fields plus:
//   faceFrac  - face-oval bounding box area as a fraction of the frame (0..1);
//               small values mean the patient is too far from the camera.
//   meanLuma  - mean luma (0..255) of the face crop; exposure sanity check.
//   sharpness - Laplacian variance of a fixed-size grayscale face crop; low
//               values suggest blur. Scale depends on the fixed 160px sampling,
//               so thresholds belong to the caller, not here.
// Metric failures degrade to null fields, never throw past the pose result.
export async function analyzePhoto(imgEl){
  const pose = await detectPose(imgEl);
  if(!pose || !pose.view) return { ...pose, faceFrac:null, meanLuma:null, sharpness:null };
  try {
    const lm = await detectFace(imgEl); // memoized
    let x0=1,y0=1,x1=0,y1=0;
    for(const idx of FACE_OVAL){ const p=lm[idx]; if(!p) continue;
      if(p.x<x0)x0=p.x; if(p.x>x1)x1=p.x; if(p.y<y0)y0=p.y; if(p.y>y1)y1=p.y; }
    const faceFrac = Math.max(0,(x1-x0))*Math.max(0,(y1-y0));
    const iw=imgEl.naturalWidth||imgEl.width, ih=imgEl.naturalHeight||imgEl.height;
    const bx=Math.max(0,Math.floor(x0*iw)), by=Math.max(0,Math.floor(y0*ih));
    const bw=Math.max(1,Math.ceil((x1-x0)*iw)), bh=Math.max(1,Math.ceil((y1-y0)*ih));
    const S=160, sc=Math.min(1, S/Math.max(bw,bh));
    const cw=Math.max(8,Math.round(bw*sc)), ch=Math.max(8,Math.round(bh*sc));
    const c=document.createElement('canvas'); c.width=cw; c.height=ch;
    const cx2=c.getContext('2d',{willReadFrequently:true});
    cx2.drawImage(imgEl,bx,by,bw,bh,0,0,cw,ch);
    const d=cx2.getImageData(0,0,cw,ch).data;
    const g=new Float32Array(cw*ch); let sum=0;
    for(let i=0,p=0;i<g.length;i++,p+=4){ const Y=0.299*d[p]+0.587*d[p+1]+0.114*d[p+2]; g[i]=Y; sum+=Y; }
    const meanLuma=sum/g.length;
    let lsum=0,l2=0,n=0;
    for(let y=1;y<ch-1;y++){ for(let x=1;x<cw-1;x++){ const i=y*cw+x;
      const L=4*g[i]-g[i-1]-g[i+1]-g[i-cw]-g[i+cw]; lsum+=L; l2+=L*L; n++; } }
    const meanL=lsum/n, sharpness=l2/n-meanL*meanL;
    return { ...pose, faceFrac, meanLuma, sharpness };
  } catch(err){
    console.warn('[Visualize] analyzePhoto metrics failed; returning pose only.', err);
    return { ...pose, faceFrac:null, meanLuma:null, sharpness:null };
  }
}

function buildFoldSegs(lm, p152, dirUp, dirOut, faceH, W){
  const segs=[];
  for(const s of ["r","l"]){
    const C0=lm[COMMISSURE[s]], ala=lm[ALA[s]];
    if(!C0||!ala) continue;
    const sgn=Math.sign(dot(sub(C0,p152),dirOut)) || (s==="r"?-1:1);
    const lat=v=>mul(dirOut, sgn*v*W);
    const upv=v=>mul(dirUp, v*faceH);
    const nlfBot=add(add(C0, upv(0.020)), lat(0.012));
    const nlfMid=add(lerp(ala,nlfBot,0.5), lat(0.018));
    segs.push([ala,nlfMid],[nlfMid,nlfBot]);
    const marTop=add(C0, upv(-0.010));
    const marBot=add(add(C0, upv(-0.130)), lat(0.030));
    segs.push([marTop,marBot]);
  }
  return segs;
}

// Build the feathered treatment-region alpha (0..1, 1 = fully editable).
// scope: 'full' = temple+cheek+lower+folds+apex; 'temple_fold' = temporal fossa +
// temporal apex + nasolabial/marionette folds only (cheeks/midface/under-eye stay
// original); 'temple' = fossa + temporal apex only; 'chin_jaw' = HA filler chin pad
// + mandibular border only (lips/nose/eyes/brows/cheeks/midface/neck protected).
function buildTreatAlpha(L, w, h, scope, sex){
  const lm = L.map(p=>({x:p.x*w, y:p.y*h}));
  const p152 = lm[152];
  const dirUp = norm(sub(lm[10], lm[152]));
  const dirOut = { x:-dirUp.y, y:dirUp.x };
  const W = Math.abs(dot(sub(lm[454], lm[234]), dirOut)) || 1;
  const faceH = (dot(sub(lm[10], lm[152]), dirUp)) || 1;

  // protected exclusion: discs over protected landmarks, blurred
  const pc=document.createElement("canvas"); pc.width=w; pc.height=h;
  const pctx=pc.getContext("2d",{willReadFrequently:true});
  pctx.fillStyle="#000"; pctx.fillRect(0,0,w,h);
  pctx.fillStyle="#fff";
  const rDisc=0.020*W;
  for(const idx of PROTECTED){ const p=lm[idx]; if(!p) continue;
    pctx.beginPath(); pctx.arc(p.x,p.y,rDisc,0,7); pctx.fill(); }
  // Perioral protection: the cutaneous upper lip / philtrum sits in a gap
  // between the nose-base discs and the vermilion discs, and the nasolabial fold
  // tubes bleed into it, which lets the model smear that strip into a faint
  // shadow. Protect it explicitly with a filled band from the alar bases and
  // subnasale down to the central upper vermilion, kept medial of the mouth
  // corners so the lateral fold softening is preserved.
  pctx.beginPath();
  [98,2,327,270,267,0,37,40].forEach((idx,k)=>{ const p=lm[idx]; if(!p) return; if(k===0) pctx.moveTo(p.x,p.y); else pctx.lineTo(p.x,p.y); });
  pctx.closePath(); pctx.fill();
  { const pf=lm[164]; if(pf){ pctx.beginPath(); pctx.arc(pf.x,pf.y,rDisc,0,7); pctx.fill(); } }
  pctx.filter="blur("+(0.028*W)+"px)"; pctx.drawImage(pc,0,0); pctx.filter="none";
  const protA=pctx.getImageData(0,0,w,h).data;

  // face-oval containment
  const oc=document.createElement("canvas"); oc.width=w; oc.height=h;
  const octx=oc.getContext("2d",{willReadFrequently:true});
  octx.fillStyle="#000"; octx.fillRect(0,0,w,h);
  octx.fillStyle="#fff"; octx.beginPath();
  FACE_OVAL.forEach((idx,k)=>{ const p=lm[idx]; if(k===0) octx.moveTo(p.x,p.y); else octx.lineTo(p.x,p.y); });
  octx.closePath(); octx.fill();
  octx.filter="blur("+(0.02*W)+"px)"; octx.drawImage(oc,0,0); octx.filter="none";
  const ovalA=octx.getImageData(0,0,w,h).data;

  // M7: a second, wide-feathered oval drives the jaw-margin guard below.
  octx.fillStyle="#000"; octx.fillRect(0,0,w,h);
  octx.fillStyle="#fff"; octx.beginPath();
  FACE_OVAL.forEach((idx,k)=>{ const p=lm[idx]; if(k===0) octx.moveTo(p.x,p.y); else octx.lineTo(p.x,p.y); });
  octx.closePath(); octx.fill();
  octx.filter="blur("+(JAW_EDGE_FEATHER*W)+"px)"; octx.drawImage(oc,0,0); octx.filter="none";
  const ovalWideA=octx.getImageData(0,0,w,h).data;

  // apex centers anchored to lateral landmarks
  const cC=[], cT=[];
  for(const s of ["r","l"]){
    const zy=lm[ZYGION[s]];
    const zside=Math.sign(dot(sub(zy,p152), dirOut))||1;
    const cheekC=add(add(zy, mul(dirUp, CHEEK_APEX_UP*faceH)), mul(dirOut, -zside*CHEEK_APEX_IN*W));
    cC.push(cheekC);
    const to=lm[TEMPLE_OVAL[s]];
    const tside=Math.sign(dot(sub(to,p152), dirOut))||1;
    const tempC=add(to, mul(dirOut, -tside*TEMPLE_APEX_IN*W));
    cT.push(tempC);
  }
  const twoSigC=2*(APEX_SIGMA_CHEEK*W)*(APEX_SIGMA_CHEEK*W);
  const twoSigT=2*(APEX_SIGMA_TEMPLE*W)*(APEX_SIGMA_TEMPLE*W);

  const foldSegs=buildFoldSegs(lm, p152, dirUp, dirOut, faceH, W);
  const twoSigFold=2*(FOLD_SIGMA*W)*(FOLD_SIGMA*W);

  // HA filler lower-face anchors (chin + mandibular border), sex-aware.
  // Female: chin tapers to a narrow central point at alar width, gonial angle
  // stays closed (never widen/lower a woman's jaw, the common masculinising
  // error). Male: wider, squarer chin at oral-commissure width, and the gonial
  // angle is opened so the jaw can be widened/straightened from the front. The
  // central column below the chin is reopened for vertical lengthening either way.
  const isMale = sex === 'male';
  const LF_JAW_SIGMA=0.035*W, LF_TOP=0.32;
  const twoSigJaw=2*LF_JAW_SIGMA*LF_JAW_SIGMA||1e-6;
  const chinC=add(p152, mul(dirUp, 0.02*faceH)); // near the menton, biased toward the chin point and the elongation column
  // chin width by landmark: female ~ alar (nostril) width, male ~ oral-commissure width
  const alaHalf = (lm[ALA.l]&&lm[ALA.r]) ? Math.abs(dot(sub(lm[ALA.l], lm[ALA.r]), dirOut))/2 : 0.08*W;
  const comHalf = (lm[COMMISSURE.l]&&lm[COMMISSURE.r]) ? Math.abs(dot(sub(lm[COMMISSURE.l], lm[COMMISSURE.r]), dirOut))/2 : 0.14*W;
  const chinHalf = isMale ? comHalf*0.95 : alaHalf*0.45; // male: square flat bottom; female: taper to near-central point
  const chinA = sub(chinC, mul(dirOut, chinHalf));
  const chinB = add(chinC, mul(dirOut, chinHalf));
  const LF_CHIN_SIGMA=(isMale?0.11:0.12)*W;
  const twoSigChin=2*LF_CHIN_SIGMA*LF_CHIN_SIGMA||1e-6;
  // male only: open the gonial angle for jaw width; empty for female
  const twoSigGonial=2*(0.065*W)*(0.065*W)||1e-6;
  const gonialPts = isMale ? [lm[172], lm[397]].filter(Boolean) : [];
  const JAW_POLY=[397,365,379,378,400,377,152,148,176,149,150,136,172]; // right gonion -> chin -> left gonion
  const jawSegs=[];
  for(let k=0;k+1<JAW_POLY.length;k++){ const A=lm[JAW_POLY[k]], B=lm[JAW_POLY[k+1]]; if(A&&B) jawSegs.push([A,B]); }

  // Lateral lower-face taper. As the chin lengthens and projects, the soft lower
  // third follows it down and the lateral contour tapers slightly inward; locking
  // that contour makes the chin look stretched rather than refined. Unlock a
  // feathered band straddling the lower-lateral silhouette (jaw-near-chin ->
  // gonion -> jaw angle), wide enough to sit a little outside the outline so the
  // edit can pull it in. Sex-aware: a woman's lower face may taper (feminising);
  // a man's jaw width is preserved, so the band is mostly off. Kept below the
  // cheekbone (the topTaper above still fades it) so the mid-cheek is untouched.
  const LF_TAPER_SIGMA=0.045*W;
  const twoSigTaper=2*LF_TAPER_SIGMA*LF_TAPER_SIGMA||1e-6;
  const taperScale = isMale ? 0.4 : 0.85;
  const taperSegs=[];
  if(taperScale>0){
    for(const POLY of [[365,397,288],[136,172,58]]){ // right side, left side
      for(let k=0;k+1<POLY.length;k++){ const A=lm[POLY[k]], B=lm[POLY[k+1]]; if(A&&B) taperSegs.push([A,B]); }
    }
  }


  const N=w*h, m=new Float32Array(N);
  for(let y=0,i=0;y<h;y++){
    for(let x=0;x<w;x++,i++){
      const relx=x-p152.x, rely=y-p152.y;
      const along=relx*dirUp.x+rely*dirUp.y;
      const latd =relx*dirOut.x+rely*dirOut.y;
      const hF=along/faceH, alat=Math.abs(latd)/W;

      // HA filler chin_jaw scope: chin pad + mandibular border only. Computed
      // before the oval early-out so it can sit on and just beyond the lower
      // silhouette (chin projection extends the outline; Sculptra zones never do).
      // Protected buffer keeps lips/nose/eyes/brows out; tapers give a hard stop
      // at the jaw (no neck/submental) and a fade toward the mid-cheek above.
      if(scope==="chin_jaw"){
        if(hF <= LF_TOP+0.12 && hF >= -0.16){
          const protOnly=1-(protA[i*4]/255);
          const dc=distToSeg(x,y,chinA,chinB);
          let lf=Math.exp(-(dc*dc)/twoSigChin);
          for(let k=0;k<jawSegs.length;k++){ const sg=jawSegs[k]; const dd=distToSeg(x,y,sg[0],sg[1]); const g=Math.exp(-(dd*dd)/twoSigJaw); if(g>lf) lf=g; }
          for(let k=0;k<gonialPts.length;k++){ const gp=gonialPts[k]; const dx=x-gp.x, dy=y-gp.y; const g=Math.exp(-(dx*dx+dy*dy)/twoSigGonial); if(g>lf) lf=g; }
          // Lateral taper, CONTAINED INSIDE the silhouette. Editing the taper band
          // over the dark background outside the jaw was what produced the muddy
          // dark halo (a tiny inward silhouette move the texture-restore correctly
          // refused to sharpen). Gate it by the face oval so it can only shade the
          // lower face inward within existing skin: a soft slim, never a contour
          // move over background. The chin/jaw/gonial terms above are NOT gated,
          // so genuine chin projection can still extend the outline.
          const ovalInside = ovalA[i*4]/255;
          let taperVal=0;
          for(let k=0;k<taperSegs.length;k++){ const sg=taperSegs[k]; const dd=distToSeg(x,y,sg[0],sg[1]); const g=taperScale*Math.exp(-(dd*dd)/twoSigTaper); if(g>taperVal) taperVal=g; }
          taperVal*=ovalInside;
          if(taperVal>lf) lf=taperVal;
          const topTaper=1-smoothstep(LF_TOP,LF_TOP+0.08,hF);
          // Downward allowance depends on laterality: directly under the chin
          // (central) the mask extends down so the chin can lengthen; toward the
          // jaw and sides it stops at the jawline so the neck is never opened.
          // The central extension is eased (0.12 -> 0.09) so chin elongation does
          // not push a crescent down over the submental shadow.
          const central=1-smoothstep(0.10,0.22,alat);     // 1 under the chin, 0 at the jaw/sides
          const floor=-0.02 - 0.12*central;               // jaw cuts at -0.02; chin column extends to ~-0.14 for clear projection
          const neckTaper=smoothstep(floor, floor+0.05, hF);
          m[i]=Math.min(1, lf*topTaper*neckTaper*protOnly);
        }
        continue;
      }

      const oval=ovalA[i*4]/255;
      const prot=1-(protA[i*4]/255);
      const base=oval*prot;
      if(base<=0.003) continue;

      // M7 jaw-margin guard (see JAW_EDGE_FEATHER): fade the alpha over a wide
      // band inside the lower-face silhouette so shading never abuts the jaw.
      let edgeG=1;
      if(hF < JAW_EDGE_FADE_TO){
        const wide=smoothstep(0.45,0.95, ovalWideA[i*4]/255);
        const wLow=1-smoothstep(JAW_EDGE_TOP, JAW_EDGE_FADE_TO, hF);
        edgeG=1-wLow*(1-wide);
      }

      let templeFrac=0;
      if(scope==="temple" || scope==="temple_fold"){
        // fossa membership
        const lo=VOL_BANDS.temple[0], hi=VOL_BANDS.temple[1];
        const band=smoothstep(lo-VOL_FB,lo,hF)*(1-smoothstep(hi,hi+VOL_FB,hF));
        if(band>0){
          const wlat=smoothstep(VOL_LAT_MIN_TEMPLE,VOL_LAT_MIN_TEMPLE+VOL_LAT_RAMP,alat);
          templeFrac=clamp01(band*wlat);
        }
        let v=templeFrac*base;
        // temporal apex
        let axt=0; for(let k=0;k<cT.length;k++){ const dx=x-cT[k].x, dy=y-cT[k].y; const g=Math.exp(-(dx*dx+dy*dy)/twoSigT); if(g>axt) axt=g; }
        const t=axt*base; if(t>v) v=t;
        // nasolabial / marionette fold tubes (temple_fold only); cheeks stay original
        if(scope==="temple_fold"){
          let fw=0;
          for(let k=0;k<foldSegs.length;k++){ const sg=foldSegs[k]; const dd=distToSeg(x,y,sg[0],sg[1]); const g=Math.exp(-(dd*dd)/twoSigFold); if(g>fw) fw=g; }
          fw*=base; if(fw>v) v=fw;
        }
        m[i]=Math.min(1,v)*edgeG;
        continue;
      }

      // full scope: dominant dodge zone + folds + both apexes
      let bestW=0;
      for(const z in VOL_BANDS){
        const lo=VOL_BANDS[z][0], hi=VOL_BANDS[z][1];
        let band=smoothstep(lo-VOL_FB,lo,hF)*(1-smoothstep(hi,hi+VOL_FB,hF));
        if(band<=0) continue;
        if(z==="cheek") band *= 1 - CHEEK_UE_ROLL*smoothstep(CHEEK_UE_LO, CHEEK_UE_HI, hF);
        const latMin = z==="temple"?VOL_LAT_MIN_TEMPLE : z==="cheek"?VOL_LAT_MIN_CHEEK : LAT_MIN;
        const wlat=smoothstep(latMin,latMin+VOL_LAT_RAMP,alat);
        const wz=band*wlat*base;
        if(wz>bestW) bestW=wz;
      }
      let v=bestW;

      let fw=0;
      for(let k=0;k<foldSegs.length;k++){ const sg=foldSegs[k]; const dd=distToSeg(x,y,sg[0],sg[1]); const g=Math.exp(-(dd*dd)/twoSigFold); if(g>fw) fw=g; }
      fw*=base; if(fw>v) v=fw;

      let axc=0; for(let k=0;k<cC.length;k++){ const dx=x-cC[k].x, dy=y-cC[k].y; const g=Math.exp(-(dx*dx+dy*dy)/twoSigC); if(g>axc) axc=g; }
      const ac=axc*base; if(ac>v) v=ac;
      let axt=0; for(let k=0;k<cT.length;k++){ const dx=x-cT[k].x, dy=y-cT[k].y; const g=Math.exp(-(dx*dx+dy*dy)/twoSigT); if(g>axt) axt=g; }
      const at=axt*base; if(at>v) v=at;

      m[i]=Math.min(1,v)*edgeG;
    }
  }
  return blurAlpha(m, w, h, 3);
}

// Texture-delta profile by scope. HA chin/jaw stays clean and shadow-free (the
// jaw must not gain an invented shadow). Sculptra is BOLD: it allows real 3D form
// by letting the broad luminance darken on the underside of restored volume (the
// shadow that makes a filled cheek read as projecting rather than just brighter).
// Colour stays locked at all times, so allowing this luminance shadow cannot
// bring back the brown discoloration; that was a chroma problem and the chroma
// lock handles it independently. SCULPTRA_DARK_FLOOR is the single lever for how
// much 3D form the volume is allowed: raise for bolder projection, lower toward 0
// if a case ever reads hollow instead of full.
const SCULPTRA_DARK_FLOOR = 20;
// DARK_FLOOR 14 -> 20 (M6.3): more underside shadow allowance is what makes the
// amplified volume read as 3D form instead of flat brightness. Chroma stays
// locked, so this cannot reintroduce the brown mud.
//
// M6.3 BRIGHT CAP. Broad brightening SATURATES perceptually: past a ceiling it
// stops reading as restored volume and starts erasing the natural shading
// gradient, which is the flat, waxy, lit-from-within look the first v23 Strong
// exports showed. The cap soft-knees (tanh) the POSITIVE broad-tone shift inside
// the delta so that the response gain amplifies structure (the spatial variation
// of the volume shading, and the floored underside shadow) while the flat
// brightening component levels off. Defined as the maximum broad brightening in
// luma levels reachable at the TOP of the slider; the pre-gain cap is derived
// from it so retuning the gain does not silently change the ceiling.
const SCULPTRA_BRIGHT_CAP_FULL = 18;
// 26 -> 18 (M6.4): with the gain back at 1.0 this IS the full-slider ceiling.
// 18 sits just above the broad brightening of the renders Andy judged decent
// (about 13 levels effective) and well below the waxy zone (26+).
//
// M6.4: EXTRAPOLATION RETIRED. The M6.2/M6.3 response gain (1.45, then 1.45
// with form shaping) was tested against real before/after pairs across three
// calibration rounds, and the finding was consistent: rendering at 0.7..1.0 of
// the AI anchor's own magnitude reads clinical and believable; rendering BEYOND
// the anchor degrades into flat, waxy brightness at the top of the slider no
// matter how the delta is shaped, because gain can only inflate the amplitude
// of information the anchor already contains; it cannot synthesize the form it
// lacks. The gain therefore returns to 1.0 and stays: the slider is now pure
// interpolation between the original and the anchor, which cannot produce that
// failure mode. Magnitude ambition belongs UPSTREAM in the anchor itself (the
// projection setting and the prompt magnitude) and in the geometry engine, not
// in post-hoc amplification. Do not raise this above 1.0 again.
const SCULPTRA_DELTA_GAIN = 1.0;
const CHIN_JAW_DELTA_GAIN = 1.0;
// Sculptra glow applied at composite time, scaled by mask and slider but NOT by
// the gain (see GLOW_LUMA note). Equal add to R,G,B, so chroma-exact.
const SCULPTRA_GLOW_APPLY = 6;
// HA chin/jaw: a defined jawline is created by the clean shadow line along the
// mandibular border, so the path needs SOME darkening to read as definition
// rather than flat. Colour is locked, so this clean luminance shadow cannot turn
// muddy or brown the way the earlier artifact did. Bounded and tunable: raise for
// a crisper, more sculpted jaw and chin, lower toward 0 if a case reads shadowed
// or harsh instead of defined.
const CHIN_JAW_DARK_FLOOR = 22;
// 14 -> 22 (M7.7): with geometry owning the border position and the outline
// gate owning the background, the remaining "sharp jawline" ingredient is the
// shadow line under the border; a deeper chroma-locked luminance floor lets the
// AI draw it. Drop back toward 14 if a case ever reads harsh or dirty.
function sculptraTexOpts(scope, opts){
  const isHA = (scope === 'chin_jaw');
  const profile = isHA
    ? { forceOriginalTexture:false, darkFloor:CHIN_JAW_DARK_FLOOR, highDarkenScale:0.5, deltaGain:CHIN_JAW_DELTA_GAIN,
        glowLuma:GLOW_LUMA, glowApply:0, brightCap:0 }
    : { forceOriginalTexture:true,  darkFloor:SCULPTRA_DARK_FLOOR, highDarkenScale:0, deltaGain:SCULPTRA_DELTA_GAIN,
        glowLuma:0, glowApply:SCULPTRA_GLOW_APPLY,
        brightCap:SCULPTRA_BRIGHT_CAP_FULL/SCULPTRA_DELTA_GAIN };
  return Object.assign(profile, opts || {});
}

/**
 * Build the Sculptra edit-mask PNG for a photo.
 * @param {HTMLImageElement} imgEl  loaded image (the exact photo being posted)
 * @param {object} [opts]
 * @param {number} [opts.maxDim=1024] long-edge cap; MUST match the posted image
 * @param {string} [opts.scope='full'] 'full' or 'temple'
 * @returns {Promise<Blob|null>} PNG blob (treated = transparent), or null if no face
 */
export async function buildSculptraMaskBlob(imgEl, opts){
  const o = opts || {};
  const maxDim = o.maxDim || 1024;
  const scope = o.scope || 'full';
  const sex = o.sex || 'female';

  const landmarks = await detectFace(imgEl);
  if(!landmarks) return null;

  // target dims: identical formula to the client's resizeToUpload
  const scale = Math.min(1, maxDim / Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
  const w = Math.round(imgEl.naturalWidth * scale);
  const h = Math.round(imgEl.naturalHeight * scale);

  const m = buildTreatAlpha(landmarks, w, h, scope, sex);

  // rasterize: treated region transparent (alpha 0), protected opaque. RGB is
  // ignored by the edit endpoint; we paint white in the treated region so the
  // file is also human-inspectable.
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d");
  const im = cx.createImageData(w, h), d = im.data;
  for(let i=0,p=0;i<m.length;i++,p+=4){
    const mm = Math.min(1, m[i]);
    const v = Math.round(255*mm);
    d[p]=v; d[p+1]=v; d[p+2]=v;
    d[p+3]=Math.round(255*(1-mm)); // alpha 0 = editable, 255 = protected
  }
  cx.putImageData(im, 0, 0);
  return await new Promise(resolve => c.toBlob(b => resolve(b), "image/png"));
}

export default buildSculptraMaskBlob;

/**
 * Composite the AI result against the original so that ONLY the treatment region
 * carries the AI change and everything else is the original photo, pixel for
 * pixel. This is the deterministic guarantee against the model beautifying skin,
 * under-eye, complexion, or background: those pixels become the original again.
 * @param {HTMLImageElement} beforeImg  the original photo that was sent
 * @param {HTMLImageElement} aiImg      the AI-edited result
 * @param {object} [opts] { scope:'full'|'temple_fold'|'temple', intensity:0..1 }
 * @returns {Promise<string|null>} a JPEG data URL, or null if no face (caller keeps the raw AI)
 */
export async function compositeSculptra(beforeImg, aiImg, opts){
  const scope = (opts && opts.scope) || 'full';
  const sex = (opts && opts.sex) || 'female';
  const textureRestore = !(opts && opts.textureRestore === false);
  const intensity = (opts && typeof opts.intensity === "number") ? Math.max(0, Math.min(1, opts.intensity)) : 1;
  const landmarks = await detectFace(beforeImg);
  if(!landmarks) return null;

  // M5b: composite on the ORIGINAL's grid, not the AI's. gpt-image-1 returns a
  // fixed supported size (often square) regardless of the input aspect, so the AI
  // result is the original non-uniformly resized into that size. Working on the AI
  // grid squished the original and emitted a squished-aspect result that no longer
  // lined up with the true original in the side-by-side export. Drawing the
  // original at its own aspect (uniform downscale, no distortion) and stretching
  // the AI back onto that grid reverses the API resize, so the AI content
  // re-aligns and the output matches the original framing.
  const maxDim = (opts && opts.maxDim) || 1024;
  const gs = Math.min(1, maxDim / Math.max(beforeImg.naturalWidth, beforeImg.naturalHeight));
  const w = Math.round(beforeImg.naturalWidth * gs), h = Math.round(beforeImg.naturalHeight * gs);
  const m = buildTreatAlpha(landmarks, w, h, scope, sex);

  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d",{willReadFrequently:true});

  cx.drawImage(beforeImg, 0, 0, w, h);
  const before = cx.getImageData(0, 0, w, h), b = before.data;
  cx.drawImage(aiImg, 0, 0, w, h);
  const ai = cx.getImageData(0, 0, w, h), a = ai.data;

  // M7.6/7.7: outline gate (chin_jaw only): zero AI contribution outside the
  // true silhouette; the projected outline comes from the warp instead.
  const outlineGate = (scope === 'chin_jaw') ? buildOutlineGate(landmarks, w, h, b) : null;

  // Geometry layer. Sculptra 'full': the M6 frontal lift (jowl + midface
  // re-drape, silhouette locked), applied to the BASE before blending. HA
  // chin_jaw: the M7.6 projection warp, applied AFTER blending (M7.9,
  // composite-then-warp) so the AI's shading travels with the moved tissue.
  // Null (other scopes, opts.warp false, or any error) means this is exactly
  // the M5 composite.
  const lift = await buildWarpForScope(beforeImg, landmarks, w, h, scope, sex, opts);
  const postWarp = (scope === 'chin_jaw');
  const wb = (lift && !postWarp) ? new Uint8ClampedArray(b) : b;
  if(lift && !postWarp) applyLiftWarp(wb, b, w, h, lift, intensity);

  if(textureRestore){
    // Keep the AI low band (volume), restore the original high band (texture);
    // out = warpedOriginal + al * delta. Identical math to makeSculptraCompositor.
    // M6.2: al carries the response gain, so the top of the slider extrapolates
    // the (chroma-locked, floored) delta beyond the AI's own magnitude.
    const a0 = new Uint8ClampedArray(a);
    const W = faceWidthPx(landmarks, w, h);
    const tdOpts = sculptraTexOpts(scope, opts);
    const gain = tdOpts.deltaGain || 1;
    const glowApply = tdOpts.glowApply || 0;
    const { dR, dG, dB } = buildTextureDelta(b, a0, w, h, W, tdOpts);
    for(let i=0,p=0;i<m.length;i++,p+=4){
      const alm = Math.min(1, m[i]) * intensity * (outlineGate ? outlineGate[i] : 1);
      const al = alm * gain;
      const gl = alm * glowApply; // M6.3: glow is never gained
      a[p]   = wb[p]   + al*dR[i] + gl;
      a[p+1] = wb[p+1] + al*dG[i] + gl;
      a[p+2] = wb[p+2] + al*dB[i] + gl;
      a[p+3] = 255;
    }
  } else {
    for(let i=0,p=0;i<m.length;i++,p+=4){
      const al = Math.min(1, m[i]) * intensity * (outlineGate ? outlineGate[i] : 1);
      a[p]   = a[p]*al   + wb[p]*(1-al);
      a[p+1] = a[p+1]*al + wb[p+1]*(1-al);
      a[p+2] = a[p+2]*al + wb[p+2]*(1-al);
      a[p+3] = 255;
    }
  }
  // M7.9: chin_jaw warps the FINISHED composite so light moves with tissue.
  if(lift && postWarp){
    const src = new Uint8ClampedArray(a);
    applyLiftWarp(a, src, w, h, lift, intensity);
  }
  cx.putImageData(ai, 0, 0);
  return c.toDataURL("image/jpeg", 0.92);
}

/**
 * Build a reusable Sculptra compositor. Runs the expensive face detection,
 * mask build, and pixel reads ONCE, then returns an apply(intensity) function
 * that only re-blends, so an intensity slider can update the image live with no
 * regeneration and no MediaPipe re-run. intensity scales the in-mask alpha:
 * 0 returns the original photo, 1 returns the full treatment-region AI volume.
 * @returns {Promise<((intensity:number)=>string)|null>} apply fn, or null if no face.
 */
export async function makeSculptraCompositor(beforeImg, aiImg, opts){
  const scope = (opts && opts.scope) || 'full';
  const sex = (opts && opts.sex) || 'female';
  const textureRestore = !(opts && opts.textureRestore === false);
  const landmarks = await detectFace(beforeImg);
  if(!landmarks) return null;
  // M5b: work on the ORIGINAL's grid, not the AI's (see compositeSculptra). The AI
  // is stretched back onto the original aspect so its content re-aligns and the
  // emitted result matches the original framing for a clean side-by-side export.
  const maxDim = (opts && opts.maxDim) || 1024;
  const gs = Math.min(1, maxDim / Math.max(beforeImg.naturalWidth, beforeImg.naturalHeight));
  const w = Math.round(beforeImg.naturalWidth * gs), h = Math.round(beforeImg.naturalHeight * gs);
  const m = buildTreatAlpha(landmarks, w, h, scope, sex);

  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d",{willReadFrequently:true});
  cx.drawImage(beforeImg, 0, 0, w, h);
  const before = cx.getImageData(0, 0, w, h);
  const b = before.data;                          // pristine original pixels
  cx.drawImage(aiImg, 0, 0, w, h);
  const out = cx.getImageData(0, 0, w, h);
  const a0 = new Uint8ClampedArray(out.data);     // pristine AI pixels
  const o = out.data;

  // M7.6/7.7: outline gate (chin_jaw only): zero AI contribution outside the
  // true silhouette; the projected outline comes from the warp instead.
  const outlineGate = (scope === 'chin_jaw') ? buildOutlineGate(landmarks, w, h, b) : null;

  // M5.1: precompute the texture-restore delta once. apply() then writes
  // out = original + al*delta, which dials the AI volume with the slider while
  // holding the original's high-frequency texture sharp at every intensity.
  let dR=null, dG=null, dB=null, gain=1, glowApply=0;
  if(textureRestore){
    const W = faceWidthPx(landmarks, w, h);
    const tdOpts = sculptraTexOpts(scope, opts);
    gain = tdOpts.deltaGain || 1;
    glowApply = tdOpts.glowApply || 0;
    const d = buildTextureDelta(b, a0, w, h, W, tdOpts);
    dR=d.dR; dG=d.dG; dB=d.dB;
  }

  // Geometry layer, precomputed once (M6 Sculptra lift or M7.6 chin/jaw
  // projection warp by scope). apply() re-samples only the field's bounding box
  // per call (bilinear, offsets scaled by t), so the slider dials geometry and
  // light together in real time. Null = exact M5 composite.
  // M7.9: order is scope-dependent. Sculptra warps the BASE then blends (M6,
  // calibrated, untouched). chin_jaw blends in the original frame then warps
  // the FINISHED composite, so the AI's border shadow and edge shading travel
  // outward with the projected tissue instead of staying at the old outline.
  const lift = await buildWarpForScope(beforeImg, landmarks, w, h, scope, sex, opts);
  const postWarp = (scope === 'chin_jaw');
  const wb = (lift && !postWarp) ? new Uint8ClampedArray(b) : b;
  const warpSrc = (lift && postWarp) ? new Uint8ClampedArray(b.length) : null;

  return function apply(intensity){
    const t = Math.max(0, Math.min(1, (typeof intensity === "number" ? intensity : 1)));
    if(lift && !postWarp) applyLiftWarp(wb, b, w, h, lift, t);
    if(textureRestore){
      // M6.2: al carries the response gain (delta extrapolation at the top).
      // M6.3: the glow term is scaled by mask and slider only, never by gain.
      // M7.6: the outline gate zeroes all out-of-silhouette AI paint.
      for(let i=0,p=0;i<m.length;i++,p+=4){
        const alm = Math.min(1, m[i]) * t * (outlineGate ? outlineGate[i] : 1);
        const al = alm * gain;
        const gl = alm * glowApply;
        o[p]   = wb[p]   + al*dR[i] + gl;
        o[p+1] = wb[p+1] + al*dG[i] + gl;
        o[p+2] = wb[p+2] + al*dB[i] + gl;
        o[p+3] = 255;
      }
    } else {
      for(let i=0,p=0;i<m.length;i++,p+=4){
        const al = Math.min(1, m[i]) * t * (outlineGate ? outlineGate[i] : 1);
        o[p]   = a0[p]*al   + wb[p]*(1-al);
        o[p+1] = a0[p+1]*al + wb[p+1]*(1-al);
        o[p+2] = a0[p+2]*al + wb[p+2]*(1-al);
        o[p+3] = 255;
      }
    }
    // M7.9: chin_jaw warps the finished composite (light travels with tissue).
    if(lift && postWarp){
      warpSrc.set(o);
      applyLiftWarp(o, warpSrc, w, h, lift, t);
    }
    cx.putImageData(out, 0, 0);
    return c.toDataURL("image/jpeg", 0.92);
  };
}
