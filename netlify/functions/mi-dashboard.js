// ============================================================================
// SkinDay Market Intelligence — dashboard API  (M41, 2026-07-31)
// ----------------------------------------------------------------------------
// Read-only apart from the saved list. Server-side service role so the data
// (the national competitive map — the moat) never leaves as an anon key a
// browser could dump. Every action calls a mi_* RPC and returns shaped rows.
//
// MULTI-TENANT, WITH ROLES. Nothing about a customer lives in this file. The
// x-mi-secret header resolves to a USER in mi_users, which yields the tenant
// (display name, branding, and the OWNER PREDICATE: owner_type
// 'manufacturer'|'distributor' plus owner_name), the ROLE and the TERRITORY.
// A distributor tenant's installed base is defined by distributor_ca, not by
// manufacturer, which no amount of p_manufacturer could express.
//
// Two rules enforced here rather than in the browser, because a dropdown is
// not a permission: a user with a province is LOCKED to it whatever the page
// asks for, and only role='admin' may write settings.
//
// Resolution order, so nobody is locked out mid-pilot:
//   mi_users -> mi_tenants (treated as admin) -> MI_SECRET env var.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MI_SECRET (fallback only)
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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

// The fallback tenant, used only when MI_SECRET matches and mi_tenants has no
// row for it. Deliberately the ONLY place a customer name appears in code.
const FALLBACK_TENANT = {
  tenant_id: null,
  user_id: null,
  slug: 'cynosure',
  display_name: 'Cynosure Lutronic',
  owner_type: 'manufacturer',
  owner_name: 'Cynosure Lutronic',
  accent_hex: '#147D74',
  logo_url: null,
  user_name: 'Pilot access',
  role: 'admin',
  province: null
};

async function rpcRow(supabase, fn, args) {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (!error && Array.isArray(data) && data.length) return data[0];
  } catch (e) { /* fall through to the next resolution step */ }
  return null;
}

async function resolveIdentity(supabase, secret) {
  if (!secret) return null;

  const asUser = await rpcRow(supabase, 'mi_user_by_secret', { p_secret: secret });
  if (asUser) return asUser;

  // a tenant-level code is an admin with no territory limit
  const asTenant = await rpcRow(supabase, 'mi_tenant_by_secret', { p_secret: secret });
  if (asTenant) {
    return Object.assign({}, asTenant, {
      user_id: null, user_name: 'Admin', role: 'admin', province: null
    });
  }

  if (process.env.MI_SECRET && secret === process.env.MI_SECRET) return FALLBACK_TENANT;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'bad json' }); }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  // ---- gate + identity -------------------------------------------------------
  const secret = event.headers['x-mi-secret'] || event.headers['X-Mi-Secret'];
  const me = await resolveIdentity(supabase, secret);
  if (!me) return json(401, { error: 'unauthorized' });

  const owner = { p_owner_type: me.owner_type, p_owner_name: me.owner_name };
  const scope = { p_tenant_id: me.tenant_id, p_user_id: me.user_id };
  const brand = {
    display_name: me.display_name,
    accent_hex: me.accent_hex,
    logo_url: me.logo_url || null,
    owner_type: me.owner_type,
    user_name: me.user_name,
    role: me.role,
    province: me.province || null
  };
  const isAdmin = me.role === 'admin';

  const action = body.action;
  // a locked territory is enforced here, not offered as a choice in the page
  const province = me.province ? me.province : nz(body.province);
  const city = nz(body.city);
  const neighbourhood = nz(body.neighbourhood);
  const category = nz(body.category);

  try {
    switch (action) {

      // who am I — lets the page set its badge and accent before anything loads
      case 'tenant':
        return json(200, { tenant: brand });

      // geography drill-down options: no args -> provinces; province -> neighbourhoods
      case 'geo': {
        const { data, error } = await supabase.rpc('mi_geo', {
          p_province: province, p_city: city
        });
        if (error) throw error;
        return json(200, { geo: data || [] });
      }

      case 'kpis': {
        const { data, error } = await supabase.rpc('mi_kpis', Object.assign({
          p_province: province, p_city: city, p_neighbourhood: neighbourhood
        }, owner));
        if (error) throw error;
        return json(200, { kpis: data });
      }

      case 'categories': {
        const { data, error } = await supabase.rpc('mi_categories', Object.assign({
          p_province: province, p_city: city, p_neighbourhood: neighbourhood
        }, owner));
        if (error) throw error;
        return json(200, { categories: data || [] });
      }

      // top N manufacturers by penetration in the selected geography. The same
      // field for every tenant: a rep sells against machines, not channels.
      case 'leaderboard': {
        const limit = Math.min(Math.max(parseInt(body.limit, 10) || 3, 1), 20);
        const { data, error } = await supabase.rpc('mi_leaderboard', Object.assign({
          p_province: province, p_neighbourhood: neighbourhood, p_limit: limit
        }, owner));
        if (error) throw error;
        return json(200, { leaderboard: data || [] });
      }

      // manufacturer + distributor option lists for the Accounts filters,
      // each with a clinic count, energy devices only
      case 'filter_options': {
        const { data, error } = await supabase.rpc('mi_filter_options', {
          p_province: province, p_neighbourhood: neighbourhood
        });
        if (error) throw error;
        return json(200, { options: data || { manufacturers: [], distributors: [] } });
      }

      // the filterable clinic list.
      // segment: ours | competitor | greenfield | research
      case 'accounts': {
        const segment = nz(body.segment);
        const limit = Math.min(Math.max(parseInt(body.limit, 10) || 200, 1), 500);
        const { data, error } = await supabase.rpc('mi_accounts', Object.assign({
          p_province: province, p_city: city, p_neighbourhood: neighbourhood,
          p_category: category, p_segment: segment, p_limit: limit,
          p_filter_manufacturer: nz(body.filter_manufacturer),
          p_filter_distributor: nz(body.filter_distributor)
        }, owner));
        if (error) throw error;
        return json(200, { accounts: data || [] });
      }

      // one call for everything above the fold, so a geography change is a
      // single request instead of four
      case 'overview': {
        const [k, c, g, l] = await Promise.all([
          supabase.rpc('mi_kpis', Object.assign({
            p_province: province, p_city: city, p_neighbourhood: neighbourhood
          }, owner)),
          supabase.rpc('mi_categories', Object.assign({
            p_province: province, p_city: city, p_neighbourhood: neighbourhood
          }, owner)),
          supabase.rpc('mi_geo', { p_province: province, p_city: city }),
          supabase.rpc('mi_leaderboard', Object.assign({
            p_province: province, p_neighbourhood: neighbourhood, p_limit: 3
          }, owner))
        ]);
        if (k.error) throw k.error;
        if (c.error) throw c.error;
        if (g.error) throw g.error;
        if (l.error) throw l.error;
        return json(200, {
          tenant: brand,
          kpis: k.data,
          categories: c.data || [],
          geo: g.data || [],
          leaderboard: l.data || []
        });
      }

      // the tenant's own installed base, their taxonomy
      case 'portfolio': {
        const { data, error } = await supabase.rpc('mi_portfolio', Object.assign({
          p_province: province, p_neighbourhood: neighbourhood
        }, owner));
        if (error) throw error;
        return json(200, { portfolio: data || [] });
      }

      // ---- My List (shared saved accounts + notes, per tenant) ----
      case 'save_account': {
        if (!body.clinic_id) return json(400, { error: 'clinic_id required' });
        const { data, error } = await supabase.rpc('mi_save_account', Object.assign({
          p_clinic_id: String(body.clinic_id), p_note: nz(body.note)
        }, scope));
        if (error) throw error;
        return json(200, { result: data });
      }
      case 'set_note': {
        if (!body.clinic_id) return json(400, { error: 'clinic_id required' });
        const { data, error } = await supabase.rpc('mi_set_note', Object.assign({
          p_clinic_id: String(body.clinic_id), p_note: body.note == null ? '' : String(body.note)
        }, scope));
        if (error) throw error;
        return json(200, { result: data });
      }
      case 'remove_account': {
        if (!body.clinic_id) return json(400, { error: 'clinic_id required' });
        const { data, error } = await supabase.rpc('mi_remove_account', Object.assign({
          p_clinic_id: String(body.clinic_id)
        }, scope));
        if (error) throw error;
        return json(200, { result: data });
      }
      case 'list_saved': {
        const { data, error } = await supabase.rpc('mi_list_saved', Object.assign({
          p_role: me.role
        }, scope, owner));
        if (error) throw error;
        return json(200, { saved: data || [] });
      }

      // ---- Settings (admin only) ----
      case 'save_settings': {
        if (!isAdmin) return json(403, { error: 'admin only' });
        if (!me.slug) return json(400, { error: 'no tenant to update' });
        const { data, error } = await supabase.rpc('mi_set_tenant_branding', {
          p_slug: me.slug,
          p_display_name: nz(body.display_name),
          p_accent_hex: nz(body.accent_hex),
          p_logo_url: body.logo_url == null ? null : String(body.logo_url)
        });
        if (error) throw error;
        const row = Array.isArray(data) && data.length ? data[0] : null;
        return json(200, { tenant: row });
      }

      default:
        return json(400, { error: 'unknown action', got: action });
    }
  } catch (e) {
    return json(500, { error: 'query failed', detail: String(e.message || e) });
  }
};
