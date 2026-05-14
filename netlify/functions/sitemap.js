// netlify/functions/sitemap.js
//
// Dynamic sitemap.xml generator.
//
// Routes:
//   GET /sitemap.xml                → calls this function (via netlify.toml redirect)
//
// Output:
//   Full sitemap including homepage, insights, all /botox-{city} pages,
//   all /guide/botox-cost-* guides, and every approved clinic page.
//
// Cached at the edge for 6 hours to avoid hammering Supabase. Forced
// refresh available via ?refresh=1 in development.

const { createClient } = require('@supabase/supabase-js');

const SITE = 'https://skinday.ca';
const TODAY = new Date().toISOString().slice(0, 10);

// ── STATIC PAGES ─────────────────────────────────────────────────
// These are the SEO-relevant pages that aren't clinic profiles.
// Update this list whenever a new city or guide page is added.

const HOMEPAGE = [
  { loc: '/',         changefreq: 'daily',   priority: 1.0 },
  { loc: '/insights', changefreq: 'weekly',  priority: 0.7 },
];

const BOTOX_CITY_PAGES = [
  'botox-toronto', 'botox-vancouver', 'botox-calgary', 'botox-edmonton',
  'botox-montreal', 'botox-quebec-city', 'botox-winnipeg',
  'botox-london', 'botox-london-ontario',
  'botox-richmond', 'botox-richmond-hill',
  'botox-mississauga', 'botox-brampton', 'botox-markham', 'botox-aurora',
  'botox-newmarket', 'botox-etobicoke', 'botox-north-york', 'botox-scarborough',
].map(slug => ({ loc: `/${slug}`, changefreq: 'weekly', priority: 0.8 }));

const COST_GUIDE_PAGES = [
  'botox-cost-toronto', 'botox-cost-vancouver',
].map(slug => ({ loc: `/guide/${slug}`, changefreq: 'weekly', priority: 0.9 }));

// ── XML BUILDERS ─────────────────────────────────────────────────

function urlEntry({ loc, changefreq, priority, lastmod }) {
  return [
    '  <url>',
    `    <loc>${SITE}${loc}</loc>`,
    `    <lastmod>${lastmod || TODAY}</lastmod>`,
    `    <changefreq>${changefreq}</changefreq>`,
    `    <priority>${priority.toFixed(1)}</priority>`,
    '  </url>',
  ].join('\n');
}

function buildSitemap(entries) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries.map(urlEntry).join('\n'),
    '</urlset>',
  ].join('\n');
}

// ── HANDLER ──────────────────────────────────────────────────────

exports.handler = async (event) => {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Fetch every approved clinic. ~5,800 rows × small shape = ~0.5 MB raw,
    // well within function memory. Single round-trip.
    const { data: clinics, error } = await supabase
      .from('clinics')
      .select('slug, updated_at')
      .eq('approved', true)
      .not('slug', 'is', null)
      .order('id', { ascending: true });

    if (error) {
      console.error('Sitemap supabase error:', error);
      return { statusCode: 500, body: `<!-- sitemap error: ${error.message} -->` };
    }

    const clinicEntries = (clinics || []).map(c => ({
      loc: `/clinic/${c.slug}`,
      changefreq: 'weekly',
      priority: 0.6,
      lastmod: (c.updated_at || '').slice(0, 10) || TODAY,
    }));

    const allEntries = [
      ...HOMEPAGE,
      ...COST_GUIDE_PAGES,
      ...BOTOX_CITY_PAGES,
      ...clinicEntries,
    ];

    const xml = buildSitemap(allEntries);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        // Edge-cache for 6 hours. Clinic additions appear in sitemap on next refresh.
        'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=3600',
      },
      body: xml,
    };
  } catch (err) {
    console.error('Sitemap function error:', err);
    return { statusCode: 500, body: `<!-- sitemap error: ${err.message} -->` };
  }
};
