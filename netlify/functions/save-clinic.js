const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Verify the user's JWT with Supabase
  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const userToken = authHeader.replace('Bearer ', '');

  try {
    // Service role client handles both auth verification and DB operations
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser(userToken);
    if (authError || !user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
    }

    const userEmail = user.email;

    const body = JSON.parse(event.body || '{}');
    const { action } = body;

    // ── GET CLINIC FOR USER ──
    if (action === 'get-clinic') {
      // Determine which clinic IDs this account owns.
      // Chain accounts have clinic_ids in user_metadata (set by approve-claim.js).
      // Single-location accounts fall back to email → claims lookup.
      const meta = user.user_metadata || {};
      let ownedIds = [];

      if (Array.isArray(meta.clinic_ids) && meta.clinic_ids.length > 0) {
        ownedIds = meta.clinic_ids.map(String);
      } else {
        // Legacy / single-location: look up via claims table
        const { data: claims, error: claimError } = await supabase
          .from('claims')
          .select('clinic_id, chain_clinic_ids')
          .eq('owner_email', userEmail)
          .limit(1);

        if (claimError || !claims || claims.length === 0) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'No clinic claim found for this account. Contact support@skinday.ca.' })
          };
        }

        // Support claims that have chain_clinic_ids stored
        if (claims[0].chain_clinic_ids) {
          try { ownedIds = JSON.parse(claims[0].chain_clinic_ids).map(String); } catch { ownedIds = []; }
        }
        if (ownedIds.length === 0) ownedIds = [String(claims[0].clinic_id)];
      }

      // Determine which specific clinic to load:
      // If body.clinicId is provided (switcher request), use it — but only if user owns it.
      let targetId;
      if (body.clinicId && ownedIds.includes(String(body.clinicId))) {
        targetId = String(body.clinicId);
      } else {
        targetId = ownedIds[0]; // default: first (primary) location
      }

      // Fetch the target clinic
      const { data: clinics, error: clinicError } = await supabase
        .from('clinics')
        .select('*')
        .eq('id', targetId)
        .eq('approved', true)
        .limit(1);

      if (clinicError || !clinics || clinics.length === 0) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'No approved clinic found for this account. Contact support@skinday.ca.' })
        };
      }

      // Fetch prices from clinic_prices for this clinic
      const { data: priceRows } = await supabase
        .from('clinic_prices')
        .select('toxin, price, injector_type, price_source, price_date')
        .eq('clinic_id', targetId);

      // Get clinic name from claims table (clinics table has no name column)
      const { data: nameRow } = await supabase
        .from('claims')
        .select('clinic_name, clinic_neighbourhood')
        .eq('clinic_id', targetId)
        .limit(1)
        .maybeSingle();

      const clinic = {
        ...clinics[0],
        name:          nameRow?.clinic_name || clinics[0].name || null,
        neighbourhood: nameRow?.clinic_neighbourhood || clinics[0].neighbourhood || null,
        prices:        priceRows || []
      };

      // For chain accounts: return name map for the switcher
      // Prefer user_metadata.clinic_names (set at approval time) — avoids DB query
      // since clinics table doesn't have a name column
      let clinicNames = {};
      if (meta.clinic_names && typeof meta.clinic_names === 'object') {
        // Normalize keys to strings
        Object.entries(meta.clinic_names).forEach(([k, v]) => {
          clinicNames[String(k)] = v;
        });
      }
      // Fill any gaps from claims table
      const missing = ownedIds.filter(id => !clinicNames[String(id)]);
      if (missing.length > 0) {
        const { data: claimRows } = await supabase
          .from('claims')
          .select('clinic_id, clinic_name')
          .in('clinic_id', missing);
        (claimRows || []).forEach(cl => {
          const label = cl.clinic_neighbourhood
            ? `${cl.clinic_name} — ${cl.clinic_neighbourhood}`
            : cl.clinic_name;
          clinicNames[String(cl.clinic_id)] = label;
        });
      }
      // Always ensure current clinic name is set
      clinicNames[String(targetId)] = clinic.name || clinicNames[String(targetId)] || 'Clinic ' + targetId;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          clinic,
          clinic_ids:   ownedIds,
          clinic_names: clinicNames
        })
      };
    }

    // ── SAVE CLINIC ──
    if (action === 'save-clinic') {
      const { clinicId, payload } = body;

      if (!clinicId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing clinicId' }) };
      }

      // Verify this user owns this clinic.
      // Chain accounts: check user_metadata.clinic_ids first (fastest).
      // Single/legacy accounts: fall back to claims table lookup.
      const saveMeta = user.user_metadata || {};
      const ownedSaveIds = Array.isArray(saveMeta.clinic_ids)
        ? saveMeta.clinic_ids.map(String)
        : [];

      let isOwner = ownedSaveIds.includes(String(clinicId));

      if (!isOwner) {
        // Fallback: check claims table (single-location or pre-chain legacy accounts)
        const { data: claims } = await supabase
          .from('claims')
          .select('clinic_id, chain_clinic_ids')
          .eq('owner_email', userEmail)
          .limit(1);

        if (claims && claims.length > 0) {
          // Check primary clinic_id
          if (String(claims[0].clinic_id) === String(clinicId)) isOwner = true;
          // Check chain_clinic_ids
          if (!isOwner && claims[0].chain_clinic_ids) {
            try {
              const chainIds = JSON.parse(claims[0].chain_clinic_ids).map(String);
              isOwner = chainIds.includes(String(clinicId));
            } catch { /* ignore parse error */ }
          }
        }
      }

      if (!isOwner) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
      }

      // Only allow safe fields to be updated
      const safePayload = {};
      const allowedFields = ['phone', 'website', 'booking_url', 'promo', 'promo_text', 'hours', 'photos', 'logo_url', 'injector_credentials', 'languages'];
      for (const field of allowedFields) {
        if (payload[field] !== undefined) safePayload[field] = payload[field];
      }

      const { error: updateError } = await supabase
        .from('clinics')
        .update(safePayload)
        .eq('id', clinicId);

      if (updateError) {
        console.error('Update error:', updateError);
        return { statusCode: 500, headers, body: JSON.stringify({ error: updateError.message }) };
      }

      // Handle multi-price rows → clinic_prices table
      if (payload.prices && Array.isArray(payload.prices) && payload.prices.length > 0) {
        const priceDate = payload.price_date || new Date().toISOString().split('T')[0];
        const priceRows = payload.prices.map(p => ({
          clinic_id:    String(clinicId),
          toxin:        p.toxin,
          price:        parseFloat(p.price),
          injector_type: p.injector_type || '',
          price_source: 'clinic',
          price_date:   priceDate,
          updated_at:   new Date().toISOString()
        }));

        const { error: pricesError } = await supabase
          .from('clinic_prices')
          .upsert(priceRows, { onConflict: 'clinic_id,toxin,injector_type' });

        if (pricesError) {
          console.error('clinic_prices error:', pricesError);
          return { statusCode: 500, headers, body: JSON.stringify({ error: pricesError.message }) };
        }

        // Sync lowest price back to clinics table for card display
        const lowestRow = priceRows.reduce((min, p) => p.price < min.price ? p : min, priceRows[0]);
        await supabase
          .from('clinics')
          .update({
            price:        lowestRow.price,
            price_source: lowestRow.price_source,
            price_date:   lowestRow.price_date,
            toxin_type:   lowestRow.toxin
          })
          .eq('id', String(clinicId));
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
