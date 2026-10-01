// netlify/functions/indexnow-ping.js
//
// Tells Bing (and every other IndexNow engine) which skinday.ca pages changed
// this week, so they are re-read in days rather than whenever the crawler
// next happens by. Bing's index is what ChatGPT search and Copilot draw on.
//
// Runs once a week on its own (schedule set in netlify.toml). Nothing to press.
//
// What it sends: every URL in our own sitemap whose <lastmod> falls in the
// last 8 days. The sitemap already stamps clinic pages with the date the row
// last changed and stamps the guide and device pages with today, so this is
// "what moved this week" without a second source of truth. IndexNow asks for
// changed URLs only, not the whole site on repeat, which is why it filters.
//
// The key file 46623e211e6e4304a963042e0578e311.txt sits at the site root and
// proves to Bing that this site sent the list.

const SITE = 'https://skinday.ca';
const HOST = 'skinday.ca';
const KEY  = '46623e211e6e4304a963042e0578e311';
const WINDOW_DAYS = 8;
const MAX_PER_CALL = 10000;   // IndexNow limit per request

exports.handler = async () => {
  try {
    const res = await fetch(`${SITE}/sitemap.xml`);
    if (!res.ok) throw new Error(`sitemap fetch ${res.status}`);
    const xml = await res.text();

    const cutoff = Date.now() - WINDOW_DAYS * 86400000;
    const urls = [];
    const re = /<url>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?/g;
    let m;
    while ((m = re.exec(xml))) {
      const loc = m[1].trim();
      const lastmod = m[2] ? Date.parse(m[2].trim()) : NaN;
      if (!loc.startsWith(SITE)) continue;
      if (!isNaN(lastmod) && lastmod >= cutoff) urls.push(loc);
    }

    if (!urls.length) {
      console.log('indexnow-ping: nothing changed this week');
      return { statusCode: 200, body: 'nothing to send' };
    }

    let sent = 0;
    for (let i = 0; i < urls.length; i += MAX_PER_CALL) {
      const batch = urls.slice(i, i + MAX_PER_CALL);
      const r = await fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          host: HOST,
          key: KEY,
          keyLocation: `${SITE}/${KEY}.txt`,
          urlList: batch,
        }),
      });
      // 200 and 202 are both success (202 = received, key check pending).
      if (r.status !== 200 && r.status !== 202) {
        const t = await r.text().catch(() => '');
        throw new Error(`indexnow ${r.status}: ${t.slice(0, 200)}`);
      }
      sent += batch.length;
    }
    console.log(`indexnow-ping: sent ${sent} urls`);
    return { statusCode: 200, body: `sent ${sent}` };
  } catch (e) {
    console.error('indexnow-ping failed', e.message);
    return { statusCode: 500, body: e.message };
  }
};
