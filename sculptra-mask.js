// sculptra-mask.js
// Client-side generator for the Sculptra hybrid edit mask. Given the patient
// photo, it finds the face and returns a PNG whose TRANSPARENT pixels are the
// Sculptra treatment region (lateral temple, lateral cheek, prejowl/jawline,
// and the nasolabial/marionette fold tubes) and whose OPAQUE pixels are
// everything to protect (eyes, brows, nose, lips, central face, hairline, neck,
// background). gpt-image-1's edit endpoint edits only the transparent region, so
// this physically prevents the global beautification leak.
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
const CHEEK_UE_LO = 0.56, CHEEK_UE_HI = 0.64, CHEEK_UE_ROLL = 0.30;

const ZYGION = { r:234, l:454 };
const TEMPLE_OVAL = { r:127, l:356 };
const CHEEK_APEX_UP = 0.06, CHEEK_APEX_IN = 0.05, TEMPLE_APEX_IN = 0.06;
const APEX_SIGMA_CHEEK = 0.17, APEX_SIGMA_TEMPLE = 0.135;

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
const TEX_RADIUS_FRAC  = 0.016;
const TEX_BLUR_PASSES  = 2;     // box passes -> approx gaussian
const TEX_STRENGTH     = 1.0;
const GUARD_RADIUS_FRAC= 0.016;
const GUARD_EDGE_LO    = 12;
const GUARD_EDGE_HI    = 40;

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
    const g=(1-smoothstep(lo,hi,edge))*strength; // 1 = stationary skin -> full original texture
    const bHr=bR[i]-bRl[i], bHg=bG[i]-bGl[i], bHb=bB[i]-bBl[i];
    const aHr=aR[i]-aRl[i], aHg=aG[i]-aGl[i], aHb=aB[i]-aBl[i];
    const detHr=aHr+(bHr-aHr)*g, detHg=aHg+(bHg-aHg)*g, detHb=aHb+(bHb-aHb)*g;
    dR[i]=(aRl[i]-bRl[i])+(detHr-bHr);
    dG[i]=(aGl[i]-bGl[i])+(detHg-bHg);
    dB[i]=(aBl[i]-bBl[i])+(detHb-bHb);
  }
  return {dR,dG,dB};
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
  const taperScale = isMale ? 0.25 : 0.6;
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
          const floor=-0.02 - 0.09*central;               // jaw cuts at -0.02; chin column extends to ~-0.11
          const neckTaper=smoothstep(floor, floor+0.05, hF);
          m[i]=Math.min(1, lf*topTaper*neckTaper*protOnly);
        }
        continue;
      }

      const oval=ovalA[i*4]/255;
      const prot=1-(protA[i*4]/255);
      const base=oval*prot;
      if(base<=0.003) continue;

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
        m[i]=Math.min(1,v);
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

      m[i]=Math.min(1,v);
    }
  }
  return blurAlpha(m, w, h, 3);
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

  // Composite at the AI result's pixel size; the AI was produced from the same
  // framing, so the original scaled to these dims aligns with it.
  const w = aiImg.naturalWidth, h = aiImg.naturalHeight;
  const m = buildTreatAlpha(landmarks, w, h, scope, sex);

  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d",{willReadFrequently:true});

  cx.drawImage(beforeImg, 0, 0, w, h);
  const before = cx.getImageData(0, 0, w, h), b = before.data;
  cx.drawImage(aiImg, 0, 0, w, h);
  const ai = cx.getImageData(0, 0, w, h), a = ai.data;

  if(textureRestore){
    // Keep the AI low band (volume), restore the original high band (texture);
    // out = original + al * delta. Identical math to makeSculptraCompositor.
    const a0 = new Uint8ClampedArray(a);
    const W = faceWidthPx(landmarks, w, h);
    const { dR, dG, dB } = buildTextureDelta(b, a0, w, h, W, opts || {});
    for(let i=0,p=0;i<m.length;i++,p+=4){
      const al = Math.min(1, m[i]) * intensity;
      a[p]   = b[p]   + al*dR[i];
      a[p+1] = b[p+1] + al*dG[i];
      a[p+2] = b[p+2] + al*dB[i];
      a[p+3] = 255;
    }
  } else {
    for(let i=0,p=0;i<m.length;i++,p+=4){
      const al = Math.min(1, m[i]) * intensity;
      a[p]   = a[p]*al   + b[p]*(1-al);
      a[p+1] = a[p+1]*al + b[p+1]*(1-al);
      a[p+2] = a[p+2]*al + b[p+2]*(1-al);
      a[p+3] = 255;
    }
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
  const w = aiImg.naturalWidth, h = aiImg.naturalHeight;
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

  // M5.1: precompute the texture-restore delta once. apply() then writes
  // out = original + al*delta, which dials the AI volume with the slider while
  // holding the original's high-frequency texture sharp at every intensity.
  let dR=null, dG=null, dB=null;
  if(textureRestore){
    const W = faceWidthPx(landmarks, w, h);
    const d = buildTextureDelta(b, a0, w, h, W, opts || {});
    dR=d.dR; dG=d.dG; dB=d.dB;
  }

  return function apply(intensity){
    const t = Math.max(0, Math.min(1, (typeof intensity === "number" ? intensity : 1)));
    if(textureRestore){
      for(let i=0,p=0;i<m.length;i++,p+=4){
        const al = Math.min(1, m[i]) * t;
        o[p]   = b[p]   + al*dR[i];
        o[p+1] = b[p+1] + al*dG[i];
        o[p+2] = b[p+2] + al*dB[i];
        o[p+3] = 255;
      }
    } else {
      for(let i=0,p=0;i<m.length;i++,p+=4){
        const al = Math.min(1, m[i]) * t;
        o[p]   = a0[p]*al   + b[p]*(1-al);
        o[p+1] = a0[p+1]*al + b[p+1]*(1-al);
        o[p+2] = a0[p+2]*al + b[p+2]*(1-al);
        o[p+3] = 255;
      }
    }
    cx.putImageData(out, 0, 0);
    return c.toDataURL("image/jpeg", 0.92);
  };
}
