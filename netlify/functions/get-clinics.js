const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs   = require('fs');

// ── TAXONOMY RESOLVER ────────────────────────────────────────────
// Loads slug→label maps from /data/taxonomy/*.json at cold start.
// JSON shape: { "slug": "...", "display": "..." }
// Falls back to inline map so labels always resolve even if file path shifts.
function buildTaxonomyMap(filename, fallback) {
  try {
    const filePath = path.join(__dirname, '..', '..', 'data', 'taxonomy', filename);
    const items = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Object.fromEntries(items.map(i => [i.slug, i.display]));
  } catch(e) {
    return fallback;
  }
}

const EXPERTISE_MAP = buildTaxonomyMap('expertise.json', {
  'natural-rejuvenation':       'Natural results',
  'facial-balancing':           'Facial balancing',
  'preventative-botox':         'Preventative Botox',
  'biostimulators':             'Biostimulators',
  'regenerative-aesthetics':    'Regenerative aesthetics',
  'skin-quality':               'Skin quality',
  'non-surgical-lifting':       'Non-surgical lifting',
  'skin-tightening-lifting':    'Skin tightening',
  'laser-treatments':           'Laser treatments',
  'pigmentation':               'Pigmentation',
  'melasma':                    'Melasma',
  'hyperpigmentation':          'Hyperpigmentation',
  'rosacea-redness':            'Rosacea & redness',
  'texture-pores':              'Texture & pores',
  'sensitive-skin':             'Sensitive skin',
  'acne-treatment':             'Acne treatment',
  'acne-scars':                 'Acne scars',
  'post-acne-repair':           'Post-acne repair',
  'scars-stretch-marks':        'Scars & stretch marks',
  'under-eye-rejuvenation':     'Under-eye rejuvenation',
  'jawline-contouring':         'Jawline contouring',
  'lip-treatments':             'Lip treatments',
  'double-chin':                'Double chin reduction',
  'conservative-filler':        'Conservative filler',
  'full-face-balancing':        'Full-face balancing',
  'asian-skin':                 'Asian skin',
  'melanin-rich-skin':          'Melanin-rich skin',
  'korean-aesthetics':          'Korean aesthetics',
  'mens-aesthetics':            "Men's aesthetics",
  'hair-restoration':           'Hair restoration',
  'body-contouring':            'Body contouring',
  'medical-weight-loss':        'Medical weight loss',
  'wellness-longevity':         'Wellness & longevity',
  'womens-wellness':            "Women's wellness",
  'postpartum-restoration':     'Postpartum restoration',
  'preventative-aging':         'Preventative aging',
  'mature-skin':                'Mature skin',
  'bridal-prep':                'Bridal prep',
  'medical-facials':            'Medical facials',
  'paramedical-camouflage':     'Camouflage treatments',
  'surgical-aesthetics':        'Surgical aesthetics',
  'other':                      'Other',
  // Legacy slugs from before taxonomy v2 — keep until all DB rows are migrated
  'collagen-first-biostim':      'Biostimulators',
  'conservative-minimal-filler': 'Conservative filler',
});

const CONCERNS_MAP = buildTaxonomyMap('concerns.json', {
  'active-acne':       'Acne',
  'acne-scars':        'Acne scars',
  'scars':             'Scars',
  'stretch-marks':     'Stretch marks',
  'pigmentation':      'Pigmentation & dark spots',
  'melasma':           'Melasma',
  'redness-rosacea':   'Redness & rosacea',
  'skin-texture':      'Texture & pores',
  'dull-skin':         'Dull / tired skin',
  'sensitive-skin':    'Sensitive skin',
  'fine-lines':        'Fine lines & wrinkles',
  'volume-loss':       'Volume loss',
  'skin-laxity':       'Skin laxity & sagging',
  'jawline-definition':'Jawline definition',
  'double-chin':       'Double chin',
  'under-eye':         'Under-eye concerns',
  'dark-circles':      'Dark circles',
  'hair-loss':         'Hair thinning & loss',
  'body-contouring':   'Body contouring',
  'cellulite':         'Cellulite',
  'breast-chest':      'Breast & chest concerns',
  'other':             'Other',
  // Legacy slugs
  'undereye-hollowness': 'Under-eye concerns',
  'jawline-laxity':      'Skin laxity & sagging',
});

// ── DEVICES (M39) ────────────────────────────────────────────────
// Published rows only. clinic_device_candidates is behind a review gate and
// must never reach a patient; clinic_devices is the approved table.
//
// The shape returned to the client is deliberately flat and small: model,
// manufacturer, the plain-English category label, and status. The card shows
// model names only; the profile shows the rest.
const DEVICE_SELECT = `
  clinic_id, status, first_seen,
  device_reference!inner ( model, manufacturer, category, active )
`;

// device_categories is 15 rows and never changes between requests, so it is
// cached for the life of the container rather than re-fetched per call.
let CATEGORY_LABELS = null;
async function loadCategoryLabels(supabase) {
  if (CATEGORY_LABELS) return CATEGORY_LABELS;
  const { data } = await supabase
    .from('device_categories')
    .select('category, segment, label_en, sort_order, group_key, group_label, group_order');
  CATEGORY_LABELS = {};
  (data || []).forEach(r => { CATEGORY_LABELS[r.category] = r; });
  return CATEGORY_LABELS;
}

// The card's chip vocabulary predates the device work and does not match
// device_categories.segment. Mapping here rather than in the browser keeps the
// two spellings from silently failing to join.
const SEGMENT_TO_CARD_CATEGORY = {
  laser_ipl:       'lasers_ipl',
  rf_hifu:         'rf_hifu',
  body_contouring: 'body',
};

function shapeDeviceRow(row, labels) {
  const d = row.device_reference || {};
  const cat = labels[d.category] || {};
  return {
    model:        d.model,
    manufacturer: d.manufacturer,
    category:     d.category,
    category_label: cat.label_en || d.category,
    segment:      cat.segment || null,
    card_category: SEGMENT_TO_CARD_CATEGORY[cat.segment] || null,
    status:       row.status,
    sort_order:   cat.sort_order != null ? cat.sort_order : 999,
  };
}

// URL-safe model key. Morpheus8 -> morpheus8, Clear + Brilliant -> clear-brilliant.
// Kept in this file so the client and the server cannot drift apart on it.
function slugifyModel(model) {
  return String(model || '')
    .toLowerCase()
    .replace(/[\u00ae\u2122]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ⭐⭐ GENERATION FAMILIES. Splitting PicoSure Pro, Thermage FLX and Ultherapy
// Prime into their own rows gave patients the exact names they search for, but
// left the filter listing them as unrelated siblings — "PicoSure 182" and
// "PicoSure Pro 73", with the real size of the installed base shown nowhere.
//
// `device_reference.platform` already carries the grouping, so no schema change.
// ⚠️ BUT IT HOLDS TWO DIFFERENT RELATIONSHIPS: 'PicoSure' and 'Elite' group
// GENERATIONS of one machine, while 'JOULE / mJOULE' and 'InMode' group
// unrelated devices sharing a console — BBL and diVa are not versions of each
// other. Nesting on platform blindly would file diVa under a "JOULE" heading no
// patient has ever heard of.
//
// THE TEST: nest only when the platform name IS one of the models in the group.
// A generation family is named after its flagship (PicoSure, Thermage,
// Ultherapy, Fraxel, Icon, M22); a shared console is not.
let FAMILY_CACHE = null;
async function loadFamilies(supabase) {
  if (FAMILY_CACHE) return FAMILY_CACHE;
  const out = { parentOf: {}, isParent: {} };
  try {
    const { data } = await supabase
      .from('device_reference')
      .select('model, platform')
      .eq('active', true);
    const rows = data || [];
    const norm = v => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, '');
    const modelSet = new Set(rows.map(r => norm(r.model)));
    rows.forEach(r => {
      if (!r.platform) return;
      const p = norm(r.platform);
      if (!modelSet.has(p)) return;              // shared console, not a family
      if (norm(r.model) === p) out.isParent[r.model] = true;
      else out.parentOf[r.model] = r.platform;
    });
  } catch (e) {
    console.error('family load failed (non-fatal):', e.message);
  }
  FAMILY_CACHE = out;
  return out;
}

async function fetchDevicesFor(supabase, clinicIds) {
  if (!clinicIds || !clinicIds.length) return {};
  const labels = await loadCategoryLabels(supabase);
  const { data, error } = await supabase
    .from('clinic_devices')
    .select(DEVICE_SELECT)
    .in('clinic_id', clinicIds)
    .eq('device_reference.active', true);
  if (error) {
    // A device failure must never take the directory down with it. The page
    // renders exactly as it did before M39 and the devices are simply absent.
    console.warn('[get-clinics] device fetch failed, continuing without:', error.message);
    return {};
  }
  const map = {};
  (data || []).forEach(row => {
    const cid = String(row.clinic_id);
    if (!map[cid]) map[cid] = [];
    map[cid].push(shapeDeviceRow(row, labels));
  });
  // Category order first, then model name, so a profile table reads sensibly
  // and the card's first three chips are stable between loads.
  Object.keys(map).forEach(cid => {
    map[cid].sort((a, b) => (a.sort_order - b.sort_order) || String(a.model).localeCompare(String(b.model)));
  });
  return map;
}

const CARD_FIELDS = `
  id, name, slug, neighbourhood, area, province, region,
  rating, reviews, place_id, maps_url, rank,
  phone, website, booking_url, logo_url, email,
  claimed, approved, promo, promo_text, consult_free,
  toxin_type, injector_credentials, languages, categories,
  price, price_source, price_date,
  photo, logo, photos,
  practitioners (id, name, designation, display_order)
`;

const PAGE_SIZE = 24;

exports.handler = async (event) => {
  try {
    // Normalize an identity row to a display-ready { label } object
    // is_other rows use free-text; standard rows resolve slug → display label via taxonomy map
    const normalizeIdentityRow = (row, map) => ({
      label: row.is_other ? row.other_text : (map[row.value] || row.value)
    });

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const params = event.queryStringParameters || {};

    // ── MODE: lookup by slug (for clinic.html) ──────────────
    if (params.slug) {
      const { data, error } = await supabase
        .from('clinics')
        .select(CARD_FIELDS)
        .eq('approved', true)
        .eq('slug', params.slug)
        .limit(1)
        .single();

      if (error || !data) return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Not found' })
      };

      // Attach identity, prices, and photos for this clinic
      const clinicId = String(data.id);
      const [expertiseRes, concernsRes, photosRes, pricesRes, devicesMap] = await Promise.all([
        supabase.from('clinic_expertise').select('value, is_other, other_text').eq('clinic_id', clinicId),
        supabase.from('clinic_concerns').select('value, is_other, other_text').eq('clinic_id', clinicId),
        supabase.from('clinic_photos').select('filename, display_order, is_hero').eq('clinic_id', clinicId).order('display_order', { ascending: true }),
        supabase.from('clinic_prices').select('toxin, price, injector_type, price_source, price_date').eq('clinic_id', clinicId).order('price', { ascending: true }),
        fetchDevicesFor(supabase, [clinicId]),
      ]);
      data.identity = {
        expertise: (expertiseRes.data || []).map(r => normalizeIdentityRow(r, EXPERTISE_MAP)),
        concerns:  (concernsRes.data  || []).map(r => normalizeIdentityRow(r, CONCERNS_MAP)),
      };
      // Full prices array for breakdown table on clinic.html
      data.prices = pricesRes.data || [];
      // Sync lowest price from clinic_prices (overrides clinics table snapshot which can lag)
      if (data.prices.length > 0) {
        const lowest = [...data.prices].sort((a, b) => a.price - b.price)[0];
        data.price        = lowest.price;
        data.price_source = lowest.price_source;
        data.price_date   = lowest.price_date;
        data.toxin_type   = lowest.toxin;
      }
      // photo_filenames: ordered list from DB, empty = client falls back to Storage listing
      // M39 devices. An EMPTY ARRAY is meaningful and different from absent:
      // most clinics simply have nothing crawled yet, and the profile must not
      // render "no devices" as if it were a finding about the clinic.
      data.devices = devicesMap[clinicId] || [];
      data.photo_filenames = (photosRes.data || []).map(r => r.filename);
      // hero_filename: explicitly designated cover photo, null = fallback to first photo
      const heroRow = (photosRes.data || []).find(r => r.is_hero === true);
      data.hero_filename = heroRow ? heroRow.filename : null;

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
        },
        body: JSON.stringify(data),
      };
    }

    // ── MODE: device facets (M39) ────────────────────────────
    // The option list for the Technology filter, with a clinic count on every
    // entry. Counts are the whole point: a filter option that returns three
    // clinics is a dead end, so the UI can hide anything below a threshold
    // instead of offering 122 models and letting the patient find the empty
    // ones. Optionally scoped by province so a provincial view offers only
    // what exists there.
    if (params.mode === 'device-facets') {
      const labels = await loadCategoryLabels(supabase);
      const prov = (params.province || '').trim();

      // Counting happens in Postgres (device_facets RPC), not here. The old
      // version pulled every clinic_devices row into this function and counted
      // in JS, which hit PostgREST's max-rows cap: the result was an unordered
      // truncated subset, so the NEWEST rows silently vanished (DermaV, restored
      // the day before, disappeared from the filter entirely) while the absence
      // of approved/country filters inflated every other count with de-approved
      // and non-Canadian clinics. Both faults are gone: the RPC scopes to
      // approved clinics in one country and returns ~170 aggregated rows.
      const { data: facets, error } = await supabase.rpc('device_facets', {
        p_country: (params.country || 'canada'),
        p_province: prov || null,
      });
      if (error) return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: error.message }) };

      const raw = facets || {};
      const fam = await loadFamilies(supabase);
      const models = (raw.models || []).map(m => ({
        model: m.model, slug: slugifyModel(m.model), clinics: m.clinics,
        // parent_model is set on a CHILD generation; family_clinics is the
        // combined total carried on the parent, so the panel can render
        // "PicoSure 255" with both generations indented beneath it.
        parent_model: fam.parentOf[m.model] || null,
        is_family_parent: !!fam.isParent[m.model],
      }));

      // Family totals computed HERE, so the browser never has to add up counts
      // it might get wrong, and so both surfaces agree on the number.
      const familyTotal = {};
      models.forEach(m => {
        const key = m.parent_model || (m.is_family_parent ? m.model : null);
        if (key) familyTotal[key] = (familyTotal[key] || 0) + (m.clinics || 0);
      });
      models.forEach(m => {
        if (m.is_family_parent) m.family_clinics = familyTotal[m.model] || m.clinics || 0;
      });

      const modelCategory = {};
      (raw.models || []).forEach(m => { if (m.category) modelCategory[m.model] = m.category; });

      const categories = (raw.categories || [])
        .map(c => {
          const lab = labels[c.category] || {};
          return {
            category: c.category,
            label: lab.label_en || c.category,
            segment: lab.segment || null,
            card_category: SEGMENT_TO_CARD_CATEGORY[lab.segment] || null,
            sort_order: lab.sort_order != null ? lab.sort_order : 999,
            clinics: c.clinics,
          };
        })
        // Categories with a NULL segment (led, lesion_removal) are deliberately
        // outside the patient filter and are not offered here.
        .filter(c => c.segment)
        .sort((a, b) => a.sort_order - b.sort_order);

      // Grouped the way the filter renders it, so the browser does not have to
      // reconstruct which model belongs to which category.
      // ⚠️ ORDER BY FAMILY WEIGHT, not by the model's own count, or a child
      // floats away from its parent. PicoSure's family is 255, which puts it
      // above PicoWay's 150 — the honest ranking of the installed base, where
      // before the two generations were ranked separately and neither showed it.
      const models_by_category = {};
      models
        .slice()
        .sort((a, b) => {
          const fa = a.parent_model || a.model, fb = b.parent_model || b.model;
          const wa = familyTotal[fa] != null ? familyTotal[fa] : (a.clinics || 0);
          const wb = familyTotal[fb] != null ? familyTotal[fb] : (b.clinics || 0);
          if (wb !== wa) return wb - wa;
          if (fa !== fb) return fa.localeCompare(fb);
          if (!!a.parent_model !== !!b.parent_model) return a.parent_model ? 1 : -1;
          return (b.clinics || 0) - (a.clinics || 0);
        })
        .forEach(m => {
          const c = modelCategory[m.model];
          if (!c) return;
          (models_by_category[c] = models_by_category[c] || []).push(m);
        });

      // Three tiers: group heading -> subcategory row -> model row. The group
      // count is DISTINCT CLINICS across the whole group, not a sum of its
      // subcategories, because one clinic can own an RF and a HIFU device and
      // must not be counted twice. That distinct count is computed in SQL.
      const groups = (raw.groups || [])
        .map(g => ({
          key: g.key,
          label: g.label || g.key,
          order: g.order != null ? g.order : 999,
          clinics: g.clinics,
          categories: categories.filter(c => (labels[c.category] || {}).group_key === g.key),
        }))
        .sort((a, b) => a.order - b.order);

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=60',
        },
        body: JSON.stringify({ groups, models, categories, models_by_category, clinics_with_devices: raw.clinics_with_devices || 0 }),
      };
    }

    // ── MODE: every clinic with one device (M39, /devices/<model>) ──────
    // Lean rows for the device landing pages, ALL of them in one call rather
    // than the 24-per-page card grid, because the page lists the whole country
    // and the crawler needs the full list in the SSR body.
    if (params.mode === 'device-clinics') {
      const slug = (params.device || '').trim().toLowerCase();
      const cat  = (params.devicecat || '').trim().toLowerCase();
      if (!slug && !cat) return { statusCode: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'device or devicecat required' }) };

      const labels = await loadCategoryLabels(supabase);
      const { data: devRows, error: devErr } = await supabase
        .from('clinic_devices')
        .select('clinic_id, status, device_reference!inner ( model, manufacturer, category, active )')
        .eq('device_reference.active', true)
        .range(0, 49999);
      if (devErr) return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: devErr.message }) };

      let device = null;
      const statusByClinic = {};
      const ids = new Set();
      (devRows || []).forEach(row => {
        const d = row.device_reference || {};
        if (slug && slugifyModel(d.model) !== slug) return;
        if (cat  && String(d.category || '').toLowerCase() !== cat) return;
        if (!device) {
          const c = labels[d.category] || {};
          device = {
            model: d.model, slug: slugifyModel(d.model),
            manufacturer: d.manufacturer, category: d.category,
            category_label: c.label_en || d.category, segment: c.segment || null,
          };
        }
        const cid = String(row.clinic_id);
        ids.add(cid);
        // verified beats listed when a clinic somehow has both
        if (row.status === 'verified' || !statusByClinic[cid]) statusByClinic[cid] = row.status;
      });

      if (!ids.size) {
        return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ device, clinics: [] }) };
      }

      const { data: clinics, error: cErr } = await supabase
        .from('clinics')
        .select('id, name, slug, neighbourhood, province, rating, reviews, claimed, photo, logo')
        .eq('approved', true)
        .in('id', [...ids])
        .order('reviews', { ascending: false, nullsFirst: false })
        .range(0, 4999);
      if (cErr) return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: cErr.message }) };

      // Sibling models in the same category, so the page can cross-link into
      // its neighbours instead of dead-ending. Internal links are the whole
      // reason a set of pages like this indexes at all.
      let siblings = [];
      if (device && device.category) {
        const sibCount = {};
        (devRows || []).forEach(row => {
          const d = row.device_reference || {};
          if (String(d.category || '').toLowerCase() !== String(device.category).toLowerCase()) return;
          if (slugifyModel(d.model) === device.slug) return;
          (sibCount[d.model] = sibCount[d.model] || new Set()).add(String(row.clinic_id));
        });
        siblings = Object.keys(sibCount)
          .map(m => ({ model: m, slug: slugifyModel(m), clinics: sibCount[m].size }))
          .sort((a, b) => b.clinics - a.clinics).slice(0, 12);
      }

      const rows = (clinics || []).map(c => Object.assign({}, c, { device_status: statusByClinic[String(c.id)] || 'listed' }));

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=300',
        },
        body: JSON.stringify({ device, clinics: rows, total: rows.length, siblings }),
      };
    }

    // ── MODE: lightweight index for chain detection ──────────
    if (params.mode === 'index') {
      const { data, error } = await supabase
        .from('clinics')
        .select('id, name, neighbourhood, province, website')
        .eq('approved', true)
        .ilike('country', params.country || 'canada')
        .order('id', { ascending: true })
        .range(0, 29999);

      if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=120',
        },
        body: JSON.stringify(data),
      };
    }

    // ── PARAMS ───────────────────────────────────────────────
    const page          = Math.max(0, parseInt(params.page || '0', 10));
    const sort          = params.sort || 'reviews';
    const country       = params.country || 'canada';
    const province      = params.province || '';
    const neighbourhood = params.neighbourhood || '';
    const injector      = params.injector || '';
    const search        = (params.search || '').trim();
    const promo         = params.promo === 'true';
    const countOnly     = params.count === 'true';
    const from          = page * PAGE_SIZE;
    const needed        = from + PAGE_SIZE;

    // ── PRICE CEILING / FLOOR (M36) ──────────────────────────
    // maxprice is the primary control (guide CTAs deep-link ?maxprice=8).
    // minprice is accepted too so a true band view is possible later with
    // no rebuild. Both are matched against the clinic's lowest clinic_prices
    // value — the same number the card displays — not the clinics.price
    // snapshot, which can lag.
    // ── TECHNOLOGY FILTER (M39) ──────────────────────────────
    // Same contract as the price ceiling: a deep-linkable query param applied
    // SERVER-SIDE so paging and counts stay correct, e.g.
    //   ?device=morpheus8            one model
    //   ?devicecat=rf_microneedling  a whole category
    // Resolved to a clinic id list and applied inside buildBase(), so it
    // composes with province, neighbourhood, search, injector and the price
    // ceiling without touching any of that logic.
    const deviceSlug  = (params.device || '').trim().toLowerCase();
    const deviceCat   = (params.devicecat || '').trim().toLowerCase();
    const deviceGroup = (params.devicegroup || '').trim().toLowerCase();
    const hasDeviceFilter = !!(deviceSlug || deviceCat || deviceGroup);
    let deviceClinicIds = null;

    if (hasDeviceFilter) {
      const { data: devRows, error: devErr } = await supabase
        .from('clinic_devices')
        .select('clinic_id, device_reference!inner ( model, category, active )')
        .eq('device_reference.active', true)
        .range(0, 49999);

      if (devErr) {
        console.error('Supabase error (device filter):', devErr);
        return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: devErr.message }) };
      }

      const catLabels = await loadCategoryLabels(supabase);
      const set = new Set();
      (devRows || []).forEach(row => {
        const d = row.device_reference || {};
        if (deviceSlug && slugifyModel(d.model) !== deviceSlug) return;
        if (deviceCat  && String(d.category || '').toLowerCase() !== deviceCat) return;
        if (deviceGroup) {
          const lab = catLabels[d.category] || {};
          if (String(lab.group_key || '').toLowerCase() !== deviceGroup) return;
        }
        set.add(String(row.clinic_id));
      });
      // Bounded by construction: only ~1,584 clinics have ANY device, so this
      // list can never grow past that even for the broadest category, which
      // keeps the resulting .in() well inside a safe URL length.
      deviceClinicIds = [...set];
    }

    const maxprice = (params.maxprice != null && params.maxprice !== '') ? parseFloat(params.maxprice) : null;
    const minprice = (params.minprice != null && params.minprice !== '') ? parseFloat(params.minprice) : null;
    const hasPriceCeiling = Number.isFinite(maxprice) || Number.isFinite(minprice);

    // ── BUILD BASE QUERY ─────────────────────────────────────
    // All filters combine cleanly — no branching that drops a filter
    const buildBase = () => {
      let q = supabase
        .from('clinics')
        .select(CARD_FIELDS, { count: 'exact' })
        .eq('approved', true)
        .ilike('country', country);

      if (search)        q = q.ilike('name', `%${search}%`);
      if (province)      q = q.ilike('province', province);
      if (neighbourhood) {
        // Slug-to-exact-name map for cities where accent stripping breaks fuzzy match
        const SLUG_EXACT = {
          'trois-rivieres':       'Trois-Rivières',
          'trois-rivires':        'Trois-Rivières',
          'cote-saint-luc':       'Côte Saint-Luc',
          'cte-saint-luc':        'Côte Saint-Luc',
          'levis':                'Levis',
          'lvis':                 'Levis',
          'chateauguay':          'Châteauguay',
          'chteauguay':           'Châteauguay',
        };
        if (SLUG_EXACT[neighbourhood]) {
          q = q.eq('neighbourhood', SLUG_EXACT[neighbourhood]);
        } else {
          // ⚠️⚠️ NO LEADING OR TRAILING WILDCARD. `%richmond%` matched
          // "Richmond Hill" (Ontario, 103 clinics) on a search for Richmond
          // (BC, 63) — a substring match across two provinces.
          //
          // The wildcards BETWEEN words are the ones doing real work: they let
          // "st-catharines" find "St. Catharines" across the period. Wrapping
          // the whole pattern was never needed for that, and it silently turns
          // every place name into a prefix search.
          const words = neighbourhood.split('-').filter(Boolean);
          const pattern = words.join('%');
          q = q.ilike('neighbourhood', pattern);
        }
      }
      if (injector)      q = q.ilike('injector_credentials', `%${injector}%`);
      if (promo)         q = q.eq('promo', true).not('promo_text', 'is', null);
      // Technology filter. An empty match list must yield NO results rather
      // than being skipped, or "clinics with a Morpheus8" would silently
      // return every clinic in the province.
      if (hasDeviceFilter) q = q.in('id', deviceClinicIds.length ? deviceClinicIds : ['__none__']);

      return q;
    };

    // ── SORT ─────────────────────────────────────────────────
    const applySort = (q) => {
      if (sort === 'price-low' || sort === 'price')  return q.order('price',   { ascending: true,  nullsFirst: false }).order('id', { ascending: true });
      if (sort === 'price-high') return q.order('price',   { ascending: false, nullsFirst: false }).order('id', { ascending: true });
      if (sort === 'reviews')    return q.order('reviews', { ascending: false, nullsFirst: false }).order('id', { ascending: true });
      return q.order('rating', { ascending: false, nullsFirst: false }).order('id', { ascending: true });
    };

    // ── COUNT ONLY ───────────────────────────────────────────
    if (countOnly) {
      const { count, error } = await buildBase().select('id', { count: 'exact', head: true }).range(0, 0);
      if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ count }),
      };
    }

    // ── RESOLVE PRICED CLINIC IDS FROM clinic_prices ─────────
    // The grid displays price from clinic_prices (the clinics.price snapshot
    // can lag), so ranking must use the same source. Fetch the set of clinic
    // ids that have any clinic_prices row, and bucket on membership in it.
    const pricedIdsRes = await supabase
      .from('clinic_prices')
      .select('clinic_id, price')
      .range(0, 29999);

    if (pricedIdsRes.error) {
      console.error('Supabase error (priced ids):', pricedIdsRes.error);
      return { statusCode: 500, body: JSON.stringify({ error: pricedIdsRes.error.message }) };
    }

    // pricedIdSet keeps the original meaning (any clinic with a price row) so
    // the default, no-ceiling ranking is byte-for-byte unchanged.
    // minPriceByClinic tracks the lowest finite price per clinic — the value
    // the card shows — which is what the ceiling filters against.
    const pricedIdSet     = new Set();
    const minPriceByClinic = {};
    (pricedIdsRes.data || []).forEach(r => {
      const cid = String(r.clinic_id);
      pricedIdSet.add(cid);
      const val = parseFloat(r.price);
      if (Number.isFinite(val) && (minPriceByClinic[cid] == null || val < minPriceByClinic[cid])) {
        minPriceByClinic[cid] = val;
      }
    });
    const pricedIdList = [...pricedIdSet];
    const hasPricedIds = pricedIdList.length > 0;

    // eligibleIdSet = clinics whose lowest price falls within the requested
    // range. Only computed when a ceiling/floor is active; otherwise it is the
    // full priced set. A clinic with only null-priced rows can't prove it's
    // in range, so it is excluded under a ceiling.
    const eligibleIdSet = hasPriceCeiling
      ? new Set(Object.keys(minPriceByClinic).filter(cid => {
          const v = minPriceByClinic[cid];
          if (Number.isFinite(maxprice) && v > maxprice) return false;
          if (Number.isFinite(minprice) && v < minprice) return false;
          return true;
        }))
      : pricedIdSet;
    const eligibleIdList = [...eligibleIdSet];
    const hasEligibleIds = eligibleIdList.length > 0;

    // ── FOUR-BUCKET FETCH (price-first, claimed as tiebreaker) ─────
    // Price-first: any clinic with a price (in clinic_prices) surfaces above any without.
    // Within each price tier, claimed clinics rank above unclaimed.
    //
    // Priced buckets use a bounded .in() on the priced id set.
    // Unpriced buckets are fetched normally then partitioned in JS (drop any
    // member of the priced set) — this avoids a NOT-IN string that grows with
    // the priced list and could eventually overflow the request URL.
    // Unpriced buckets fetch with headroom equal to the priced-set size, so that
    // filtering out priced members in JS can never leave the page slice short.
    const unpricedNeeded = needed + pricedIdList.length;
    const emptyRes = { data: [], error: null, count: 0 };

    // Which id set feeds the priced buckets: the in-range set under a ceiling,
    // otherwise the full priced set.
    const bucketIdList = hasPriceCeiling ? eligibleIdList : pricedIdList;
    const hasBucketIds = hasPriceCeiling ? hasEligibleIds : hasPricedIds;

    const [pricedClaimedRes, pricedUnclaimedRes, claimedAllRes, unclaimedAllRes, countRes] = await Promise.all([
      hasBucketIds ? applySort(buildBase().eq('claimed', true).in('id', bucketIdList)).range(0, needed - 1)  : Promise.resolve(emptyRes),
      hasBucketIds ? applySort(buildBase().eq('claimed', false).in('id', bucketIdList)).range(0, needed - 1) : Promise.resolve(emptyRes),
      // Unpriced buckets are dropped entirely while a ceiling is active — a
      // clinic with no in-range price can't satisfy "under $X".
      hasPriceCeiling ? Promise.resolve(emptyRes) : applySort(buildBase().eq('claimed', true)).range(0, unpricedNeeded - 1),
      hasPriceCeiling ? Promise.resolve(emptyRes) : applySort(buildBase().eq('claimed', false)).range(0, unpricedNeeded - 1),
      // Count: under a ceiling, count only in-range priced clinics (still
      // honouring province/neighbourhood/search); otherwise the whole set.
      hasPriceCeiling
        ? (hasBucketIds ? buildBase().select('id', { count: 'exact', head: true }).in('id', bucketIdList).range(0, 0) : Promise.resolve(emptyRes))
        : buildBase().select('id', { count: 'exact', head: true }).range(0, 0),
    ]);

    if (pricedClaimedRes.error || pricedUnclaimedRes.error || claimedAllRes.error || unclaimedAllRes.error) {
      const err = pricedClaimedRes.error || pricedUnclaimedRes.error || claimedAllRes.error || unclaimedAllRes.error;
      console.error('Supabase error:', err);
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }

    // Unpriced = the claimed/unclaimed sets minus anyone in the priced set.
    const unpricedClaimed   = (claimedAllRes.data   || []).filter(c => !pricedIdSet.has(String(c.id)));
    const unpricedUnclaimed = (unclaimedAllRes.data || []).filter(c => !pricedIdSet.has(String(c.id)));

    // Merge buckets then slice the requested page
    const pool = [
      ...(pricedClaimedRes.data   || []),
      ...(pricedUnclaimedRes.data || []),
      ...unpricedClaimed,
      ...unpricedUnclaimed,
    ];

    // ── FOUNDER BIAS MITIGATION ───────────────────────────────
    // Skin Trek (id: 386) is owned by the SkinDay founder.
    // To avoid the appearance of bias, it is nudged out of the
    // top 5 positions on page 1. It still appears organically
    // based on real rating/review data — just not in the spotlight.
    const FOUNDER_CLINIC_ID = '386';
    const FOUNDER_MIN_POSITION = 5;
    if (from === 0) {
      const founderIdx = pool.findIndex(c => String(c.id) === FOUNDER_CLINIC_ID);
      if (founderIdx !== -1 && founderIdx < FOUNDER_MIN_POSITION) {
        const [founder] = pool.splice(founderIdx, 1);
        pool.splice(FOUNDER_MIN_POSITION, 0, founder);
      }
    }

    const totalCount = countRes.count || 0;
    const pageSlice  = pool.slice(from, from + PAGE_SIZE);

    // ── FETCH CLINIC_PRICES + IDENTITY FOR THIS PAGE ─────────
    const clinicIds = pageSlice.map(c => String(c.id));
    let pricesMap   = {};
    let identityMap = {};
    let deviceMapForPage = {};

    if (clinicIds.length > 0) {
      const [pricesRes, expertiseRes, concernsRes, devicesMap] = await Promise.all([
        supabase
          .from('clinic_prices')
          .select('clinic_id, toxin, price, injector_type, price_source, price_date')
          .in('clinic_id', clinicIds)
          .order('price', { ascending: true }),
        supabase
          .from('clinic_expertise')
          .select('clinic_id, value, is_other, other_text')
          .in('clinic_id', clinicIds),
        supabase
          .from('clinic_concerns')
          .select('clinic_id, value, is_other, other_text')
          .in('clinic_id', clinicIds),
        fetchDevicesFor(supabase, clinicIds),
      ]);
      deviceMapForPage = devicesMap || {};

      if (pricesRes.data && pricesRes.data.length) {
        pricesRes.data.forEach(p => {
          if (!pricesMap[p.clinic_id]) pricesMap[p.clinic_id] = [];
          pricesMap[p.clinic_id].push(p);
        });
      }

      if (expertiseRes.data) {
        expertiseRes.data.forEach(row => {
          if (!identityMap[row.clinic_id]) identityMap[row.clinic_id] = { expertise: [], concerns: [] };
          identityMap[row.clinic_id].expertise.push(normalizeIdentityRow(row, EXPERTISE_MAP));
        });
      }
      if (concernsRes.data) {
        concernsRes.data.forEach(row => {
          if (!identityMap[row.clinic_id]) identityMap[row.clinic_id] = { expertise: [], concerns: [] };
          identityMap[row.clinic_id].concerns.push(normalizeIdentityRow(row, CONCERNS_MAP));
        });
      }
    }

    // ── MERGE + STRIP NULLS ───────────────────────────────────
    const keep = [
      'id','name','slug','neighbourhood','area','province','region',
      'rating','reviews','place_id','maps_url','rank',
      'phone','website','booking_url','logo_url','email',
      'claimed','approved','promo','promo_text',
      'toxin_type','injector_credentials','languages','categories','consult_free',
      'price','price_source','price_date',
      'photo','logo','photos',
    ];

    const merged = pageSlice.map(clinic => {
      const out = {};
      keep.forEach(k => {
        const v = clinic[k];
        if (v === null || v === undefined || v === '') return;
        if (Array.isArray(v) && v.length === 0) return;
        out[k] = v;
      });
      out.consult_free = clinic.consult_free === true;
      out.practitioners = (clinic.practitioners || []).sort((a, b) => a.display_order - b.display_order);

      const clinicPrices = pricesMap[String(clinic.id)];
      if (clinicPrices && clinicPrices.length > 0) {
        const lowest = [...clinicPrices].sort((a, b) => a.price - b.price)[0];
        out.price        = lowest.price;
        out.price_source = lowest.price_source;
        out.price_date   = lowest.price_date;
        out.toxin_type   = lowest.toxin;
        out.prices       = clinicPrices;
      } else {
        out.prices = [];
      }

      // M39: model names for the card chips, full rows for the profile modal.
      // Omitted entirely when empty so the card renders exactly as before for
      // the ~70% of clinics with nothing crawled.
      const clinicDevices = deviceMapForPage[String(clinic.id)];
      if (clinicDevices && clinicDevices.length) out.devices = clinicDevices;

      // Attach identity
      const id = identityMap[String(clinic.id)];
      out.identity = id
        ? { expertise: id.expertise, concerns: id.concerns }
        : { expertise: [], concerns: [] };

      return out;
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=60',
        'Vary': 'Accept-Encoding',
      },
      body: JSON.stringify({
        clinics: merged,
        total: totalCount,
        page,
        pageSize: PAGE_SIZE,
        hasMore: (from + merged.length) < totalCount,
      }),
    };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
