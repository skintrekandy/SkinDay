// skinday-data.js
// Drop-in replacement for the static clinics array on the homepage.
//
// Usage (in skinday-homepage.html, replace the static clinics array reference):
//   <script src="skinday-data.js"></script>
//   Then use: await SkinDayData.load()  → returns merged clinic array
//
// Merge strategy: only non-null DB fields overwrite static data.
// This preserves Google rating/reviews if clinic hasn't changed them.
//
// The static CLINICS_STATIC array must be defined before this script loads,
// OR this script can be bundled below the static array inline.

const SkinDayData = (() => {
  const API_URL = '/api/get-clinics';
  let _loaded = false;
  let _clinics = null;

  /**
   * Merge a DB override object into a static clinic object.
   * Only non-null DB fields win.
   */
  function mergeClinic(staticClinic, dbOverride) {
    if (!dbOverride) return staticClinic;

    const merged = { ...staticClinic };

    // Fields that DB can override (only if non-null)
    const overridable = ['price', 'promo', 'promo_text', 'phone', 'website', 'email'];
    for (const field of overridable) {
      if (dbOverride[field] !== null && dbOverride[field] !== undefined) {
        merged[field] = dbOverride[field];
      }
    }

    // claimed is a boolean — false is a valid value, so check existence not truthiness
    if (typeof dbOverride.claimed === 'boolean') {
      merged.claimed = dbOverride.claimed;
    }

    return merged;
  }

  /**
   * Load clinic data.
   * 1. Start with CLINICS_STATIC (defined in homepage HTML).
   * 2. Fetch approved DB overrides from /api/get-clinics.
   * 3. Merge non-null DB fields over matching static records.
   * 4. Returns merged array.
   *
   * Falls back gracefully to static-only if API fails.
   */
  async function load() {
    if (_loaded && _clinics) return _clinics;

    // CLINICS_STATIC must be a global defined before this is called
    const base = (typeof CLINICS_STATIC !== 'undefined' ? CLINICS_STATIC : []).map(c => ({
      ...c,
      claimed: false  // default — overwritten if DB has a record
    }));

    // Build lookup map by id (id is string or int — normalise to string)
    const baseMap = new Map(base.map(c => [String(c.id), c]));

    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { clinics: dbClinics } = await res.json();

      for (const dbClinic of (dbClinics || [])) {
        const key = String(dbClinic.id);
        if (baseMap.has(key)) {
          baseMap.set(key, mergeClinic(baseMap.get(key), dbClinic));
        }
        // If DB has a record not in static array — skip (shouldn't happen).
      }
    } catch (err) {
      // Non-fatal: static data still loads. Claimed clinics will show as unclaimed
      // until next successful fetch.
      console.warn('SkinDay: could not load clinic overrides from API.', err.message);
    }

    _clinics = Array.from(baseMap.values());
    _loaded = true;
    return _clinics;
  }

  /** Force a fresh fetch on next load() call (e.g. after admin approval) */
  function invalidate() {
    _loaded = false;
    _clinics = null;
  }

  return { load, invalidate };
})();
