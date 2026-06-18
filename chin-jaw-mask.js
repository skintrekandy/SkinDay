/**
 * chin-jaw-mask.js  --  Dedicated compositor for HA chin/jawline filler.
 *
 * Sculptra and chin/jaw filler are anatomically different tasks:
 *
 *   Sculptra:   soft diffuse volume, broad feathering OK, texture matters most
 *   Chin/jaw:   crisp contour change, mandibular edge definition, chin projection
 *               -- broad feathering creates blur, old shadow fights new contour
 *
 * This module wraps makeSculptraCompositor from sculptra-mask.js with a
 * dedicated parameter set tuned for chin/jaw:
 *
 *   - midKeep 0.28:    very low original mid-band restore; AI shape dominates.
 *                      The old jawline shadow is mid-frequency; restoring it
 *                      at 0.6 (Sculptra default) creates "double contour" blur.
 *   - texRadiusFrac 0.005: finer frequency cutoff -- pore texture only, not
 *                      coarser skin/shadow bands that carry the old contour.
 *   - glowApply 0:     no glow (chin/jaw is structural, not volumetric)
 *   - brightCap 0:     no brightness cap (chin/jaw needs the AI's border shadow)
 *   - darkFloor 26:    deep dark floor so the AI can draw the border-to-neck step
 *   - warp: true:      chin projection warp always on
 *   - jowlTexRelease:  on (release the jowl fold so filler can read correctly)
 *   - jawDef: true:    jaw definition pass on
 *
 * Neck/collar protection is handled by the submental forced-restore pass inside
 * makeSculptraCompositor (SUBMENT_FLOOR_F), which is already robust and stays
 * active for chin_jaw scope.
 *
 * The returned apply(0..1) -> jpegDataUrl contract is identical to
 * makeSculptraCompositor, so visualize.html needs no changes.
 *
 * Debug: load the page with ?debug=layers to see Original / Raw AI / Final.
 */

// Re-export the Sculptra compositor with chin/jaw-specific overrides.
// We do not duplicate the MediaPipe detection, warp field, or texture-delta
// pipelines -- those all live in sculptra-mask.js and are already correct.

export async function makeChinJawCompositor(beforeImg, aiImg, opts) {
  // Import at call time (matches the dynamic import pattern in visualize.html)
  const MASK_MODULE_VERSION = opts && opts._maskModuleVersion || '';
  const maskPath = './sculptra-mask.js' + (MASK_MODULE_VERSION ? ('?v=' + MASK_MODULE_VERSION) : '');
  const { makeSculptraCompositor } = await import(maskPath);

  // Chin/jaw specific defaults -- all overridable via opts for A/B testing.
  const chinJawDefaults = {
    scope:          'chin_jaw',
    warp:           true,
    jowlTexRelease: true,
    jawDef:         true,
    // Key difference from Sculptra: low mid-band restore so AI shape dominates.
    // ChatGPT diagnosis: midKeep 0.6 restores old jaw shadow = double contour = blur.
    midKeep:        0.28,
    // Very tight frequency cutoff: pore texture only, not coarser shadow bands.
    texRadiusFrac:  0.005,
    // No glow (chin/jaw is structural not volumetric)
    glowApply:      0,
    // No brightness cap (preserve the AI's border-to-neck shadow)
    brightCap:      0,
    // Deep dark floor so the mandibular border shadow can register
    darkFloor:      26,
  };

  // Merge: caller opts override our defaults, except scope is always chin_jaw.
  const mergedOpts = Object.assign({}, chinJawDefaults, opts || {}, { scope: 'chin_jaw' });

  return makeSculptraCompositor(beforeImg, aiImg, mergedOpts);
}

export default makeChinJawCompositor;
