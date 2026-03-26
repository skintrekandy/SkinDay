// netlify/functions/approve-claim.js
//
// Triggered by a Supabase Postgres webhook on UPDATE to the `clinics` table.
// Fires when `approved` flips to true.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const WEBHOOK_SECRET       = process.env.APPROVE_WEBHOOK_SECRET;
const PORTAL_URL           = process.env.PORTAL_URL || 'https://skinday.ca/editor.html';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const secret = event.headers['x-webhook-secret'];
  if (secret !== WEBHOOK_SECRET) {
    console.error('Webhook secret mismatch');
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const record    = payload.record;
  const oldRecord = payload.old_record;

  // Only act when approved flips false/null → true
  if (!record || record.approved !== true || oldRecord?.approved === true) {
    console.log('Skipping — not an approval event');
    return { statusCode: 200, body: 'Skipped' };
  }

  const clinicId = record.id;

  try {
    // 1. Look up clinic_name + owner_email from claims table
    const claimRes = await fetch(
      `${SUPABASE_URL}/rest/v1/claims?clinic_id=eq.${clinicId}&select=clinic_name,owner_email,is_chain,chain_clinic_ids&limit=1`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      }
    );
    const claims = await claimRes.json();

    if (!claims || claims.length === 0) {
      console.error(`No claim found for clinic ${clinicId}`);
      return { statusCode: 200, body: 'No claim — skipped' };
    }

    const { clinic_name, owner_email, is_chain, chain_clinic_ids } = claims[0];

    // Parse all location IDs this auth account should own
    let allClinicIds;
    if (is_chain && chain_clinic_ids) {
      try {
        allClinicIds = JSON.parse(chain_clinic_ids);
      } catch {
        allClinicIds = [String(clinicId)];
      }
    } else {
      allClinicIds = [String(clinicId)];
    }

    if (!owner_email) {
      console.error(`Clinic ${clinicId} claim has no owner_email`);
      return { statusCode: 200, body: 'No email — skipped' };
    }

    console.log(`Approving: ${clinic_name} (${owner_email}) — ${allClinicIds.length} location(s)`);

    // 2. Create Supabase Auth user, linking all clinic IDs in metadata
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({
        email: owner_email,
        email_confirm: true,
        user_metadata: {
          clinic_id:   allClinicIds[0],
          clinic_ids:  allClinicIds,
          clinic_name,
          is_chain:    is_chain || false
        }
      })
    });

    const authData = await authRes.json();

    if (!authRes.ok) {
      const msg = authData.msg || authData.message || '';
      if (!msg.toLowerCase().includes('already') && authData.code !== 'email_exists') {
        console.error('Auth user creation failed:', JSON.stringify(authData));
        return { statusCode: 500, body: 'Auth creation failed' };
      }
      console.log('Auth user already exists — continuing');
    }

    // 3. Generate password-setup link
    const linkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({
        type: 'recovery',
        email: owner_email,
        redirect_to: PORTAL_URL
      })
    });

    const linkText = await linkRes.text();
    console.log('generate_link raw response:', linkText);

    let linkData;
    try {
      linkData = JSON.parse(linkText);
    } catch {
      console.error('Could not parse generate_link response:', linkText);
      return { statusCode: 500, body: 'Link parse failed' };
    }

    if (!linkRes.ok || !linkData.action_link) {
      console.error('Link generation failed:', JSON.stringify(linkData));
      return { statusCode: 500, body: 'Link generation failed' };
    }

    // 4. For chains: mark all other locations as claimed in the clinics table
    if (allClinicIds.length > 1) {
      const otherIds = allClinicIds.filter(id => String(id) !== String(clinicId));
      console.log(`Chain: marking ${otherIds.length} additional location(s) as claimed: ${otherIds.join(', ')}`);
      for (const id of otherIds) {
        const patchRes = await fetch(
          `${SUPABASE_URL}/rest/v1/clinics?id=eq.${id}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ claimed: true, approved: true, claimed_email: owner_email })
          }
        );
        if (!patchRes.ok) {
          console.error(`Failed to mark clinic ${id} as claimed`);
        }
      }
    }

    // 5. Send approval email via Resend
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'SkinDay <hello@skinday.ca>',
        to: owner_email,
        subject: is_chain
          ? `Your SkinDay listings are approved — ${clinic_name}`
          : `Your SkinDay listing is approved — ${clinic_name}`,
        html: buildEmail(clinic_name, linkData.action_link, allClinicIds.length)
      })
    });

    if (!emailRes.ok) {
      const emailErr = await emailRes.json();
      console.error('Resend error:', emailErr);
      return { statusCode: 500, body: 'Email send failed' };
    }

    console.log(`✅ Approved and emailed: ${clinic_name} → ${owner_email}`);
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Unexpected error:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
};

function buildEmail(clinicName, setupLink, locationCount = 1) {
  const isChain = locationCount > 1;
  const headline = isChain ? 'Your listings are live 🎉' : 'Your listing is live 🎉';
  const bodyLine = isChain
    ? `Great news — <strong>${clinicName}</strong> and your other ${locationCount - 1} location(s) have been approved on SkinDay.`
    : `Great news — <strong>${clinicName}</strong> has been approved on SkinDay. Patients in your area can now find your Botox pricing.`;
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { margin: 0; padding: 0; background: #faf8f5; font-family: Georgia, sans-serif; }
    .wrap { max-width: 520px; margin: 40px auto; background: #fffef9; border: 1px solid #e8ddd8; border-radius: 16px; overflow: hidden; }
    .header { background: #3d2c28; padding: 28px 36px; }
    .logo { font-size: 24px; color: white; }
    .logo span { color: #e8a89f; }
    .body { padding: 36px; }
    h1 { font-size: 22px; color: #3d2c28; margin: 0 0 12px; font-weight: 600; }
    p { font-size: 15px; color: #6b4c44; line-height: 1.6; margin: 0 0 16px; }
    .btn { display: inline-block; background: #c9736a; color: white; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-size: 15px; font-weight: 600; margin: 8px 0 24px; }
    .note { font-size: 13px; color: #9e7a72; }
    .footer { background: #faf8f5; border-top: 1px solid #e8ddd8; padding: 20px 36px; font-size: 12px; color: #9e7a72; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header"><div class="logo">Skin<span>Day</span></div></div>
    <div class="body">
      <h1>${headline}</h1>
      <p>${bodyLine}</p>
      <p>Set up your password to access the Clinic Portal, where you can update your price, add promos, upload photos, and manage your hours.</p>
      <a href="${setupLink}" class="btn">Set up your password →</a>
      <p class="note">This link expires in 24 hours. If it expires, visit <a href="https://skinday.ca/editor.html" style="color:#c9736a;">skinday.ca/editor.html</a> and use "Forgot password" to get a new one.</p>
    </div>
    <div class="footer">
      Questions? Reply to this email or contact <a href="mailto:hello@skinday.ca" style="color:#c9736a;">hello@skinday.ca</a><br/>
      SkinDay · Toronto, ON
    </div>
  </div>
</body>
</html>`.trim();
}
