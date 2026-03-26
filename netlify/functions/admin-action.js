// Build a map of clinic_id → clinic_name for chain accounts
// Uses claims table (has clinic_name) and falls back to 'Clinic {id}'
async function buildClinicNamesMap(clinicIds, primaryName, primaryId, supabase) {
  const namesMap = {};
  // Primary name — neighbourhood comes from the claim itself, passed separately if needed
  namesMap[String(primaryId)] = primaryName;
  const others = clinicIds.filter(id => String(id) !== String(primaryId));
  if (others.length > 0) {
    const { data: otherClaims } = await supabase
      .from('claims')
      .select('clinic_id, clinic_name, clinic_neighbourhood')
      .in('clinic_id', others);
    (otherClaims || []).forEach(cl => {
      const label = cl.clinic_neighbourhood
        ? `${cl.clinic_name} — ${cl.clinic_neighbourhood}`
        : cl.clinic_name;
      namesMap[String(cl.clinic_id)] = label;
    });
    // Fill any missing with fallback
    others.forEach(id => {
      if (!namesMap[String(id)]) namesMap[String(id)] = 'Location ' + id;
    });
  }
  return namesMap;
}

// netlify/functions/admin-action.js
// Admin-only endpoint. Approves, rejects, lists claims, or adds missing clinics.
// Auth: ADMIN_SECRET env var checked on every request.
//
// POST /api/admin-action
// Headers: x-admin-secret: <ADMIN_SECRET>
// Body (JSON):
//   action: 'approve' | 'reject' | 'list' | 'add-clinic'
//
//   For approve/reject:
//     claim_id: string
//     admin_note: string (optional)
//
//   For add-clinic:
//     name: string (required)
//     neighbourhood: string
//     area: string
//     phone: string
//     website: string
//     maps_url: string
//     owner_name: string
//     owner_email: string
//     admin_note: string

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // Auth check
  const secret = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { action } = body;

  // ── LIST ────────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const status = body.status || 'pending';
    const { data, error } = await supabase
      .from('claims')
      .select('*')
      .eq('status', status)
      .order('submitted_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('admin list error:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to list claims' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ claims: data }) };
  }

  // ── SET PRICES (multi-row to clinic_prices table) ───────────────────────────
  if (action === 'set-prices') {
    const { clinic_id, prices } = body;

    if (!clinic_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'clinic_id required' }) };
    }
    if (!prices || !prices.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'prices array required' }) };
    }

    const priceDate = new Date().toISOString().split('T')[0];

    // Ensure clinic row exists FIRST (foreign key requirement)
    await supabase
      .from('clinics')
      .upsert({ id: String(clinic_id), approved: true }, { onConflict: 'id' });

    const rows = prices.map(p => ({
      clinic_id:     String(clinic_id),
      toxin:         p.toxin,
      price:         parseFloat(p.price),
      injector_type: p.injector_type || '',
      price_source:  'inquiry',
      price_date:    priceDate,
      updated_at:    new Date().toISOString()
    }));

    const { error: pricesError } = await supabase
      .from('clinic_prices')
      .upsert(rows, { onConflict: 'clinic_id,toxin,injector_type' });

    if (pricesError) {
      console.error('set-prices error:', pricesError);
      return { statusCode: 500, headers, body: JSON.stringify({ error: pricesError.message }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, inserted: rows.length }) };
  }

  // ── SET CLINIC INFO (credentials + languages) ────────────────────────────────
  if (action === 'set-clinic-info') {
    const { clinic_id, injector_credentials, languages } = body;

    if (!clinic_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'clinic_id required' }) };
    }

    const update = {};
    if (injector_credentials !== undefined) update.injector_credentials = injector_credentials;
    if (languages !== undefined) update.languages = languages;

    if (!Object.keys(update).length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nothing to update' }) };
    }

    const { error: updateError } = await supabase
      .from('clinics')
      .upsert({ id: String(clinic_id), approved: true, ...update }, { onConflict: 'id' });

    if (updateError) {
      console.error('set-clinic-info error:', updateError);
      return { statusCode: 500, headers, body: JSON.stringify({ error: updateError.message }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  // ── GET CLINIC PRICES ────────────────────────────────────────────────────────
  if (action === 'get-clinic-prices') {
    const { clinic_id } = body;
    if (!clinic_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'clinic_id required' }) };
    }

    const { data, error } = await supabase
      .from('clinic_prices')
      .select('*')
      .eq('clinic_id', String(clinic_id))
      .order('price', { ascending: true });

    if (error) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }

    // Also get credentials/languages from clinics table
    const { data: clinicData } = await supabase
      .from('clinics')
      .select('injector_credentials, languages')
      .eq('id', String(clinic_id))
      .maybeSingle();

    return { statusCode: 200, headers, body: JSON.stringify({
      prices: data || [],
      injector_credentials: clinicData?.injector_credentials || [],
      languages: clinicData?.languages || []
    })};
  }

  // ── DELETE CLINIC PRICE ──────────────────────────────────────────────────────
  if (action === 'delete-price') {
    const { price_id } = body;
    if (!price_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'price_id required' }) };
    }

    const { error } = await supabase
      .from('clinic_prices')
      .delete()
      .eq('id', price_id);

    if (error) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  // ── ADD CLINIC ──────────────────────────────────────────────────────────────
  if (action === 'add-clinic') {
    const { name, neighbourhood, area, phone, website, maps_url, owner_name, owner_email, admin_note } = body;

    if (!name || !name.trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Clinic name is required' }) };
    }

    // Generate a unique ID: find current max int id in clinics table and increment
    // We use a large base (10000+) to avoid colliding with the static array IDs (max ~1696)
    const { data: existing } = await supabase
      .from('clinics')
      .select('id')
      .gte('id', '10000')
      .order('id', { ascending: false })
      .limit(1);

    let newId;
    if (existing && existing.length > 0) {
      newId = String(parseInt(existing[0].id) + 1);
    } else {
      newId = '10001'; // first manually added clinic
    }

    const now = new Date().toISOString();

    // Insert into clinics table — approved but NOT claimed (clinic hasn't verified ownership)
    const { error: clinicErr } = await supabase
      .from('clinics')
      .insert({
        id:          newId,
        claimed:     false,
        approved:    true,
        phone:       phone   || null,
        website:     website || null,
      });

    if (clinicErr) {
      console.error('add-clinic insert error:', clinicErr);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to add clinic' }) };
    }

    // Insert claims audit record
    await supabase.from('claims').insert({
      clinic_id:            newId,
      clinic_name:          name.trim(),
      clinic_neighbourhood: neighbourhood || null,
      owner_name:           owner_name  || 'Unknown',
      owner_email:          owner_email || 'unknown@unknown.com',
      owner_role:           'Owner',
      status:               'approved',
      admin_note:           admin_note || 'Manually added by admin',
      reviewed_at:          now,
      reviewed_by:          'admin'
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:   true,
        clinic_id: newId,
        name:      name.trim()
      })
    };
  }

  // ── REVOKE ─────────────────────────────────────────────────────────────────
  if (action === 'revoke') {
    const { claim_id, admin_note } = body;
    if (!claim_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'claim_id required' }) };
    }

    // Fetch the claim
    const { data: revokeClaim, error: rClaimErr } = await supabase
      .from('claims')
      .select('clinic_id, owner_email, chain_clinic_ids, status')
      .eq('id', claim_id)
      .maybeSingle();

    if (rClaimErr || !revokeClaim) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Claim not found' }) };
    }
    if (revokeClaim.status === 'revoked') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Claim is already revoked' }) };
    }

    // Determine all clinic IDs to reset (handles chains)
    let clinicIds = [String(revokeClaim.clinic_id)];
    if (revokeClaim.chain_clinic_ids) {
      try {
        const chainIds = JSON.parse(revokeClaim.chain_clinic_ids).map(String);
        if (chainIds.length > 0) clinicIds = chainIds;
      } catch { /* use primary only */ }
    }

    // Reset all clinic rows to unclaimed
    const { error: resetErr } = await supabase
      .from('clinics')
      .update({ claimed: false, approved: false, claimed_email: null })
      .in('id', clinicIds);

    if (resetErr) {
      console.error('revoke reset error:', resetErr);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reset clinic(s)' }) };
    }

    // Mark claim as revoked
    const { error: rUpdateErr } = await supabase
      .from('claims')
      .update({
        status:      'revoked',
        admin_note:  admin_note || null,
        reviewed_at: new Date().toISOString()
      })
      .eq('id', claim_id);

    if (rUpdateErr) {
      console.error('revoke claim update error:', rUpdateErr);
    }

    // Ban the auth user so they lose portal access
    if (revokeClaim.owner_email) {
      try {
        const userRes = await fetch(
          `${process.env.SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(revokeClaim.owner_email)}`,
          { headers: { 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
        );
        const userData = await userRes.json();
        const authUser = userData?.users?.[0];
        if (authUser?.id) {
          await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${authUser.id}`, {
            method: 'PUT',
            headers: {
              'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ban_duration: '87600h' })
          });
          console.log(`Banned auth user: ${revokeClaim.owner_email}`);
        }
      } catch (e) {
        // Non-fatal — clinic is already reset
        console.error('Auth ban failed (non-fatal):', e.message);
      }
    }

    console.log(`✅ Revoked claim ${claim_id} — reset ${clinicIds.length} clinic(s)`);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, action: 'revoked', claim_id, clinic_ids_reset: clinicIds })
    };
  }

    // ── APPROVE / REJECT ────────────────────────────────────────────────────────
  if (!['approve', 'reject', 'revoke'].includes(action)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action. Use approve, reject, revoke, list, set-prices, set-clinic-info, get-clinic-prices, delete-price, or add-clinic.' }) };
  }

  const { claim_id, admin_note } = body;
  if (!claim_id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'claim_id required' }) };
  }

  // Fetch the claim
  const { data: claim, error: claimErr } = await supabase
    .from('claims')
    .select('*')
    .eq('id', claim_id)
    .maybeSingle();

  if (claimErr || !claim) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Claim not found' }) };
  }

  // If already approved, allow re-triggering the email (handles failed first attempts)
  // If rejected or revoked, block
  if (claim.status === 'approved' && action === 'approve') {
    console.log(`Claim ${claim_id} already approved — re-triggering email only`);
    // Fall through to email trigger below, skip DB upsert
  } else if (claim.status !== 'pending') {
    return { statusCode: 409, headers, body: JSON.stringify({ error: `Claim is already ${claim.status}` }) };
  }

  const now = new Date().toISOString();

  if (action === 'reject') {
    const { error } = await supabase
      .from('claims')
      .update({ status: 'rejected', reviewed_at: now, admin_note: admin_note || null })
      .eq('id', claim_id);

    if (error) {
      console.error('reject error:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reject claim' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, action: 'rejected', claim_id }) };
  }

  // APPROVE: upsert clinics row, then update claim
  const { error: upsertErr } = await supabase
    .from('clinics')
    .upsert({
      id:           claim.clinic_id,
      claimed:      true,
      approved:     true,
      claimed_email: claim.owner_email,
      claimed_at:   claim.submitted_at,
      approved_at:  now
    }, { onConflict: 'id' });

  if (upsertErr) {
    console.error('upsert error:', upsertErr);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to approve claim' }) };
  }

  // For chains: mark all other locations as claimed/approved too
  if (claim.is_chain && claim.chain_clinic_ids) {
    try {
      const allIds = JSON.parse(claim.chain_clinic_ids).map(String);
      const otherIds = allIds.filter(id => id !== String(claim.clinic_id));
      if (otherIds.length > 0) {
        console.log(`Chain: marking ${otherIds.length} additional location(s) as claimed: ${otherIds.join(', ')}`);
        const { error: chainErr } = await supabase
          .from('clinics')
          .update({ claimed: true, approved: true, claimed_email: claim.owner_email })
          .in('id', otherIds);
        if (chainErr) console.error('Chain locations update error:', chainErr);
      }
    } catch (e) {
      console.error('Chain clinic_ids parse error:', e.message);
    }
  }

  const { error: claimUpdateErr } = await supabase
    .from('claims')
    .update({ status: 'approved', reviewed_at: now, admin_note: admin_note || null })
    .eq('id', claim_id);

  if (claimUpdateErr) {
    console.error('claim update error:', claimUpdateErr);
  }

  // Inline: create auth user + send approval email
  // (avoids unreliable self-HTTP calls between Netlify functions)
  try {
    const SUPA_URL = process.env.SUPABASE_URL;
    const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const RESEND_KEY = process.env.RESEND_API_KEY;
    const PORTAL_URL = process.env.PORTAL_URL || 'https://skinday.ca/editor.html';

    const clinicId = claim.clinic_id;

    // Determine all location IDs (chain support)
    let allClinicIds = [String(clinicId)];
    if (claim.is_chain && claim.chain_clinic_ids) {
      try {
        const parsed = JSON.parse(claim.chain_clinic_ids).map(String);
        if (parsed.length > 0) allClinicIds = parsed;
      } catch { /* use primary */ }
    }

    const ownerEmail = claim.owner_email;
    const clinicName = claim.clinic_name;

    // Create Supabase Auth user
    const authRes = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` },
      body: JSON.stringify({
        email: ownerEmail,
        email_confirm: true,
        user_metadata: { clinic_id: allClinicIds[0], clinic_ids: allClinicIds, clinic_name: clinicName, is_chain: claim.is_chain || false, clinic_names: await buildClinicNamesMap(allClinicIds, clinicName, claim.clinic_id, supabase) }
      })
    });
    const authData = await authRes.json();
    if (!authRes.ok) {
      const msg = authData.msg || authData.message || '';
      if (!msg.toLowerCase().includes('already') && authData.code !== 'email_exists') {
        console.error('Auth user creation failed:', JSON.stringify(authData));
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, action: 'approved', claim_id, clinic_id: clinicId, warning: 'Auth user creation failed — ' + msg }) };
      }
      console.log('Auth user already exists — continuing to send email');
    }

    // Generate password-setup link
    const linkRes = await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` },
      body: JSON.stringify({ type: 'recovery', email: ownerEmail, redirect_to: PORTAL_URL })
    });
    const linkData = await linkRes.json();
    if (!linkRes.ok || !linkData.action_link) {
      console.error('Link generation failed:', JSON.stringify(linkData));
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, action: 'approved', claim_id, clinic_id: clinicId, warning: 'Link generation failed' }) };
    }

    // Build email
    const isChain = allClinicIds.length > 1;
    const headline = isChain ? 'Your listings are live 🎉' : 'Your listing is live 🎉';
    const bodyLine = isChain
      ? `Great news — <strong>${clinicName}</strong> and your other ${allClinicIds.length - 1} location(s) have been approved on SkinDay.`
      : `Great news — <strong>${clinicName}</strong> has been approved on SkinDay. Patients in your area can now find your Botox pricing.`;

    const emailHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>
      body{margin:0;padding:0;background:#faf8f5;font-family:Georgia,sans-serif;}
      .wrap{max-width:520px;margin:40px auto;background:#fffef9;border:1px solid #e8ddd8;border-radius:16px;overflow:hidden;}
      .header{background:#3d2c28;padding:28px 36px;}.logo{font-size:24px;color:white;}.logo span{color:#e8a89f;}
      .body{padding:36px;}h1{font-size:22px;color:#3d2c28;margin:0 0 12px;font-weight:600;}
      p{font-size:15px;color:#6b4c44;line-height:1.6;margin:0 0 16px;}
      .btn{display:inline-block;background:#c9736a;color:white;text-decoration:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:600;margin:8px 0 24px;}
      .note{font-size:13px;color:#9e7a72;}
      .footer{background:#faf8f5;border-top:1px solid #e8ddd8;padding:20px 36px;font-size:12px;color:#9e7a72;}
    </style></head><body><div class="wrap">
      <div class="header"><div class="logo">Skin<span>Day</span></div></div>
      <div class="body">
        <h1>${headline}</h1>
        <p>${bodyLine}</p>
        <p>Set up your password to access the Clinic Portal, where you can update your price, add promos, upload photos, and manage your hours.</p>
        <a href="${linkData.action_link}" class="btn">Set up your password →</a>
        <p class="note">This link expires in 24 hours. If it expires, visit <a href="https://skinday.ca/editor.html" style="color:#c9736a;">skinday.ca/editor.html</a> and use "Forgot password."</p>
      </div>
      <div class="footer">Questions? Reply to this email or contact <a href="mailto:hello@skinday.ca" style="color:#c9736a;">hello@skinday.ca</a><br/>SkinDay · Toronto, ON</div>
    </div></body></html>`;

    // Send email
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'SkinDay <hello@skinday.ca>',
        to: ownerEmail,
        subject: isChain ? `Your SkinDay listings are approved — ${clinicName}` : `Your SkinDay listing is approved — ${clinicName}`,
        html: emailHtml
      })
    });

    if (!emailRes.ok) {
      const emailErr = await emailRes.json();
      console.error('Resend error:', emailErr);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, action: 'approved', claim_id, clinic_id: clinicId, warning: 'Email failed: ' + JSON.stringify(emailErr) }) };
    }

    console.log(`✅ Approved and emailed: ${clinicName} → ${ownerEmail}`);

  } catch (e) {
    console.error('Approval email error (non-fatal):', e.message);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, action: 'approved', claim_id, clinic_id: claim.clinic_id })
  };
};
