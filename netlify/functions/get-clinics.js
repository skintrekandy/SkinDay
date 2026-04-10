const { createClient } = require('@supabase/supabase-js');

const CARD_FIELDS = `
  id, name, neighbourhood, area, province, region,
  rating, reviews, place_id, maps_url, rank,
  phone, website, booking_url, logo_url,
  claimed, approved, promo, promo_text,
  toxin_type, injector_credentials, languages,
  price, price_source, price_date,
  practitioners (id, name, designation, display_order)
`;

const PAGE_SIZE = 24;

exports.handler = async (event) => {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const params = event.queryStringParameters || {};

    // ── MODE: lightweight index ──────────────────────────────
    if (params.mode === 'index') {
      const { data, error } = await supabase
        .from('clinics')
        .select('id, name, neighbourhood, province')
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
          'Vary': 'Accept-Encoding',
        },
        body: JSON.stringify(data),
      };
    }

    // ── MODE: paginated card data ────────────────────────────
    const page          = Math.max(0, parseInt(params.page || '0', 10));
    const sort          = params.sort || 'rating';
    const province      = params.province || '';
    const neighbourhood = params.neighbourhood || '';
    const injector      = params.injector || '';
    const search        = (params.search || '').trim();
    const promo         = params.promo === 'true';
    const countOnly     = params.count === 'true';

    const from = page * PAGE_SIZE;
    const needed = from + PAGE_SIZE;

    // ── Build base filter query ───────────────────────────────
    const buildBase = () => {
      let q = supabase
        .from('clinics')
        .select(CARD_FIELDS, { count: 'exact' })
        .eq('approved', true);

      if (search) {
        q = q.ilike('name', `%${search}%`);
      } else {
        if (province)      q = q.eq('province', province);
        if (neighbourhood) q = q.ilike('neighbourhood', neighbourhood.replace(/-/g, ' '));
        if (promo)         q = q.eq('promo', true).not('promo_text', 'is', null);
        if (injector)      q = q.contains('injector_credentials', [injector]);
      }
      return q;
    };

    // ── Apply metric sort ─────────────────────────────────────
    const applySort = (q) => {
      if (sort === 'price-low')  return q.order('price',   { ascending: true,  nullsFirst: false }).order('id', { ascending: true });
      if (sort === 'price-high') return q.order('price',   { ascending: false, nullsFirst: false }).order('id', { ascending: true });
      if (sort === 'reviews')    return q.order('reviews', { ascending: false, nullsFirst: false }).order('id', { ascending: true });
      return q.order('rating', { ascending: false, nullsFirst: false }).order('id', { ascending: true });
    };

    // ── Count only ────────────────────────────────────────────
    if (countOnly) {
      const { count, error } = await buildBase().range(0, 0);
      if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ count }),
      };
    }

    // ── Priority-aware three-bucket fetch ─────────────────────
    // Supabase JS doesn't support computed ORDER BY, so we run three
    // parallel queries by priority tier and merge them server-side.
    // Bucket 2: claimed  |  Bucket 1: priced not claimed  |  Bucket 0: unpriced unclaimed
    const [claimedRes, pricedRes, unpricedRes, countRes] = await Promise.all([
      applySort(buildBase().eq('claimed', true)).range(0, needed - 1),
      applySort(buildBase().eq('claimed', false).not('price', 'is', null)).range(0, needed - 1),
      applySort(buildBase().eq('claimed', false).is('price', null)).range(0, needed - 1),
      buildBase().select('id', { count: 'exact', head: true }),
    ]);

    if (claimedRes.error || pricedRes.error || unpricedRes.error) {
      const err = claimedRes.error || pricedRes.error || unpricedRes.error;
      console.error('Supabase error:', err);
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }

    // Merge: claimed → priced → unpriced, then slice page window
    const pool = [
      ...(claimedRes.data  || []),
      ...(pricedRes.data   || []),
      ...(unpricedRes.data || []),
    ];

    const totalCount = countRes.count || 0;
    const pageSlice  = pool.slice(from, from + PAGE_SIZE);

    // ── Fetch prices for this page only ──────────────────────
    const clinicIds = pageSlice.map(c => String(c.id));
    let pricesMap = {};

    if (clinicIds.length > 0) {
      const { data: pricesData } = await supabase
        .from('clinic_prices')
        .select('clinic_id, toxin, price, injector_type, price_source, price_date')
        .in('clinic_id', clinicIds)
        .order('price', { ascending: true });

      if (pricesData && pricesData.length) {
        pricesData.forEach(p => {
          if (!pricesMap[p.clinic_id]) pricesMap[p.clinic_id] = [];
          pricesMap[p.clinic_id].push(p);
        });
      }
    }

    // ── Merge + strip nulls ───────────────────────────────────
    const keep = [
      'id','name','neighbourhood','area','province','region',
      'rating','reviews','place_id','maps_url','rank',
      'phone','website','booking_url','logo_url',
      'claimed','approved','promo','promo_text',
      'toxin_type','injector_credentials','languages',
      'price','price_source','price_date',
    ];

    const merged = pageSlice.map(clinic => {
      const practitioners = (clinic.practitioners || [])
        .sort((a, b) => a.display_order - b.display_order);

      const out = {};
      keep.forEach(k => {
        const v = clinic[k];
        if (v === null || v === undefined || v === '') return;
        if (Array.isArray(v) && v.length === 0) return;
        out[k] = v;
      });

      out.practitioners = practitioners;

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
