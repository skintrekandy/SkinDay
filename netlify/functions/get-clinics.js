const { createClient } = require('@supabase/supabase-js');

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
      if (neighbourhood) q = q.ilike('neighbourhood', neighbourhood.replace(/-/g, ' '));
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

    // ── FETCH CLINIC_PRICES FOR THIS PAGE ────────────────────
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
