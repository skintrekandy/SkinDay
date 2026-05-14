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

// Server-rendered content block — shown immediately on page load with
// real clinic data (no flash of empty/template content), then removed by
// the client-side JS in clinic.html once the full rich UI is hydrated.
//
// This is progressive enhancement, not cloaking: the content humans see
// during the brief pre-hydration window is the same content the crawler
// reads. Google's documentation explicitly endorses this pattern.
//
// Visual: styled as a centered loading-state card matching the SkinDay
// design tokens, so the brief moment before JS replaces it doesn't look
// broken. Once clinic.html's renderClinic() runs, it removes #ssr-content.
function buildSeoBody(clinic) {
  const safe = (k) => escapeHtml(clinic[k]);
  const loc  = clinic.neighbourhood || clinic.area || clinic.province || '';

  const priceBlock = clinic.price
    ? `<p>Botox pricing starts from $${escapeHtml(clinic.price)} per unit.</p>`
    : '';

  const ratingBlock = (clinic.rating && clinic.reviews)
    ? `<p>${escapeHtml(clinic.rating)} ★ · ${escapeHtml(clinic.reviews)} Google reviews</p>`
    : '';

  const creds = formatInjectorCreds(clinic.injector_credentials);
  const credBlock = creds
    ? `<p>Credentials: ${escapeHtml(creds)}</p>`
    : '';

  const expertise = (clinic.identity && clinic.identity.expertise) || [];
  const expertiseBlock = expertise.length
    ? `<p>Specialties: ${expertise.map(e => escapeHtml(e.label)).join(' · ')}</p>`
    : '';

  // Styled to match SkinDay design: centered, cream background, serif heading.
  // Padding-top accounts for the fixed nav (~64px). Removed by client JS
  // once hydration completes (clinic.html should call
  // document.getElementById('ssr-content')?.remove() at the end of render).
  const style = [
    'padding:120px 5% 80px',
    'text-align:center',
    'font-family:"DM Sans",sans-serif',
    'color:#1C1714',
    'background:#FAF7F2',
    'min-height:50vh',
  ].join(';');

  const headingStyle = [
    'font-family:"Cormorant Garamond",serif',
    'font-size:2.2rem',
    'font-weight:400',
    'margin-bottom:0.5rem',
  ].join(';');

  const locStyle = 'color:#8A7B72;font-size:1rem;margin-bottom:1.5rem;';
  const pStyle = 'color:#8A7B72;font-size:0.95rem;margin:0.4rem 0;';

  return `
<div id="ssr-content" style="${style}">
  <h1 style="${headingStyle}">${safe('name')}</h1>
  ${loc ? `<p style="${locStyle}">${escapeHtml(loc)}</p>` : ''}
  ${priceBlock ? priceBlock.replace('<p>', `<p style="${pStyle}">`) : ''}
  ${ratingBlock ? ratingBlock.replace('<p>', `<p style="${pStyle}">`) : ''}
  ${credBlock ? credBlock.replace('<p>', `<p style="${pStyle}">`) : ''}
  ${expertiseBlock ? expertiseBlock.replace('<p>', `<p style="${pStyle}">`) : ''}
  <p style="${pStyle};margin-top:2rem;font-size:0.85rem;">Loading full profile…</p>
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
