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
const VOL_BANDS = { temple:[0.58,0.80], cheek:[0.42,0.64], lower_cheek:[0.27,0.42] };
const VOL_FB = 0.05;
const VOL_LAT_RAMP = 0.06;
const LAT_MIN = 0.12;
const VOL_LAT_MIN_CHEEK = 0.18;
const VOL_LAT_MIN_TEMPLE = 0.34;
const CHEEK_UE_LO = 0.56, CHEEK_UE_HI = 0.64, CHEEK_UE_ROLL = 0.7;

const ZYGION = { r:234, l:454 };
const TEMPLE_OVAL = { r:127, l:356 };
const CHEEK_APEX_UP = 0.06, CHEEK_APEX_IN = 0.05, TEMPLE_APEX_IN = 0.06;
const APEX_SIGMA_CHEEK = 0.15, APEX_SIGMA_TEMPLE = 0.11;

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

// ---- model singleton ------------------------------------------------------
let _landmarker = null;
async function ensureModel(){
  if(_landmarker) return _landmarker;
  const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm");
  _landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions:{ modelAssetPath:"https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task" },
    runningMode:"IMAGE", numFaces:1
  });
  return _landmarker;
}

// Detect once per image element and memoize, so mask generation and the later
// composite do not run the model twice on the same photo.
let _lastDetectEl = null, _lastDetect = null;
async function detectFace(imgEl){
  if(_lastDetectEl === imgEl && _lastDetect) return _lastDetect;
  const landmarker = await ensureModel();
  const res = landmarker.detect(imgEl);
  const out = (res && res.faceLandmarks && res.faceLandmarks.length) ? res.faceLandmarks[0] : null;
  _lastDetectEl = imgEl; _lastDetect = out;
  return out;
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
// original); 'temple' = fossa + temporal apex only.
function buildTreatAlpha(L, w, h, scope){
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

  const N=w*h, m=new Float32Array(N);
  for(let y=0,i=0;y<h;y++){
    for(let x=0;x<w;x++,i++){
      const relx=x-p152.x, rely=y-p152.y;
      const along=relx*dirUp.x+rely*dirUp.y;
      const latd =relx*dirOut.x+rely*dirOut.y;
      const hF=along/faceH, alat=Math.abs(latd)/W;

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

  const landmarks = await detectFace(imgEl);
  if(!landmarks) return null;

  // target dims: identical formula to the client's resizeToUpload
  const scale = Math.min(1, maxDim / Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
  const w = Math.round(imgEl.naturalWidth * scale);
  const h = Math.round(imgEl.naturalHeight * scale);

  const m = buildTreatAlpha(landmarks, w, h, scope);

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
  const intensity = (opts && typeof opts.intensity === "number") ? Math.max(0, Math.min(1, opts.intensity)) : 1;
  const landmarks = await detectFace(beforeImg);
  if(!landmarks) return null;

  // Composite at the AI result's pixel size; the AI was produced from the same
  // framing, so the original scaled to these dims aligns with it.
  const w = aiImg.naturalWidth, h = aiImg.naturalHeight;
  const m = buildTreatAlpha(landmarks, w, h, scope);

  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d",{willReadFrequently:true});

  cx.drawImage(beforeImg, 0, 0, w, h);
  const before = cx.getImageData(0, 0, w, h), b = before.data;
  cx.drawImage(aiImg, 0, 0, w, h);
  const ai = cx.getImageData(0, 0, w, h), a = ai.data;

  for(let i=0,p=0;i<m.length;i++,p+=4){
    const al = Math.min(1, m[i]) * intensity;
    a[p]   = a[p]*al   + b[p]*(1-al);
    a[p+1] = a[p+1]*al + b[p+1]*(1-al);
    a[p+2] = a[p+2]*al + b[p+2]*(1-al);
    a[p+3] = 255;
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
  const landmarks = await detectFace(beforeImg);
  if(!landmarks) return null;
  const w = aiImg.naturalWidth, h = aiImg.naturalHeight;
  const m = buildTreatAlpha(landmarks, w, h, scope);

  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d",{willReadFrequently:true});
  cx.drawImage(beforeImg, 0, 0, w, h);
  const b = cx.getImageData(0, 0, w, h).data;
  cx.drawImage(aiImg, 0, 0, w, h);
  const out = cx.getImageData(0, 0, w, h);
  const a0 = new Uint8ClampedArray(out.data); // pristine AI pixels as the source
  const o = out.data;

  return function apply(intensity){
    const t = Math.max(0, Math.min(1, (typeof intensity === "number" ? intensity : 1)));
    for(let i=0,p=0;i<m.length;i++,p+=4){
      const al = Math.min(1, m[i]) * t;
      o[p]   = a0[p]*al   + b[p]*(1-al);
      o[p+1] = a0[p+1]*al + b[p+1]*(1-al);
      o[p+2] = a0[p+2]*al + b[p+2]*(1-al);
      o[p+3] = 255;
    }
    cx.putImageData(out, 0, 0);
    return c.toDataURL("image/jpeg", 0.92);
  };
}
