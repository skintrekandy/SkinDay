// ============================================================================
// SkinDay Market Intelligence — dashboard API  (M40, 2026-07-30)
// ----------------------------------------------------------------------------
// Read-only. Password-gated (MI_SECRET). Server-side service role so the data
// (the national competitive map — the moat) never leaves as an anon key a
// browser could dump. Every action calls a mi_* RPC in the data layer and
// returns only shaped, geography-scoped rows.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MI_SECRET
// ============================================================================
const { createClient } = require('@supabase/supabase-js');

function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-mi-secret'
  };
}
function json(status, body) {
  return {
    statusCode: status,
    headers: Object.assign({ 'content-type': 'application/json' }, cors()),
    body: JSON.stringify(body)
  };
}

// null out empty strings so the RPCs treat "" the same as "all"
function nz(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  // ---- gate ----------------------------------------------------------------
  const secret = event.headers['x-mi-secret'] || event.headers['X-Mi-Secret'];
  if (!process.env.MI_SECRET || secret !== process.env.MI_SECRET) {
    return json(401, { error: 'unauthorized' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'bad json' }); }

  const action = body.action;
  const province = nz(body.province);
  const city = nz(body.city);
  const neighbourhood = nz(body.neighbourhood);
  const category = nz(body.category);
  const manufacturer = nz(body.manufacturer) || 'Cynosure Lutronic';

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    switch (action) {

      // geography drill-down options: no args -> provinces; province -> cities;
      // province+city -> neighbourhoods
      case 'geo': {
        const { data, error } = await supabase.rpc('mi_geo', {
          p_province: province, p_city: city
        });
        if (error) throw error;
        return json(200, { geo: data || [] });
      }

      // the four headline tiles + MoM delta
      case 'kpis': {
        const { data, error } = await supabase.rpc('mi_kpis', {
          p_province: province, p_city: city,
          p_neighbourhood: neighbourhood, p_manufacturer: manufacturer
        });
        if (error) throw error;
        return json(200, { kpis: data });
      }

      // per-category ours vs competitor vs total (the panel below the KPI row)
      case 'categories': {
        const { data, error } = await supabase.rpc('mi_categories', {
          p_province: province, p_city: city,
          p_neighbourhood: neighbourhood, p_manufacturer: manufacturer
        });
        if (error) throw error;
        return json(200, { categories: data || [] });
      }

      // the filterable clinic list. segment: ours|competitor|none|greenfield
      case 'accounts': {
        const segment = nz(body.segment);
        const limit = Math.min(Math.max(parseInt(body.limit, 10) || 200, 1), 500);
        const { data, error } = await supabase.rpc('mi_accounts', {
          p_province: province, p_city: city, p_neighbourhood: neighbourhood,
          p_category: category, p_segment: segment, p_limit: limit
        });
        if (error) throw error;
        return json(200, { accounts: data || [] });
      }

      // ranked opportunities for a target category, with reasons
      case 'opportunities': {
        if (!category) return json(400, { error: 'category required' });
        const limit = Math.min(Math.max(parseInt(body.limit, 10) || 100, 1), 500);
        const { data, error } = await supabase.rpc('mi_opportunities', {
          p_category: category, p_province: province, p_city: city,
          p_neighbourhood: neighbourhood, p_limit: limit
        });
        if (error) throw error;
        return json(200, { opportunities: data || [] });
      }

      // one call that returns everything the top of the dashboard needs, so the
      // page makes ONE request on a geography change instead of three
      case 'overview': {
        const [k, c, g] = await Promise.all([
          supabase.rpc('mi_kpis', {
            p_province: province, p_city: city,
            p_neighbourhood: neighbourhood, p_manufacturer: manufacturer
          }),
          supabase.rpc('mi_categories', {
            p_province: province, p_city: city,
            p_neighbourhood: neighbourhood, p_manufacturer: manufacturer
          }),
          supabase.rpc('mi_geo', { p_province: province, p_city: city })
        ]);
        if (k.error) throw k.error;
        if (c.error) throw c.error;
        if (g.error) throw g.error;
        return json(200, { kpis: k.data, categories: c.data || [], geo: g.data || [] });
      }

      // the manufacturer's own installed base, their taxonomy, generation split
      case 'portfolio': {
        const { data, error } = await supabase.rpc('mi_portfolio', {
          p_province: province, p_neighbourhood: neighbourhood, p_manufacturer: manufacturer
        });
        if (error) throw error;
        return json(200, { portfolio: data || [] });
      }

      // ---- My List (shared saved accounts + notes) ----
      case 'save_account': {
        if (!body.clinic_id) return json(400, { error: 'clinic_id required' });
        const { data, error } = await supabase.rpc('mi_save_account', {
          p_clinic_id: String(body.clinic_id), p_note: nz(body.note)
        });
        if (error) throw error;
        return json(200, { result: data });
      }
      case 'set_note': {
        if (!body.clinic_id) return json(400, { error: 'clinic_id required' });
        const { data, error } = await supabase.rpc('mi_set_note', {
          p_clinic_id: String(body.clinic_id), p_note: body.note == null ? '' : String(body.note)
        });
        if (error) throw error;
        return json(200, { result: data });
      }
      case 'remove_account': {
        if (!body.clinic_id) return json(400, { error: 'clinic_id required' });
        const { data, error } = await supabase.rpc('mi_remove_account', {
          p_clinic_id: String(body.clinic_id)
        });
        if (error) throw error;
        return json(200, { result: data });
      }
      case 'list_saved': {
        const { data, error } = await supabase.rpc('mi_list_saved', {});
        if (error) throw error;
        return json(200, { saved: data || [] });
      }

      default:
        return json(400, { error: 'unknown action', got: action });
    }
  } catch (e) {
    return json(500, { error: 'query failed', detail: String(e.message || e) });
  }
};
