// netlify/functions/get-visit-signal.js
//
// Returns the public would-return signal for a clinic.
// Minimum 6 non-flagged responses required before anything is returned.
// Never exposes raw visit counts or individual responses publicly.
//
// Query: GET /api/get-visit-signal?clinic_id=123
//
// Response (threshold met):
//   { signal: { pct: 84, count: 14 } }
//
// Response (below threshold or no data):
//   { signal: null }

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const clinic_id = event.queryStringParameters?.clinic_id;

  if (!clinic_id) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing clinic_id' })
    };
  }

  // ── Fetch all non-flagged would_return values for this clinic ──
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/clinic_visits?clinic_id=eq.${encodeURIComponent(clinic_id)}&flagged=eq.false&select=would_return`,
    {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    console.error('get-visit-signal fetch error:', errText);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }

  const rows = await res.json();
  const count = rows.length;

  // Below threshold — return ghost state so UI can show "be first" prompt
  if (count < 6) {
    return {
      statusCode: 200,
      headers: { 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({ signal: null, ghost: true })
    };
  }

  // ── Calculate would-return percentage ──
  // 'unsure' responses are excluded from the percentage calculation
  // but count toward the threshold so they still contribute to signal confidence
  const positives = rows.filter(r => r.would_return === 'yes').length;
  const scored    = rows.filter(r => r.would_return === 'yes' || r.would_return === 'no').length;

  // Edge case: if everyone answered 'unsure', don't show a percentage
  if (scored === 0) {
    return {
      statusCode: 200,
      headers: { 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({ signal: null })
    };
  }

  const pct = Math.round((positives / scored) * 100);

  return {
    statusCode: 200,
    headers: { 'Cache-Control': 'public, max-age=3600' },
    body: JSON.stringify({ signal: { pct, count } })
  };
};
