// netlify/functions/render-clinic.js
//
// Server-side render for /clinic/{slug} pages.
//
// Why this exists:
//   The existing client-side clinic.html template ships an empty shell -
//   every clinic URL serves the same generic HTML, populated by JS at runtime.
//   Googlebot crawls the empty shell first and treats all 5,800 clinic URLs
//   as duplicates, dropping them from the index.
//
// What this does:
//   On request to /clinic/{slug}, fetch the clinic from Supabase, inject
//   real <title>, <meta>, OpenGraph, canonical, and a baseline content
//   block into the HTML before sending. The existing client-side JS then
//   hydrates over it - user experience unchanged, crawler experience fixed.
//
// Routing (in netlify.toml):
//   [[redirects]]
//     from = "/clinic/:slug"
//     to = "/.netlify/functions/render-clinic?slug=:slug"
//     status = 200
//     force = true

// ⚡ COLD START. This function used to require('@supabase/supabase-js') for
// what amounts to one REST call. That package is the heaviest thing in the
// bundle and every cold start paid to parse and evaluate it. PostgREST is a
// plain HTTP API and Node 18 has global fetch, so the dependency is gone.
//
// Everything below runs during Lambda INIT, not during the request. Init gets
// a full CPU burst; the handler can be throttled. So the template read and the
// env lookups happen here deliberately, not on first invocation.
const path = require('path');
const fs   = require('fs');

const SITE = 'https://skinday.ca';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Minimal PostgREST GET. Returns parsed JSON, throws on a non-2xx so the
// caller's existing try/catch treats it exactly like the old client error.
async function pgGet(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`PostgREST ${res.status}: ${detail.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Load the existing clinic.html template once at cold start.
// We surgically swap in meta tags and inject content; the rest of the page
// (scripts, styles, body structure) is preserved exactly as deployed.
let TEMPLATE = null;
function loadTemplate() {
  if (TEMPLATE) return TEMPLATE;
  // Template ships in the deployed site root. Netlify functions can read
  // siblings via process.cwd() or relative paths from the function bundle.
  const candidates = [
    path.join(__dirname, '..', '..', 'clinic.html'),
    path.join(process.cwd(), 'clinic.html'),
  ];
  for (const p of candidates) {
    try {
      TEMPLATE = fs.readFileSync(p, 'utf8');
      return TEMPLATE;
    } catch (_) { /* try next */ }
  }
  throw new Error('Could not locate clinic.html template');
}

// Read the 84 KB template during init rather than mid-request. Wrapped because
// a throw at module scope would take down every invocation with no useful log;
// loadTemplate() is still called in the handler and will throw there instead,
// where the error path already handles it.
try { loadTemplate(); } catch (_) { /* handler will surface it */ }

// ── HTML ESCAPING ─────────────────────────────────────────────────
// Crucial because clinic names and addresses go straight into attributes
// and meta tags. Without this, a clinic named `Bliss "Beauty" & Co.`
// breaks the HTML.

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── SEO STRING BUILDERS ───────────────────────────────────────────
// These mirror what a well-crafted manual page would have for each clinic.
// Keep them succinct - Google truncates titles at ~60 chars and descriptions
// at ~155 chars on SERPs.

function buildTitle(clinic) {
  const name = clinic.name || 'Cosmetic Clinic';
  const loc  = clinic.neighbourhood || clinic.area || clinic.province || '';
  // "Lumiere Aesthetics - Botox Price & Reviews · Toronto · SkinDay"
  // Keep under 60 chars when possible
  const base = `${name} - Botox Price & Reviews`;
  const suffix = loc ? ` · ${loc}` : '';
  return `${base}${suffix} · SkinDay`;
}

function buildDescription(clinic) {
  const name = clinic.name || 'this clinic';
  const loc  = clinic.neighbourhood || clinic.area || clinic.province || 'Canada';
  const price = (clinic.price != null && clinic.price > 0) ? `Botox from $${clinic.price}/unit. ` : '';
  const rating = (clinic.rating && clinic.reviews)
    ? `Rated ${clinic.rating} from ${clinic.reviews} Google reviews. `
    : '';
  return `${name} in ${loc}. ${price}${rating}Compare prices, services, and verified clinic details on SkinDay.`.trim();
}

// Format injector_credentials which may be a JSON array string,
// a plain string, or null. Examples: '["rn","img"]', 'RN, MD', null.
// ── LINK TARGETS ──────────────────────────────────────────────────
// The SSR block used to contain no links at all. Every clinic page was a dead
// end: readable, but with no path to the device pages that list the same
// machines or the city guide that explains the price it quotes. These two
// helpers supply the only two link families we can resolve from a clinic row
// alone, without another query.

// MUST match slugifyModel() in render-devices.js exactly. That function derives
// the /devices/{model} slug from the model name — there is no slug column — and
// any active device_reference row resolves to a real page (an unmatched model
// 404s, a matched-but-unused one renders noindexed). Since render-clinic only
// ever sees devices already filtered on active === true, a link built here
// always lands on a real page. If the device slug rule ever changes, change it
// in both files or these links start 404ing.
function slugifyModel(model) {
  return String(model || '')
    .toLowerCase()
    .replace(/[\u00ae\u2122]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// City pages that actually exist. Sourced from the [[redirects]] blocks in
// netlify.toml — a link to a city page with no file behind it is a soft 404,
// so this list must not be guessed at. Keyed by province because "Richmond"
// is Richmond BC here and Richmond Hill is a separate Ontario page.
//
// Where both a /botox-{city} page and a /guide/botox-cost-{city} guide exist
// for the same place (Montreal), the guide wins: it is the far richer page and
// the one an AI answering "how much is Botox in Montreal" should land on.
const CITY_PAGES = {
  on: {
    'toronto':       '/guide/botox-cost-toronto',
    'london':        '/guide/botox-cost-london-ontario',
    'north york':    '/botox-north-york',
    'richmond hill': '/botox-richmond-hill',
    'markham':       '/botox-markham',
    'etobicoke':     '/botox-etobicoke',
  },
  bc: {
    'vancouver': '/guide/botox-cost-vancouver',
    'richmond':  '/botox-richmond',
    'victoria':  '/botox-victoria',
    'kelowna':   '/botox-kelowna',
  },
  ab: { 'calgary': '/botox-calgary', 'edmonton': '/botox-edmonton' },
  qc: {
    'montreal':    '/guide/botox-cost-montreal',
    'montréal':    '/guide/botox-cost-montreal',
    'quebec city': '/botox-quebec-city',
    'québec':      '/botox-quebec-city',
    'sherbrooke':  '/botox-sherbrooke',
    'gatineau':    '/botox-gatineau',
  },
  mb: { 'winnipeg': '/botox-winnipeg' },
};

// GTA municipalities the Toronto guide actually reports on — its neighbourhood
// table covers exactly these. A clinic in one of them has no page of its own
// but the GTA guide genuinely contains its local average, so the link is
// honest. Anywhere not on this list gets no city link rather than a wrong one.
const GTA_GUIDE_AREAS = new Set([
  'woodbridge', 'milton', 'burlington', 'aurora', 'oakville',
  'vaughan', 'thornhill', 'mississauga', 'brampton',
]);

function cityPageFor(clinic) {
  const prov = String(clinic.province || '').toLowerCase();
  const city = String(clinic.neighbourhood || clinic.area || '').trim().toLowerCase();
  if (!city) return null;
  const byProv = CITY_PAGES[prov];
  if (byProv && byProv[city]) return byProv[city];
  if (prov === 'on' && GTA_GUIDE_AREAS.has(city)) return '/guide/botox-cost-toronto';
  return null;
}

function formatInjectorCreds(raw) {
  if (!raw) return '';
  if (Array.isArray(raw)) return raw.map(s => String(s).toUpperCase()).join(', ');
  // Try JSON parse if it looks like an array
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map(s => String(s).toUpperCase()).join(', ');
    } catch (_) { /* fall through */ }
  }
  return String(raw);
}

// ── INDEXABILITY GATE ─────────────────────────────────────────────
// A clinic page with no price, no reviews, no credentials, and no listed
// services is a near-duplicate of every other bare listing. Google rejects
// those as "Crawled - currently not indexed". We mark them noindex until
// they gain real data, at which point they automatically become indexable
// again (no manual step). This is the fix for the bulk of that bucket.
//
// IMPORTANT: keep this rule in sync with clinicIsSubstantive() in sitemap.js
// so the sitemap never lists a page we've told Google not to index.

function hasCreds(raw) {
  if (!raw) return false;
  const s = String(raw).trim();
  return s !== '' && s !== '[]' && s.toLowerCase() !== 'null';
}

function clinicIsIndexable(clinic) {
  const hasPrice    = clinic.price != null && Number(clinic.price) > 0;
  const hasReviews  = clinic.rating != null && clinic.reviews != null && Number(clinic.reviews) > 0;
  const hasExpertise = !!(clinic.identity && clinic.identity.expertise && clinic.identity.expertise.length);
  return hasPrice || hasReviews || hasExpertise || hasCreds(clinic.injector_credentials);
}

// ── STRUCTURED DATA ───────────────────────────────────────────────
// MedicalBusiness JSON-LD for indexable clinics. Helps Google understand
// the entity and can earn richer search listings. Deliberately conservative:
// no aggregateRating (avoids review-snippet policy risk across thousands of
// pages). The visible body still shows the rating for users and relevance.

function buildSchema(clinic) {
  const url = `${SITE}/clinic/${clinic.slug}`;
  const loc = clinic.neighbourhood || clinic.area || '';
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'MedicalBusiness',
    name: clinic.name || 'Cosmetic Clinic',
    url,
    address: {
      '@type': 'PostalAddress',
      addressRegion: clinic.province || 'ON',
      addressCountry: 'CA',
    },
  };
  if (loc) schema.address.addressLocality = loc;
  if (clinic.phone)   schema.telephone = String(clinic.phone);
  if (clinic.website) schema.sameAs = [String(clinic.website)];
  if (clinic.price != null && clinic.price > 0) schema.priceRange = `From $${clinic.price}/unit`;
  // Escape "<" so a clinic name containing "</script>" can't break out.
  return JSON.stringify(schema).replace(/</g, '\\u003c');
}

// Server-rendered content block - minimal, semantic, crawler-focused.
//
// Goal: defeat Google's Soft 404 classification by giving the page real,
// unique, body-level content before any JavaScript runs.
//
// Also the AEO surface: this is the only body content an AI crawler that does
// not execute JavaScript will ever read on a clinic page. Every fact worth
// citing about a clinic has to appear here as plain text.
//
// Non-goals: hydration parity, design matching. Client JS overwrites this
// block once the rich UI is ready.
//
// Users DO see it, briefly. It renders inside #pageWrap for the 1-2s the
// client spends fetching /api/get-clinics, and it stays on screen permanently
// if that fetch fails transiently (initFromDB deliberately keeps SSR content
// on 5xx rather than showing "not found"). It is styled in clinic.html under
// #ssr-content so that moment reads as a lightweight version of the page
// rather than raw markup. Keep it plain and factual; it is user-visible copy.
//
// What matters: unique <h1>, unique paragraph content, semantic structure.
// No inline CSS because that's where today's quote-collision bugs lived.
function buildSeoBody(clinic) {
  const name = escapeHtml(clinic.name || 'Cosmetic Clinic');
  const loc  = escapeHtml(clinic.neighbourhood || clinic.area || clinic.province || 'Canada');
  const province = escapeHtml(clinic.province || 'ON');

  // Build paragraphs from whatever data is available. Each one adds a few
  // unique words that distinguish this URL from every other clinic page.
  const paragraphs = [];

  paragraphs.push(`${name} is a cosmetic clinic in ${loc}, ${province}.`);

  if (clinic.price != null && clinic.price > 0) {
    paragraphs.push(`Botox pricing from $${escapeHtml(clinic.price)} per unit.`);
  } else {
    paragraphs.push(`Botox and neurotoxin pricing available on request.`);
  }

  if (clinic.rating && clinic.reviews) {
    paragraphs.push(`Rated ${escapeHtml(clinic.rating)} stars from ${escapeHtml(clinic.reviews)} Google reviews.`);
  }

  const creds = formatInjectorCreds(clinic.injector_credentials);
  if (creds) {
    paragraphs.push(`Injector credentials: ${escapeHtml(creds)}.`);
  }

  const expertise = (clinic.identity && clinic.identity.expertise) || [];
  if (expertise.length) {
    paragraphs.push(`Specialties: ${expertise.map(e => escapeHtml(e.label)).join(', ')}.`);
  }

  // M39 devices. Named machines are strong, specific keywords on a clinic page
  // ("morpheus8 toronto" lands here as well as on /devices/morpheus8), and
  // without this the SSR paint has no technology at all and Googlebot never
  // sees it, because the card only appears after the client hydrates.
  //
  // Each model is LINKED to its /devices/{model} page. Capped at 8 rather than
  // the full list: this block is short prose, and a paragraph that is mostly
  // anchors gets scored as navigation and discarded by content extractors —
  // the exact failure that cost the device pages their clinic list. Eight
  // links against seven sentences keeps density well under that threshold.
  const devices = clinic.devices || [];
  if (devices.length) {
    const linked = devices.slice(0, 8)
      .map(d => `<a href="/devices/${escapeHtml(slugifyModel(d.model))}">${escapeHtml(d.model)}</a>`)
      .join(', ');
    const rest = devices.length > 8 ? `, and ${devices.length - 8} more` : '';
    paragraphs.push(`Technology listed by ${name}: ${linked}${rest}.`);
  }

  if (clinic.phone) {
    paragraphs.push(`Contact ${name} at ${escapeHtml(clinic.phone)}.`);
  }

  // Closing sentence, now with somewhere to go. This used to say "compare
  // against other Hamilton clinics on SkinDay" and link nowhere at all.
  // cityPageFor returns null wherever no city page exists, in which case the
  // sentence still reads correctly and only the directory link is offered —
  // never a fabricated URL.
  const cityHref = cityPageFor(clinic);
  const compare = cityHref
    ? `Compare ${name}'s Botox pricing and services against <a href="${escapeHtml(cityHref)}">other ${loc} clinics</a> on <a href="${SITE}/">SkinDay</a>.`
    : `Compare ${name}'s Botox pricing and services against other ${loc} clinics on <a href="${SITE}/">SkinDay</a>.`;
  paragraphs.push(compare);

  const body = paragraphs.map(p => `  <p>${p}</p>`).join('\n');

  return `<div id="ssr-content">
  <h1>${name}</h1>
${body}
</div>`;
}

// ── TEMPLATE PATCHING ─────────────────────────────────────────────
// Surgical string replacements on the cached template. We avoid an HTML
// parser to keep the function fast (<50ms) and bundle small.

function patchTemplate(html, clinic) {
  const url   = `${SITE}/clinic/${clinic.slug}`;
  const title = buildTitle(clinic);
  const desc  = buildDescription(clinic);
  const ogImg = clinic.logo_url || `${SITE}/og-default.jpg`;

  let out = html;

  // <title>
  out = out.replace(
    /<title>[^<]*<\/title>/,
    `<title>${escapeHtml(title)}</title>`
  );

  // <link rel="canonical">
  out = out.replace(
    /<link rel="canonical"[^>]*>/,
    `<link rel="canonical" id="meta-canonical" href="${escapeHtml(url)}" />`
  );

  // <meta name="description">
  out = out.replace(
    /<meta name="description"[^>]*\/>/,
    `<meta name="description" id="meta-description" content="${escapeHtml(desc)}" />`
  );

  // OG tags
  out = out.replace(
    /<meta property="og:title"[^>]*\/>/,
    `<meta property="og:title" id="og-title" content="${escapeHtml(title)}" />`
  );
  out = out.replace(
    /<meta property="og:description"[^>]*\/>/,
    `<meta property="og:description" id="og-description" content="${escapeHtml(desc)}" />`
  );
  out = out.replace(
    /<meta property="og:url"[^>]*\/>/,
    `<meta property="og:url" id="og-url" content="${escapeHtml(url)}" />`
  );
  out = out.replace(
    /<meta property="og:image"[^>]*\/>/,
    `<meta property="og:image" id="og-image" content="${escapeHtml(ogImg)}" />`
  );

  // Twitter tags
  out = out.replace(
    /<meta name="twitter:title"[^>]*\/>/,
    `<meta name="twitter:title" id="tw-title" content="${escapeHtml(title)}" />`
  );
  out = out.replace(
    /<meta name="twitter:description"[^>]*\/>/,
    `<meta name="twitter:description" id="tw-description" content="${escapeHtml(desc)}" />`
  );
  out = out.replace(
    /<meta name="twitter:image"[^>]*\/>/,
    `<meta name="twitter:image" id="tw-image" content="${escapeHtml(ogImg)}" />`
  );

  // Inject the SSR content block by REPLACING the loading placeholder inside
  // #pageWrap. The client-side JS that renders clinic.html overwrites
  // pageWrap.innerHTML wholesale (or calls .remove() on #ssr-content); either
  // path disposes of it cleanly.
  //
  // ⚠️ PLACEMENT IS THE WHOLE POINT — DO NOT MOVE THIS BACK AFTER <body>.
  // This block used to be injected immediately after the opening <body> tag,
  // which put it OUTSIDE #pageWrap, the page's only content container.
  // Googlebot coped, because it renders the page. Content extractors do not
  // render: they score candidate nodes and treat a text block sitting above
  // the main container as header boilerplate, discard it, and fall through to
  // the largest surviving block — which on this page is the visit-signal
  // modal. Verified 2026-08-21 against trafilatura and readability: injected
  // after <body> BOTH extractors returned the modal and no clinic data;
  // injected here BOTH returned the full record (name, price, rating, review
  // count, credentials, devices, phone).
  //
  // That is what AI crawlers read. Every LLM answer that could cite a SkinDay
  // clinic depends on this one replacement target. A semantic <main>/<article>
  // wrapper does NOT rescue it from the wrong position — placement is the only
  // variable that mattered in testing.
  //
  // The fallback below is deliberate: if clinic.html ever drifts and the
  // placeholder string stops matching, we revert to the old post-<body>
  // injection rather than emitting no body content at all. Degraded (Google
  // still sees it, extractors do not) beats empty. The ssr_present log line in
  // the handler will not catch this case, because both branches produce the
  // id — check ssr_in_wrap instead.
  const seoBody = buildSeoBody(clinic);
  const LOADING_PLACEHOLDER = '<div class="loading" id="loadingState">Loading clinic…</div>';
  if (out.includes(LOADING_PLACEHOLDER)) {
    out = out.replace(LOADING_PLACEHOLDER, seoBody);
  } else {
    console.error('render-clinic: loading placeholder not found in template — falling back to post-<body> injection (extractor-invisible)');
    out = out.replace(/<body([^>]*)>/, `<body$1>\n${seoBody}\n`);
  }

  // Indexability gate, injected just before </head>:
  //   - Empty stub clinics → noindex (with follow, so Google still discovers
  //     links to richer clinic pages). Auto-reverts once the clinic has data.
  //   - Real clinics → MedicalBusiness structured data.
  if (!clinicIsIndexable(clinic)) {
    out = out.replace('</head>', '  <meta name="robots" content="noindex, follow" />\n</head>');
  } else {
    out = out.replace('</head>', `  <script type="application/ld+json">${buildSchema(clinic)}</script>\n</head>`);
  }

  return out;
}

// ── HANDLER ──────────────────────────────────────────────────────

// Hard timeout: return 503 (retry-able) instead of letting Netlify's 10s limit
// fire a 500 (which Search Console logs as a server error and can hurt rankings).
// 8 seconds gives the main logic 8s to complete; the remaining 2s is buffer for
// Netlify's own response overhead. 503 tells Google "temporarily unavailable" -
// it will retry and the page stays in good standing.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`render-clinic timeout after ${ms}ms`)), ms)
    ),
  ]);
}

exports.handler = async (event) => {
  try {
    return await withTimeout(_handler(event), 8000);
  } catch (err) {
    if (err.message && err.message.includes('timeout')) {
      console.error('render-clinic timeout:', err.message);
      return {
        statusCode: 503,
        headers: {
          'Content-Type': 'text/plain',
          'Retry-After': '30',
        },
        body: 'Service temporarily unavailable. Please try again.',
      };
    }
    console.error('render-clinic unhandled error:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
};

async function _handler(event) {
  try {
    // Slug arrives via path splat from netlify.toml redirect.
    // Netlify can deliver this in several places depending on routing config,
    // so we try them in order:
    //   1. ?slug= query param (direct invocation or :param substitution)
    //   2. /clinic/{slug} in event.path (original request URL)
    //   3. /.netlify/functions/render-clinic/{slug} in event.path (post-rewrite)
    //   4. event.rawUrl (some Netlify versions populate this instead)
    let slug = (event.queryStringParameters || {}).slug;

    if (!slug && event.path) {
      // Match /clinic/{slug} OR /.netlify/functions/render-clinic/{slug}
      const m = event.path.match(/(?:\/clinic\/|\/render-clinic\/)([^\/\?#]+)/);
      if (m) slug = m[1];
    }

    if (!slug && event.rawUrl) {
      const m = event.rawUrl.match(/(?:\/clinic\/|\/render-clinic\/)([^\/\?#]+)/);
      if (m) slug = m[1];
    }

    if (!slug) {
      // Log everything so future debugging is one click in the function logs.
      console.error('Missing slug. event.path=', event.path, 'event.rawUrl=', event.rawUrl, 'qs=', event.queryStringParameters);
      return { statusCode: 400, body: 'Missing slug' };
    }

    // Mirror get-clinics.js slug-mode shape so SEO output matches what
    // the client-side renderer ultimately shows. Keep this minimal -
    // we only need fields used in title/desc/body, not the full payload.
    //
    // NOTE: we deliberately do NOT filter by approved here. We need to
    // distinguish three cases:
    //   (a) approved clinic        → render the page
    //   (b) exists but unapproved  -> 410 Gone (removed listing; body
    //                                 carries noindex plus a link to the
    //                                 directory so users are not stranded)
    //   (c) slug not in DB at all  → real 404 (genuine garbage URL)
    //
    // Slugs are NOT unique. Three locations of one chain share a name and
    // therefore a generated slug, and a Visualize Pro sign-up row carries the
    // same generated slug as the directory listing it belongs to. The old
    // query was .eq('slug', slug).limit(1).single() with no ordering, so
    // Postgres was free to return any matching row, and which one it returned
    // changed whenever the rows were rewritten. When it happened to return an
    // unapproved row, the approved listing beside it was served as 410 Gone.
    // Order explicitly and pick deliberately instead.
    // ⚡ ONE ROUND TRIP, NOT FOUR. This used to fetch the clinic, then wait,
    // then fire three enrichment queries for expertise, prices and devices —
    // parallel with each other but strictly after the first. Two sequential
    // hops to the database on every page view.
    //
    // PostgREST embeds related tables through their foreign keys, so all four
    // arrive in a single request. Devices are filtered in JS rather than with
    // a nested filter: the active flag lives on the embedded device_reference
    // and nested filter syntax is fragile enough that a silent empty result is
    // a real risk. Filtering a handful of rows in memory costs nothing.
    const SELECT_BASE =
      'id,name,slug,neighbourhood,area,province,rating,reviews,price,' +
      'injector_credentials,logo_url,approved,phone,website,source';
    const SELECT_EMBEDDED = SELECT_BASE +
      ',clinic_expertise(value,is_other,other_text)' +
      ',clinic_prices(price)' +
      ',clinic_devices(device_reference(model,active))';

    const q = `clinics?slug=eq.${encodeURIComponent(slug)}` +
              `&order=approved.desc.nullslast,id.asc&limit=10&select=`;

    let rows = null;
    let error = null;
    let embedded = true;
    try {
      rows = await pgGet(q + encodeURIComponent(SELECT_EMBEDDED));
    } catch (e) {
      // An embedding failure means a foreign key PostgREST cannot see, not an
      // outage. Fall back to the plain row so the page still renders, and log
      // loudly — losing devices and expertise silently is exactly the kind of
      // quiet degradation that goes unnoticed for weeks.
      console.error('render-clinic: embedded select failed, falling back', slug, e.message);
      embedded = false;
      try {
        rows = await pgGet(q + encodeURIComponent(SELECT_BASE));
      } catch (e2) {
        error = e2;
      }
    }

    // A database error is not the same thing as "this clinic does not exist".
    // Answering 404 on a transient failure lets an outage deindex a live page,
    // so fail soft with a 503 that asks the crawler to come back instead.
    if (error) {
      console.error('render-clinic: slug lookup failed', slug, error.message);
      return {
        statusCode: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Retry-After': '120',
        },
        body: '<!DOCTYPE html><html><head><title>Temporarily unavailable \u00b7 SkinDay</title><meta name="robots" content="noindex" /></head><body><h1>Temporarily unavailable</h1><p>Please try again shortly, or <a href="/">browse clinics on SkinDay</a>.</p></body></html>',
      };
    }

    // Prefer an approved directory listing. Fall back to any approved row, and
    // only then to an unapproved one, so the 410 branch below still fires for a
    // genuinely removed listing. Lowest id wins among equals, which keeps the
    // longest-standing listing on the URL that search engines already indexed.
    const matches = rows || [];
    const approvedMatches = matches.filter(r => r.approved === true);
    const clinic =
      approvedMatches.find(r => r.source !== 'signup') ||
      approvedMatches[0] ||
      matches[0] ||
      null;

    // Case (c): slug not found at all → real 404.
    if (!clinic) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: '<!DOCTYPE html><html><head><title>Clinic not found · SkinDay</title><meta name="robots" content="noindex" /></head><body><h1>Clinic not found</h1><p>We couldn\'t find a clinic matching this address. <a href="/">Browse clinics on SkinDay</a>.</p></body></html>',
      };
    }

    // Case (b): clinic exists but is no longer approved (removed in cleanup,
    // non-cosmetic, etc.). Return 410 Gone rather than 301 to "/". Mass
    // redirects of removed pages to the bare homepage get reclassified by
    // Google as Soft 404s and keep getting re-crawled, so they never leave
    // the index cleanly. A 410 says the page is intentionally gone: it drops
    // from the index quickly and crawling backs off. The body still carries
    // noindex and a human-friendly link to the directory, so a user landing
    // here from an old search result is not stranded. If the clinic is later
    // re-approved this path returns 200 again and it re-indexes on its own.
    if (clinic.approved !== true) {
      return {
        statusCode: 410,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: '<!DOCTYPE html><html><head><title>Clinic no longer listed \u00b7 SkinDay</title><meta name="robots" content="noindex" /></head><body><h1>This clinic is no longer listed</h1><p>This listing has been removed from SkinDay. <a href="/">Browse current clinics</a>.</p></body></html>',
      };
    }

    // Case (a): approved → fall through and render normally.

    // Enrichment now arrives with the row above. When the embedded select
    // worked these are already present; when it fell back they are absent and
    // the page renders without expertise, devices or the cheapest price —
    // exactly the non-fatal contract the three separate queries had.
    if (embedded) {
      const exp = Array.isArray(clinic.clinic_expertise) ? clinic.clinic_expertise : [];
      if (exp.length) {
        clinic.identity = {
          expertise: exp.slice(0, 10).map(r => ({ label: r.is_other ? r.other_text : r.value })),
        };
      }

      const devRows = Array.isArray(clinic.clinic_devices) ? clinic.clinic_devices : [];
      const devices = devRows
        .map(r => (r.device_reference || {}))
        .filter(d => d.model && d.active === true)
        .sort((a, b) => String(a.model).localeCompare(String(b.model)))
        .slice(0, 30);
      if (devices.length) clinic.devices = devices;

      const priceRows = Array.isArray(clinic.clinic_prices) ? clinic.clinic_prices : [];
      const cheapest = priceRows
        .map(r => r.price)
        .filter(v => v != null)
        .sort((a, b) => Number(a) - Number(b))[0];
      if (cheapest != null) clinic.price = cheapest;

      // Drop the raw embedded arrays so nothing downstream reads them by
      // accident and so the shape matches what the old code produced.
      delete clinic.clinic_expertise;
      delete clinic.clinic_devices;
      delete clinic.clinic_prices;
    }

    const template = loadTemplate();
    const rendered = patchTemplate(template, clinic);

    // Sanity check: confirm the injection actually landed. If the regex
    // missed and #ssr-content isn't in the output, the function logs will
    // show it immediately rather than us discovering it via Search Console.
    const ssrPresent = rendered.includes('id="ssr-content"');
    // ssr_present only proves the block exists somewhere. ssr_in_wrap proves it
    // landed INSIDE #pageWrap, which is the difference between AI crawlers
    // reading the clinic record and reading the visit-signal modal.
    // Search only the text AFTER #pageWrap opens. A plain indexOf comparison
    // gives a false negative here: clinic.html's stylesheet comment mentions
    // id="ssr-content" literally, in <head>, ahead of the wrapper.
    const wrapIdx = rendered.indexOf('id="pageWrap"');
    const ssrInWrap = wrapIdx !== -1 &&
      rendered.slice(wrapIdx).includes('id="ssr-content"');
    const titlePresent = rendered.includes(escapeHtml(clinic.name || ''));
    const indexable = clinicIsIndexable(clinic);
    console.log(`render-clinic slug=${slug} ssr_present=${ssrPresent} ssr_in_wrap=${ssrInWrap} title_present=${titlePresent} indexable=${indexable}`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Browser cache: short, because a clinic can edit its own profile and
        // should see the change on a reload.
        'Cache-Control': 'public, max-age=0, must-revalidate',
        // ⚡ THE HEADER THAT ACTUALLY REMOVES THE COLD START. Netlify's edge
        // does NOT cache function responses off plain Cache-Control s-maxage;
        // it needs this one. Without it every single profile view booted the
        // function and hit the database, which is why the page felt slow on a
        // first visit.
        //
        // stale-while-revalidate is the important half: once a page is warm,
        // an expired entry is still served INSTANTLY from the edge while the
        // refresh happens behind it. The visitor never waits for the function
        // even when the cache has gone stale.
        'Netlify-CDN-Cache-Control':
          'public, s-maxage=600, stale-while-revalidate=86400, durable',
      },
      body: rendered,
    };
  } catch (err) {
    console.error('render-clinic error:', err);
    throw err; // re-throw so outer handler's catch picks it up
  }
}
