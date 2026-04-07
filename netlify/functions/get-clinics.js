const { createClient } = require('@supabase/supabase-js');

// Fields needed for card grid + filtering + sorting — nothing more
// Dropping: email, photos (heavy, only needed in modal — fetched separately)
const CARD_FIELDS = `
  id, name, neighbourhood, area, province, region,
  rating, reviews, place_id, maps_url, rank,
  phone, website, booking_url, logo_url,
  claimed, approved, promo, promo_text,
  toxin_type, injector_credentials, languages,
  price, price_source, price_date,
  practitioners (id, name, designation, display_order)
`;

exports.handler = async (event) => {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Run both queries in parallel
    const [clinicsResult, pricesResult] = await Promise.all([
      supabase
        .from('clinics')
        .select(CARD_FIELDS)
        .eq('approved', true)
        .order('id', { ascending: true })
        .range(0, 9999),
      supabase
        .from('clinic_prices')
        .select('clinic_id, toxin, price, injector_type, price_source, price_date')
        .order('price', { ascending: true })
    ]);

    if (clinicsResult.error) {
      console.error('Supabase clinics error:', clinicsResult.error);
      return { statusCode: 500, body: JSON.stringify({ error: clinicsResult.error.message }) };
    }

    // Build prices map keyed by clinic_id
    const pricesMap = {};
    if (pricesResult.data && pricesResult.data.length) {
      pricesResult.data.forEach(p => {
        if (!pricesMap[p.clinic_id]) pricesMap[p.clinic_id] = [];
        pricesMap[p.clinic_id].push(p);
      });
    }

    // Merge + strip null/empty fields to shrink payload ~30%
    const merged = clinicsResult.data.map(clinic => {
      const practitioners = (clinic.practitioners || [])
        .sort((a, b) => a.display_order - b.display_order);

      const out = {};
      const keep = [
        'id','name','neighbourhood','area','province','region',
        'rating','reviews','place_id','maps_url','rank',
        'phone','website','booking_url','logo_url',
        'claimed','approved','promo','promo_text',
        'toxin_type','injector_credentials','languages',
        'price','price_source','price_date',
      ];

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
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
        'Vary': 'Accept-Encoding',
      },
      body: JSON.stringify(merged),
    };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
