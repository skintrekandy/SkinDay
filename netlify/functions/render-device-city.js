// netlify/functions/render-device-city.js
//
// Server-side render for device x city pages:
//   /devices/{model}/{province}/{city}   e.g. /devices/morpheus8/ontario/toronto
//
// Why this exists:
//   "morpheus8 toronto" style searches are the patient question these pages
//   answer. The national page (/devices/{model}, render-devices.js) and the
//   province page (/devices/{model}/{province}, device-page.js) sit above this
//   one; the city is the grain people actually search at.
//
// Why the province is in the path:
//   /devices/:model/:province already belongs to device-page.js, so a two-part
//   /devices/morpheus8/toronto would be caught by that rule and 404. The
//   province segment also keeps same-named places apart (Richmond BC is not
//   Richmond Hill ON, and a city name can exist in two provinces).
//
// Which devices get city pages:
//   CITY_PAGE_DEVICES below. Start small, add slugs as they prove out. The
//   same list is copied into render-devices.js and sitemap.js; ⚠️ keep all
//   three in sync or the sitemap and the links advertise pages that 404.
//
// Which clinics count:
//   device_clinic_ids RPC, the same source the directory's Technology filter
//   uses, so a city page and the filtered directory can never disagree. It
//   already applies approved + country + the portal "published list" rule and
//   expands a parent slug to its generations.
//
// What this page deliberately does NOT show:
//   Any national or province-wide total. The complete install base is the
//   Market Intelligence product; this page is the city slice a patient needs.
//
// Page shape follows render-devices.js on purpose (flat h1 + lede directly
// inside <main>, clinics as a TABLE with only the name linked). See the long
// comments in that file: anchor-row lists and wrapped headings made content
// extractors drop the clinic list, which is how AI crawlers read these pages.
//
// Routing (netlify.toml, ABOVE the /devices/:model/:province rule):
//   [[redirects]]
//     from   = "/devices/:model/:province/:city"
//     to     = "/.netlify/functions/render-device-city?model=:model&province=:province&city=:city"
//     status = 200
//     force  = true

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs   = require('fs');

const SITE = 'https://skinday.ca';

// ⚠️ Keep in sync with render-devices.js and sitemap.js.
const CITY_PAGE_DEVICES = ['morpheus8', 'xerf'];

// Same floor as the national device pages. Under it the page still renders
// (so a link or a search never dead-ends) but asks not to be indexed.
const MIN_CLINICS_TO_INDEX = 3;

// Mirrors render-devices.js / device-page.js: a province page exists only at
// 10+ clinics, so the breadcrumb links to it only then.
const PROVINCE_PAGE_MIN = 10;

const PROVINCE_SLUGS = {
  ab: 'alberta', bc: 'british-columbia', mb: 'manitoba', nb: 'new-brunswick',
  nl: 'newfoundland-and-labrador', ns: 'nova-scotia', nt: 'northwest-territories',
  nu: 'nunavut', on: 'ontario', pe: 'prince-edward-island', qc: 'quebec',
  sk: 'saskatchewan', yt: 'yukon'
};
const PROVINCE_NAMES = {
  ab: 'Alberta', bc: 'British Columbia', mb: 'Manitoba', nb: 'New Brunswick',
  nl: 'Newfoundland and Labrador', ns: 'Nova Scotia', nt: 'Northwest Territories',
  nu: 'Nunavut', on: 'Ontario', pe: 'Prince Edward Island', qc: 'Quebec',
  sk: 'Saskatchewan', yt: 'Yukon'
};

// Cities that already have a Botox price page. Keyed by province code + city
// slug so Richmond BC and Richmond Hill ON cannot cross.
const PRICE_PAGES = {
  'on|toronto':       { url: '/guide/botox-cost-toronto',        label: 'Toronto Botox cost guide' },
  'bc|vancouver':     { url: '/guide/botox-cost-vancouver',      label: 'Vancouver Botox cost guide' },
  'qc|montreal':      { url: '/guide/botox-cost-montreal',       label: 'Montreal Botox cost guide' },
  'on|london':        { url: '/guide/botox-cost-london-ontario', label: 'London Botox cost guide' },
  'on|north-york':    { url: '/botox-north-york',    label: 'Botox in North York' },
  'on|richmond-hill': { url: '/botox-richmond-hill', label: 'Botox in Richmond Hill' },
  'on|markham':       { url: '/botox-markham',       label: 'Botox in Markham' },
  'on|etobicoke':     { url: '/botox-etobicoke',     label: 'Botox in Etobicoke' },
  'bc|richmond':      { url: '/botox-richmond',      label: 'Botox in Richmond' },
  'bc|victoria':      { url: '/botox-victoria',      label: 'Botox in Victoria' },
  'bc|kelowna':       { url: '/botox-kelowna',       label: 'Botox in Kelowna' },
  'ab|calgary':       { url: '/botox-calgary',       label: 'Botox in Calgary' },
  'ab|edmonton':      { url: '/botox-edmonton',      label: 'Botox in Edmonton' },
  'qc|quebec-city':   { url: '/botox-quebec-city',   label: 'Botox in Quebec City' },
  'qc|sherbrooke':    { url: '/botox-sherbrooke',    label: 'Botox in Sherbrooke' },
  'qc|gatineau':      { url: '/botox-gatineau',      label: 'Botox in Gatineau' },
  'mb|winnipeg':      { url: '/botox-winnipeg',      label: 'Botox in Winnipeg' },
};

// ── helpers ─────────────────────────────────────────────────────
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Same rule as render-devices.js / get-clinics.js, so /devices/{slug} and
// /devices/{slug}/.../... agree on what a model is called in a URL.
function slugifyModel(model) {
  return String(model || '')
    .toLowerCase()
    .replace(/[\u00ae\u2122]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Place names: accents folded first, so Montréal -> montreal and
// Trois-Rivières -> trois-rivieres (not trois-rivires).
function placeSlug(v) {
  return String(v || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// clinics.province holds the two-letter code; tolerate a full name too.
function provCodeOf(p) {
  const k = String(p || '').trim().toLowerCase();
  if (PROVINCE_SLUGS[k]) return k;
  const bySlug = Object.keys(PROVINCE_SLUGS).find(c => PROVINCE_SLUGS[c] === placeSlug(k));
  return bySlug || null;
}

let TEMPLATE = null;
function loadTemplate() {
  if (TEMPLATE) return TEMPLATE;
  const candidates = [
    path.join(__dirname, '..', '..', 'devices.html'),
    path.join(process.cwd(), 'devices.html'),
    path.join(__dirname, 'devices.html'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) { TEMPLATE = fs.readFileSync(p, 'utf8'); return TEMPLATE; } } catch (e) {}
  }
  throw new Error('devices.html template not found');
}

// Extra styles for this page only. The template's #ssr-content rules already
// style the table and headings; these add the city blocks and a phone layout.
const PAGE_CSS = `
  <style>
    #ssr-content .city-note { font-size: 0.92rem; color: var(--muted); margin: 0 0 2rem; max-width: 62ch; }
    #ssr-content .city-note a { color: var(--rose); text-decoration: none; }
    #ssr-content .also-block h2 { font-size: 0.72rem; letter-spacing: 0.09em; text-transform: uppercase; color: var(--muted); font-weight: 600; margin: 0 0 0.7rem; }
    #ssr-content .cta { margin: 0 0 3rem; }
    @media (max-width: 600px) {
      #ssr-content .ssr-table { font-size: 0.86rem; }
      #ssr-content .ssr-table td { padding: 0.75rem 0.3rem; }
    }
  </style>`;

function patchTemplate(html, { title, desc, url, indexable, ssrBody, jsonLd }) {
  let out = html;
  out = out.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`);
  out = out.replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" id="meta-canonical" href="${escapeHtml(url)}" />`);
  out = out.replace(/<meta name="description"[^>]*\/>/, `<meta name="description" id="meta-description" content="${escapeHtml(desc)}" />`);
  out = out.replace(/<meta property="og:title"[^>]*\/>/, `<meta property="og:title" id="og-title" content="${escapeHtml(title)}" />`);
  out = out.replace(/<meta property="og:description"[^>]*\/>/, `<meta property="og:description" id="og-description" content="${escapeHtml(desc)}" />`);
  out = out.replace(/<meta property="og:url"[^>]*\/>/, `<meta property="og:url" id="og-url" content="${escapeHtml(url)}" />`);
  out = out.replace(/<meta name="twitter:title"[^>]*\/>/, `<meta name="twitter:title" id="tw-title" content="${escapeHtml(title)}" />`);
  out = out.replace(/<meta name="twitter:description"[^>]*\/>/, `<meta name="twitter:description" id="tw-description" content="${escapeHtml(desc)}" />`);

  let head = PAGE_CSS + '\n';
  if (!indexable) head += '  <meta name="robots" content="noindex, follow" />\n';
  if (jsonLd) head += `  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>\n`;
  out = out.replace('</head>', head + '</head>');

  // ⚠️ THE TEMPLATE'S CLIENT SCRIPT MUST GO. It reads /devices/{slug} from the
  // path, fetches the NATIONAL list and paints it over the page, so a Toronto
  // page would turn into the all-Canada page a second after loading. This
  // page is complete as served and needs no JavaScript. The empty #app shell
  // ("Loading...") goes with it. JSON-LD lives in <head>, so stripping plain
  // <script> tags from the body cannot touch it.
  const bodyAt = out.indexOf('<body');
  if (bodyAt !== -1) {
    const head_ = out.slice(0, bodyAt);
    let body = out.slice(bodyAt);
    body = body.replace(/<main class="wrap" id="app">[\s\S]*?<\/main>/, '');
    body = body.replace(/<script>[\s\S]*?<\/script>/g, '');
    out = head_ + body;
  }

  // After the site header, so the page reads header -> content. Falls back to
  // the top of <body> if the template ever loses its header.
  const block = `\n<div id="ssr-content">${ssrBody}</div>`;
  if (out.includes('</header>')) out = out.replace('</header>', '</header>' + block);
  else out = out.replace(/<body([^>]*)>/, `<body$1>${block}`);
  return out;
}

// .in() lists go in the URL, so ids are fetched in chunks rather than one
// request that can outgrow the URL limit as coverage grows.
async function fetchClinicsByIds(supabase, ids) {
  const out = [];
  const CHUNK = 150;
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  const results = await Promise.all(chunks.map(chunk =>
    supabase
      .from('clinics')
      .select('id, name, slug, neighbourhood, province, rating, reviews')
      .eq('approved', true)
      .ilike('country', 'canada')
      .in('id', chunk)
  ));
  for (const r of results) {
    if (r.error) throw r.error;
    out.push(...(r.data || []));
  }
  return out;
}

async function clinicIdsFor(supabase, slug) {
  const { data, error } = await supabase.rpc('device_clinic_ids', {
    p_country: 'canada', p_province: null, p_slug: slug, p_category: null, p_group: null,
  });
  if (error) throw error;
  return (data || []).map(r => String(r.clinic_id));
}

const CDN_CACHE = 'public, durable, s-maxage=21600, stale-while-revalidate=86400';

function errorPage(statusCode, heading, body) {
  return {
    statusCode,
    headers: Object.assign(
      { 'Content-Type': 'text/html; charset=utf-8' },
      statusCode === 404 ? { 'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=3600' } : {}
    ),
    body: `<!DOCTYPE html><html lang="en"><head><title>${heading} \u00b7 SkinDay</title><meta name="robots" content="noindex" /></head><body><h1>${heading}</h1><p>${body}</p></body></html>`,
  };
}

// Netlify may hand the function its own path or the original one; read the
// three segments from whichever carries them.
function readParams(event) {
  const q = event.queryStringParameters || {};
  let model = (q.model || '').trim().toLowerCase();
  let province = (q.province || '').trim().toLowerCase();
  let city = (q.city || '').trim().toLowerCase();
  if (!model || !province || !city) {
    const m = String(event.path || event.rawUrl || '').match(/\/devices\/([^\/?#]+)\/([^\/?#]+)\/([^\/?#]+)/);
    if (m) {
      model = model || decodeURIComponent(m[1]).toLowerCase();
      province = province || decodeURIComponent(m[2]).toLowerCase();
      city = city || decodeURIComponent(m[3]).toLowerCase();
    }
  }
  return { model, province, city };
}

// ── handler ─────────────────────────────────────────────────────
exports.handler = async (event) => {
  const { model: slug, province: provSlug, city: citySlug } = readParams(event);

  const provCode = Object.keys(PROVINCE_SLUGS).find(c => PROVINCE_SLUGS[c] === provSlug);
  if (!slug || !provCode || !citySlug || !CITY_PAGE_DEVICES.includes(slug)) {
    return errorPage(404, 'Page not found', 'We could not find this page. <a href="/">Browse clinics on SkinDay</a>.');
  }

  let supabase;
  try {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  } catch (e) {
    console.error('render-device-city: supabase init failed', e);
    return errorPage(503, 'Temporarily unavailable', 'Please try again shortly, or <a href="/">browse clinics on SkinDay</a>.');
  }

  try {
    const [refRes, catRes, idLists] = await Promise.all([
      supabase
        .from('device_reference')
        .select('id, model, manufacturer, category, active, name_is_also_generic')
        .eq('active', true)
        .range(0, 999),
      supabase.from('device_categories').select('category, label_en'),
      // Every city-page device at once, so "other devices in this city" costs
      // no extra round trip.
      Promise.all(CITY_PAGE_DEVICES.map(s => clinicIdsFor(supabase, s))),
    ]);
    if (refRes.error) throw refRes.error;

    const refs = refRes.data || [];
    const modelBySlug = {};
    refs.forEach(r => {
      const s = slugifyModel(r.model);
      // A parent and its generations share a family; the page is named after
      // the row whose slug is the one in the URL.
      if (!modelBySlug[s]) modelBySlug[s] = r;
    });
    const ref = modelBySlug[slug];
    if (!ref || ref.name_is_also_generic === true) {
      return errorPage(404, 'Page not found', 'We could not find this page. <a href="/devices/">Browse devices</a>.');
    }
    const catLabel = ((catRes.data || []).find(c => c.category === ref.category) || {}).label_en || '';

    const idsBySlug = {};
    CITY_PAGE_DEVICES.forEach((s, i) => { idsBySlug[s] = new Set(idLists[i]); });
    const allIds = [...new Set(idLists.flat())];
    const clinics = await fetchClinicsByIds(supabase, allIds);

    // Group every clinic under province code + city slug.
    const place = c => {
      const pc = provCodeOf(c.province);
      const cs = placeSlug(c.neighbourhood);
      return pc && cs ? { pc, cs } : null;
    };

    const mine = clinics.filter(c => idsBySlug[slug].has(String(c.id)));
    const inProvince = mine.filter(c => { const p = place(c); return p && p.pc === provCode; });
    const here = inProvince.filter(c => place(c).cs === citySlug);

    if (!here.length) {
      const back = inProvince.length >= PROVINCE_PAGE_MIN
        ? `/devices/${slug}/${provSlug}` : `/devices/${slug}`;
      return errorPage(404, 'Page not found',
        `We could not find ${escapeHtml(ref.model)} clinics for this city. <a href="${back}">See ${escapeHtml(ref.model)} clinics</a>.`);
    }

    // Display name: the most common spelling in the data (Montréal over Montreal
    // if that is how the rows read).
    const spell = {};
    here.forEach(c => { const n = String(c.neighbourhood).trim(); spell[n] = (spell[n] || 0) + 1; });
    const cityName = Object.keys(spell).sort((a, b) => spell[b] - spell[a])[0];
    const provName = PROVINCE_NAMES[provCode];

    here.sort((a, b) => (Number(b.reviews) || 0) - (Number(a.reviews) || 0)
      || (Number(b.rating) || 0) - (Number(a.rating) || 0)
      || String(a.name).localeCompare(String(b.name)));

    const count = here.length;
    const indexable = count >= MIN_CLINICS_TO_INDEX;
    const url = `${SITE}/devices/${slug}/${provSlug}/${citySlug}`;

    // Nearby: other cities in the same province with a real page.
    const cityCounts = {};
    const cityNames = {};
    inProvince.forEach(c => {
      const cs = place(c).cs;
      if (cs === citySlug) return;
      cityCounts[cs] = (cityCounts[cs] || 0) + 1;
      cityNames[cs] = cityNames[cs] || String(c.neighbourhood).trim();
    });
    const nearby = Object.keys(cityCounts)
      .filter(cs => cityCounts[cs] >= MIN_CLINICS_TO_INDEX)
      .sort((a, b) => cityCounts[b] - cityCounts[a])
      .slice(0, 16);

    // Other city-page devices with an indexable page for this same city.
    const otherDevices = CITY_PAGE_DEVICES
      .filter(s => s !== slug && modelBySlug[s])
      .map(s => {
        const n = clinics.filter(c => {
          if (!idsBySlug[s].has(String(c.id))) return false;
          const p = place(c);
          return p && p.pc === provCode && p.cs === citySlug;
        }).length;
        return { slug: s, model: modelBySlug[s].model, clinics: n };
      })
      .filter(d => d.clinics >= MIN_CLINICS_TO_INDEX);

    const price = PRICE_PAGES[`${provCode}|${citySlug}`];
    const provinceHasPage = inProvince.length >= PROVINCE_PAGE_MIN;

    // ── copy ──────────────────────────────────────────────────
    const model = ref.model;
    const mfr = ref.manufacturer;
    const clinicWord = count === 1 ? 'clinic' : 'clinics';
    const title = `${model} in ${cityName}, ${provCode.toUpperCase()}: ${count} ${count === 1 ? 'Clinic' : 'Clinics'} | SkinDay`;
    const desc = `${count} ${clinicWord} in ${cityName}, ${provName} ${count === 1 ? 'lists' : 'list'} ${model}${mfr ? ' by ' + mfr : ''}. Compare locations, ratings and reviews to find the right ${model} clinic in ${cityName}.`;

    // "an RF microneedling device", not "a rf microneedling device":
    // acronyms keep their capitals and the article follows how they are said.
    const catText = String(catLabel || '').split(' ')
      .map(w => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase())).join(' ');
    const first = catText.split(' ')[0] || '';
    const an = /^[A-Z0-9]{2,}$/.test(first) ? /^[AEFHILMNORSX8]/.test(first) : /^[aeiou]/.test(first);
    const madeBy = mfr ? ` made by ${escapeHtml(mfr)}` : '';
    const catSentence = catText
      ? ` ${escapeHtml(model)} is ${an ? 'an' : 'a'} ${escapeHtml(catText)} device${madeBy}.`
      : (mfr ? ` ${escapeHtml(model)} is made by ${escapeHtml(mfr)}.` : '');

    const rows = here.map(c => {
      const rating = (c.rating != null)
        ? `${Number(c.rating).toFixed(1)}${c.reviews ? ' \u00b7 ' + Number(c.reviews).toLocaleString('en-CA') + ' reviews' : ''}`
        : '';
      return `<tr>
        <td><a href="/clinic/${escapeHtml(c.slug || '')}">${escapeHtml(c.name)}</a></td>
        <td>${escapeHtml(rating)}</td>
      </tr>`;
    }).join('');

    const crumbProvince = provinceHasPage
      ? `<a href="/devices/${escapeHtml(slug)}/${escapeHtml(provSlug)}">${escapeHtml(provName)}</a>`
      : escapeHtml(provName);

    const nearbyBlock = nearby.length ? `<div class="also-block">
      <h2>${escapeHtml(model)} elsewhere in ${escapeHtml(provName)}</h2>
      <div class="also-links">${nearby.map(cs => `<a class="also-link" href="/devices/${escapeHtml(slug)}/${escapeHtml(provSlug)}/${escapeHtml(cs)}">${escapeHtml(cityNames[cs])} <em>${cityCounts[cs]}</em></a>`).join('')}</div>
    </div>` : '';

    const otherBlock = otherDevices.length ? `<div class="also-block">
      <h2>Other devices in ${escapeHtml(cityName)}</h2>
      <div class="also-links">${otherDevices.map(d => `<a class="also-link" href="/devices/${escapeHtml(d.slug)}/${escapeHtml(provSlug)}/${escapeHtml(citySlug)}">${escapeHtml(d.model)} <em>${d.clinics}</em></a>`).join('')}</div>
    </div>` : '';

    const priceNote = price
      ? `<p class="city-note">For injectable prices in ${escapeHtml(cityName)}, see the <a href="${price.url}">${escapeHtml(price.label)}</a>.</p>`
      : '';

    const ssrBody = `<main class="wrap">
      <div class="crumb"><a href="/">SkinDay</a> <span>/</span> <a href="/devices/">Devices</a> <span>/</span> <a href="/devices/${escapeHtml(slug)}">${escapeHtml(model)}</a> <span>/</span> ${crumbProvince} <span>/</span> ${escapeHtml(cityName)}</div>
      <h1>${escapeHtml(model)} in ${escapeHtml(cityName)}</h1>
      <p class="page-sub">${count.toLocaleString('en-CA')} ${clinicWord} in ${escapeHtml(cityName)}, ${escapeHtml(provName)} ${count === 1 ? 'lists' : 'list'} ${escapeHtml(model)} on their own website.${catSentence}</p>
      <table class="ssr-table">
        <thead><tr><th>Clinic</th><th>Google rating</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${priceNote}
      <a class="cta" href="/?device=${escapeHtml(slug)}">Browse ${escapeHtml(model)} clinics on the directory</a>
      ${otherBlock}
      ${nearbyBlock}
    </main>`;

    const crumbs = [
      { name: 'SkinDay', item: `${SITE}/` },
      { name: 'Devices', item: `${SITE}/devices/` },
      { name: model, item: `${SITE}/devices/${slug}` },
    ];
    if (provinceHasPage) crumbs.push({ name: provName, item: `${SITE}/devices/${slug}/${provSlug}` });
    crumbs.push({ name: cityName, item: url });

    const jsonLd = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'ItemList',
          name: `${model} clinics in ${cityName}, ${provName}`,
          numberOfItems: count,
          itemListElement: here.slice(0, 50).map((c, i) => ({
            '@type': 'ListItem', position: i + 1,
            url: `${SITE}/clinic/${c.slug || ''}`, name: c.name,
          })),
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.item })),
        },
      ],
    };

    const rendered = patchTemplate(loadTemplate(), { title, desc, url, indexable, ssrBody, jsonLd });
    console.log(`render-device-city ${slug}/${provSlug}/${citySlug} clinics=${count} indexable=${indexable}`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Netlify-CDN-Cache-Control': CDN_CACHE,
      },
      body: rendered,
    };
  } catch (e) {
    // 503, never 500: a 500 is held against the whole domain in Search Console.
    console.error('render-device-city failed', e);
    return errorPage(503, 'Temporarily unavailable', 'Please try again shortly, or <a href="/">browse clinics on SkinDay</a>.');
  }
};

// Exposed for the sitemap and the national page to share the exact grouping.
exports._internals = { CITY_PAGE_DEVICES, placeSlug, provCodeOf, PROVINCE_SLUGS, MIN_CLINICS_TO_INDEX };
