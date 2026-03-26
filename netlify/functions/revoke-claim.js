// netlify/functions/revoke-claim.js
//
// Revokes an approved clinic claim.
// Called from the admin dashboard when an approval needs to be undone.
//
// POST /api/claims (action: 'revoke', claim_id)
// Auth: x-admin-secret header
//
// What it does:
//   1. Sets claims.status = 'revoked'
//   2. Resets clinics.claimed = false, approved = false, claimed_email = null
//      — for chains: resets ALL locations in chain_clinic_ids
//   3. Disables the Supabase auth user (does not delete — preserves audit trail)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

async function sb(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Auth
  const secret = event.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { claim_id, admin_note } = body;
  if (!claim_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing claim_id' }) };

  try {
    // 1. Fetch the claim to get clinic_id, owner_email, chain_clinic_ids
    const claimRes = await sb(`claims?id=eq.${claim_id}&select=clinic_id,owner_email,chain_clinic_ids,status&limit=1`);
    if (!claimRes.ok || !claimRes.data?.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Claim not found' }) };
    }

    const claim = claimRes.data[0];

    if (claim.status === 'revoked') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Claim is already revoked' }) };
    }

    // 2. Determine all clinic IDs to reset
    let clinicIds = [String(claim.clinic_id)];
    if (claim.chain_clinic_ids) {
      try {
        const chainIds = JSON.parse(claim.chain_clinic_ids).map(String);
        if (chainIds.length > 0) clinicIds = chainIds;
      } catch { /* use primary only */ }
    }

    // 3. Reset all clinic rows
    for (const id of clinicIds) {
      await sb(
        `clinics?id=eq.${id}`,
        'PATCH',
        { claimed: false, approved: false, claimed_email: null }
      );
    }

    // 4. Mark claim as revoked
    await sb(
      `claims?id=eq.${claim_id}`,
      'PATCH',
      {
        status: 'revoked',
        admin_note: admin_note || null,
        reviewed_at: new Date().toISOString()
      }
    );

    // 5. Disable auth user (ban them — doesn't delete, preserves audit trail)
    if (claim.owner_email) {
      // Find user by email
      const userRes = await fetch(
        `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(claim.owner_email)}`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const userData = await userRes.json();
      const user = userData?.users?.[0];

      if (user?.id) {
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
          method: 'PUT',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ ban_duration: 'none', is_sso_user: false })
          // Note: to fully disable use ban_duration: '87600h' (10 years)
          // We use a soft disable here — admin can re-enable if needed
        });
        // Actually ban them
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
          method: 'PUT',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ ban_duration: '87600h' })
        });
        console.log(`Banned auth user: ${claim.owner_email}`);
      }
    }

    console.log(`✅ Revoked claim ${claim_id} — reset ${clinicIds.length} clinic(s)`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        clinic_ids_reset: clinicIds,
        message: `Claim revoked. ${clinicIds.length} clinic(s) reset to unclaimed.`
      })
    };

  } catch (err) {
    console.error('revoke-claim error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
