// Nourish & Flow — static site builder.
// Reads content from Airtable (or data/seed.json when no credentials), outputs ./dist
import { mkdir, rm, writeFile, readFile, cp } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DIST = path.join(ROOT, 'dist');
const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE = process.env.AIRTABLE_BASE_ID;

let sharp = null;
try { sharp = (await import('sharp')).default; } catch { console.warn('! sharp not installed: images will be copied as-is'); }

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (s) => String(s ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p>${esc(p).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`).join('');
const plain = (s) => String(s ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const idr = (n) => 'Rp ' + Number(n).toLocaleString('id-ID');
const camel = (k) => k.trim().split(/[\s_-]+/).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
const byOrder = (a, b) => (a.order ?? 999) - (b.order ?? 999);
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Makassar' });
const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Makassar' });
const jsonLd = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;

/* ---------- data ---------- */
const seed = JSON.parse(await readFile(path.join(ROOT, 'data/seed.json'), 'utf8'));

async function fetchTable(name) {
  const records = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(name)}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (r.status === 404) { console.warn(`! Airtable table "${name}" not found, skipped`); return []; }
    if (!r.ok) throw new Error(`Airtable "${name}" failed: ${r.status} ${await r.text()}`);
    const j = await r.json();
    for (const rec of j.records) {
      const o = {};
      for (const [k, v] of Object.entries(rec.fields)) o[camel(k)] = v;
      records.push(o);
    }
    offset = j.offset;
  } while (offset);
  return records;
}

async function loadData() {
  if (!TOKEN || !BASE) {
    console.warn('! AIRTABLE_TOKEN / AIRTABLE_BASE_ID not set: using data/seed.json');
    return structuredClone(seed);
  }
  const names = ['Settings', 'Services', 'Events', 'Products', 'Reels', 'Team', 'Gallery'];
  const [settingsRows, services, events, products, reels, team, gallery] = await Promise.all(names.map(fetchTable));
  const settings = { ...seed.settings };
  for (const r of settingsRows) {
    if (!r.key) continue;
    const v = Array.isArray(r.image) && r.image.length ? r.image : r.value;
    if (v !== undefined && v !== '') settings[r.key.trim()] = v;
  }
  return { settings, services, events, products, reels, team, gallery };
}

/* ---------- images ---------- */
await rm(DIST, { recursive: true, force: true });
await mkdir(path.join(DIST, 'img'), { recursive: true });
const imgCache = new Map();

async function prepareImage(att) {
  const a = Array.isArray(att) ? att[0] : att;
  if (!a) return null;
  if (typeof a === 'string') return a.trim() ? { src: a.trim(), og: a.trim() } : null;
  if (!a.url) return null;
  const key = a.id || a.url;
  if (imgCache.has(key)) return imgCache.get(key);
  let result = null;
  try {
    const res = await fetch(a.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const id = crypto.createHash('md5').update(String(key)).digest('hex').slice(0, 10);
    if (sharp) {
      const variants = [];
      for (const w of [640, 1280, 1920]) {
        const file = `${id}-${w}.webp`;
        const info = await sharp(buf).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 78 }).toFile(path.join(DIST, 'img', file));
        if (variants.some((v) => v.width === info.width)) { continue; }
        variants.push({ file, width: info.width, height: info.height });
        if (info.width < w) break;
      }
      const mid = variants.find((v) => v.width >= 1000) || variants[variants.length - 1];
      result = {
        src: `/img/${mid.file}`,
        srcset: variants.map((v) => `/img/${v.file} ${v.width}w`).join(', '),
        width: mid.width, height: mid.height, og: `/img/${mid.file}`,
      };
    } else {
      const ext = path.extname(a.filename || '') || '.jpg';
      const file = `${id}${ext}`;
      await writeFile(path.join(DIST, 'img', file), buf);
      result = { src: `/img/${file}`, width: a.width, height: a.height, og: `/img/${file}` };
    }
  } catch (e) {
    console.warn(`! image failed (${a.filename || a.url}): ${e.message}`);
  }
  imgCache.set(key, result);
  return result;
}

async function resolveImages(data) {
  for (const [k, v] of Object.entries(data.settings)) {
    if ((Array.isArray(v) && v[0]?.url) || (typeof v === 'string' && /^(\/img\/|https?:\/\/.+\.(jpe?g|png|webp))/i.test(v) && /image$/i.test(k))) {
      data.settings[k] = await prepareImage(v);
    } else if (/image$/i.test(k)) {
      data.settings[k] = null;
    }
  }
  for (const col of ['services', 'events', 'products', 'team', 'gallery']) {
    for (const it of data[col]) {
      it.image = await prepareImage(it.image || it.photo);
    }
  }
}

/* ---------- load + normalise ---------- */
const data = await loadData();
await resolveImages(data);
const S = data.settings;
const s = (k) => (typeof S[k] === 'string' ? S[k] : '');
const SITE = (process.env.SITE_URL || s('siteUrl') || 'https://hi-kreasidigital.github.io/nourish-flow')
  .trim().replace(/^http:\/\//, 'https://').replace(/\/$/, '');
const HOST = new URL(SITE).host;
// GitHub Pages project sites live under a sub-path (e.g. /nourish-flow). Prefix every root-relative
// link/asset with it. With a custom domain the path is empty and nothing changes.
const BASE_PATH = new URL(SITE).pathname.replace(/\/$/, '');
const rebase = (html) => (!BASE_PATH ? html : html
  .replace(/(href|src)="\/(?!\/)/g, `$1="${BASE_PATH}/`)
  .replace(/srcset="([^"]*)"/g, (_, v) => `srcset="${v.split(', ').map((c) => (c.startsWith('/') ? BASE_PATH + c : c)).join(', ')}"`));

const services = data.services.filter((x) => x.published && x.name).map((x) => ({
  ...x, slug: x.slug || plain(x.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  cat: /plate/i.test(x.category || '') ? 'plate' : 'body',
})).sort(byOrder);
const events = data.events.filter((x) => x.published && x.title)
  .filter((x) => !x.date || String(x.date).slice(0, 10) >= today)
  .sort((a, b) => (a.date && b.date ? String(a.date).localeCompare(String(b.date)) : a.date ? -1 : b.date ? 1 : byOrder(a, b)));
const products = data.products.filter((x) => x.published && x.name).map((x) => ({
  ...x, slug: x.slug || plain(x.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
})).sort(byOrder);
const reels = data.reels.filter((x) => x.published && x.url).sort(byOrder);
const team = data.team.filter((x) => x.published !== false && x.name).sort(byOrder);
const gallery = data.gallery.filter((x) => x.published && x.image).sort(byOrder);

const bodyServices = services.filter((x) => x.cat === 'body');
const plateServices = services.filter((x) => x.cat === 'plate');
const svcUrl = (x) => `/for-your-${x.cat}/${x.slug}/`;

/* ---------- links / CTAs ---------- */
const waNumber = s('whatsappNumber').replace(/\D/g, '');
const wa = (msg) => (waNumber ? `https://wa.me/${waNumber}?text=${encodeURIComponent(msg || s('whatsappMessage'))}` : '/connect/');
function cta(item, label, subject) {
  const type = String(item.ctaType || 'WhatsApp').toLowerCase();
  const l = item.ctaLabel || label;
  if (type === 'link' && (item.ctaUrl || item.orderUrl)) return { href: item.ctaUrl || item.orderUrl, label: l, external: /^https?:/.test(item.ctaUrl || item.orderUrl) };
  if (type === 'form') return { href: '/book-and-shop/#booking', label: l };
  return { href: wa(`Hi Nourish & Flow! ${l}: ${subject}`), label: l, external: !!waNumber };
}
const btn = (c, cls = '') => `<a class="btn ${cls}" href="${esc(c.href)}"${c.external ? ' target="_blank" rel="noopener"' : ''}>${esc(c.label)}</a>`;

/* ---------- html pieces ---------- */
function pic(p, alt, { sizes = '(min-width: 900px) 33vw, 100vw', eager = false } = {}) {
  if (!p) return `<div class="ph" role="img" aria-label="${esc(alt)}"></div>`;
  return `<img src="${esc(p.src)}"${p.srcset ? ` srcset="${esc(p.srcset)}" sizes="${sizes}"` : ''}${p.width ? ` width="${p.width}" height="${p.height}"` : ''} alt="${esc(alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`;
}
const price = (x) => (x.price ? `<p class="price">${x.priceNote && /from/i.test(x.priceNote) ? esc(x.priceNote) + ' ' : ''}${idr(x.price)}${x.priceNote && !/from/i.test(x.priceNote) ? ` <span>/ ${esc(x.priceNote.replace(/^per\s+/i, ''))}</span>` : ''}</p>` : x.priceNote ? `<p class="price"><span>${esc(x.priceNote)}</span></p>` : '');

const serviceCard = (x, primary = false) => `<article class="card">
  <a class="card-img" href="${svcUrl(x)}" tabindex="-1" aria-hidden="true">${pic(x.image, x.name)}</a>
  <div class="card-body">
    <h3><a href="${svcUrl(x)}">${esc(x.name)}</a></h3>
    <p>${esc(x.shortDescription)}</p>
    ${price(x)}
    ${btn(cta(x, 'Book now', x.name), primary ? 'btn-primary' : 'btn-ghost')}
  </div></article>`;

const eventCard = (x) => `<article class="card card-event">
  <div class="card-img">${pic(x.image, x.title, { sizes: '(min-width: 900px) 50vw, 100vw' })}</div>
  <div class="card-body">
    ${x.type ? `<p class="kicker">${esc(x.type)}</p>` : ''}
    <h3>${esc(x.title)}</h3>
    <p class="meta">${x.date ? `<time datetime="${esc(String(x.date).slice(0, 10))}">${fmtDate(x.date)}</time>` : 'Dates announced soon'}${x.location ? ` · ${esc(x.location)}` : ''}</p>
    <p>${esc(x.description)}</p>
    ${x.price ? `<p class="price">${idr(x.price)}</p>` : ''}
    ${btn(cta(x, 'Get tickets', x.title), 'btn-ghost')}
  </div></article>`;

const productCard = (x) => {
  const c = cta({ ...x, ctaType: x.orderUrl ? 'Link' : 'WhatsApp' }, 'Order now', x.name);
  return `<article class="card">
  <div class="card-img">${pic(x.image, x.name)}</div>
  <div class="card-body"><h3>${esc(x.name)}</h3><p>${esc(x.description)}</p>${price(x)}
  ${x.soldOut ? '<span class="btn btn-ghost is-disabled" aria-disabled="true">Sold out</span>' : btn(c, 'btn-ghost')}</div></article>`;
};

function reelUrl(u) { try { const x = new URL(u); return `https://www.instagram.com${x.pathname.replace(/\/?$/, '/')}`; } catch { return null; } }
const reelsSection = (title = s('reelsTitle')) => {
  const list = reels.map((r) => ({ ...r, u: reelUrl(r.url) })).filter((r) => r.u);
  if (!list.length) return '';
  return `<section class="section reels"><div class="wrap"><h2 class="display">${esc(title)}</h2><div class="reel-grid">${list.map((r) =>
    `<div class="reel"><blockquote class="instagram-media" data-instgrm-permalink="${esc(r.u)}" data-instgrm-version="14"><a href="${esc(r.u)}">${esc(r.title || 'View on Instagram')}</a></blockquote></div>`).join('')}</div></div></section>`;
};

const NAV = [['Home', '/'], ['About', '/about/'], ['For Your Body', '/for-your-body/'], ['For Your Plate', '/for-your-plate/'], ['Book & Shop', '/book-and-shop/'], ['Connect', '/connect/']];
const socials = [['Instagram', 'instagramUrl'], ['Facebook', 'facebookUrl'], ['YouTube', 'youtubeUrl'], ['TikTok', 'tiktokUrl']].filter(([, k]) => s(k));

const orgSchema = () => ({
  '@context': 'https://schema.org',
  '@type': ['LocalBusiness', 'SportsActivityLocation'],
  '@id': `${SITE}/#org`,
  name: s('siteName') + ' Bali',
  url: SITE,
  description: s('metaDescription'),
  email: s('email'),
  ...(waNumber ? { telephone: '+' + waNumber } : {}),
  address: { '@type': 'PostalAddress', ...(s('street') ? { streetAddress: s('street') } : {}), addressLocality: s('city'), addressRegion: s('region'), addressCountry: s('country') },
  areaServed: 'Bali, Indonesia',
  ...(socials.length ? { sameAs: socials.map(([, k]) => s(k)) } : {}),
  ...(team.length ? { founder: team.map((t) => ({ '@type': 'Person', name: t.name, jobTitle: t.role })) } : {}),
});

const crumbs = (items) => ({
  '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, item: SITE + p })),
});

function layout({ title, description, pathname, body, image, schema = [], noindex = false }) {
  const url = SITE + pathname;
  const og = image ? SITE + image.og : '';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
${noindex ? '<meta name="robots" content="noindex">' : '<meta name="robots" content="index, follow, max-image-preview:large">'}
<meta name="theme-color" content="#253C57">
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(s('siteName'))} Bali">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${url}">
${og ? `<meta property="og:image" content="${og}">` : ''}
<meta name="twitter:card" content="${og ? 'summary_large_image' : 'summary'}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap">
<link rel="stylesheet" href="/assets/styles.css">
${schema.map(jsonLd).join('\n')}
</head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header"><div class="header-in">
  <a class="brand" href="/">Nourish &amp; Flow</a>
  <button class="nav-toggle" aria-expanded="false" aria-controls="site-nav" aria-label="Menu"><span></span><span></span></button>
  <nav id="site-nav" aria-label="Main">${NAV.map(([l, h]) => `<a href="${h}"${pathname === h || (h !== '/' && pathname.startsWith(h)) ? ' aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</nav>
</div></header>
<main id="main">${body}</main>
<footer class="site-footer"><div class="wrap">
  <div class="foot-grid">
    <div><p class="foot-brand">${esc(s('siteName'))} Bali</p><p>${esc(s('email')) ? `<a href="mailto:${esc(s('email'))}">${esc(s('email'))}</a>` : ''}</p><p>${esc([s('street'), s('city'), s('region')].filter(Boolean).join(', '))} | ${esc(s('tagline'))}</p></div>
    <nav class="foot-nav" aria-label="Footer">${NAV.slice(1).map(([l, h]) => `<a href="${h}">${esc(l)}</a>`).join('')}</nav>
    <div class="foot-soc">${socials.map(([l, k]) => `<a href="${esc(s(k))}" target="_blank" rel="noopener me">${l}</a>`).join('')}</div>
  </div>
  <div class="foot-base"><span>© ${new Date().getFullYear()} ${esc(s('siteName'))}</span>${s('creditUrl') ? `<a class="foot-credit" href="${esc(s('creditUrl'))}" target="_blank" rel="noopener">${esc(s('credit'))}</a>` : `<span class="foot-credit">${esc(s('credit'))}</span>`}<span class="foot-tag">${esc(s('footerTag'))}</span></div>
</div></footer>
${waNumber ? `<a class="wa-float" href="${wa()}" target="_blank" rel="noopener" aria-label="Chat on WhatsApp"><svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M16 3C9 3 3.4 8.6 3.4 15.5c0 2.4.7 4.7 1.9 6.600L3.200 29l7.100-2.100a12.600 12.600 0 0 0 5.700 1.400c6.900 0 12.600-5.600 12.600-12.500S22.900 3 16 3Zm0 22.700c-1.800 0-3.600-.5-5.100-1.400l-.4-.2-4.200 1.200 1.300-4.100-.3-.4a10.300 10.300 0 0 1-1.600-5.400C5.700 9.800 10.300 5.300 16 5.300s10.300 4.500 10.300 10.200S21.700 25.700 16 25.700Zm5.700-7.600c-.3-.2-1.800-.9-2.100-1-.3-.1-.5-.2-.7.200-.2.300-.8 1-1 1.200-.2.200-.4.200-.7.100-.3-.2-1.300-.5-2.500-1.500-.9-.8-1.500-1.800-1.700-2.100-.2-.3 0-.5.100-.6l.5-.5c.1-.2.200-.3.300-.5.100-.2 0-.4 0-.5l-1-2.300c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.100-.8.400-.3.300-1.100 1.100-1.100 2.600s1.100 3 1.300 3.200c.2.200 2.200 3.400 5.400 4.700.8.300 1.400.5 1.800.6.800.2 1.400.2 2 .1.600-.1 1.800-.7 2-1.400.3-.7.300-1.300.2-1.400-.1-.1-.3-.2-.6-.4Z"/></svg></a>` : ''}
<script src="/assets/main.js" defer></script>
</body></html>`;
}

/* ---------- pages ---------- */
const pages = [];
const addPage = (pathname, html) => pages.push({ pathname, html });

// HOME
{
  const featured = services.filter((x) => x.featured);
  const offer = (featured.length ? featured : services).slice(0, 3);
  const evs = events.slice(0, 4);
  const body = `
<section class="hero"><div class="wrap center">
  <p class="eyebrow">${esc(s('heroEyebrow'))}</p>
  <h1 class="display hero-title">${esc(s('heroTitle')).replace(/\.\s+/g, '.<br>')}</h1>
  <p class="lead">${esc(s('heroText'))}</p>
  <div class="btn-row">${btn({ href: s('heroCtaUrl') || '/for-your-body/', label: s('heroCtaLabel') }, 'btn-primary')}${btn({ href: s('heroCta2Url') || '/for-your-plate/', label: s('heroCta2Label') }, 'btn-outline')}</div>
</div></section>
<section class="split"><div class="split-text"><h2 class="display">${esc(s('pleasureTitle'))}</h2><p>${esc(s('pleasureText'))}</p></div>
  <div class="split-img">${pic(S.pleasureImage, s('pleasureImageAlt'), { sizes: '(min-width: 900px) 50vw, 100vw' })}</div></section>
<section class="section"><div class="wrap"><h2 class="display">${esc(s('offeringsTitle'))}</h2><p class="lead-left">${esc(s('offeringsIntro'))}</p>
  <div class="grid grid-3">${offer.map((x) => serviceCard(x)).join('')}</div></div></section>
<section class="section blue" id="events"><div class="wrap"><h2 class="display">${esc(s('eventsTitle'))}</h2>
  ${evs.length ? `<div class="grid grid-2">${evs.map(eventCard).join('')}</div>` : `<p>${esc(s('eventsEmpty'))}</p>`}</div></section>
<section class="band-navy"><div class="wrap center"><h2 class="display">${esc(s('bandTitle'))}</h2><p class="upper">${esc(s('bandText'))}</p><a class="btn btn-primary" href="${esc(s('ctaUrl') || '/book-and-shop/')}">${esc(s('ctaLabel'))}</a></div></section>
${gallery.length ? `<section class="mosaic">${gallery.slice(0, 6).map((g) => `<figure>${pic(g.image, g.caption || 'Nourish & Flow Bali', { sizes: '(min-width: 900px) 33vw, 50vw' })}</figure>`).join('')}</section>` : ''}
<div class="marquee" aria-hidden="true"><div class="marquee-in">${Array(4).fill(`<span>${esc(s('marquee'))} • </span>`).join('')}</div></div>
${reelsSection()}`;
  addPage('/', layout({
    title: s('seoHomeTitle'), description: s('metaDescription'), pathname: '/', body,
    image: S.pleasureImage || offer[0]?.image,
    schema: [orgSchema(), { '@context': 'https://schema.org', '@type': 'WebSite', name: s('siteName') + ' Bali', url: SITE }],
  }));
}

// ABOUT
{
  const body = `
<section class="page-head"><div class="wrap"><h1 class="display">${esc(s('aboutTitle'))}</h1><div class="prose big">${md(s('aboutText'))}</div>
  <blockquote class="pull">${esc(s('aboutQuote'))}</blockquote></div></section>
<section class="section"><div class="wrap grid grid-2 team">${team.map((t) => `<article class="person">
  <div class="card-img">${pic(t.image, t.name)}</div>
  <h2>Meet ${esc(t.name)}</h2><p class="kicker">${esc(t.role)}</p><div class="prose">${md(t.bio)}</div></article>`).join('')}</div></section>
<section class="section alt"><div class="wrap narrow"><h2 class="display small">${esc(s('aboutWhyTitle'))}</h2><div class="prose">${md(s('aboutWhyText'))}</div>
  <div class="btn-row">${btn({ href: '/for-your-body/', label: 'For your body' }, 'btn-primary')}${btn({ href: '/for-your-plate/', label: 'For your plate' }, 'btn-outline')}</div></div></section>`;
  addPage('/about/', layout({
    title: s('seoAboutTitle'), description: s('seoAboutDescription'), pathname: '/about/', body,
    image: team[0]?.image,
    schema: [orgSchema(), crumbs([['Home', '/'], ['About', '/about/']])],
  }));
}

// BODY / PLATE listing pages + detail pages
for (const [cat, list] of [['body', bodyServices], ['plate', plateServices]]) {
  const p = `/for-your-${cat}/`;
  const body = `
<section class="page-head"><div class="wrap"><h1 class="display">${esc(s(cat + 'Title'))}</h1><p class="kicker">${esc(s(cat + 'Byline'))}</p><p class="lead-left">${esc(s(cat + 'Intro'))}</p></div></section>
<section class="section"><div class="wrap"><div class="grid grid-3">${list.map((x) => serviceCard(x, true)).join('')}</div></div></section>`;
  addPage(p, layout({
    title: s(cat === 'body' ? 'seoBodyTitle' : 'seoPlateTitle'), description: s(cat === 'body' ? 'seoBodyDescription' : 'seoPlateDescription'), pathname: p, body,
    image: list[0]?.image,
    schema: [orgSchema(), crumbs([['Home', '/'], [s(cat + 'Title'), p]]),
      { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: list.map((x, i) => ({ '@type': 'ListItem', position: i + 1, url: SITE + svcUrl(x), name: x.name })) }],
  }));

  for (const x of list) {
    const c = cta(x, 'Book now', x.name);
    const related = list.filter((y) => y !== x).slice(0, 3);
    const dBody = `
<section class="page-head"><div class="wrap"><nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <a href="${p}">${esc(s(cat + 'Title'))}</a> / <span>${esc(x.name)}</span></nav>
  <h1 class="display">${esc(x.name)}</h1></div></section>
<section class="section"><div class="wrap grid grid-2 detail">
  <div class="card-img tall">${pic(x.image, x.name, { sizes: '(min-width: 900px) 50vw, 100vw', eager: true })}</div>
  <div><div class="prose big">${md(x.description)}</div>
    <ul class="facts">${x.instructor ? `<li><strong>With</strong> ${esc(x.instructor)}</li>` : ''}${x.level ? `<li><strong>Level</strong> ${esc(x.level)}</li>` : ''}${x.duration ? `<li><strong>Duration</strong> ${esc(x.duration)}</li>` : ''}</ul>
    ${price(x)}${btn(c, 'btn-primary')}</div></div></section>
${related.length ? `<section class="section alt"><div class="wrap"><h2 class="display small">More ${cat === 'body' ? 'for your body' : 'for your plate'}</h2><div class="grid grid-3">${related.map((x) => serviceCard(x)).join('')}</div></div></section>` : ''}`;
    const offer = x.price ? { offers: { '@type': 'Offer', price: x.price, priceCurrency: 'IDR', availability: 'https://schema.org/InStock', url: SITE + svcUrl(x) } } : {};
    addPage(svcUrl(x), layout({
      title: x.seoTitle || `${x.name} in Bali | ${s('siteName')}`, description: x.seoDescription || plain(x.shortDescription), pathname: svcUrl(x), body: dBody, image: x.image,
      schema: [crumbs([['Home', '/'], [s(cat + 'Title'), p], [x.name, svcUrl(x)]]),
        { '@context': 'https://schema.org', '@type': 'Service', name: x.name, description: plain(x.shortDescription), url: SITE + svcUrl(x), areaServed: 'Bali, Indonesia', provider: { '@id': `${SITE}/#org` }, ...(x.image ? { image: SITE + x.image.og } : {}), ...offer },
        orgSchema()],
    }));
  }
}

// BOOK & SHOP
{
  const body = `
<section class="page-head"><div class="wrap"><h1 class="display">${esc(s('shopTitle'))}</h1><p class="lead-left">${esc(s('shopIntro'))}</p></div></section>
<section class="section" id="booking"><div class="wrap"><h2 class="display small">${esc(s('bookingTitle'))}</h2>
  <ul class="book-list">${services.map((x) => `<li><div><h3><a href="${svcUrl(x)}">${esc(x.name)}</a></h3><p>${esc(x.shortDescription)}</p></div><div class="book-act">${price(x)}${btn(cta(x, 'Book now', x.name), 'btn-primary')}</div></li>`).join('')}</ul>
  ${s('bookingFormUrl') ? `<h3 class="form-title">${esc(s('bookingFormTitle'))}</h3><iframe class="embed-form" src="${esc(s('bookingFormUrl'))}" title="${esc(s('bookingFormTitle'))}" loading="lazy"></iframe>` : ''}</div></section>
<section class="section alt" id="shop"><div class="wrap"><h2 class="display small">${esc(s('shopProductsTitle'))}</h2>
  ${products.length ? `<div class="grid grid-3">${products.map(productCard).join('')}</div>` : `<p>${esc(s('shopEmpty'))}</p>`}</div></section>`;
  addPage('/book-and-shop/', layout({
    title: s('seoShopTitle'), description: s('seoShopDescription'), pathname: '/book-and-shop/', body, image: products[0]?.image || services[0]?.image,
    schema: [orgSchema(), crumbs([['Home', '/'], ['Book & Shop', '/book-and-shop/']]),
      ...products.map((x) => ({ '@context': 'https://schema.org', '@type': 'Product', name: x.name, description: plain(x.description), ...(x.image ? { image: SITE + x.image.og } : {}),
        ...(x.price ? { offers: { '@type': 'Offer', price: x.price, priceCurrency: 'IDR', availability: x.soldOut ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock', url: SITE + '/book-and-shop/#shop' } } : {}) })),
      ...events.filter((e) => e.date).map((e) => ({ '@context': 'https://schema.org', '@type': 'Event', name: e.title, description: plain(e.description), startDate: String(e.date), eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode', location: { '@type': 'Place', name: e.location || s('city') + ', ' + s('region'), address: { '@type': 'PostalAddress', addressLocality: s('city'), addressRegion: s('region'), addressCountry: s('country') } }, organizer: { '@id': `${SITE}/#org` } }))],
  }));
}

// CONNECT
{
  const body = `
<section class="page-head"><div class="wrap"><h1 class="display">${esc(s('connectTitle'))}</h1><p class="lead-left">${esc(s('connectIntro'))}</p><blockquote class="pull">${esc(s('connectQuote'))}</blockquote></div></section>
<section class="section"><div class="wrap grid grid-2">
  <div><h2 class="display small">Get in touch</h2><p>${esc(s('connectResponse'))}</p>
    <div class="btn-row">${waNumber ? btn({ href: wa(), label: 'Chat on WhatsApp', external: true }, 'btn-primary') : ''}${s('email') ? btn({ href: 'mailto:' + s('email'), label: 'Send an email' }, 'btn-outline') : ''}</div>
    ${socials.length ? `<p class="soc-links">${socials.map(([l, k]) => `<a href="${esc(s(k))}" target="_blank" rel="noopener me">${l}</a>`).join(' · ')}</p>` : ''}
    <h2 class="display small mt">Find us</h2><p>${esc(s('findUsText'))}</p>
    <address>${esc([s('street'), s('city'), s('region')].filter(Boolean).join(', '))}</address></div>
  <div>${s('contactFormUrl') ? `<iframe class="embed-form" src="${esc(s('contactFormUrl'))}" title="Contact form" loading="lazy"></iframe>` : `<p>Prefer a message? Email us at <a href="mailto:${esc(s('email'))}">${esc(s('email'))}</a>.</p>`}
    ${s('mapEmbedUrl') ? `<iframe class="embed-map" src="${esc(s('mapEmbedUrl'))}" title="Map" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>` : ''}</div>
</div></section>
${reelsSection()}`;
  addPage('/connect/', layout({
    title: s('seoConnectTitle'), description: s('seoConnectDescription'), pathname: '/connect/', body,
    schema: [{ ...orgSchema(), '@type': ['LocalBusiness', 'SportsActivityLocation'] }, { '@context': 'https://schema.org', '@type': 'ContactPage', name: s('connectTitle'), url: SITE + '/connect/' }, crumbs([['Home', '/'], ['Connect', '/connect/']])],
  }));
}

/* ---------- write ---------- */
for (const { pathname, html } of pages) {
  const dir = path.join(DIST, pathname);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), rebase(html));
}
await writeFile(path.join(DIST, '404.html'), rebase(layout({
  title: 'Page not found | ' + s('siteName'), description: 'Page not found', pathname: '/404/', noindex: true,
  body: `<section class="page-head"><div class="wrap center"><h1 class="display">Lost the flow?</h1><p class="lead">That page doesn't exist. Let's get you back.</p><a class="btn btn-primary" href="/">Back home</a></div></section>`,
})));
await mkdir(path.join(DIST, 'assets'), { recursive: true });
await cp(path.join(ROOT, 'src'), path.join(DIST, 'assets'), { recursive: true });
await writeFile(path.join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `  <url><loc>${SITE}${p.pathname}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`);
await writeFile(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
// CNAME only for a custom domain (never for *.github.io)
if (!HOST.endsWith('github.io')) await writeFile(path.join(DIST, 'CNAME'), HOST + '\n');
await writeFile(path.join(DIST, '.nojekyll'), '');

if (!waNumber) console.warn('! whatsappNumber is empty: WhatsApp buttons fall back to /connect/');
console.log(`Built ${pages.length} pages + 404 → dist/ (${TOKEN && BASE ? 'Airtable' : 'seed'} data)`);
