const { createClient } = require('@supabase/supabase-js');

const CARD_FIELDS = `
  id, name, neighbourhood, area, province, region,
  rating, reviews, place_id, maps_url, rank,
  phone, website, booking_url, logo_url,
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

    // ── BUILD QUERY ──────────────────────────────────────────
    // Single query — priority sort handled by ORDER BY CASE
    const buildQuery = (forCount = false) => {
      let q = supabase
        .from('clinics')
        .select(forCount ? 'id' : CARD_FIELDS, { count: 'exact' })
        .eq('approved', true);

      // Filters — all combine cleanly, no if/else branching
      if (search)        q = q.ilike('name', `%${search}%`);
      if (province)      q = q.eq('province', province);
      if (neighbourhood) q = q.ilike('neighbourhood', neighbourhood.replace(/-/g, ' '));
      if (injector)      q = q.contains('injector_credentials', [injector]);
      if (promo)         q = q.eq('promo', true).not('promo_text', 'is', null);

      return q;
    };

    // ── COUNT ONLY ───────────────────────────────────────────
    if (countOnly) {
      const { count, error } = await buildQuery(true).range(0, 0);
      if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ count }),
      };
    }

    // ── FETCH WITH PRIORITY SORT ─────────────────────────────
    // Priority: claimed (2) > has price (1) > unclaimed no price (0)
    // We fetch a larger window then sort client-side by priority + metric
    const fetchSize = from + PAGE_SIZE * 4; // fetch ahead to allow priority reordering

    const applySort = (q) => {
      if (sort === 'price-low')  return q.order('price', { ascending: true,  nullsFirst: false }).order('rating', { ascending: false, nullsFirst: false }).order('id', { ascending: true });
      if (sort === 'price-high') return q.order('price', { ascending: false, nullsFirst: false }).order('rating', { ascending: false, nullsFirst: false }).order('id', { ascending: true });
      if (sort === 'reviews')    return q.order('reviews', { ascending: false, nullsFirst: false }).order('id', { ascending: true });
      return q.order('rating', { ascending: false, nullsFirst: false }).order('id', { ascending: true });
    };

    const [dataRes, countRes] = await Promise.all([
      applySort(buildQuery()).range(0, fetchSize - 1),
      buildQuery(true).range(0, 0),
    ]);

    if (dataRes.error) {
      console.error('Supabase error:', dataRes.error);
      return { statusCode: 500, body: JSON.stringify({ error: dataRes.error.message }) };
    }

    const totalCount = countRes.count || 0;
    const allClinics = dataRes.data || [];

    // Priority sort: claimed first, then priced, then unpriced
    const priority = c => c.claimed ? 2 : (c.price != null ? 1 : 0);
    allClinics.sort((a, b) => {
      const pd = priority(b) - priority(a);
      if (pd !== 0) return pd;
      // Within same priority, preserve DB sort order (already sorted by metric)
      return 0;
    });

    const pageSlice = allClinics.slice(from, from + PAGE_SIZE);

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
      'id','name','neighbourhood','area','province','region',
      'rating','reviews','place_id','maps_url','rank',
      'phone','website','booking_url','logo_url',
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
