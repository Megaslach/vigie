// Interface de Vigie. Les textes des flux passent uniquement par des nœuds texte, jamais par innerHTML.
const $ = id => document.getElementById(id);
const HOUR = 3.6e6;
const POLL_EVERY = 60 * 1000;
const STALE_AFTER = 90 * 60 * 1000; // GitHub peut retarder ses passages planifiés
const PAGE = 48;

const stroke = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  today: stroke('<path d="M4 5h12a1 1 0 0 1 1 1v12a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z"/><path d="M17 9h2a1 1 0 0 1 1 1v8a2 2 0 0 1-2 2M8 9h5M8 13h5M8 17h2"/>'),
  sparkles: stroke('<path d="M11 4l1.8 5.2L18 11l-5.2 1.8L11 18l-1.8-5.2L4 11l5.2-1.8z"/><path d="M18 3.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6zM18.5 16l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z"/>'),
  cap: stroke('<path d="M12 4.5 2.5 9.5 12 14.5l9.5-5z"/><path d="M6.5 12v4.5c0 1.3 2.5 2.8 5.5 2.8s5.5-1.5 5.5-2.8V12"/>'),
  chip: stroke('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4" rx=".5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>'),
  tag: stroke('<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1"/>'),
  gamepad: stroke('<path d="M6.8 6h10.4a4 4 0 0 1 4 3.6l.7 6.1A2.9 2.9 0 0 1 19 19c-1 0-1.8-.5-2.3-1.2L15 16H9l-1.7 1.8C6.8 18.5 6 19 5 19a2.9 2.9 0 0 1-2.9-3.3l.7-6.1A4 4 0 0 1 6.8 6z"/><path d="M6.5 11h4M8.5 9v4M15 12h.01M18 10.5h.01"/>'),
  book: stroke('<path d="M12 6.5C10.5 5 8 4.5 3.5 4.5v13.5c4.5 0 7 .5 8.5 2 1.5-1.5 4-2 8.5-2V4.5C16 4.5 13.5 5 12 6.5zM12 6.5V20"/>'),
  film: stroke('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21"/>'),
  layout: stroke('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18M9 9v11"/>'),
  chart: stroke('<path d="M4 19h16M6 15l4.5-4.5 3 3L20 7"/><path d="M15.5 7H20v4.5"/>'),
  terminal: stroke('<path d="M5 7l5 5-5 5M12.5 18H19"/>'),
  shield: stroke('<path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  bag: stroke('<path d="M6 8h12l1 12.5H5zM9 10.5V6.5a3 3 0 0 1 6 0v4"/>'),
  left: stroke('<path d="M15 6l-6 6 6 6"/>'),
  right: stroke('<path d="M9 6l6 6-6 6"/>'),
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
};

const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...kids.flat().filter(k => k != null && k !== false));
  return node;
};
const icon = name => {
  const span = el('span', { style: 'display:contents' });
  span.innerHTML = ICONS[name] ?? ''; // icônes constantes de ce fichier
  return span;
};
const tile = cat => el('span', { class: 'tile', style: cat ? `--c:${cat.color}` : '--c:#ff3b30' }, icon(cat ? cat.icon : 'today'));

const store = {
  read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* navigation privée : pas de mémoire */ } },
};

let data = null;      // dernier instantané affiché
let pending = null;   // instantané reçu, en attente d'un clic sur la pastille
let refreshing = false;
let local = false;    // server.mjs : seul cas où la page peut demander une mise à jour
let view = 'today';
let topic = null;
let shown = PAGE;
let query = '';
const seen = store.read('vigie.seen', {}); // catégorie -> date de la dernière visite

const catOf = id => data.categories.find(c => c.id === id);
const seenAt = cat => seen[cat] ?? Date.now() - 24 * HOUR;
const isNew = item => item.ts > seenAt(item.cat);
const fold = s => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const setWall = color => $('wall').style.setProperty('--wall', color);

function timeLabel(ts) {
  const diff = Date.now() - ts;
  if (diff < 60e3) return 'à l’instant';
  if (diff < HOUR) return `${Math.floor(diff / 60e3)} min`;
  const date = new Date(ts);
  const today = new Date();
  if (diff < 12 * HOUR || date.toDateString() === today.toDateString()) return `${Math.floor(diff / HOUR)} h`;
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'hier';
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function agoSentence(ts) {
  const min = Math.floor((Date.now() - ts) / 60e3);
  if (min < 1) return 'à l’instant';
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `il y a ${h} h` : `il y a ${Math.floor(h / 24)} jours`;
}

function meta(item) {
  let host = '';
  try { host = new URL(item.url).hostname; } catch { /* URL déjà validée côté serveur */ }
  return el('div', { class: 'meta' },
    isNew(item) && el('span', { class: 'new', title: 'Nouveau depuis ta dernière visite' }),
    el('img', { class: 'fav', src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`, alt: '', loading: 'lazy', width: 15, height: 15, onerror: e => e.target.remove() }),
    el('span', { class: 'name' }, item.source),
    item.also?.length > 0 && el('span', { class: 'plus', title: `Aussi sur ${item.also.map(a => a.source).join(', ')}` }, `+${item.also.length}`),
    el('time', { datetime: new Date(item.ts).toISOString() }, timeLabel(item.ts)));
}

// Un résumé anglais n'a pas sa place sous un titre traduit.
const summaryOf = item => (item.original ? '' : item.summary);

function media(item) {
  const cat = catOf(item.cat);
  const fallback = () => (summaryOf(item)
    ? el('div', { class: 'excerpt' }, summaryOf(item))
    : el('div', { class: 'glyph' }, icon(cat.icon)));
  const box = el('div', { class: `media${item.img ? '' : ' bare'}` });
  if (item.img) {
    box.append(el('img', {
      src: item.img, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer',
      onerror: e => { box.classList.add('bare'); e.target.replaceWith(fallback()); },
    }));
  } else box.append(fallback());
  if (item.kind === 'video') box.append(el('span', { class: 'play' }, icon('play')));
  return box;
}

function card(item) {
  const cat = catOf(item.cat);
  const deal = item.kind === 'deal';
  return el('a', { class: `item${deal ? ' deal' : ''}`, href: item.url, target: '_blank', rel: 'noopener noreferrer', style: `--c:${cat.color}` },
    media(item),
    el('div', { class: 'cap' },
      deal && (item.price || item.merchant) && el('div', { class: 'price-row' },
        item.price && el('span', { class: 'price' }, item.price),
        item.merchant && el('span', { class: 'merchant' }, item.merchant)),
      el('h3', { title: item.original }, item.title),
      meta(item)));
}

// Une en pleine largeur : les articles défilent seuls, la barre de progression pilote le changement.
function hero(stories, head, { showCat = false } = {}) {
  let current = 0;
  const frames = stories.map((s, i) => el('img', { class: i ? '' : 'on', src: s.img, alt: '', decoding: 'async', referrerpolicy: 'no-referrer', onerror: e => e.target.remove() }));
  const copies = stories.map((s, i) => el('a', {
    class: `copy${i ? '' : ' on'}`, href: s.url, target: '_blank', rel: 'noopener noreferrer', tabindex: i ? '-1' : null, 'aria-hidden': i ? 'true' : null,
  },
  showCat && el('div', { class: 'kicker' }, tile(catOf(s.cat)), catOf(s.cat).name),
  el('h2', { title: s.original }, s.title),
  summaryOf(s) && el('p', { class: 'deck' }, summaryOf(s)),
  meta(s)));
  const show = i => {
    current = i;
    for (const list of [frames, copies, tabs]) list.forEach((node, j) => node.classList.toggle('on', j === i));
    copies.forEach((node, j) => {
      node.tabIndex = j === i ? 0 : -1;
      node.setAttribute('aria-hidden', String(j !== i));
    });
    tabs.forEach((node, j) => node.setAttribute('aria-pressed', String(j === i)));
    if (showCat) setWall(catOf(stories[i].cat).color);
  };
  const tabs = stories.map((s, i) => el('button', { class: `tab${i ? '' : ' on'}`, type: 'button', 'aria-label': s.title, 'aria-pressed': String(!i), onclick: () => show(i) },
    el('span', { class: 'bar' }, el('i', {})),
    el('span', { class: 'tab-title' }, s.title)));
  const bar = stories.length > 1 && el('div', { class: 'tabs glass', role: 'group', 'aria-label': 'Articles à la une', onanimationend: () => show((current + 1) % stories.length) }, tabs);
  return el('section', { class: 'hero', 'aria-label': 'À la une', style: `--c:${catOf(stories[0].cat).color}` },
    el('div', { class: 'frames' }, frames),
    head,
    el('div', { class: 'hero-low' }, el('div', { class: 'copies' }, copies), bar));
}

// Les articles assez forts pour la une : avec une photo, hors bons plans, posts et vidéos.
function topStories(items, n, perCategory) {
  const out = [];
  const count = {};
  for (const item of items) {
    if (out.length === n) break;
    if (!item.img || item.kind !== 'article' || item.noLead) continue;
    const key = perCategory ? item.cat : item.source;
    count[key] = (count[key] ?? 0) + 1;
    if (count[key] <= (perCategory ? 1 : 2)) out.push(item);
  }
  return out;
}

// Évite qu'une seule source occupe tout un rayon.
function diverse(items, n, perSource = 2) {
  const counts = {};
  const out = [];
  for (const item of items) {
    counts[item.source] = (counts[item.source] ?? 0) + 1;
    if (counts[item.source] <= perSource) out.push(item);
    if (out.length === n) break;
  }
  return out;
}

function shelf({ title, cat, href, items, iconTile }) {
  const rail = el('div', { class: 'rail' }, items.map(card));
  const back = el('button', { type: 'button', 'aria-label': 'Précédent', disabled: true, onclick: () => rail.scrollBy({ left: -rail.clientWidth * .7, behavior: 'smooth' }) }, icon('left'));
  const next = el('button', { type: 'button', 'aria-label': 'Suivant', onclick: () => rail.scrollBy({ left: rail.clientWidth * .7, behavior: 'smooth' }) }, icon('right'));
  const sync = () => {
    back.disabled = rail.scrollLeft < 8;
    next.disabled = rail.scrollLeft + rail.clientWidth > rail.scrollWidth - 8;
  };
  rail.addEventListener('scroll', sync, { passive: true });
  requestAnimationFrame(sync);
  return el('section', { class: 'shelf', style: cat ? `--c:${cat.color}` : null },
    el('div', { class: 'shelf-head' },
      iconTile,
      el('h2', {}, href ? el('a', { href }, title) : title),
      href && el('a', { class: 'all', href }, 'Tout voir'),
      el('div', { class: 'arrows' }, back, next)),
    rail);
}

function renderToday() {
  const byScore = [...data.items].sort((a, b) => b.score - a.score);
  const stories = topStories(byScore, 5, true);
  const used = new Set(stories.map(s => s.id));
  const dayCount = data.items.filter(i => Date.now() - i.ts < 24 * HOUR).length;
  const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  const shelves = [];
  for (const cat of data.categories) {
    const items = diverse(byScore.filter(i => i.cat === cat.id && !used.has(i.id) && (i.kind !== 'video' || cat.id === 'claude')), 10);
    if (items.length) shelves.push(shelf({ title: cat.name, cat, href: `#${cat.id}`, items, iconTile: tile(cat) }));
    if (cat.id === 'cine') {
      const videos = diverse(byScore.filter(i => i.kind === 'video' && i.cat !== 'claude'), 12, 1);
      if (videos.length) shelves.push(shelf({ title: 'À regarder', items: videos, iconTile: el('span', { class: 'tile', style: '--c:#ff3b30' }, icon('play')) }));
    }
  }
  const dateHead = cls => el('header', { class: `head ${cls}` },
    el('p', { class: 'sub' }, today[0].toUpperCase() + today.slice(1)),
    el('h1', {}, 'Aujourd’hui'));
  setWall(stories[0] ? catOf(stories[0].cat).color : '#0a84ff');
  return [
    stories.length ? hero(stories, dateHead('hero-head'), { showCat: true }) : dateHead('plain-head'),
    shelves,
    el('button', { class: 'foot', type: 'button', 'aria-haspopup': 'dialog', onclick: openSources },
      `${dayCount} articles ces dernières 24 heures, issus de ${data.health.filter(h => h.ok).length} sources. Mis à jour ${agoSentence(data.generatedAt)}.`),
  ];
}

const KINDS = { video: 'Vidéos', social: 'Communauté' };

function renderCategory(cat) {
  const mine = data.items.filter(i => i.cat === cat.id);
  const tests = cat.topics.map(name => [name, i => i.topics.includes(name)]);
  for (const [kind, label] of Object.entries(KINDS)) tests.push([label, i => i.kind === kind]);
  const chips = tests.map(([name, test]) => [name, test, mine.filter(test).length]).filter(([, , n]) => n > 0);
  if (topic && !chips.some(([name]) => name === topic)) topic = null;
  const list = (topic ? mine.filter(chips.find(([name]) => name === topic)[1]) : mine).sort((a, b) => b.score - a.score);

  const stories = cat.id === 'deals' ? [] : topStories(list, 4, false);
  const used = new Set(stories.map(s => s.id));
  const rest = list.filter(i => !used.has(i.id));

  // Regroupe par jour ; dans chaque jour, le plus important d'abord.
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const days = [['Aujourd’hui', i => i.ts >= startOfToday], ['Hier', i => i.ts >= startOfToday - 24 * HOUR && i.ts < startOfToday], ['Plus tôt', i => i.ts < startOfToday - 24 * HOUR]];
  const visible = rest.slice(0, shown);
  const fresh = mine.filter(i => i.ts > seenAt(cat.id)).length;
  const subtitle = !seen[cat.id] ? plural(fresh, 'article', 'articles') + ' ces dernières 24 heures'
    : fresh ? `${plural(fresh, 'nouveauté', 'nouveautés')} depuis ta dernière visite`
    : 'Rien de nouveau depuis ta dernière visite';
  const head = cls => el('header', { class: `${cls} cat`, style: `--c:${cat.color}` },
    tile(cat),
    el('div', { class: 'head' }, el('h1', {}, cat.name), el('p', { class: 'sub' }, subtitle)));

  setWall(cat.color);
  return [
    stories.length ? hero(stories, head('hero-head')) : head('plain-head'),
    chips.length > 1 && el('div', { class: 'chips-bar glass' }, el('div', { class: 'chips', role: 'group', 'aria-label': 'Filtrer par sujet' },
      el('button', { class: 'chip', type: 'button', 'aria-pressed': String(!topic), onclick: () => setTopic(null) }, !topic && el('span', { class: 'thumb' }), 'Tout'),
      chips.map(([name, , n]) => el('button', { class: 'chip', type: 'button', 'aria-pressed': String(topic === name), onclick: () => setTopic(name) }, topic === name && el('span', { class: 'thumb' }), name, el('small', {}, n))))),
    days.map(([label, test]) => {
      const items = visible.filter(test);
      return items.length > 0 && el('section', { class: 'day' },
        el('h2', {}, label),
        el('div', { class: 'grid' }, items.map(card)));
    }),
    rest.length > shown && el('button', { class: 'more', type: 'button', onclick: () => { shown += PAGE; render(); } }, 'Afficher plus'),
    !list.length && el('div', { class: 'note' }, el('h2', {}, 'Rien pour le moment'), el('p', {}, 'Les articles de cette catégorie apparaîtront ici dès la prochaine mise à jour.')),
  ];
}

function renderSearch() {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const hits = data.items
    .filter(i => { const hay = fold(`${i.title} ${i.original ?? ''} ${i.summary} ${i.source} ${i.topics.join(' ')}`); return terms.every(t => hay.includes(t)); })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 96);
  setWall('#0a84ff');
  return [
    el('header', { class: 'head plain-head' },
      el('p', { class: 'sub' }, hits.length ? plural(hits.length, 'résultat', 'résultats') : 'Aucun résultat'),
      el('h1', {}, `« ${query} »`)),
    hits.length
      ? el('div', { class: 'grid' }, hits.map(card))
      : el('div', { class: 'note' }, el('p', {}, 'Essaie un autre mot, par exemple le nom d’un modèle, d’un composant ou d’un jeu.')),
  ];
}

function renderNav() {
  const nav = $('nav');
  const left = nav.scrollLeft;
  const top = nav.scrollTop;
  const here = query ? null : view;
  const link = (id, label, tileNode, count) => el('a', { href: `#${id}`, 'aria-current': here === id ? 'page' : null, onclick: clearSearch },
    here === id && el('span', { class: 'thumb' }),
    tileNode, el('span', { class: 'label' }, label),
    count > 0 && el('span', { class: 'count' }, count > 99 ? '99+' : count));
  nav.replaceChildren(
    link('today', 'Aujourd’hui', tile(null)),
    el('div', { class: 'divider' }),
    ...data.categories.map(cat => link(cat.id, cat.name, tile(cat), data.items.filter(i => i.cat === cat.id && i.ts > seenAt(cat.id)).length)));
  nav.scrollLeft = left;
  nav.scrollTop = top;
  // Capsule du téléphone : garder la catégorie ouverte visible.
  if (nav.scrollWidth > nav.clientWidth) nav.querySelector('[aria-current]')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

function renderStatus() {
  const age = Date.now() - data.generatedAt;
  const stale = data.generatedAt > 0 && age > STALE_AFTER;
  // Reddit limité (429) se rétablit seul : pas d'alerte ici, le détail reste dans la fiche Sources.
  const failing = data.health.filter(h => !h.ok && !/429/.test(h.error)).length;
  const text = refreshing ? 'Mise à jour en cours'
    : !data.generatedAt ? 'Première récupération'
    : `Mis à jour ${agoSentence(data.generatedAt)}`;
  $('status').replaceChildren(
    el('span', { class: `dot${refreshing ? ' busy' : stale ? ' warn' : ''}` }),
    el('span', {}, text, failing > 0 && !refreshing ? `, ${plural(failing, 'source muette', 'sources muettes')}` : ''));
}

function render() {
  if (!data) return;
  const main = $('main');
  const cat = data.categories.find(c => c.id === view);
  const chipsLeft = main.querySelector('.chips')?.scrollLeft;
  document.title = query ? `${query} – Vigie` : cat ? `${cat.short} – Vigie` : 'Vigie';
  if (!data.items.length) {
    main.replaceChildren(el('div', { class: 'note plain-head' }, el('h2', {}, 'Première récupération en cours'), el('p', {}, 'Vigie lit ses sources pour la première fois. Cela prend quelques minutes et la page se remplira toute seule.')));
  } else {
    main.replaceChildren(...[query ? renderSearch() : cat ? renderCategory(cat) : renderToday()].flat(2).filter(Boolean));
  }
  if (chipsLeft) { const chips = main.querySelector('.chips'); if (chips) chips.scrollLeft = chipsLeft; }
  renderNav();
  renderStatus();
}

const transition = fn => (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches ? document.startViewTransition(fn) : fn());

function setTopic(name) {
  topic = name;
  shown = PAGE;
  transition(render);
}

// Une catégorie est "vue" quand on la quitte : les points bleus restent pendant la lecture.
function markSeen() {
  if (!data?.categories.some(c => c.id === view)) return;
  seen[view] = Date.now();
  store.write('vigie.seen', seen);
}

// Cliquer la catégorie déjà ouverte ne change pas l'ancre : la recherche se ferme ici.
function clearSearch() {
  if (!query) return;
  query = '';
  $('q').value = '';
  render();
}

function route() {
  markSeen();
  view = location.hash.slice(1) || 'today';
  topic = null;
  shown = PAGE;
  query = '';
  $('q').value = '';
  transition(render);
  scrollTo({ top: 0 });
}

function applyPending() {
  if (pending) { data = pending; pending = null; }
  $('fresh').hidden = true;
  transition(render);
  scrollTo({ top: 0, behavior: 'smooth' });
}

async function fetchNews() {
  const res = await fetch('news.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function poll() {
  try {
    const res = await fetch('status.json', { cache: 'no-store' });
    const status = await res.json();
    const wasRefreshing = refreshing;
    refreshing = !!status.refreshing;
    local = !!status.local;
    if (data && status.generatedAt > (pending ?? data).generatedAt) {
      const next = await fetchNews();
      const known = new Set(data.items.map(i => i.id));
      const added = next.items.filter(i => !known.has(i.id)).length;
      // Page encore vide : on remplit. Rien de nouveau : on ne touche pas à ce que tu lis.
      if (!data.items.length) { data = next; render(); return; }
      if (added === 0) { data = next; renderStatus(); return; }
      pending = next;
      const fresh = $('fresh');
      fresh.textContent = added === 1 ? '1 nouvel article' : `${added} nouveaux articles`;
      fresh.hidden = false;
    }
    if (wasRefreshing !== refreshing && data) renderStatus();
  } catch {
    showOffline();
  }
}

function showOffline() {
  if (data) {
    $('status').replaceChildren(el('span', { class: 'dot warn' }), el('span', {}, 'Connexion perdue'));
    return;
  }
  $('main').replaceChildren(el('div', { class: 'note plain-head' }, el('h2', {}, 'Vigie ne répond pas'), el('p', {}, 'Les actualités n’ont pas pu être chargées. Vérifie ta connexion puis recharge cette page.')));
}

async function requestRefresh() {
  if (!local) return;
  refreshing = true;
  if (data) renderStatus();
  await fetch('refresh', { method: 'POST' }).catch(() => {});
}

function openSources() {
  const sheet = $('sheet');
  const failing = data.health.filter(h => !h.ok);
  const okCount = data.health.length - failing.length;
  const reason = h => {
    if (/403/.test(h.error)) return 'bloquée par le site';
    if (/429/.test(h.error)) return 'trop de requêtes, réessai bientôt';
    if (/404/.test(h.error)) return 'flux introuvable';
    if (/5\d\d/.test(h.error)) return 'site en panne';
    if (/timeout|abort/i.test(h.error)) return 'pas de réponse';
    return h.error;
  };
  sheet.replaceChildren(
    el('header', {},
      el('div', {}, el('h2', {}, 'Sources'),
        el('p', {}, `${okCount} sur ${data.health.length} ont répondu à la dernière mise à jour, ${agoSentence(data.generatedAt)}. Vigie se met à jour toute seule, à peu près tous les quarts d’heure.`),
        data.translation?.ok === false && el('p', {}, 'Traduction indisponible pour l’instant : les nouveaux titres restent en version originale.')),
      local && el('button', { class: 'act primary', type: 'button', disabled: refreshing, onclick: async e => { e.target.disabled = true; e.target.textContent = 'En cours'; await requestRefresh(); } }, refreshing ? 'En cours' : 'Mettre à jour'),
      el('button', { class: 'act', type: 'button', onclick: () => sheet.close() }, 'Fermer')),
    el('div', { class: 'body' },
      failing.length > 0 && el('section', {}, el('h3', {}, 'Muettes pour l’instant'), el('ul', {}, failing.map(h => el('li', {}, el('span', { class: 'dot warn' }), el('span', {}, h.name), el('small', {}, reason(h)))))),
      data.categories.map(cat => el('section', {}, el('h3', {}, cat.name), el('ul', {},
        data.health.filter(h => h.cat === cat.id && h.ok).map(h => el('li', {}, el('span', { class: 'dot' }), el('span', {}, h.name)))))),
    ));
  sheet.showModal();
}

// Réfraction sur les bords de la barre, comme le Liquid Glass : les images se courbent en passant dessous.
// Chromium seul (backdrop-filter avec un filtre SVG) ; ailleurs, le verre reste simplement flou.
function lens(node) {
  const able = navigator.userAgentData?.brands.some(b => b.brand === 'Chromium')
    && matchMedia('(min-width: 861px) and (prefers-reduced-motion: no-preference)').matches;
  $('lens-svg')?.remove();
  node.style.removeProperty('backdrop-filter');
  if (!able) return;
  const W = node.offsetWidth;
  const H = node.offsetHeight;
  const radius = parseFloat(getComputedStyle(node).borderTopLeftRadius);
  const BAND = 34;
  const STEP = 3;
  const w = Math.ceil(W / STEP);
  const h = Math.ceil(H / STEP);
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  const map = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = (x + .5) * STEP - W / 2;
      const py = (y + .5) * STEP - H / 2;
      const qx = Math.abs(px) - (W / 2 - radius);
      const qy = Math.abs(py) - (H / 2 - radius);
      const corner = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const depth = radius - corner - Math.min(Math.max(qx, qy), 0); // distance au bord, vers l'intérieur
      const force = depth < BAND ? (1 - Math.max(depth, 0) / BAND) ** 2 : 0;
      const nx = corner > 0 ? Math.max(qx, 0) / corner : Number(qx > qy);
      const ny = corner > 0 ? Math.max(qy, 0) / corner : Number(qy >= qx);
      const i = (x + y * w) * 4;
      map.data[i] = 128 - Math.sign(px) * nx * force * 127;
      map.data[i + 1] = 128 - Math.sign(py) * ny * force * 127;
      map.data[i + 2] = 128;
      map.data[i + 3] = 255;
    }
  }
  ctx.putImageData(map, 0, 0);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.id = 'lens-svg';
  svg.setAttribute('style', 'position:absolute;width:0;height:0');
  const filter = document.createElementNS(NS, 'filter');
  filter.id = 'lens';
  for (const [k, v] of Object.entries({ x: 0, y: 0, width: W, height: H, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' })) filter.setAttribute(k, v);
  const image = document.createElementNS(NS, 'feImage');
  for (const [k, v] of Object.entries({ href: canvas.toDataURL(), x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', result: 'map' })) image.setAttribute(k, v);
  const shift = document.createElementNS(NS, 'feDisplacementMap');
  for (const [k, v] of Object.entries({ in: 'SourceGraphic', in2: 'map', scale: 60, xChannelSelector: 'R', yChannelSelector: 'G' })) shift.setAttribute(k, v);
  filter.append(image, shift);
  svg.append(filter);
  document.body.append(svg);
  node.style.setProperty('backdrop-filter', 'url(#lens) blur(14px) saturate(190%) brightness(var(--glass-b))');
}

$('status').addEventListener('click', () => data && openSources());
$('fresh').addEventListener('click', applyPending);
$('sheet').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('q').addEventListener('input', e => {
  query = e.target.value.trim();
  render();
});
addEventListener('hashchange', route);
addEventListener('pagehide', markSeen);
addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? '');
  if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
    e.preventDefault();
    $('q').focus();
    $('q').select();
  } else if (e.key === 'Escape' && document.activeElement === $('q')) {
    query = '';
    $('q').value = '';
    $('q').blur();
    render();
  }
});
// Le reflet du verre suit le curseur.
addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse') return;
  const glass = e.target.closest?.('.glass, .item');
  if (!glass) return;
  const target = glass.classList.contains('item') ? glass.querySelector('.cap') : glass;
  const box = target.getBoundingClientRect();
  target.style.setProperty('--mx', `${e.clientX - box.left}px`);
  target.style.setProperty('--my', `${e.clientY - box.top}px`);
}, { passive: true });
let lensTimer;
addEventListener('resize', () => {
  clearTimeout(lensTimer);
  lensTimer = setTimeout(() => lens($('side')), 200);
});
// Au retour sur la page : vérifier tout de suite, et relancer une mise à jour si la dernière date un peu.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  poll();
  if (data && Date.now() - data.generatedAt > 10 * 60 * 1000) requestRefresh();
});
setInterval(() => { if (!document.hidden) { poll(); if (data) renderStatus(); } }, POLL_EVERY);

(async () => {
  view = location.hash.slice(1) || 'today';
  lens($('side'));
  $('main').replaceChildren(
    el('div', { class: 'skeleton hero-skel' }),
    el('div', { class: 'skeleton row-skel' }));
  try {
    data = await fetchNews();
    render();
    await poll();
    if (Date.now() - data.generatedAt > 10 * 60 * 1000) requestRefresh();
  } catch {
    showOffline();
  }
})();
