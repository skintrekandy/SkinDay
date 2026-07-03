// netlify/functions/sitemap.js
//
// Dynamic sitemap.xml generator.
//
// Routes:
//   GET /sitemap.xml                -> calls this function (via netlify.toml redirect)
//
// Output:
//   Full sitemap including homepage, insights, all /botox-{city} pages,
//   all /guide/botox-cost-* guides, and every approved clinic page that
//   render-clinic.js will serve as an indexable 200.
//
// Cached at the edge for 6 hours to avoid hammering Supabase. Forced
// refresh available via ?refresh=1 in development.
//
// CHANGE LOG:
//   - Paginates the clinics fetch. PostgREST returns a bounded page (the
//     project default is commonly 1000 rows), so a single .select() on a
//     ~5,800 row table silently truncated the sitemap. We now page through
//     the full set with .range().
//   - Indexability now mirrors clinicIsIndexable() in render-clinic.js
//     exactly, including clinic_prices and clinic_expertise. Previously the
//     sitemap only looked at clinics.price, so any clinic whose price lives
//     in clinic_prices (or that qualifies via expertise) was a real
//     indexable page that never appeared in the sitemap.

const { createClient } = require('@supabase/supabase-js');

const SITE = 'https://skinday.ca';
const TODAY = new Date().toISOString().slice(0, 10);
const PAGE_SIZE = 1000;

// STATIC PAGES
// SEO-relevant pages that are not clinic profiles. Update whenever a new
// city or guide page is added.
const HOMEPAGE = [
  { loc: '/',         changefreq: 'daily',  priority: 1.0 },
  { loc: '/insights', changefreq: 'weekly', priority: 0.7 },
];

// Must match the [[redirects]] block in netlify.toml AND the actual
// botox-{city}.html files deployed in the repo root. Adding an entry here
// without the file plus redirect creates a Soft 404. toronto, vancouver,
// and london-ontario were consolidated into /guide/botox-cost-* (they 301
// now), so they live in COST_GUIDE_PAGES below. Listing a redirecting URL
// here creates "Page with redirect" entries in Search Console.
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

// INDEXABILITY GATE
// Kept identical in spirit to clinicIsIndexable() in render-clinic.js so the
// sitemap lists every page that function serves as an indexable 200, and no
// page it noindexes. A clinic qualifies on any of: a price on the clinics row,
// a price row in clinic_prices, Google reviews, injector credentials, or a
// listed expertise row.
function hasCreds(raw) {
  if (!raw) return false;
  const s = String(raw).trim();
  return s !== '' && s !== '[]' && s.toLowerCase() !== 'null';
}

function clinicIsIndexable(c, priceIds, expertiseIds) {
  const id = String(c.id);
  const hasPrice   = c.price != null && Number(c.price) > 0;
  const hasReviews = c.rating != null && c.reviews != null && Number(c.reviews) > 0;
  return hasPrice
    || hasReviews
    || hasCreds(c.injector_credentials)
    || priceIds.has(id)
    || expertiseIds.has(id);
}

// PAGINATED FETCHERS
// Every fetch pages through the full table. Supabase id columns are text, so
// all id comparisons are done as strings.

async function fetchAllApprovedClinics(supabase) {
  const all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('clinics')
      .select('id, slug, updated_at, price, rating, reviews, injector_credentials')
      .eq('approved', true)
      .not('slug', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`clinics fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function fetchClinicIdsWithPrice(supabase) {
  const ids = new Set();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('clinic_prices')
      .select('clinic_id, price')
      .order('clinic_id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`clinic_prices fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (r.clinic_id != null && r.price != null && Number(r.price) > 0) {
        ids.add(String(r.clinic_id));
      }
    }
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return ids;
}

async function fetchClinicIdsWithExpertise(supabase) {
  const ids = new Set();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('clinic_expertise')
      .select('clinic_id')
      .order('clinic_id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`clinic_expertise fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (r.clinic_id != null) ids.add(String(r.clinic_id));
    }
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return ids;
}

// XML BUILDERS

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

// HANDLER

exports.handler = async () => {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Fetch clinics plus the two enrichment id sets. The id sets run in
    // parallel with the clinics page-loop kickoff; all three are needed
    // before we can decide indexability.
    const [clinics, priceIds, expertiseIds] = await Promise.all([
      fetchAllApprovedClinics(supabase),
      fetchClinicIdsWithPrice(supabase),
      fetchClinicIdsWithExpertise(supabase),
    ]);

    const clinicEntries = clinics
      .filter(c => clinicIsIndexable(c, priceIds, expertiseIds))
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

    console.log(
      `sitemap built: clinics_fetched=${clinics.length} ` +
      `indexable=${clinicEntries.length} price_ids=${priceIds.size} ` +
      `expertise_ids=${expertiseIds.size} total_urls=${allEntries.length}`
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=3600',
      },
      body: xml,
    };
  } catch (err) {
    console.error('Sitemap function error:', err);
    return { statusCode: 500, body: `<!-- sitemap error: ${err.message} -->` };
  }
};
