const { createClient } = require('@supabase/supabase-js');

exports.handler = async () => {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Fetch ALL clinics — discovery fields + enrichment fields
    const { data: clinics, error: clinicsError } = await supabase
      .from('clinics')
      .select(`
        id, name, neighbourhood, area, rating, reviews,
        place_id, maps_url, rank, phone, website,
        claimed, approved,
        promo, promo_text, booking_url, email, photos,
        toxin_type, injector_credentials, languages,
        price, price_source, price_date
      `)
      .eq('approved', true)
      .order('id', { ascending: true })
      .range(0, 9999);

    if (clinicsError) {
      console.error('Supabase clinics error:', clinicsError);
      return { statusCode: 500, body: JSON.stringify({ error: clinicsError.message }) };
    }

    // Fetch all prices from clinic_prices table
    const { data: prices, error: pricesError } = await supabase
      .from('clinic_prices')
      .select('clinic_id, toxin, price, injector_type, price_source, price_date')
      .order('price', { ascending: true });

    if (pricesError) {
      console.error('Supabase prices error:', pricesError);
    }

    // Build prices map keyed by clinic_id
    const pricesMap = {};
    if (prices && prices.length) {
      prices.forEach(p => {
        if (!pricesMap[p.clinic_id]) pricesMap[p.clinic_id] = [];
        pricesMap[p.clinic_id].push(p);
      });
    }

    // Merge clinic_prices onto each clinic
    const merged = clinics.map(clinic => {
      const clinicPrices = pricesMap[String(clinic.id)];
      if (clinicPrices && clinicPrices.length > 0) {
        const sorted = [...clinicPrices].sort((a, b) => a.price - b.price);
        const lowest = sorted[0];
        return {
          ...clinic,
          price:        lowest.price,
          price_source: lowest.price_source,
          price_date:   lowest.price_date,
          toxin_type:   lowest.toxin,
          prices:       clinicPrices,
        };
      }
      return { ...clinic, prices: [] };
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600', // 1-hour CDN cache
      },
      body: JSON.stringify(merged),
    };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
