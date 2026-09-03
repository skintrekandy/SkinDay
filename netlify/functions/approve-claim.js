// netlify/functions/approve-claim.js
//
// Triggered by a Supabase Postgres webhook on UPDATE to the `clinics` table.
// Fires when `approved` flips to true.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const WEBHOOK_SECRET       = process.env.APPROVE_WEBHOOK_SECRET;

// ─────────────────────────────────────────────────────────────
// M23 - THE PORTAL A CLINIC IS SENT TO DEPENDS ON ITS COUNTRY.
//
// ⚠️⚠️ THIS FUNCTION MUST EXIST IN EXACTLY ONE PLACE. It is not called by a
// page; it is called by a Supabase Postgres webhook on the `clinics` table,
// and there is one clinics table and one webhook. Deploying a second copy on
// another site and pointing a second webhook at it would create the auth user
// twice and email the clinic twice for every approval.
//
// Before M23 the portal url was a single env var defaulting to skinday.ca.
// That was correct while every claimable clinic was Canadian. It is wrong the
// moment a US clinic is approved: they would receive a password link that
// lands on the Canadian site, whose save-clinic cannot serve them.
//
// The webhook payload carries the whole clinics row, so `record.country` is
// already available and no schema change is needed.
//
// ⚠️ `redirect_to` on a recovery link only works if the exact url is in
// Supabase Auth > URL Configuration > Redirect URLs. Adding a country here
// without allowlisting its editor url makes Supabase silently fall back to
// the project Site URL, and the clinic lands in the wrong place with no error
// anywhere to explain it.
// ─────────────────────────────────────────────────────────────
const SITE_BY_COUNTRY = {
  canada:   'https://skinday.ca',
  usa:      'https://skinday.com',
  taiwan:   'https://skinday.com',
  hongkong: 'https://skinday.com'
};

// ⚠️ The CONTACT address follows the clinic's own site, so each site's contact
// email matches its domain. The SENDER stays hello@skinday.ca on both: that is
// the domain verified in Resend and the one the .com key is scoped to, and
// verifying a second domain is deliberately not being paid for.
//
// ⚠️ Both approval paths serve BOTH countries. This function is .ca-only but is
// fired by a webhook on every clinic; the .com admin's claims queue likewise
// shows every country. So neither can hardcode a contact address.
function contactFor(country) {
  const site = siteFor(country) || 'https://skinday.ca';
  return 'hello@' + site.replace(/^https?:\/\//, '');
}

// PORTAL_URL is kept only as the last resort for a clinics row with no country
// value at all. It is no longer the primary source, so if it is still set in
// Netlify to the .ca url that setting now affects nothing except that edge.
const FALLBACK_PORTAL_URL = process.env.PORTAL_URL || 'https://skinday.ca/editor.html';

function siteFor(country) {
  const key = String(country || '').trim().toLowerCase();
  return SITE_BY_COUNTRY[key] || null;
}

function portalUrlFor(country) {
  const site = siteFor(country);
  if (!site) {
    console.error(`No site mapped for country "${country}" - falling back to ${FALLBACK_PORTAL_URL}. The clinic may be sent to the wrong portal.`);
    return FALLBACK_PORTAL_URL;
  }
  return `${site}/editor.html`;
}

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

  // Resolved from the row the webhook just handed us, not from an env var.
  const portalUrl = portalUrlFor(record.country);

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

    console.log(`Approving: ${clinic_name} (${owner_email}) — ${allClinicIds.length} location(s), country=${record.country}, portal=${portalUrl}`);

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
        redirect_to: portalUrl
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
        html: buildEmail(clinic_name, linkData.action_link, allClinicIds.length, portalUrl)
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

function buildEmail(clinicName, setupLink, locationCount = 1, portalUrl = FALLBACK_PORTAL_URL) {
  const contact = 'hello@' + String(portalUrl).replace(/^https?:\/\//, '').split('/')[0];
  // The expiry fallback link must point at the SAME portal as the setup link,
  // or a US clinic whose link expires is sent to the Canadian login.
  const portalLabel = String(portalUrl).replace(/^https?:\/\//, '');
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
      <p class="note">This link expires in 24 hours. If it expires, visit <a href="${portalUrl}" style="color:#c9736a;">${portalLabel}</a> and use "Forgot password" to get a new one.</p>
    </div>
    <div class="footer">
      Questions? Reply to this email or contact <a href="mailto:${contact}" style="color:#c9736a;">${contact}</a><br/>
      SkinDay · Toronto, ON
    </div>
  </div>
</body>
</html>`.trim();
}
