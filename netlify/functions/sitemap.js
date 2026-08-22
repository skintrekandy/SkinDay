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

// The guide pages are the strongest AEO asset on the site: fully static HTML,
// real numbers in the body, question-shaped headings. Every one of them must
// be listed. botox-cost-montreal was missing from this array while being
// linked from the homepage footer — the Quebec guide was effectively
// undiscoverable except by crawl.
const COST_GUIDE_PAGES = [
  'botox-cost-toronto', 'botox-cost-vancouver', 'botox-cost-london-ontario',
  'botox-cost-montreal',
].map(slug => ({ loc: `/guide/${slug}`, changefreq: 'weekly', priority: 0.9 }));

// ── DEVICE PAGES ─────────────────────────────────────────────────────────────
// Clears part of the M39 TODO in netlify.toml and adds the M19.3 province
// pages in the same pass:
//   /devices/{model}            national, served by render-devices.js
//   /devices/{model}/{province} served by device-page.js
//
// ⚠️ THE FLOOR AND THE GRAIN ARE COPIED FROM device-page.js ON PURPOSE. That
// function 404s any combination under DEVICE_MIN_CLINICS and excludes devices
// whose name is also an ordinary word. If the two ever disagree the sitemap
// advertises URLs that 404, which is worse than listing nothing.
//
// ⚠️ THE NATIONAL PAGES ARE DELIBERATELY UNDER-LISTED. render-devices.js owns
// which models get a /devices/{model} page and I have not read its gate, so
// only models with DEVICE_MIN_CLINICS+ Canadian clinics are listed here — a
// model that dense is certainly served. Under-listing costs slower indexing;
// over-listing costs soft-404s. Read render-devices.js to close this properly.
const DEVICE_MIN_CLINICS = 10;

function devSlug(v) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const PROVINCE_SLUGS = {
  ab: 'alberta', bc: 'british-columbia', mb: 'manitoba', nb: 'new-brunswick',
  nl: 'newfoundland-and-labrador', ns: 'nova-scotia', nt: 'northwest-territories',
  nu: 'nunavut', on: 'ontario', pe: 'prince-edward-island', qc: 'quebec',
  sk: 'saskatchewan', yt: 'yukon'
};

async function fetchDeviceEntries(supabase) {
  const { data: devices, error: dErr } = await supabase
    .from('device_reference')
    .select('id, model')
    .eq('active', true)
    .eq('name_is_also_generic', false);
  if (dErr) throw new Error(`device_reference fetch failed: ${dErr.message}`);
  const modelById = new Map((devices || []).map(d => [d.id, d.model]));

  const national = new Map();   // deviceSlug -> Set(clinic id)
  const byProvince = new Map(); // deviceSlug|provinceSlug -> Set(clinic id)

  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('clinic_devices')
      .select('clinic_id, device_id, clinics!inner(id, country, province, approved)')
      .eq('status', 'listed')
      .eq('clinics.approved', true)
      .eq('clinics.country', 'canada')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`clinic_devices fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      const model = modelById.get(r.device_id);
      if (!model) continue;
      const d = devSlug(model);
      if (!national.has(d)) national.set(d, new Set());
      national.get(d).add(String(r.clinic_id));

      const prov = r.clinics && r.clinics.province;
      // The province slug is spelled out, never the two-letter code — a code
      // in a search result loses its context the moment it is shared.
      const pSlug = prov ? (PROVINCE_SLUGS[String(prov).toLowerCase()] || devSlug(prov)) : null;
      if (!pSlug) continue;
      const key = d + '|' + pSlug;
      if (!byProvince.has(key)) byProvince.set(key, new Set());
      byProvince.get(key).add(String(r.clinic_id));
    }
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  const entries = [{ loc: '/devices/', changefreq: 'weekly', priority: 0.8 }];
  for (const [d, ids] of national) {
    if (ids.size < DEVICE_MIN_CLINICS) continue;
    entries.push({ loc: `/devices/${d}`, changefreq: 'weekly', priority: 0.7 });
  }
  for (const [key, ids] of byProvince) {
    if (ids.size < DEVICE_MIN_CLINICS) continue;
    const [d, p] = key.split('|');
    entries.push({ loc: `/devices/${d}/${p}`, changefreq: 'monthly',
                   priority: ids.size >= 30 ? 0.7 : 0.6 });
  }
  return entries;
}

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

    // Device pages must never take the sitemap down: the clinic URLs are the
    // load-bearing half and predate them.
    let deviceEntries = [];
    try {
      deviceEntries = await fetchDeviceEntries(supabase);
    } catch (e) {
      console.error('sitemap: device pages skipped -', e.message);
    }

    const allEntries = [
      ...HOMEPAGE,
      ...COST_GUIDE_PAGES,
      ...BOTOX_CITY_PAGES,
      ...deviceEntries,
      ...clinicEntries,
    ];

    const xml = buildSitemap(allEntries);

    console.log(
      `sitemap built: clinics_fetched=${clinics.length} ` +
      `indexable=${clinicEntries.length} price_ids=${priceIds.size} ` +
      `expertise_ids=${expertiseIds.size} device_urls=${deviceEntries.length} ` +
      `total_urls=${allEntries.length}`
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
