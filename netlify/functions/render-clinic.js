// netlify/functions/render-clinic.js
//
// Server-side render for /clinic/{slug} pages.
//
// Why this exists:
//   The existing client-side clinic.html template ships an empty shell —
//   every clinic URL serves the same generic HTML, populated by JS at runtime.
//   Googlebot crawls the empty shell first and treats all 5,800 clinic URLs
//   as duplicates, dropping them from the index.
//
// What this does:
//   On request to /clinic/{slug}, fetch the clinic from Supabase, inject
//   real <title>, <meta>, OpenGraph, canonical, and a baseline content
//   block into the HTML before sending. The existing client-side JS then
//   hydrates over it — user experience unchanged, crawler experience fixed.
//
// Routing (in netlify.toml):
//   [[redirects]]
//     from = "/clinic/:slug"
//     to = "/.netlify/functions/render-clinic?slug=:slug"
//     status = 200
//     force = true

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs   = require('fs');

const SITE = 'https://skinday.ca';

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
// Keep them succinct — Google truncates titles at ~60 chars and descriptions
// at ~155 chars on SERPs.

function buildTitle(clinic) {
  const name = clinic.name || 'Cosmetic Clinic';
  const loc  = clinic.neighbourhood || clinic.area || clinic.province || '';
  // "Lumiere Aesthetics — Botox Price & Reviews · Toronto · SkinDay"
  // Keep under 60 chars when possible
  const base = `${name} — Botox Price & Reviews`;
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

// Server-rendered content block — minimal, semantic, crawler-focused.
//
// Goal: defeat Google's Soft 404 classification by giving the page real,
// unique, body-level content before any JavaScript runs.
//
// Non-goals: visual polish, hydration parity, design matching. Client JS
// overwrites this block (via document.getElementById('ssr-content')?.remove())
// once the rich UI is ready, so users never see it.
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

  paragraphs.push(`Cosmetic clinic in ${loc}, ${province}.`);

  if (clinic.price != null && clinic.price > 0) {
    paragraphs.push(`Botox pricing from $${escapeHtml(clinic.price)} per unit.`);
  } else {
    paragraphs.push(`Botox and neurotoxin pricing available.`);
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

  paragraphs.push(`View full pricing, photos, and contact details on SkinDay.`);

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

  // Inject SSR content block right after <body>. The client-side JS that
  // renders clinic.html replaces #ssr-content (or ignores it; either is fine).
  const seoBody = buildSeoBody(clinic);
  out = out.replace(/<body([^>]*)>/, `<body$1>\n${seoBody}\n`);

  return out;
}

// ── HANDLER ──────────────────────────────────────────────────────

exports.handler = async (event) => {
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

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Mirror get-clinics.js slug-mode shape so SEO output matches what
    // the client-side renderer ultimately shows. Keep this minimal —
    // we only need fields used in title/desc/body, not the full payload.
    //
    // NOTE: we deliberately do NOT filter by approved here. We need to
    // distinguish three cases:
    //   (a) approved clinic        → render the page
    //   (b) exists but unapproved  → 301 to "/" (recovers any accrued SEO
    //                                 signal; avoids a dead end for users
    //                                 clicking an old Google result)
    //   (c) slug not in DB at all  → real 404 (genuine garbage URL)
    const { data: clinic, error } = await supabase
      .from('clinics')
      .select(`
        id, name, slug, neighbourhood, area, province,
        rating, reviews, price, injector_credentials, logo_url, approved
      `)
      .eq('slug', slug)
      .limit(1)
      .single();

    // Case (c): slug not found at all → real 404.
    if (error || !clinic) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: '<!DOCTYPE html><html><head><title>Clinic not found · SkinDay</title><meta name="robots" content="noindex" /></head><body><h1>Clinic not found</h1><p>We couldn\'t find a clinic matching this address. <a href="/">Browse clinics on SkinDay</a>.</p></body></html>',
      };
    }

    // Case (b): clinic exists but is no longer approved (removed in cleanup,
    // non-cosmetic, etc.) → permanent redirect to the directory. A 301 passes
    // any accumulated ranking signal to the homepage and gives users who land
    // here from an old search result somewhere useful to go.
    if (clinic.approved !== true) {
      return {
        statusCode: 301,
        headers: { 'Location': '/' },
        body: '',
      };
    }

    // Case (a): approved → fall through and render normally.

    // Optional: attach expertise for richer SEO body
    try {
      const { data: expertiseRows } = await supabase
        .from('clinic_expertise')
        .select('value, is_other, other_text')
        .eq('clinic_id', String(clinic.id))
        .limit(10);
      if (expertiseRows && expertiseRows.length) {
        clinic.identity = {
          expertise: expertiseRows.map(r => ({
            label: r.is_other ? r.other_text : r.value
          })),
        };
      }
    } catch (_) { /* non-fatal */ }

    // Sync lowest price from clinic_prices, since clinics.price snapshot
    // can lag behind the breakdown table (matches get-clinics.js behavior).
    try {
      const { data: priceRows } = await supabase
        .from('clinic_prices')
        .select('price')
        .eq('clinic_id', String(clinic.id))
        .order('price', { ascending: true })
        .limit(1);
      if (priceRows && priceRows.length && priceRows[0].price != null) {
        clinic.price = priceRows[0].price;
      }
    } catch (_) { /* non-fatal */ }

    const template = loadTemplate();
    const rendered = patchTemplate(template, clinic);

    // Sanity check: confirm the injection actually landed. If the regex
    // missed and #ssr-content isn't in the output, the function logs will
    // show it immediately rather than us discovering it via Search Console.
    const ssrPresent = rendered.includes('id="ssr-content"');
    const titlePresent = rendered.includes(escapeHtml(clinic.name || ''));
    console.log(`render-clinic slug=${slug} ssr_present=${ssrPresent} title_present=${titlePresent}`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Cache rendered HTML at the edge for 10 minutes.
        // Clinic data changes are rare; cache misses are cheap.
        'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=300',
      },
      body: rendered,
    };
  } catch (err) {
    console.error('render-clinic error:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
};
