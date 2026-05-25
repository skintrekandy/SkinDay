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

const CARD_FIELDS = `
  id, name, slug, neighbourhood, area, province, region,
  rating, reviews, place_id, maps_url, rank,
  phone, website, booking_url, logo_url, email,
  claimed, approved, promo, promo_text, consult_free,
  toxin_type, injector_credentials, languages, categories,
  price, price_source, price_date,
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
      const [expertiseRes, concernsRes, photosRes, pricesRes] = await Promise.all([
        supabase.from('clinic_expertise').select('value, is_other, other_text').eq('clinic_id', clinicId),
        supabase.from('clinic_concerns').select('value, is_other, other_text').eq('clinic_id', clinicId),
        supabase.from('clinic_photos').select('filename, display_order, is_hero').eq('clinic_id', clinicId).order('display_order', { ascending: true }),
        supabase.from('clinic_prices').select('toxin, price, injector_type, price_source, price_date').eq('clinic_id', clinicId).order('price', { ascending: true }),
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

    // ── MODE: lightweight index for chain detection ──────────
    if (params.mode === 'index') {
      const { data, error } = await supabase
        .from('clinics')
        .select('id, name, neighbourhood, province, website')
        .eq('approved', true)
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
    const sort          = params.sort || 'rating';
    const province      = params.province || '';
    const neighbourhood = params.neighbourhood || '';
    const injector      = params.injector || '';
    const search        = (params.search || '').trim();
    const promo         = params.promo === 'true';
    const countOnly     = params.count === 'true';
    const from          = page * PAGE_SIZE;
    const needed        = from + PAGE_SIZE;

    // ── BUILD BASE QUERY ─────────────────────────────────────
    // All filters combine cleanly — no branching that drops a filter
    const buildBase = () => {
      let q = supabase
        .from('clinics')
        .select(CARD_FIELDS, { count: 'exact' })
        .eq('approved', true);

      if (search)        q = q.ilike('name', `%${search}%`);
      if (province)      q = q.eq('province', province);
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
          // Fuzzy match — handles periods/abbreviations e.g. "st-catharines" → "St. Catharines"
          const words = neighbourhood.split('-').filter(Boolean);
          const pattern = '%' + words.join('%') + '%';
          q = q.ilike('neighbourhood', pattern);
        }
      }
      if (injector)      q = q.ilike('injector_credentials', `%${injector}%`);
      if (promo)         q = q.eq('promo', true).not('promo_text', 'is', null);

      return q;
    };

    // ── SORT ─────────────────────────────────────────────────
    const applySort = (q) => {
      if (sort === 'price-low')  return q.order('price',   { ascending: true,  nullsFirst: false }).order('id', { ascending: true });
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

    // ── FOUR-BUCKET FETCH (price-first, claimed as tiebreaker) ─────
    // Price-first: any clinic with a Botox price surfaces above any without.
    // Within each price tier, claimed clinics rank above unclaimed.
    const [pricedClaimedRes, pricedUnclaimedRes, unpricedClaimedRes, unpricedUnclaimedRes, countRes] = await Promise.all([
      applySort(buildBase().not('price', 'is', null).eq('claimed', true)).range(0, needed - 1),
      applySort(buildBase().not('price', 'is', null).eq('claimed', false)).range(0, needed - 1),
      applySort(buildBase().is('price', null).eq('claimed', true)).range(0, needed - 1),
      applySort(buildBase().is('price', null).eq('claimed', false)).range(0, needed - 1),
      buildBase().select('id', { count: 'exact', head: true }).range(0, 0),
    ]);

    if (pricedClaimedRes.error || pricedUnclaimedRes.error || unpricedClaimedRes.error || unpricedUnclaimedRes.error) {
      const err = pricedClaimedRes.error || pricedUnclaimedRes.error || unpricedClaimedRes.error || unpricedUnclaimedRes.error;
      console.error('Supabase error:', err);
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }

    // Merge buckets then slice the requested page
    const pool = [
      ...(pricedClaimedRes.data   || []),
      ...(pricedUnclaimedRes.data || []),
      ...(unpricedClaimedRes.data || []),
      ...(unpricedUnclaimedRes.data || []),
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

    if (clinicIds.length > 0) {
      const [pricesRes, expertiseRes, concernsRes] = await Promise.all([
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
      ]);

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
