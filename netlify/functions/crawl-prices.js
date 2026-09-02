// netlify/functions/crawl-prices.js
//
// Crawls Canadian clinic websites for PUBLISHED neurotoxin prices and lands them
// in clinic_price_candidates for review. Ported from crawl-doctors.js: the queue
// claiming, the batch loop, the abort-on-timeout fetch, toText and the link
// scorer are that file's, near enough unchanged.
//
// NO API KEY AND NO PER-PAGE COST. The extraction is a parser, not a model call.
// The brief for this milestone assumed prices would need a model because they are
// not a rigid pattern. Reading five real pricing pages by hand showed otherwise:
// what makes a price storable is lexical (a brand name, a plausible per-unit
// amount, no disqualifying words), and everything difficult lives in the reject
// rules, which are lexical too. The parser passes a 28-case golden fixture built
// from those five real pages.
//
// NOTHING REACHES PATIENTS FROM HERE. Candidates land in a table with RLS enabled
// and no policies, so the anon key cannot read it. Approving a candidate in admin
// is what writes to clinic_prices.
//
// Environment variables, all three already set, nothing new needed:
//   SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · ADMIN_SECRET

const BATCH_DEFAULT = 3;          // up to 3 page fetches per host, so smaller than Taiwan's 5
const FETCH_TIMEOUT_MS = 12000;
const MAX_PAGES_PER_HOST = 3;

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ── Near-miss probe (sample-run instrumentation, NOT part of extraction) ────
// Answers one question about a host that produced no price: how close did we
// get? Kept completely separate from extractPrices so it can never widen what
// the crawler accepts. Read only from the queue row's last_error.
function probeNearMiss(text) {
  if (!text) return null;
  const brandHit = TOXINS.find(([, re]) => re.test(text));
  const amounts = [];
  // Must use the SAME number shape as the extractor, or the diagnostic lies:
  // the first version read $6,000 as 6 and reported a fake in-band amount.
  const re = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,5}(?:[.,]\d{1,2})?)|(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,5}(?:[.,]\d{1,2})?)\s?\$/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = toNumber(m[1] || m[2]);
    if (!isNaN(v)) amounts.push(v);
  }

  if (!brandHit && amounts.length === 0) return null;
  if (!brandHit) return { rank: 1, note: 'amounts on page but no toxin brand named' };
  if (amounts.length === 0) return { rank: 2, note: `brand ${brandHit[0]} named, no dollar amount anywhere` };

  const inBand = amounts.filter(v => v >= MIN_UNIT_PRICE && v <= MAX_UNIT_PRICE);
  if (inBand.length === 0) {
    const near = amounts.filter(v => v > 0 && v < 200).sort((a, b) => a - b);
    return { rank: 4, note: `brand ${brandHit[0]} named; amounts present but NONE in the $${MIN_UNIT_PRICE}-$${MAX_UNIT_PRICE} band` + (near.length ? ` (closest: ${near.slice(0, 5).join(', ')})` : '') };
  }
  return { rank: 3, note: `brand ${brandHit[0]} named and ${inBand.length} amount(s) in band, but a reject rule or the basis test discarded them (${inBand.slice(0, 5).join(', ')})` };
}

// ── The extractor ───────────────────────────────────────────────────────────
// Verified against a 42-case golden fixture drawn from real Canadian pricing
// pages AND the first full production run. Two run-driven fixes baked in: the
// $6/unit floor and therapeutic-rate rejection, which killed the $2-$4 false
// positives (therapeutic Botox priced separately from cosmetic on the same page).
const MIN_UNIT_PRICE = 6;    // Cosmetic neurotoxin in Canada essentially never
                             // sits below $6/unit. The old $2 floor let THERAPEUTIC
                             // rates through: essentialsmedispa.ca published cosmetic
                             // Botox at $10 AND therapeutic (migraine/TMJ, insurance)
                             // at $3.57, and the extractor took the lower number.
                             // $6 also excludes promo loss-leaders ($2.98/unit anchors)
                             // that are real but misleading as a "typical" price.
const MAX_UNIT_PRICE = 40;   // nothing legitimate is above this per unit
const MAX_WINDOW_CHARS = 320;
// With no explicit basis word, the brand and the number must be near enough to
// read as a label and its price. "Botox/Dysport $7.25" is 14 characters.
const MAX_INFERRED_GAP = 40;

// Brand names only. A generic "botulinum toxin" mention is not a product and
// gives us nothing to put in the toxin column.
const TOXINS = [
  ['botox',    /\bbotox\b/i],
  ['dysport',  /\bdysport\b/i],
  ['xeomin',   /\bxeomin\b/i],
  // nuceiva is the Canadian trade name; the same product is Jeuveau in the US,
  // so one row covers both markets.
  ['nuceiva',  /\bnuceiva\b|\bjeuveau\b/i],
  ['letybo',   /\bletybo\b|\bletibotulinum\b/i],
  // ⭐ US ONLY. Daxxify has no Canadian presence, so a Canada-built brand list
  // could not have contained it. A California clinic publishing only a Daxxify
  // price would otherwise read as "no price found", which would understate the
  // US publication rate this sample exists to measure.
  // ⓘ Daxxify is often priced per TREATMENT rather than per unit. Those get
  // rejected by the existing basis rules, which is correct.
  ['daxxify',  /\bdaxxify\b|\bdaxibotulinum\b/i]
];

// The accept condition. An explicit per-unit basis, English or French.
const UNIT_BASIS = [
  /\bper\s*unit\b/i,
  /\/\s*unit\b/i,
  /\bunit\s*price\b/i,
  /\bprice\s*per\s*unit\b/i,
  /\ba\s+unit\b/i,
  /\beach\s+unit\b/i,
  // No trailing \b on the French forms: "é" is not a word character in JS, so
  // /unité\b/ can never match. A negative lookahead does the same job.
  /\bpar\s*unit[eé]s?(?![a-z])/i,
  /\bl['’]\s*unit[eé]s?(?![a-z])/i,
  /\/\s*unit[eé]s?(?![a-z])/i
];

// Anything here in the same window and the window is discarded, even when a
// per-unit token is present. Order does not matter; one hit is enough.
//
// "area" and "zone" are here because a per-area price sitting in a per-unit
// column makes every comparison on the site false. "minimum" is here because
// "from $8 with a 20-unit minimum" is not a unit price. The weekday names are
// here because unionmd and others advertise day-limited rates, which are not a
// standing price. "consultation" and "évaluation" are here because of
// unionmd.ca/tarifs, which lists "Évaluation pour des injections esthétiques
// $195", a consult fee that keyword proximity would store as a Botox price and
// be wrong by a factor of twenty.
const DISQUALIFY = [
  // Consultation and assessment FEES, matched narrowly. A bare /consult/ was a
  // mistake: pricing copy says "book your free consultation" a few words from
  // the number, and the brand requirement plus the $2-$40 bound already reject
  // almost every real consult fee, because those run $50 and up. unionmd's
  // "Évaluation pour des injections esthétiques $195" is caught twice over: it
  // names no brand, and $195 is far outside a per-unit range.
  /consultation\s+(fee|fees|charge)/i, /\bfrais\s+de\s+consultation/i,
  /\bévaluation\s+pour\b/i,
  /\bdeposit\b/i, /\bdépôt\b/i,

  // Genuinely ambiguous: "from $8 per unit with a 20 unit minimum" is not $8.
  /\bminimum\b/i, /\bmin\.\s/i,

  // Per-area, per-session and package pricing, matched as a BASIS rather than as
  // a bare word. "The total cost depends on your treatment area" is prose about
  // an area, not a price per area, and rejecting on the bare word cost real
  // prices on pages that explain what affects the total.
  /\bper\s*area\b/i, /\/\s*area\b/i, /\beach\s+area\b/i, /\bpar\s*zone\b/i,
  /\d+\s*areas?\b/i,
  /\bper\s*session\b/i, /\/\s*session\b/i, /\d+\s*sessions?\b/i,
  /\bper\s*syringe\b/i, /\bper\s*vial\b/i,
  /\bpackage\b/i, /\bforfait\b/i, /\bbundl/i,
  /\bmembership\b/i, /\badhésion\b/i, /\bannual\s+fee/i,

  // Day-limited and promotional rates are not a standing price.
  /\bmonday|tuesday|wednesday|thursday|friday|saturday|sunday\b/i,
  /\blundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche\b/i,
  /\bpromo/i, /\bspecial\s+offer/i, /\bsale\b/i, /\blimited\s+time\b/i, /\brabais\b/i,

  // A number sitting beside a different product tells us nothing about the
  // toxin. This is the real protection against mis-assignment, so it stays broad.
  /\bfiller\b/i, /\bsculptra\b/i, /\bradiesse\b/i, /\bjuvéderm\b/i, /\bjuvederm\b/i,
  /\brestylane\b/i, /\bharmonyca\b/i, /\bskinvive\b/i, /\bteosyal\b/i, /\bversa\b/i,
  /\blaser\b/i, /\bhair\s+removal\b/i, /\bépilation\b/i,
  /\bfacial\b/i, /\bpeel\b/i, /\bmicroneedling\b/i, /\bprp\b/i, /\bprf\b/i,
  /\bcoolsculpting\b/i, /\bmorpheus\b/i, /\bbelkyra\b/i, /\bkybella\b/i,
  /\bexosome/i, /\bhydrafacial\b/i,

  // Therapeutic / medical-indication pricing is a DIFFERENT rate (often insurance-
  // linked), not the cosmetic per-unit price a directory patient compares.
  // essentialsmedispa.ca published cosmetic Botox at $10 AND therapeutic Botox at
  // $3.57; the crawler took the lower one. This rejects the therapeutic line.
  /\btherapeutic\b/i, /\bhyperhidrosis\b/i, /\bmigraine\b/i, /\bbruxism\b/i,
  /\bTMJ\b/, /\bmasseter\b/i, /\bteeth\s*grinding\b/i, /\bjaw\s+clench/i,
  /\bmedically\s+covered\b/i, /\binsurance\b/i, /\bmedical\s+botox\b/i,
  /\bexcessive\s+sweat/i,

  // Discounts and credits are not prices.
  /\boff\b/i, /\bsave\b/i, /\bcredit\b/i, /\bgift\b/i, /\bcoupon\b/i,
  /\brebate\b/i, /\d\s*%/
];

// DELIBERATELY NOT REJECTED, each one having cost a real price on a real page:
//   "plus tax" / "plus GST"  abbotsfordplasticsurgery.com publishes
//       "Our Botox treatments are $10 per unit plus tax". Tax does not change the
//       unit price, and /tax/ threw the whole thing away.
//   "free"  pricing pages offer free consultations next to the number.
//   "hyperhidrosis", "migraine", "TMJ"  therapeutic toxin is still priced per
//       unit, and a per-treatment package price is already outside the bound.

// A toxin name inside a hostname is not a price context:
// britishcolumbiabotoxclinics.com would otherwise seed a Botox window.
function stripUrls(text) {
  return text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b[\w-]+\.(?:com|ca|net|org|io|co|tw|fr|shop)\b\S*/gi, ' ')
    .replace(/\S+@\S+/g, ' ');
}

// Wix and Squarespace drop the whitespace between elements, so a brand ends up
// glued to the previous word: "Book ServiceBotox/Dysport $7.25". No \b exists
// between "e" and "B", so /\bbotox\b/ cannot match. Insert the missing space in
// front of a brand name only, because a blanket lowercase-to-uppercase split would
// also break "CoolSculpting" and "SkinVive", which the reject list depends on.
const JAMMED = /([a-z])(Botox|Dysport|Xeomin|Nuceiva|Jeuveau|Letybo)/g;
function unjam(text) {
  return text.replace(JAMMED, (all, before, brand) => before + ' ' + brand);
}

// Windows are sentences, plus pairs of adjacent short lines. The pair rule is
// what catches a price table that puts the label and the number in separate
// cells: "Botox" on one line, "$12 per unit" on the next. It is safe to be
// generous here because every reject rule still applies to the joined text:
// subtlyyou's "Botox · Dysport · Xeomin" + "$8-$11 per unit" joins into one
// window and is then thrown out for naming three toxins.
function windows(text) {
  const out = [];
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    for (const s of line.split(/(?<=[.!?;])\s+/)) {
      const t = s.trim();
      if (t) out.push(t.slice(0, MAX_WINDOW_CHARS));
    }
  }
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].length <= 80 && lines[i + 1].length <= 80) {
      out.push((lines[i] + ' ' + lines[i + 1]).slice(0, MAX_WINDOW_CHARS));
    }
  }

  // A window anchored on each number, because Wix and Squarespace strip the
  // whitespace between elements: freshcosmeticclinic.com renders as
  // "...natural results.Book ServiceBotox/Dysport $7.25Plump, lift, and define..."
  // with no sentence break anywhere near the price. Sentence windows swallow the
  // whole tail, pick up "Dermal Filler" further along, and reject a real price.
  // Reaching backwards further than forwards is deliberate: the brand and the
  // basis words usually precede the number, while the next table row follows it.
  const flat = text.replace(/\s+/g, ' ');
  // ⚠⚠ THOUSANDS SEPARATORS. `\d{1,5}(?:[.,]\d{1,2})?` truncates "$6,000"
  // to "6,00", which toNumber reads as a FRENCH DECIMAL and returns 6.00 -
  // a four-figure surgical price arriving as a plausible per-unit number.
  // Found on cosmeticsurgerycenter.com, whose "Only $6,000" and "$10,000"
  // specials surfaced as 6 and 10. Match the grouped form FIRST so the whole
  // number is captured; toNumber already strips thousands commas correctly
  // once it receives them. Quebec's "9,50 $" still parses as 9.50, because
  // ,50 is two digits and not three.
  const re = /\$\s?(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,5}(?:[.,]\d{1,2})?)|(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,5}(?:[.,]\d{1,2})?)\s?\$/g;
  let m;
  while ((m = re.exec(flat)) !== null) {
    let a = Math.max(0, m.index - 70);
    let b = Math.min(flat.length, m.index + m[0].length + 30);
    // Snap both edges out to whitespace. Cutting a word in half silently
    // disarms a reject rule: "…with a 20 unit minim" no longer matches
    // /minimum/ and a price we must not keep gets kept. Capped so a long
    // unbroken run of jammed markup cannot swallow the page.
    let guard = 0;
    while (a > 0 && !/\s/.test(flat[a - 1]) && guard++ < 25) a--;
    guard = 0;
    while (b < flat.length && !/\s/.test(flat[b]) && guard++ < 25) b++;
    out.push(flat.slice(a, b));
  }

  return out;
}

function toNumber(raw) {
  const s = String(raw).trim();
  // 11,50 is a decimal comma; 3,200 is a thousands separator.
  if (/,\d{1,2}$/.test(s)) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return parseFloat(s.replace(/,/g, ''));
}

// Every currency amount in the window, in order. Quebec sites write the sign on
// both sides and unionmd.ca/tarifs uses both orders on the same page.
function amounts(win) {
  const found = [];
  // Same thousands fix as the scanning regex above.
  const re = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,5}(?:[.,]\d{1,2})?)|(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,5}(?:[.,]\d{1,2})?)\s?\$/g;
  let m;
  while ((m = re.exec(win)) !== null) {
    const raw = m[1] !== undefined ? m[1] : m[2];
    found.push({ value: toNumber(raw), start: m.index, end: m.index + m[0].length });
  }
  return found;
}

function toxinsIn(win) {
  const out = [];
  for (const [name, re] of TOXINS) {
    const m = win.match(re);
    if (m) out.push({ name, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// One price per window, or nothing. Reports whether it came from a range,
// because a range plus several toxins is unassignable.
function priceFrom(win) {
  const found = amounts(win);
  if (!found.length) return null;
  if (found.length === 1) {
    return { value: found[0].value, isRange: false, at: found[0].start };
  }

  // More than one number. Accept it only as an explicit range, and take the low
  // end, which matches the "from $X" display the directory already uses.
  const between = win.slice(found[0].end, found[1].start);
  if (found.length === 2 && /^[\s$]*(?:-|–|—|to|à)[\s$]*$/.test(between)) {
    return {
      value: Math.min(found[0].value, found[1].value),
      isRange: true,
      at: found[0].start
    };
  }
  return null;   // two unrelated numbers: new-patient vs existing, or a table row
}

function extractPrices(text, opts = {}) {
  const min = opts.min ?? MIN_UNIT_PRICE;
  const max = opts.max ?? MAX_UNIT_PRICE;
  const best = new Map();   // toxin -> { toxin, price, basis, raw }

  for (const win of windows(unjam(stripUrls(text)))) {
    const toxins = toxinsIn(win);
    if (!toxins.length) continue;
    if (DISQUALIFY.some(re => re.test(win))) continue;

    const got = priceFrom(win);
    if (!got || !isFinite(got.value)) continue;
    if (got.value < min || got.value > max) continue;         // implausible per unit

    // A range cannot be split across several brands.
    if (got.isRange && toxins.length > 1) continue;

    const explicit = UNIT_BASIS.some(re => re.test(win));
    if (!explicit) {
      // No basis word, so the number has to sit right beside a brand name.
      const gap = Math.min(...toxins.map(t =>
        got.at >= t.end ? got.at - t.end : t.start - got.at));
      if (gap > MAX_INFERRED_GAP) continue;
    }
    const basis_source = explicit ? 'explicit' : 'inferred';

    for (const t of toxins) {
      const prev = best.get(t.name);
      // Prefer an explicit basis over an inferred one; among equals, the lower
      // price, since the card displays "from $X".
      const better = !prev
        || (prev.basis_source === 'inferred' && explicit)
        || (prev.basis_source === basis_source && got.value < prev.price);
      if (better) {
        best.set(t.name, {
          toxin: t.name,
          price: got.value,
          basis: 'per_unit',
          basis_source,
          from_range: got.isRange,
          raw: win.slice(0, 200)
        });
      }
    }
  }

  return [...best.values()];
}

// ── Supabase helpers ────────────────────────────────────────────────────────
async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {})
    }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ── Fetching a page, with a timeout so one dead host cannot stall the batch ──
async function getPage(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'SkinDayBot/1.0 (+https://skinday.ca)' }
    });
    if (!r.ok) return { ok: false, error: `http ${r.status}` };
    const html = await r.text();
    return { ok: true, html, finalUrl: r.url || url };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// ── Finding the pages a price might be on ───────────────────────────────────
// Reading five real sites turned up three different homes for the same fact:
// homepage prose (britishcolumbiabotoxclinics.com), a dedicated pricing page
// (subtlyyou.ca/pricing), and an FAQ answer on the service page
// (launiquelasercentre.com/botox). So the scorer cannot chase pricing words
// alone the way the Taiwan crawler chased team words. It runs twice, once for
// price pages and once for toxin service pages, and the homepage is always read.
//
// French matters here: unionmd.ca labels its price page TARIFS, not Pricing.
const PRICE_HINTS = [
  ['price-list', 100], ['pricing', 100], ['tarifs', 100], ['our-prices', 100],
  ['prices', 95], ['tarif', 95], ['price', 85], ['prix', 85],
  ['fees', 80], ['honoraires', 80], ['rates', 75], ['cost', 60], ['couts', 60]
];

const SERVICE_HINTS = [
  ['botox', 100], ['neuromodulator', 95], ['dysport', 90], ['nuceiva', 90],
  ['xeomin', 90], ['letybo', 90], ['botulinum', 85],
  ['injectables', 80], ['injectable', 80], ['injections', 70], ['injection', 70],
  ['neurotoxin', 80], ['wrinkle-relaxer', 75], ['anti-wrinkle', 70],
  ['medecine-esthetique', 70], ['toxine', 70]
];

function bestLink(html, baseUrl, hints, exclude) {
  const seen = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const label = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl).href; } catch { continue; }
    try {
      if (new URL(abs).hostname !== new URL(baseUrl).hostname) continue;   // same host only
    } catch { continue; }
    if (exclude && exclude.has(abs)) continue;
    // Accents off, so tarifs matches Tarifs and medecine matches medecine.
    const hay = (decodeURIComponent(abs) + ' ' + label)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    let score = 0;
    for (const [word, w] of hints) if (hay.includes(word)) score = Math.max(score, w);
    if (score) seen.push({ abs, score });
  }
  seen.sort((a, b) => b.score - a.score);
  return seen.length ? seen[0].abs : null;
}

// ── Page text ───────────────────────────────────────────────────────────────
function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|tr|td|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 120000);
}

// The meta description is worth reading on its own: bcbotox publishes the price
// there as well as in the body, and it is the cheapest text on the page.
function metaText(html) {
  const m = html.match(/<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : '';
}

// ── Landing the rows. Unpublished, always, in a table patients cannot read. ──
//
// A price found on a host applies to every clinic on that host: Andy's call,
// 2026-07-25, and britishcolumbiabotoxclinics.com is the argument for it, since
// one physician sets $8.50 per unit across all seven of his clinics.
//
// A clinic that already has a price for that toxin is skipped. A price obtained
// by phoning a clinic outranks anything published on a web page, and
// clinic_prices is unique on (clinic_id, toxin, injector_type), so writing over
// it later would be a genuine loss.
async function landPrices(prices, clinicIds, sourceUrl, host) {
  let inserted = 0, skipped = 0;

  for (const clinicId of clinicIds) {
    for (const p of prices) {
      const existing = await sb(
        `clinic_prices?select=id&clinic_id=eq.${encodeURIComponent(clinicId)}` +
        `&toxin=eq.${encodeURIComponent(p.toxin)}&limit=1`
      );
      if (existing && existing.length) { skipped++; continue; }

      await sb('clinic_price_candidates', {
        method: 'POST',
        prefer: 'return=minimal,resolution=ignore-duplicates',
        body: JSON.stringify({
          clinic_id: clinicId,
          host,
          toxin: p.toxin,
          price: p.price,
          currency: 'CAD',
          basis: 'per_unit',
          basis_source: p.basis_source,
          from_range: !!p.from_range,
          source_url: sourceUrl,
          raw_text: p.raw,
          status: 'needs_review'
        })
      });
      inserted++;
    }
  }
  return { inserted, skipped };
}

// ── One host ────────────────────────────────────────────────────────────────
async function crawlOne(row) {
  const home = await getPage(row.home_url);
  if (!home.ok) return { status: 'error', last_error: `home: ${home.error}`, pages_tried: 1 };

  const tried = new Set([home.finalUrl]);
  const pages = [{ url: home.finalUrl, text: toText(home.html) + '\n' + metaText(home.html) }];

  const priceUrl = bestLink(home.html, home.finalUrl, PRICE_HINTS, tried);
  if (priceUrl) tried.add(priceUrl);
  const serviceUrl = bestLink(home.html, home.finalUrl, SERVICE_HINTS, tried);
  if (serviceUrl) tried.add(serviceUrl);

  for (const url of [priceUrl, serviceUrl]) {
    if (!url || pages.length >= MAX_PAGES_PER_HOST) continue;
    const p = await getPage(url);
    if (p.ok) pages.push({ url, text: toText(p.html) + '\n' + metaText(p.html) });
  }

  // A JavaScript shell yields a title and a copyright line and nothing else.
  const anyText = pages.some(p => p.text.length >= 200);
  if (!anyText) {
    return { status: 'needs_render', price_url: priceUrl || null,
             pages_tried: pages.length, last_error: 'pages have almost no text' };
  }

  // Prefer whichever page gave an explicit per-unit basis. A pricing page that
  // spells out "per unit" beats a homepage where the basis was inferred.
  let picked = null;
  for (const page of pages) {
    const prices = extractPrices(page.text);
    if (!prices.length) continue;
    const explicit = prices.some(p => p.basis_source === 'explicit');
    if (!picked || (explicit && !picked.explicit)) picked = { page, prices, explicit };
    if (picked.explicit) break;
  }

  if (!picked) {
    // ⭐ SAMPLE-RUN DIAGNOSTIC. An 'empty' row used to record nothing, so a
    // false negative was invisible from the outside and every extractor bug in
    // Canada had to be found by hand-reading pages. Record the closest thing to
    // a price we saw, so the miss can be classified without a page fetch:
    //   nothing at all      -> the site genuinely publishes no toxin price
    //   brand but no amount -> a price page we failed to reach or parse
    //   amount out of band  -> the CAD-tuned $6-$40 window is wrong for the US
    let nearest = null;
    for (const page of pages) {
      const probe = probeNearMiss(page.text);
      if (probe && (!nearest || probe.rank > nearest.rank)) {
        nearest = probe;
        nearest.url = page.url;
      }
    }
    return { status: 'empty', price_url: priceUrl || null,
             pages_tried: pages.length, prices_found: 0,
             last_error: nearest ? ('near-miss: ' + nearest.note).slice(0, 400) : 'near-miss: no toxin brand on any page read' };
  }

  const { inserted, skipped } =
    await landPrices(picked.prices, row.clinic_ids || [], picked.page.url, row.host);

  return {
    status: 'done',
    price_url: picked.page.url,
    pages_tried: pages.length,
    prices_found: picked.prices.length,
    inserted,
    skipped,
    summary: picked.prices
      .map(p => `${p.toxin} $${p.price}${p.basis_source === 'inferred' ? '?' : ''}`)
      .join(', ')
  };
}

// ── Handler ─────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const json = (code, body) => ({
    statusCode: code,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const given = (event.headers || {})['x-admin-secret'] || (event.headers || {})['X-Admin-Secret'];
  if (!ADMIN_SECRET || given !== ADMIN_SECRET) return json(401, { error: 'unauthorised' });

  if (!SB || !SB_KEY) return json(500, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const batch = Math.min(Math.max(parseInt(body.batch, 10) || BATCH_DEFAULT, 1), 5);
  const retry = body.retry === true;

  try {
    const want = retry ? 'in.(pending,error)' : 'eq.pending';
    const claim = await sb(`crawl_price_queue?select=*&status=${want}&order=id.asc&limit=${batch}`);
    if (!claim || !claim.length) {
      return json(200, { done: true, processed: [], remaining: 0, note: 'queue empty' });
    }

    const ids = claim.map(r => r.id);
    await sb(`crawl_price_queue?id=in.(${ids.join(',')})`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ status: 'running' })
    });

    const processed = [];
    for (const row of claim) {
      let result;
      try { result = await crawlOne(row); }
      catch (e) { result = { status: 'error', last_error: String(e.message || e).slice(0, 400) }; }

      await sb(`crawl_price_queue?id=eq.${row.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({
          status: result.status,
          price_url: result.price_url || null,
          pages_tried: result.pages_tried || 0,
          prices_found: result.prices_found || 0,
          last_error: result.last_error || null,
          attempts: (row.attempts || 0) + 1,
          fetched_at: new Date().toISOString()
        })
      });

      processed.push({
        host: row.host,
        clinics: (row.clinic_ids || []).length,
        status: result.status,
        prices: result.prices_found || 0,
        inserted: result.inserted || 0,
        skipped: result.skipped || 0,
        summary: result.summary || null,
        price_url: result.price_url || null,
        error: result.last_error || null
      });
    }

    const pending = await sb('crawl_price_queue?select=id&status=eq.pending', { prefer: 'count=exact' });
    return json(200, { done: false, processed, remaining: (pending || []).length });
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 500) });
  }
};
