// netlify/functions/update-profile.js
// Allows a claimed+approved clinic owner to update their profile.
// Auth: owner_email must match the email on the approved clinics row.
//
// POST /api/update-profile
// Body (JSON): { clinic_id, owner_email, fields: { price?, promo?, promo_text?, phone?, website?, email? } }
// Response: { success: true, updated: {...} } | { error: string }

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Fields the clinic owner is allowed to set
const ALLOWED_FIELDS = ['price', 'promo', 'promo_text', 'phone', 'website', 'email'];

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
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

  const { clinic_id, owner_email, fields } = body;

  if (!clinic_id || !owner_email || !fields || typeof fields !== 'object') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing clinic_id, owner_email, or fields' }) };
  }

  // Verify this owner email matches the approved clinic record
  const { data: clinic, error: fetchErr } = await supabase
    .from('clinics')
    .select('id, claimed, approved, owner_email')
    .eq('id', String(clinic_id))
    .maybeSingle();

  if (fetchErr || !clinic) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Clinic not found' }) };
  }

  if (!clinic.approved || !clinic.claimed) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Clinic is not yet approved' }) };
  }

  if (clinic.owner_email?.toLowerCase() !== owner_email.trim().toLowerCase()) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Not authorised for this clinic' }) };
  }

  // Filter to only allowed fields, strip undefined/null keys the owner didn't send
  const updates = {};
  for (const key of ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      updates[key] = fields[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No valid fields to update' }) };
  }

  // Validate price if provided
  if ('price' in updates) {
    const p = parseFloat(updates.price);
    if (isNaN(p) || p < 0 || p > 9999) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid price value' }) };
    }
    updates.price = p;
  }

  const { data: updated, error: updateErr } = await supabase
    .from('clinics')
    .update(updates)
    .eq('id', String(clinic_id))
    .select()
    .single();

  if (updateErr) {
    console.error('update-profile error:', updateErr);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Update failed' }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, updated })
  };
};
