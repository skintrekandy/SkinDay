// netlify/functions/render-devices.js
//
// Server-side render for /devices/ and /devices/{model}.
//
// Why this exists:
//   Same reason as render-clinic.js. devices.html ships an empty shell that JS
//   populates at runtime, so Googlebot would see one identical page for every
//   device URL and treat the whole set as duplicates. These pages only earn
//   their keep if they can rank for "morpheus8 toronto", which means the model
//   name, the clinic count and the clinic list all have to be in the HTML
//   before any JavaScript runs.
//
// Routing (add to netlify.toml, ABOVE any catch-all):
//   [[redirects]]
//     from = "/devices"
//     to = "/.netlify/functions/render-devices"
//     status = 200
//     force = true
//   [[redirects]]
//     from = "/devices/"
//     to = "/.netlify/functions/render-devices"
//     status = 200
//     force = true
//   [[redirects]]
//     from = "/devices/:slug"
//     to = "/.netlify/functions/render-devices?slug=:slug"
//     status = 200
//     force = true

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs   = require('fs');

const SITE = 'https://skinday.ca';

// A device page with almost nobody on it is a thin page. Google logs those as
// "Crawled - currently not indexed" and it drags on the whole set, so anything
// under this threshold is rendered but marked noindex, follow: the links are
// still crawled, the page just does not ask to be ranked.
const MIN_CLINICS_TO_INDEX = 3;

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

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function slugifyModel(model) {
  return String(model || '')
    .toLowerCase()
    .replace(/[\u00ae\u2122]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const PROV_NAMES = {
  ON: 'Ontario', QC: 'Quebec', BC: 'British Columbia', AB: 'Alberta',
  MB: 'Manitoba', SK: 'Saskatchewan', NS: 'Nova Scotia', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', PE: 'Prince Edward Island',
  YT: 'Yukon', NT: 'Northwest Territories', NU: 'Nunavut',
};
const provLabel = p => PROV_NAMES[String(p || '').trim().toUpperCase()] || (p || '');

// ── meta copy ───────────────────────────────────────────────────
// Written to read like a search result, because that is where it appears.
// The province list is in the description because "morpheus8 toronto" style
// queries are the whole point of these pages.
function buildModelTitle(device, count) {
  return count
    ? `${device.model} Clinics in Canada (${count}) — SkinDay`
    : `${device.model} — SkinDay`;
}
function buildModelDescription(device, count, topProvinces) {
  if (!count) {
    return `${device.model} by ${device.manufacturer || 'its manufacturer'}. Browse Canadian cosmetic clinics and the technology they use on SkinDay.`;
  }
  const where = topProvinces.length ? ` Clinics in ${topProvinces.slice(0, 3).map(provLabel).join(', ')}.` : '';
  const mfr = device.manufacturer ? ` by ${device.manufacturer}` : '';
  return `${count} Canadian ${count === 1 ? 'clinic lists' : 'clinics list'} ${device.model}${mfr}.${where} Compare clinics, ratings and pricing on SkinDay.`;
}

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

  if (!indexable) {
    out = out.replace('</head>', '  <meta name="robots" content="noindex, follow" />\n</head>');
  }
  if (jsonLd) {
    out = out.replace('</head>', `  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>\n</head>`);
  }

  // Injected right after <body> so it is the first thing in the DOM. The
  // client script leaves it alone if its own fetch fails.
  out = out.replace(/<body([^>]*)>/, `<body$1>\n<div id="ssr-content">${ssrBody}</div>`);
  return out;
}

// ── READING clinic_devices WITHOUT HITTING THE ROW CAP ─────────────────
// This page used to read the WHOLE clinic_devices table with embedded
// device_reference on every request, in one call with .range(0, 49999). Two
// problems. It was slow (the 4.4s /devices/exion request), and PostgREST caps
// a response at the project's Max rows setting whatever range is asked for, so
// once the table grew past that cap the page could be working from a silently
// cut-off subset. get-clinics.js documents the same failure costing the
// Technology filter its counts.
//
// Now: device_reference (a small table) is read first, and clinic_devices is
// read only for the device ids the page actually needs, in explicitly ordered
// pages that are fetched in parallel, so nothing is dropped.
const CD_PAGE = 1000;
async function readClinicDevices(supabase, deviceIds) {
  if (!deviceIds.length) return [];
  const head = await supabase
    .from('clinic_devices')
    .select('clinic_id', { count: 'exact', head: true })
    .in('device_id', deviceIds);
  if (head.error) throw head.error;
  const total = head.count || 0;
  const pages = Math.ceil(total / CD_PAGE);
  const results = await Promise.all(Array.from({ length: pages }, (_, i) =>
    supabase
      .from('clinic_devices')
      .select('clinic_id, device_id, status')
      .in('device_id', deviceIds)
      .order('device_id', { ascending: true })
      .order('clinic_id', { ascending: true })
      .range(i * CD_PAGE, i * CD_PAGE + CD_PAGE - 1)
  ));
  const out = [];
  for (const r of results) {
    if (r.error) throw r.error;
    (r.data || []).forEach(row => out.push(row));
  }
  return out;
}

// Six hours fresh at Netlify's edge, then served stale for up to a day while it
// refreshes in the background. `durable` shares one copy across every edge
// location. Without this header Netlify does not cache a function's response
// at all, so every crawler hit rebuilt the page from the database.
const CDN_CACHE = 'public, durable, s-maxage=21600, stale-while-revalidate=86400';

function errorPage(statusCode, heading, body) {
  return {
    statusCode,
    headers: Object.assign(
      { 'Content-Type': 'text/html; charset=utf-8' },
      // A 404 is cached too (for an hour), so bots repeating a dead URL do not
      // reach the database. A 503 is never cached.
      statusCode === 404 ? { 'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=3600' } : {}
    ),
    body: `<!DOCTYPE html><html lang="en"><head><title>${heading} \u00b7 SkinDay</title><meta name="robots" content="noindex" /></head><body><h1>${heading}</h1><p>${body}</p></body></html>`,
  };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const slug = (params.slug || '').trim().toLowerCase();

  let supabase;
  try {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  } catch (e) {
    console.error('render-devices: supabase init failed', e);
    return errorPage(503, 'Temporarily unavailable', 'Please try again shortly, or <a href="/">browse clinics on SkinDay</a>.');
  }

  try {
    // device_reference and the category labels first; both are small.
    const [refRes, catRes] = await Promise.all([
      supabase
        .from('device_reference')
        .select('id, model, manufacturer, category, active, name_is_also_generic')
        .eq('active', true)
        .range(0, 999),
      supabase.from('device_categories').select('category, segment, label_en, sort_order'),
    ]);
    if (refRes.error) throw refRes.error;
    const refs = refRes.data || [];
    const refById = new Map(refs.map(r => [String(r.id), r]));

    // Which device ids this request needs. The index needs all of them. A model
    // page needs the model itself plus the rest of its category, for the
    // "Other ... devices" sibling links.
    const targetRefs = slug ? refs.filter(r => slugifyModel(r.model) === slug) : [];
    let wantedIds;
    if (!slug) {
      wantedIds = refs.map(r => r.id);
    } else {
      const cats = new Set(targetRefs.map(r => r.category).filter(Boolean));
      wantedIds = refs
        .filter(r => slugifyModel(r.model) === slug || cats.has(r.category))
        .map(r => r.id);
    }

    // Same shape the rest of this function has always read:
    // { clinic_id, status, device_reference: { model, manufacturer, ... } }
    const devRows = (await readClinicDevices(supabase, wantedIds))
      .map(r => ({ clinic_id: r.clinic_id, status: r.status, device_reference: refById.get(String(r.device_id)) }))
      .filter(r => r.device_reference);

    const labels = {};
    (catRes.data || []).forEach(r => { labels[r.category] = r; });

    // ── INDEX MODE: /devices/ ──────────────────────────────────
    if (!slug) {
      const byCat = {};
      const catClinics = {};
      devRows.forEach(row => {
        const d = row.device_reference || {};
        if (!d.model || !d.category) return;
        const lab = labels[d.category];
        if (!lab || !lab.segment) return;   // led / lesion_removal / womens_health stay out
        (byCat[d.category] = byCat[d.category] || {});
        (byCat[d.category][d.model] = byCat[d.category][d.model] || new Set()).add(String(row.clinic_id));
        (catClinics[d.category] = catClinics[d.category] || new Set()).add(String(row.clinic_id));
      });

      const cats = Object.keys(byCat)
        .map(c => ({ category: c, label: (labels[c] && labels[c].label_en) || c, sort: (labels[c] && labels[c].sort_order) || 999, clinics: catClinics[c].size }))
        .sort((a, b) => a.sort - b.sort);

      // Same reason as the clinic table on the model page: a wall of
      // <a class="also-link"> is pure link markup and readability discards it
      // as navigation, leaving the index with a heading and nothing else.
      // Verified 2026-08-21: as anchor blocks readability kept neither the
      // category names nor the models; as tables it keeps both. Headings are
      // real <h2>s so the category names survive independently of the table.
      const blocks = cats.map(c => {
        const models = Object.keys(byCat[c.category])
          .map(m => ({ model: m, slug: slugifyModel(m), clinics: byCat[c.category][m].size }))
          .sort((a, b) => b.clinics - a.clinics);
        return `<h2>${escapeHtml(c.label)}</h2>
          <p class="cat-count">${c.clinics.toLocaleString()} ${c.clinics === 1 ? 'clinic' : 'clinics'} in Canada list a ${escapeHtml(c.label.toLowerCase())} device.</p>
          <table class="ssr-table">
            <thead><tr><th>Device</th><th>Clinics</th></tr></thead>
            <tbody>${models.map(m => `<tr><td><a href="/devices/${escapeHtml(m.slug)}">${escapeHtml(m.model)}</a></td><td>${m.clinics}</td></tr>`).join('')}</tbody>
          </table>`;
      }).join('');

      const ssrBody = `<main class="wrap">
        <div class="crumb"><a href="/">SkinDay</a> <span>/</span> Devices</div>
        <h1>Aesthetic devices in Canada</h1>
        <p class="page-sub">Browse Canadian clinics by the technology they use. Device listings are read from clinics&rsquo; own published pages.</p>
        ${blocks}</main>`;

      const rendered = patchTemplate(loadTemplate(), {
        title: 'Aesthetic Devices in Canada \u2014 SkinDay',
        desc: 'Browse Canadian cosmetic clinics by the device and technology they use, from Morpheus8 to CoolSculpting.',
        url: `${SITE}/devices/`,
        indexable: cats.length > 0,
        ssrBody,
        jsonLd: null,
      });
      console.log(`render-devices index categories=${cats.length} ssr_present=${rendered.includes('id="ssr-content"')}`);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600', 'Netlify-CDN-Cache-Control': CDN_CACHE },
        body: rendered,
      };
    }

    // ── MODEL MODE: /devices/{slug} ────────────────────────────
    let device = null;
    const clinicIds = new Set();
    const statusByClinic = {};
    const siblingCounts = {};

    devRows.forEach(row => {
      const d = row.device_reference || {};
      if (!d.model) return;
      if (slugifyModel(d.model) === slug) {
        if (!device) {
          const lab = labels[d.category] || {};
          device = {
            model: d.model, slug: slug, manufacturer: d.manufacturer,
            name_is_also_generic: d.name_is_also_generic === true,
            category: d.category, category_label: lab.label_en || d.category,
          };
        }
        const cid = String(row.clinic_id);
        clinicIds.add(cid);
        if (row.status === 'verified' || !statusByClinic[cid]) statusByClinic[cid] = row.status;
      }
    });

    // A model can exist in device_reference but be on no clinic yet. That is a
    // real page (someone searching the name should find something), just an
    // empty one, so it renders and is noindexed rather than 404ing.
    if (!device) {
      const match = targetRefs[0];
      if (!match) {
        return errorPage(404, 'Device not found', 'We could not find a device matching this address. <a href="/devices/">Browse all devices</a>.');
      }
      const lab = labels[match.category] || {};
      device = { model: match.model, slug, manufacturer: match.manufacturer, category: match.category, category_label: lab.label_en || match.category, name_is_also_generic: match.name_is_also_generic === true };
    }

    if (device.category) {
      devRows.forEach(row => {
        const d = row.device_reference || {};
        if (d.category !== device.category) return;
        if (slugifyModel(d.model) === slug) return;
        (siblingCounts[d.model] = siblingCounts[d.model] || new Set()).add(String(row.clinic_id));
      });
    }

    let clinics = [];
    if (clinicIds.size) {
      const { data, error } = await supabase
        .from('clinics')
        .select('id, name, slug, neighbourhood, province, rating, reviews')
        .eq('approved', true)
        .in('id', [...clinicIds])
        .order('reviews', { ascending: false, nullsFirst: false })
        .range(0, 4999);
      if (error) throw error;
      clinics = data || [];
    }

    const provCount = {};
    clinics.forEach(c => {
      const p = String(c.province || '').trim().toUpperCase();
      if (p) provCount[p] = (provCount[p] || 0) + 1;
    });
    const topProvinces = Object.keys(provCount).sort((a, b) => provCount[b] - provCount[a]);

    const count = clinics.length;
    const title = buildModelTitle(device, count);
    const desc  = buildModelDescription(device, count, topProvinces);
    const url   = `${SITE}/devices/${device.slug}`;

    // ⚠️ TABLE MARKUP IS DELIBERATE — DO NOT REVERT TO <a class="clinic-row">.
    // The clinic list used to be a stack of anchors, one per row, with every
    // cell inside the <a>. That container is ~100% link markup, and readability
    // penalises high link-density nodes as navigation: it dropped the entire
    // list and kept only the page head. Verified 2026-08-21 — with anchor rows,
    // trafilatura kept the clinics and readability did not; as a table BOTH
    // keep them. device-page.js has always used tables, which is why the
    // province pages never had this problem.
    //
    // Adding an explanatory paragraph does NOT fix it and makes things worse:
    // trafilatura then scores the prose highest and drops the list instead, so
    // the page loses clinics in both extractors. Tested, rejected.
    //
    // Only the clinic NAME is a link. The location and rating are plain text
    // cells, which is what keeps link density down.
    const rows = clinics.map(c => {
      const where = [c.neighbourhood, provLabel(c.province)].filter(Boolean).join(', ');
      const rating = (c.rating != null)
        ? `${Number(c.rating).toFixed(1)}${c.reviews ? ' \u00b7 ' + Number(c.reviews).toLocaleString() + ' reviews' : ''}`
        : '';
      const verified = statusByClinic[String(c.id)] === 'verified' ? '<span class="verified-tag">Verified</span> ' : '';
      return `<tr>
        <td><a href="/clinic/${escapeHtml(c.slug || '')}">${escapeHtml(c.name)}</a></td>
        <td>${escapeHtml(where)}</td>
        <td>${verified}${escapeHtml(rating)}</td>
      </tr>`;
    }).join('');

    const siblings = Object.keys(siblingCounts)
      .map(m => ({ model: m, slug: slugifyModel(m), clinics: siblingCounts[m].size }))
      .sort((a, b) => b.clinics - a.clinics).slice(0, 12);

    // ── LINKS INTO THE PROVINCE PAGES (M19.3) ──────────────────────
    // /devices/{model}/{province} is served by device-page.js. Without this
    // block those pages are orphans reachable only from the sitemap, which is
    // the weakest discovery path there is — Google follows links first.
    //
    // ⚠️ TWO CONDITIONS, both mirroring device-page.js exactly, because a link
    // to a page that 404s is worse than no link:
    //   - the province must have >= 10 clinics with this device
    //   - the device's name must not also be an ordinary word (device-page.js
    //     never renders those; /devices/elite exists here, /devices/elite/
    //     ontario deliberately does not)
    // The province slug is the FULL NAME (ontario, british-columbia), never the
    // two-letter code, matching device-page.js and both sitemaps.
    const PROVINCE_PAGE_MIN = 10;
    const provinceLinks = device.name_is_also_generic ? [] : topProvinces
      .filter(p => provCount[p] >= PROVINCE_PAGE_MIN)
      .map(p => ({
        label: provLabel(p) || p,
        slug: slugifyModel(provLabel(p) || p),
        clinics: provCount[p]
      }));

    const provinceBlock = provinceLinks.length ? `<div class="also-block">
      <div class="also-label">${escapeHtml(device.model)} by province</div>
      <div class="also-links">${provinceLinks.map(v => `<a class="also-link" href="/devices/${escapeHtml(device.slug)}/${escapeHtml(v.slug)}">${escapeHtml(v.label)} <em>${v.clinics}</em></a>`).join('')}</div>
    </div>` : '';

    const siblingBlock = siblings.length ? `<div class="also-block">
      <div class="also-label">Other ${escapeHtml(String(device.category_label || '').toLowerCase())} devices</div>
      <div class="also-links">${siblings.map(s => `<a class="also-link" href="/devices/${escapeHtml(s.slug)}">${escapeHtml(s.model)} <em>${s.clinics}</em></a>`).join('')}</div>
    </div>` : '';

    // ⚠️ THE HEADING AND LEDE ARE FLAT — NOT WRAPPED IN <div class="page-head">.
    // That wrapper is what cost this page its clinic list. Readability picks a
    // single highest-scoring node: with the h1 and lede inside their own div,
    // that div wins and the table is discarded; with them as direct children of
    // <main class="wrap">, the wrapper wins and the table comes with it.
    // Verified 2026-08-21 — wrapped: readability returned the head only.
    // Flat: both extractors return the full clinic list.
    //
    // The manufacturer and category are stated IN THE SENTENCE, not only in the
    // .meta-chip spans. Trafilatura drops bare <span> chips as non-prose, so a
    // fact that lives only in a chip does not survive extraction. Anything that
    // matters on this page has to appear in a sentence somewhere.
    const madeBy = device.manufacturer ? `, made by ${escapeHtml(device.manufacturer)}` : '';
    const catSentence = device.category_label
      ? ` ${escapeHtml(device.model)} is a ${escapeHtml(String(device.category_label).toLowerCase())} device.`
      : '';
    const ssrBody = `<main class="wrap">
      <div class="crumb"><a href="/">SkinDay</a> <span>/</span> <a href="/devices/">Devices</a> <span>/</span> ${escapeHtml(device.model)}</div>
      <h1>${escapeHtml(device.model)}</h1>
      <p class="page-sub">${count
        ? `${count.toLocaleString()} ${count === 1 ? 'clinic' : 'clinics'} in Canada list ${escapeHtml(device.model)}${madeBy} on their own website.${catSentence}`
        : `No clinics in our directory currently list ${escapeHtml(device.model)}${madeBy}.${catSentence}`}</p>
      <table class="ssr-table">
        <thead><tr><th>Clinic</th><th>Location</th><th>Rating</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${provinceBlock}
      ${siblingBlock}
    </main>`;

    // ItemList rather than a fake Product: the page is a list of clinics, and
    // claiming otherwise in structured data is the kind of thing that earns a
    // manual action.
    const jsonLd = count ? {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: `Canadian clinics with ${device.model}`,
      numberOfItems: count,
      itemListElement: clinics.slice(0, 50).map((c, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: `${SITE}/clinic/${c.slug || ''}`,
        name: c.name,
      })),
    } : null;

    const indexable = count >= MIN_CLINICS_TO_INDEX;
    const rendered = patchTemplate(loadTemplate(), { title, desc, url, indexable, ssrBody, jsonLd });

    console.log(`render-devices slug=${slug} clinics=${count} indexable=${indexable} ssr_present=${rendered.includes('id="ssr-content"')}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=300', 'Netlify-CDN-Cache-Control': CDN_CACHE },
      body: rendered,
    };

  } catch (e) {
    // 503, never 500. Search Console records a 500 as a server error against
    // the whole site; a 503 reads as "come back later" and is not held against
    // the domain. Same call render-clinic.js makes.
    console.error('render-devices failed', e);
    return errorPage(503, 'Temporarily unavailable', 'Please try again shortly, or <a href="/">browse clinics on SkinDay</a>.');
  }
};
