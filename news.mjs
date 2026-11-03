// Récupère les flux, les fusionne avec le cache disque et prépare le JSON servi à l'interface.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { categories } from './sources.mjs';

const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), 'data', 'news.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Vigie/1.0';
const HOUR = 3.6e6;
const KEEP_DAYS = 21;
const PER_CATEGORY = 240; // articles envoyés à l'interface par catégorie
const IMAGE_LOOKUPS_PER_CATEGORY = 60;
// Reddit sans compte : un appel par minute au plus (mesuré), sinon HTTP 429. 3 subreddits par passage, à tour de rôle.
const REDDIT_PER_RUN = 3;
const HOST_DELAY = { 'www.reddit.com': 65000 };
const wait = ms => new Promise(r => setTimeout(r, ms));

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  ndash: '–', mdash: '—', laquo: '«', raquo: '»', euro: '€', deg: '°', oelig: 'œ', eacute: 'é', egrave: 'è', ecirc: 'ê',
  euml: 'ë', agrave: 'à', acirc: 'â', ugrave: 'ù', ucirc: 'û', icirc: 'î', iuml: 'ï', ocirc: 'ô', ccedil: 'ç',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Agrave: 'À', Ccedil: 'Ç',
};

export function decode(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x?[\da-f]+|\w+);/gi, (m, e) => {
    if (e[0] !== '#') return NAMED[e] ?? m;
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

const stripHtml = s => decode(decode(s).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const get = (block, ...names) => {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m) return m[1];
  }
  return '';
};
const attr = (tag, name) => decode(tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] ?? '');

// Le contenu des flux n'est pas fiable : seules les URL http(s) passent, sans paramètres de pistage.
export function cleanUrl(raw, base) {
  try {
    const u = new URL(raw.trim(), base || undefined);
    if (!/^https?:$/.test(u.protocol)) return null;
    for (const k of [...u.searchParams.keys()]) if (/^(utm_\w+|fbclid|gclid|ocid)$/i.test(k)) u.searchParams.delete(k);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function linkOf(block) {
  const orig = get(block, 'feedburner:origLink');
  if (orig) return decode(orig);
  for (const [tag] of block.matchAll(/<link\b[^>]*>/gi)) {
    if (/\brel\s*=\s*["'](self|replies|edit|enclosure|hub)/i.test(tag)) continue;
    const href = attr(tag, 'href');
    if (href) return href;
  }
  return decode(get(block, 'link') || get(block, 'guid'));
}

const BAD_IMAGE = /feedburner|gravatar|avatars\.githubusercontent|wp-smiley|\/emoji\/|stats\.wp|doubleclick|blank\.gif|spacer|pixel\.|1x1|\.svg(\?|$)/i;

function imageOf(block, html, base) {
  const found = [];
  for (const [tag] of block.matchAll(/<(?:media:thumbnail|media:content|enclosure|itunes:image)\b[^>]*>/gi)) {
    const type = attr(tag, 'type');
    if (type && !/image/i.test(type)) continue;
    if (/video|audio/i.test(attr(tag, 'medium'))) continue;
    found.push(attr(tag, 'url') || attr(tag, 'href'));
  }
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    if (/\b(width|height)\s*=\s*["']?[01]["']?(\s|\/|>)/i.test(tag)) continue;
    found.push(attr(tag, 'data-src') || attr(tag, 'src'));
  }
  for (const f of found) {
    const url = f && cleanUrl(f.replace(/^\/\//, 'https://'), base);
    if (url && !BAD_IMAGE.test(url)) return url;
  }
  return null;
}

const PRICE = /(\d[\d\s.,]*\s?€|€\s?\d[\d.,]*|\$\s?\d[\d,.]*|£\s?\d[\d,.]*)/g;

export function parseFeed(xml) {
  const items = [];
  for (const [block] of xml.matchAll(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi)) {
    const url = cleanUrl(linkOf(block));
    if (!url) continue;
    const html = decode(get(block, 'content:encoded', 'content', 'description', 'summary', 'media:description'));
    const summary = stripHtml(html)
      .replace(/The post .* appeared first on .*$/i, '')
      .replace(/L’article .* est apparu en premier sur .*$/i, '')
      .replace(/submitted by \/u\/.*$/i, '')
      .trim();
    const shorten = (s, n) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s);
    // Les posts Bluesky n'ont pas de titre : le début du texte en tient lieu.
    const rawTitle = stripHtml(get(block, 'title'));
    const title = rawTitle || shorten(summary, 110);
    if (!title) continue;
    const ts = Date.parse(decode(get(block, 'pubDate', 'dc:date', 'published', 'updated')).trim());
    const merchant = block.match(/<pepper:merchant\b[^>]*>/i)?.[0];
    items.push({
      title,
      url,
      ts: Number.isFinite(ts) ? ts : null,
      img: imageOf(block, html, url),
      summary: rawTitle && rawTitle !== summary ? shorten(summary, 240) : '',
      price: (merchant && attr(merchant, 'price')) || null,
      merchant: (merchant && attr(merchant, 'name')) || null,
    });
  }
  return items;
}

async function fetchFeed(src, retry = true) {
  const res = await fetch(src.url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status >= 500 && retry) {
    await wait(3000);
    return fetchFeed(src, false);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const head = new TextDecoder('latin1').decode(buf.slice(0, 200));
  const charset = head.match(/encoding=["']([\w-]+)/i)?.[1] ?? res.headers.get('content-type')?.match(/charset=([\w-]+)/i)?.[1] ?? 'utf-8';
  let xml;
  try { xml = new TextDecoder(charset).decode(buf); } catch { xml = new TextDecoder().decode(buf); }
  const items = parseFeed(xml);
  if (!items.length) throw new Error('flux vide ou illisible');
  return items.slice(0, 40);
}

async function pool(list, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => {
    while (i < list.length) await fn(list[i++]);
  }));
}

const NON_PUBLIC = new BlockList(); // couvre aussi les adresses IPv4 mappées en IPv6, quelle que soit leur écriture
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) NON_PUBLIC.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) NON_PUBLIC.addSubnet(net, bits, 'ipv6');
export const isPrivateIp = ip => !isIP(ip) || NON_PUBLIC.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');

// Les liens viennent de flux non fiables : ni réseau interne, ni redirection vers lui.
// shortcut: l'adresse vérifiée peut changer avant la connexion (DNS rebinding), à figer avec un Agent undici si Vigie lit un jour des flux inconnus.
async function fetchPublicPage(url, hops = 3) {
  const { hostname } = new URL(url);
  const addresses = await lookup(hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (addresses.some(a => isPrivateIp(a.address))) return null;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(8000), redirect: 'manual' });
  if (res.status < 300 || res.status >= 400) return res;
  await res.body?.cancel();
  const next = hops > 0 && cleanUrl(res.headers.get('location') ?? '', url);
  return next ? fetchPublicPage(next, hops - 1) : null;
}

// Dernier recours pour illustrer un article : l'image de partage de sa page, sans lire plus de 256 Ko.
async function findOgImage(url) {
  if (/reddit\.com$/.test(new URL(url).hostname)) return null;
  const res = await fetchPublicPage(url);
  if (!res?.ok || !res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  while (html.length < 256 * 1024 && !/<\/head>/i.test(html)) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (/\b(property|name)\s*=\s*["'](og:image|twitter:image)(:src)?["']/i.test(tag)) {
      const img = cleanUrl(attr(tag, 'content'), url);
      if (img && !BAD_IMAGE.test(img)) return img;
    }
  }
  return null;
}

const STOP = new Set('les des une pour sur avec dans par que qui est sont aux ses son leur the and for with from that this are was has have will new its his her you your how why what plus nouveau nouvelle'.split(' '));
const wordsOf = title => new Set(title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2 && !STOP.has(w)));
const similarity = (a, b) => {
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return common / (a.size + b.size - common);
};

// Regroupe les articles d'une catégorie qui racontent la même histoire : une seule carte, "+N sources".
export function cluster(items) {
  const groups = [];
  for (const item of [...items].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1) || b.ts - a.ts)) {
    const words = wordsOf(item.title);
    const group = words.size >= 3 && groups.find(g => g.lead.source !== item.source && Math.abs(g.lead.ts - item.ts) < 72 * HOUR && similarity(g.words, words) >= 0.5);
    if (group) group.also.push(item);
    else groups.push({ lead: item, words, also: [] });
  }
  return groups.map(({ lead, also }) => ({
    ...lead,
    img: lead.img ?? also.find(a => a.img)?.img ?? null,
    also: also.map(a => ({ source: a.source, url: a.url })),
  }));
}

const scoreOf = (item, now) => {
  const halfLife = item.kind === 'deal' ? 18 : 24;
  const age = Math.max(0, now - item.ts) / HOUR;
  return (item.weight ?? 1) * (1 + 0.5 * item.also.length) * 0.5 ** (age / halfLife);
};

let store = { generatedAt: 0, items: {}, health: {} };

export async function load() {
  try {
    store = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Cache illisible, on repart de zéro :', err.message);
  }
}

async function save() {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(store));
  await rename(tmp, DATA_FILE);
}

export async function refresh() {
  const now = Date.now();
  const all = categories.flatMap(cat => cat.sources.map(src => ({ ...src, cat: cat.id })));
  const keyOf = s => `${s.cat}:${s.name}:${s.url}`;
  const isReddit = s => s.url.includes('reddit.com');
  const redditTurn = all.filter(isReddit)
    .sort((a, b) => (store.health[keyOf(a)]?.tried ?? 0) - (store.health[keyOf(b)]?.tried ?? 0))
    .slice(0, REDDIT_PER_RUN);
  // Un seul appel à la fois par site, pour rester poli (Reddit, Dealabs...).
  const byHost = [...Map.groupBy([...all.filter(s => !isReddit(s)), ...redditTurn], s => new URL(s.url).host).values()];

  await pool(byHost, 14, async group => {
    for (const src of group) {
      const key = keyOf(src);
      const prev = store.health[key];
      try {
        const items = await fetchFeed(src);
        for (const it of items) {
          if (it.url.includes('/shorts/') || (src.only && !src.only.test(it.title))) continue;
          if (src.prefix) it.title = src.prefix + it.title;
          if (src.strip) it.title = it.title.replace(src.strip, '');
          if (src.kind === 'deal' && !it.price) it.price = /\b(gratuits?|free|100 ?% off)\b/i.test(it.title) ? 'Gratuit' : it.title.match(PRICE)?.at(-1)?.trim() ?? null;
          const id = createHash('sha1').update(`${src.cat} ${it.url}`).digest('base64url').slice(0, 12); // un article peut vivre dans deux catégories
          const old = store.items[id];
          const ts = Math.min(it.ts ?? old?.ts ?? now, now); // pas de date dans le futur ; sans date : première vue
          if (now - ts > KEEP_DAYS * 24 * HOUR) continue;
          store.items[id] = {
            ...old, ...it, id, ts,
            img: it.img ?? old?.img ?? null,
            cat: src.cat, source: src.name, kind: src.kind ?? 'article', weight: src.weight ?? 1, noLead: src.noLead,
          };
        }
        store.health[key] = { name: src.name, cat: src.cat, ok: true, count: items.length, lastOk: now, tried: now };
      } catch (err) {
        store.health[key] = { name: src.name, cat: src.cat, ok: false, error: err.message, lastOk: prev?.lastOk ?? null, tried: now };
      }
      if (src !== group.at(-1)) await wait(HOST_DELAY[new URL(src.url).host] ?? 0);
    }
  });

  // Une source retirée de sources.mjs disparaît aussi de l'interface.
  const known = new Set(all.map(s => `${s.cat}:${s.name}`));
  for (const [id, it] of Object.entries(store.items)) if (now - it.ts > KEEP_DAYS * 24 * HOUR || !known.has(`${it.cat}:${it.source}`)) delete store.items[id];
  for (const [key, h] of Object.entries(store.health)) if (!known.has(`${h.cat}:${h.name}`)) delete store.health[key];

  // og:image seulement pour les articles visibles en tête de chaque catégorie, une seule tentative par article.
  const missing = categories.flatMap(cat => Object.values(store.items)
    .filter(it => it.cat === cat.id && !it.img && !it.imgTried)
    .sort((a, b) => (b.weight ?? 1) * 0.5 ** ((now - b.ts) / (24 * HOUR)) - (a.weight ?? 1) * 0.5 ** ((now - a.ts) / (24 * HOUR)))
    .slice(0, IMAGE_LOOKUPS_PER_CATEGORY));
  await pool(missing, 10, async it => {
    it.imgTried = true;
    it.img = await findOgImage(it.url).catch(() => null);
  });

  store.generatedAt = Date.now();
  await save();
  return snapshot();
}

export function snapshot() {
  const now = Date.now();
  const all = Object.values(store.items);
  const items = categories.flatMap(cat => {
    const mine = cluster(all.filter(it => it.cat === cat.id)).map(it => ({ ...it, score: scoreOf(it, now) }));
    mine.sort((a, b) => b.score - a.score);
    // Sujets lus dans le titre seul : les résumés citent trop de choses pour filtrer juste.
    return mine.slice(0, PER_CATEGORY).map(({ weight, imgTried, ...it }) => (
      { ...it, topics: Object.entries(cat.topics).filter(([, re]) => re.test(it.title)).map(([name]) => name) }
    ));
  });
  return {
    generatedAt: store.generatedAt,
    categories: categories.map(({ id, name, short, color, icon, topics, sources }) => ({ id, name, short, color, icon, topics: Object.keys(topics), sourceCount: sources.length })),
    items,
    health: Object.values(store.health),
  };
}

// `node news.mjs` : met à jour une fois, écrit les données du site et affiche l'état des sources.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await load();
  const t = Date.now();
  const snap = await refresh();
  // Panne réseau sans cache : échouer ici garde en ligne la dernière version correcte du site.
  if (!snap.items.length) {
    console.error('Aucun article récupéré : site non mis à jour.');
    process.exit(1);
  }
  const site = join(dirname(DATA_FILE), '..', 'public');
  await writeFile(join(site, 'news.json'), JSON.stringify(snap));
  await writeFile(join(site, 'status.json'), JSON.stringify({ generatedAt: snap.generatedAt }));
  const bad = snap.health.filter(h => !h.ok);
  console.log(`${snap.items.length} articles, ${snap.health.length - bad.length}/${snap.health.length} sources OK, ${Math.round((Date.now() - t) / 1000)} s`);
  for (const cat of snap.categories) {
    const mine = snap.items.filter(i => i.cat === cat.id);
    const day = mine.filter(i => Date.now() - i.ts < 24 * HOUR).length;
    console.log(`  ${cat.short.padEnd(12)} ${String(mine.length).padStart(4)} articles, ${String(day).padStart(4)} en 24 h, ${Math.round(100 * mine.filter(i => i.img).length / (mine.length || 1))} % avec image`);
  }
  for (const h of bad) console.log(`  KO ${h.cat}/${h.name} : ${h.error}`);
}
