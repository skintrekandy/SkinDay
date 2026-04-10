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

    // ── MODE: lightweight index for Near Me / compare / hash routing ──
    // Called once on page load: /api/get-clinics?mode=index
    if (params.mode === 'index') {
      const { data, error } = await supabase
        .from('clinics')
        .select('id, name, neighbourhood, province')
        .eq('approved', true)
        .order('id', { ascending: true })
        .range(0, 29999); // covers full Canada expansion

      if (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
      }

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          // Index changes rarely — cache for 10 minutes
          'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=120',
          'Vary': 'Accept-Encoding',
        },
        body: JSON.stringify(data),
      };
    }

    // ── MODE: paginated card data (default) ──
    const page        = Math.max(0, parseInt(params.page || '0', 10));
    const sort        = params.sort || 'rating';
    const province    = params.province || '';      // e.g. 'ON', 'BC'
    const neighbourhood = params.neighbourhood || ''; // slug e.g. 'yorkville'
    const injector    = params.injector || '';      // e.g. 'physician'
    const search      = (params.search || '').trim().toLowerCase();
    const promo       = params.promo === 'true';
    const countOnly   = params.count === 'true';

    const from = page * PAGE_SIZE;
    const to   = from + PAGE_SIZE - 1;

    // ── Build base query ──
    let query = supabase
      .from('clinics')
      .select(CARD_FIELDS, { count: 'exact' })
      .eq('approved', true);

    // ── Filters ──
    if (search) {
      query = query.ilike('name', `%${search}%`);
    } else {
      if (province) {
        query = query.eq('province', province);
      }
      if (neighbourhood) {
        // neighbourhood stored as display name; slug-match via ilike
        const displayName = neighbourhood.replace(/-/g, ' ');
        query = query.ilike('neighbourhood', displayName);
      }
      if (promo) {
        query = query.eq('promo', true).not('promo_text', 'is', null);
      }
      if (injector) {
        // injector_credentials is a text[] column — use contains
        query = query.contains('injector_credentials', [injector]);
      }
    }

    // ── Sorting ──
    // Primary sort by business priority, secondary by user sort
    // We apply the pin-order sort (claimed > priced > unclaimed) on the
    // client side after receive since it requires derived logic.
    // Server handles the metric sorts.
    if (sort === 'price-low') {
      query = query.order('price', { ascending: true, nullsFirst: false });
    } else if (sort === 'price-high') {
      query = query.order('price', { ascending: false, nullsFirst: false });
    } else if (sort === 'reviews') {
      query = query.order('reviews', { ascending: false, nullsFirst: false });
    } else {
      // Default: rating desc
      query = query.order('rating', { ascending: false, nullsFirst: false });
    }

    // Secondary sort for stability
    query = query.order('id', { ascending: true });

    // ── Count only (for filter pill counts) ──
    if (countOnly) {
      const { count, error } = await query.range(0, 0);
      if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ count }),
      };
    }

    // ── Execute paginated query ──
    const { data: clinicsData, count: totalCount, error: clinicsError } = await query.range(from, to);

    if (clinicsError) {
      console.error('Supabase clinics error:', clinicsError);
      return { statusCode: 500, body: JSON.stringify({ error: clinicsError.message }) };
    }

    // ── Fetch prices only for this page's clinics ──
    const clinicIds = (clinicsData || []).map(c => String(c.id));
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

    // ── Merge + strip nulls ──
    const keep = [
      'id','name','neighbourhood','area','province','region',
      'rating','reviews','place_id','maps_url','rank',
      'phone','website','booking_url','logo_url',
      'claimed','approved','promo','promo_text',
      'toxin_type','injector_credentials','languages',
      'price','price_source','price_date',
    ];

    const merged = (clinicsData || []).map(clinic => {
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

    // ── Response ──
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        // Paginated results: shorter cache, vary by query string
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=60',
        'Vary': 'Accept-Encoding',
      },
      body: JSON.stringify({
        clinics: merged,
        total: totalCount || 0,
        page,
        pageSize: PAGE_SIZE,
        hasMore: (from + merged.length) < (totalCount || 0),
      }),
    };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
