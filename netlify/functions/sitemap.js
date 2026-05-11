const { createClient } = require('@supabase/supabase-js');

// Static pages — update this list when new SEO pages are added
const STATIC_PAGES = [
  { loc: 'https://skinday.ca/',                     priority: '1.0', changefreq: 'daily',  lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/insights',             priority: '0.8', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/guide/botox-cost-toronto', priority: '0.8', changefreq: 'weekly', lastmod: '2026-05-10' },
  // City SEO pages
  { loc: 'https://skinday.ca/botox-toronto',        priority: '0.9', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-north-york',     priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-richmond-hill',  priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-markham',        priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-etobicoke',      priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-aurora',         priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-newmarket',      priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-mississauga',    priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-brampton',       priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-scarborough',    priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-london-ontario', priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-calgary',        priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-edmonton',       priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-vancouver',      priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-richmond',       priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-montreal',       priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-quebec-city',    priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
  { loc: 'https://skinday.ca/botox-winnipeg',       priority: '0.85', changefreq: 'weekly', lastmod: '2026-05-10' },
];

// Claimed clinics get higher priority — they have richer content
const CLINIC_PRIORITY_CLAIMED   = '0.8';
const CLINIC_PRIORITY_UNCLAIMED = '0.6';

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toLastmod(dateStr) {
  if (!dateStr) return new Date().toISOString().slice(0, 10);
  return String(dateStr).slice(0, 10);
}

exports.handler = async () => {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Fetch all approved clinics — only the columns we need for the sitemap
    // Paginate in batches of 1000 (Supabase row limit per request)
    let allClinics = [];
    let from = 0;
    const BATCH = 1000;

    while (true) {
      const { data, error } = await supabase
        .from('clinics')
        .select('slug, claimed, updated_at')
        .eq('approved', true)
        .not('slug', 'is', null)
        .order('id', { ascending: true })
        .range(from, from + BATCH - 1);

      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;

      allClinics = allClinics.concat(data);
      if (data.length < BATCH) break;
      from += BATCH;
    }

    // Build XML
    const staticUrls = STATIC_PAGES.map(p => `
  <url>
    <loc>${escapeXml(p.loc)}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
    <lastmod>${p.lastmod}</lastmod>
  </url>`).join('');

    const clinicUrls = allClinics.map(c => `
  <url>
    <loc>https://skinday.ca/clinic/${escapeXml(c.slug)}</loc>
    <changefreq>weekly</changefreq>
    <priority>${c.claimed ? CLINIC_PRIORITY_CLAIMED : CLINIC_PRIORITY_UNCLAIMED}</priority>
    <lastmod>${toLastmod(c.updated_at)}</lastmod>
  </url>`).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrls}
${clinicUrls}
</urlset>`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        // Cache for 4 hours — fresh enough for daily crawls, cheap on DB
        'Cache-Control': 'public, s-maxage=14400, stale-while-revalidate=3600',
      },
      body: xml,
    };

  } catch (err) {
    console.error('Sitemap error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Sitemap generation failed: ' + err.message,
    };
  }
};
