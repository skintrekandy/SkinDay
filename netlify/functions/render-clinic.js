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
  const price = clinic.price ? `Botox from $${clinic.price}/unit. ` : '';
  const rating = (clinic.rating && clinic.reviews)
    ? `Rated ${clinic.rating} from ${clinic.reviews} Google reviews. `
    : '';
  return `${name} in ${loc}. ${price}${rating}Compare prices, services, and verified clinic details on SkinDay.`.trim();
}

// Server-rendered content block — visible to crawlers, replaced by client JS
// on hydration. Keep it semantic and self-contained so a Lynx-style crawler
// understands the page even without CSS or JS.
function buildSeoBody(clinic) {
  const safe = (k) => escapeHtml(clinic[k]);
  const loc  = clinic.neighbourhood || clinic.area || clinic.province || '';

  const priceBlock = clinic.price
    ? `<p>Botox pricing starts from $${escapeHtml(clinic.price)} per unit.</p>`
    : '';

  const ratingBlock = (clinic.rating && clinic.reviews)
    ? `<p>Google rating: ${escapeHtml(clinic.rating)} stars (${escapeHtml(clinic.reviews)} reviews).</p>`
    : '';

  const credBlock = clinic.injector_credentials
    ? `<p>Injector credentials: ${escapeHtml(clinic.injector_credentials)}.</p>`
    : '';

  const expertise = (clinic.identity && clinic.identity.expertise) || [];
  const expertiseBlock = expertise.length
    ? `<p>Specialties: ${expertise.map(e => escapeHtml(e.label)).join(', ')}.</p>`
    : '';

  return `
<div id="ssr-content" aria-hidden="false">
  <h1>${safe('name')}${loc ? ` <small>· ${escapeHtml(loc)}</small>` : ''}</h1>
  ${priceBlock}
  ${ratingBlock}
  ${credBlock}
  ${expertiseBlock}
  <p>View pricing, services, photos, and contact details below.</p>
</div>`.trim();
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
    // Slug arrives via path splat: /.netlify/functions/render-clinic/{slug}
    // (rewritten from /clinic/{slug} by netlify.toml).
    // We strip the function-name prefix and take what's left as the slug.
    // Fallback to ?slug= query param for backward compatibility and direct
    // function invocation during local testing.
    let slug = (event.queryStringParameters || {}).slug;
    if (!slug && event.path) {
      // event.path is the full request path, e.g. "/clinic/skin-trek"
      // or "/.netlify/functions/render-clinic/skin-trek" depending on routing.
      const parts = event.path.split('/').filter(Boolean);
      // Last segment after the function name or "clinic" prefix is the slug.
      slug = parts[parts.length - 1];
      // Guard against the function name itself being the last segment
      // (i.e. someone hit /clinic with no slug).
      if (slug === 'render-clinic' || slug === 'clinic') slug = null;
    }
    if (!slug) {
      return { statusCode: 400, body: 'Missing slug' };
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Mirror get-clinics.js slug-mode shape so SEO output matches what
    // the client-side renderer ultimately shows. Keep this minimal —
    // we only need fields used in title/desc/body, not the full payload.
    const { data: clinic, error } = await supabase
      .from('clinics')
      .select(`
        id, name, slug, neighbourhood, area, province,
        rating, reviews, price, injector_credentials, logo_url
      `)
      .eq('approved', true)
      .eq('slug', slug)
      .limit(1)
      .single();

    if (error || !clinic) {
      // Render 404 — Google needs a real 404, not a soft one.
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: '<!DOCTYPE html><html><head><title>Clinic not found · SkinDay</title><meta name="robots" content="noindex" /></head><body><h1>Clinic not found</h1><p>This clinic profile may have been removed. <a href="/">Browse other clinics on SkinDay</a>.</p></body></html>',
      };
    }

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

    const template = loadTemplate();
    const rendered = patchTemplate(template, clinic);

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
