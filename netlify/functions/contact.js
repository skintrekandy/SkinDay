// netlify/functions/contact.js
// Handles contact form submissions from /contact.html
// Sends email to hello@skinday.ca via Resend

const RESEND_API_KEY = process.env.RESEND_API_KEY;

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

  const { name, email, subject, message } = body;

  if (!name || !email || !subject || !message) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'All fields are required' }) };
  }

  const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#faf8f5;font-family:Georgia,sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#fffef9;border:1px solid #e8ddd8;border-radius:16px;overflow:hidden;">
    <div style="background:#3d2c28;padding:24px 36px;">
      <div style="font-size:22px;color:white;font-family:Georgia,serif;">Skin<span style="color:#e8a89f;">Day</span></div>
      <div style="font-size:12px;color:#b5a89f;margin-top:4px;letter-spacing:0.06em;text-transform:uppercase;">New contact form submission</div>
    </div>
    <div style="padding:32px 36px;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="padding:8px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#9e7a72;width:90px;">From</td>
          <td style="padding:8px 0;font-size:15px;color:#3d2c28;">${escapeHtml(name)}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#9e7a72;">Email</td>
          <td style="padding:8px 0;font-size:15px;color:#3d2c28;"><a href="mailto:${escapeHtml(email)}" style="color:#c8725a;">${escapeHtml(email)}</a></td>
        </tr>
        <tr>
          <td style="padding:8px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#9e7a72;">Subject</td>
          <td style="padding:8px 0;font-size:15px;color:#3d2c28;">${escapeHtml(subject)}</td>
        </tr>
      </table>
      <div style="font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#9e7a72;margin-bottom:10px;">Message</div>
      <div style="font-size:15px;color:#3d2c28;line-height:1.7;white-space:pre-wrap;background:#faf7f2;border:1px solid #e8ddd8;border-radius:10px;padding:16px 20px;">${escapeHtml(message)}</div>
    </div>
    <div style="background:#faf8f5;border-top:1px solid #e8ddd8;padding:16px 36px;font-size:12px;color:#9e7a72;">
      Sent via SkinDay contact form · skinday.ca/contact.html
    </div>
  </div>
</body>
</html>`.trim();

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'SkinDay Contact <hello@skinday.ca>',
        to: 'hello@skinday.ca',
        reply_to: email,
        subject: `[SkinDay] ${subject} — ${name}`,
        html: emailHtml
      })
    });

    if (!res.ok) {
      const err = await res.json();
      console.error('Resend error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email send failed' }) };
    }

    console.log(`✅ Contact form: ${subject} from ${name} <${email}>`);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

  } catch (err) {
    console.error('Unexpected error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
