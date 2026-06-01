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

// Must match the [[redirects]] block in netlify.toml AND the actual
// botox-{city}.html files deployed in the repo root. Adding an entry
// here without the file + redirect creates a Soft 404 in Google.
// NOTE: toronto, vancouver, and london-ontario were consolidated into the
// /guide/botox-cost-* pages (they 301 now), so they live in COST_GUIDE_PAGES
// below, not here. Listing a redirecting URL here creates "Page with redirect"
// entries in Search Console.
const BOTOX_CITY_PAGES = [
  // Ontario
  'botox-north-york', 'botox-richmond-hill',
  'botox-markham', 'botox-etobicoke',
  // British Columbia
  'botox-richmond', 'botox-victoria', 'botox-kelowna',
  // Alberta
  'botox-calgary', 'botox-edmonton',
  // Quebec
  'botox-montreal', 'botox-quebec-city', 'botox-sherbrooke', 'botox-gatineau',
  // Manitoba
  'botox-winnipeg',
].map(slug => ({ loc: `/${slug}`, changefreq: 'weekly', priority: 0.8 }));

const COST_GUIDE_PAGES = [
  'botox-cost-toronto', 'botox-cost-vancouver', 'botox-cost-london-ontario',
].map(slug => ({ loc: `/guide/${slug}`, changefreq: 'weekly', priority: 0.9 }));

// ── SUBSTANTIVE CLINIC FILTER ─────────────────────────────────────
// Only list clinics that have real, unique content (a price, reviews, or
// credentials). Empty stub clinics are noindex'd by render-clinic.js, so
// listing them here would tell Google to crawl pages we've asked it not to
// index — that creates the conflicting signals behind Soft 404s.
//
// IMPORTANT: keep in sync with clinicIsIndexable() in render-clinic.js.
// (render-clinic also counts listed services/expertise, which require a
// join we don't do here — so this stays a strict subset of what's indexable,
// which is the safe direction.)

function hasCreds(raw) {
  if (!raw) return false;
  const s = String(raw).trim();
  return s !== '' && s !== '[]' && s.toLowerCase() !== 'null';
}

function clinicIsSubstantive(c) {
  const hasPrice   = c.price != null && Number(c.price) > 0;
  const hasReviews = c.rating != null && c.reviews != null && Number(c.reviews) > 0;
  return hasPrice || hasReviews || hasCreds(c.injector_credentials);
}

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
      .select('slug, updated_at, price, rating, reviews, injector_credentials')
      .eq('approved', true)
      .not('slug', 'is', null)
      .order('id', { ascending: true });

    if (error) {
      console.error('Sitemap supabase error:', error);
      return { statusCode: 500, body: `<!-- sitemap error: ${error.message} -->` };
    }

    const clinicEntries = (clinics || [])
      .filter(clinicIsSubstantive)
      .map(c => ({
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
