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
  toxin_type, injector_credentials, languages,
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

      // Attach identity (expertise + concerns) for this clinic
      const clinicId = String(data.id);
      const [expertiseRes, concernsRes] = await Promise.all([
        supabase.from('clinic_expertise').select('value, is_other, other_text').eq('clinic_id', clinicId),
        supabase.from('clinic_concerns').select('value, is_other, other_text').eq('clinic_id', clinicId),
      ]);
      data.identity = {
        expertise: (expertiseRes.data || []).map(r => normalizeIdentityRow(r, EXPERTISE_MAP)),
        concerns:  (concernsRes.data  || []).map(r => normalizeIdentityRow(r, CONCERNS_MAP)),
      };

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

    // ── THREE-BUCKET FETCH (claimed → priced → unpriced) ─────
    // Three parallel queries, each applying all filters.
    // Claimed clinics always surface first regardless of rating.
    const [claimedRes, pricedRes, unpricedRes, countRes] = await Promise.all([
      applySort(buildBase().eq('claimed', true)).range(0, needed - 1),
      applySort(buildBase().eq('claimed', false).not('price', 'is', null)).range(0, needed - 1),
      applySort(buildBase().eq('claimed', false).is('price', null)).range(0, needed - 1),
      buildBase().select('id', { count: 'exact', head: true }).range(0, 0),
    ]);

    if (claimedRes.error || pricedRes.error || unpricedRes.error) {
      const err = claimedRes.error || pricedRes.error || unpricedRes.error;
      console.error('Supabase error:', err);
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }

    // Merge buckets then slice the requested page
    const pool = [
      ...(claimedRes.data  || []),
      ...(pricedRes.data   || []),
      ...(unpricedRes.data || []),
    ];

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
      'toxin_type','injector_credentials','languages','consult_free',
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
