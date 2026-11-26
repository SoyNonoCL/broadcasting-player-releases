'use strict';
/* Interfaz de Broadcasting Player para Windows. */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
// En la web app (navegador) no hay Mi TV, Google Drive ni descargas de actualizaciones.
const WEB = !!(window.bp && window.bp.web);
const ASSETS = WEB ? 'assets/' : '../../assets/';

// ---------------- Preferencias y progreso (guardados en la carpeta portable) ----------------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* nada */ } }
};
const prefs = {
  get lang() { return store.get('lang', ({ en: 'E', pt: 'T', ru: 'U' })[navigator.language.slice(0, 2)] || 'S'); },
  set lang(v) { store.set('lang', v); },
  get quality() { return store.get('quality', 1080); },
  set quality(v) { store.set('quality', v); },
  get subtitles() { return store.get('subtitles', false); },
  set subtitles(v) { store.set('subtitles', v); },
  get theme() { return store.get('theme', 'dark'); }, // estilo original oscuro por defecto
  set theme(v) { store.set('theme', v); },
  get uiLang() { return store.get('uiLang', ''); },
  set uiLang(v) { store.set('uiLang', v); }
};
const progress = {
  all() { return store.get('progress', {}); },
  id(m) { return `${m.lang}|${m.key}`; },
  get(m) { return this.all()[this.id(m)] || null; },
  save(m, pos, dur) {
    const a = this.all();
    a[this.id(m)] = { pos, dur, t: Date.now(), item: m };
    const keys = Object.keys(a).sort((x, y) => a[y].t - a[x].t);
    keys.slice(60).forEach((k) => delete a[k]);
    store.set('progress', a);
  },
  clear(m) { const a = this.all(); delete a[this.id(m)]; store.set('progress', a); },
  list(lang) { return Object.values(this.all()).filter((e) => e.item && e.item.lang === lang).sort((a, b) => b.t - a.t).map((e) => e.item).slice(0, 20); }
};

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const resolveTheme = (v) => (v === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : v);
try { document.documentElement.dataset.theme = resolveTheme(JSON.parse(localStorage.getItem('theme') || '"dark"')); } catch (e) { /* nada */ }

// ---------------- Textos ----------------
let S = {};
function t(key, ...args) {
  let s = S[key] || key;
  args.forEach((a, i) => { s = s.split(`{${i + 1}}`).join(String(a)); });
  return s;
}
function plural(key, n) {
  const forms = S['pl_' + key] || {};
  let q = 'other';
  try { q = new Intl.PluralRules(S._locale || 'en').select(n); } catch (e) { q = n === 1 ? 'one' : 'other'; }
  return (forms[q] || forms.other || '{1}').split('{1}').join(String(n));
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const api = (name, ...args) => window.bp.api(name, ...args);

// ---------------- Navegación ----------------
const view = $('#view');
let currentTab = 'home';
const stack = []; // pantallas abiertas sobre la pestaña (rutas, fichas)
let renderToken = 0;

function setTab(tab) {
  currentTab = tab;
  stack.length = 0;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  render();
}
function push(entry) { stack.push(entry); render(); }
function back() { if (stack.length) { stack.pop(); render(); } }

async function render() {
  const token = ++renderToken;
  $('#back').hidden = stack.length === 0;
  view.innerHTML = '';
  view.scrollTop = 0;
  const top = stack[stack.length - 1];
  try {
    if (top && top.type === 'route') await renderRoute(top.route, top.title, token);
    else if (top && top.type === 'details') renderDetails(top.item);
    else if (currentTab === 'home') await renderHome(token);
    else if (currentTab === 'explore') await renderRoute('explore', t('explore'), token);
    else if (currentTab === 'search') renderSearch();
    else if (currentTab === 'settings') renderSettings();
  } catch (e) {
    if (token === renderToken) view.appendChild(el('div', 'message', /HTTP 404|no encontrada/.test(String(e && e.message)) ? t('not_available') : t('error_loading') + '\n\n' + (e && e.message ? e.message : '')));
  }
}
const stale = (token) => token !== renderToken;

// ---------------- Tarjetas ----------------
function img(src) { const i = el('img'); i.loading = 'lazy'; i.alt = ''; if (src) i.src = src; i.onerror = () => i.remove(); return i; }

// ---------------- Mis favoritos ----------------
let favKeys = new Set();
const favKey = (x) => (x.kind === 'media' ? 'm:' + x.lang + '|' + x.key : 'i:' + x.url);
/** Lo que se marca al tocar ♥ en una tarjeta (o null si no se puede marcar). */
function favTarget(item) {
  if (!item) return null;
  if (item.kind === 'media') return item;
  if (item.kind === 'image') return item;
  if (item.kind === 'tile' && item.action) {
    const a = item.action;
    if (a.play) return a.play[a.index] || null;
    if (a.images) return { kind: 'image', url: a.images[a.index], caption: (a.captions || [])[a.index] || '', title: item.subtitle || item.title };
  }
  return null;
}
async function loadFavorites() {
  const list = await api('favList');
  favKeys = new Set(list.map(favKey));
  return list;
}
const isFav = (target) => !!target && favKeys.has(favKey(target));
async function toggleFav(target) {
  const on = await api('favToggle', target);
  if (on) favKeys.add(favKey(target)); else favKeys.delete(favKey(target));
  toast(t(on ? 'fav_added' : 'fav_removed'));
  return on;
}
const HEART_ON = '♥', HEART_OFF = '♡';
function heartButton(target, cls) {
  const b = el('button', cls || 'fav-btn');
  const paint = () => { const on = isFav(target); b.textContent = on ? HEART_ON : HEART_OFF; b.classList.toggle('on', on); b.title = t(on ? 'fav_remove' : 'fav_add'); };
  paint();
  b.onclick = async (e) => { e.stopPropagation(); await toggleFav(target); paint(); };
  return b;
}
/** Favoritos como tarjetas (las imágenes se abren en el visor). */
function favoriteCards(list) {
  const images = list.filter((x) => x.kind === 'image');
  const urls = images.map((x) => x.url), caps = images.map((x) => x.caption);
  return list.map((x) => (x.kind === 'image'
    ? { kind: 'tile', id: 'fav:' + x.url, title: x.caption || x.title, subtitle: x.title, image: x.url, action: { images: urls, captions: caps, index: urls.indexOf(x.url) } }
    : x));
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat(S._locale || 'en', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso + 'T12:00:00')); } catch (e) { return iso; }
}
function card(item, rowItems, opts = {}) {
  const c = el('div', 'card');
  c.tabIndex = 0;
  const box = el('div', 'card-img');
  let title = '', sub = '';
  if (item.kind === 'media') {
    title = item.title;
    sub = item.isAudio ? '♪  ' + item.durationText : item.durationText;
    if (opts.date && item.published) sub = [sub, fmtDate(item.published)].filter(Boolean).join('  ·  ');
    box.appendChild(img(item.images.card));
    const p = progress.get(item);
    if (p && p.dur > 0) {
      sub = t('remaining', fmtTime(p.dur - p.pos));
      const bar = el('div', 'card-progress'); const fill = el('div'); fill.style.width = Math.min(100, (p.pos / p.dur) * 100) + '%';
      bar.appendChild(fill); box.appendChild(bar);
    }
  } else if (item.kind === 'category') {
    if (item.viewAll) { c.classList.add('view-all'); title = t('view_all'); sub = item.name; box.appendChild(img(ASSETS + 'card_view_all.png')); }
    else { title = item.name; box.appendChild(img(item.image)); }
  } else if (item.kind === 'hit') {
    title = item.title; box.appendChild(img(item.image));
  } else if (item.kind === 'tile') {
    title = item.title; sub = item.subtitle;
    if (item.image) box.appendChild(img(item.image));
    else if (item.icon) box.appendChild(img(ASSETS + item.icon));
    else {
      const tt = el('div', 'text-tile ' + (/^\d{1,3}$/.test(item.text || '') ? 'big' : 'name'), item.text || item.title);
      tt.style.background = `linear-gradient(135deg, ${lighten(item.color)}, ${item.color})`;
      box.appendChild(tt);
    }
  }
  const target = favTarget(item);
  if (target) box.appendChild(heartButton(target));
  c.appendChild(box);
  c.appendChild(el('div', 'card-title', title));
  if (sub) c.appendChild(el('div', 'card-sub', sub));
  const go = () => openItem(item, rowItems || []);
  c.addEventListener('click', go);
  c.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  return c;
}
function lighten(hex) {
  const n = parseInt((hex || '#2A3446').slice(1), 16);
  const ch = (v) => Math.round(v + (255 - v) * 0.18);
  return `rgb(${ch(n >> 16)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
}

function row(title, items, opts = {}) {
  const r = el('section', 'row');
  const head = el('div', 'row-head');
  head.appendChild(el('h2', null, title));
  if (opts.badge) head.appendChild(el('span', 'badge-new', opts.badge));
  if (opts.viewAll) {
    const more = el('button', 'more', t('view_all') + ' ›');
    more.onclick = () => openItem(opts.viewAll, []);
    head.appendChild(more);
  }
  r.appendChild(head);
  const scroll = el('div', 'row-scroll');
  r.appendChild(scroll);
  const fill = (list) => { scroll.innerHTML = ''; list.forEach((it) => scroll.appendChild(card(it, list))); };
  if (items) fill(items); else scroll.appendChild(el('div', 'loading-row', t('loading')));
  const l = el('button', 'row-arrow l', '‹'); l.onclick = () => { scroll.scrollLeft -= scroll.clientWidth * 0.85; };
  const rr = el('button', 'row-arrow r', '›'); rr.onclick = () => { scroll.scrollLeft += scroll.clientWidth * 0.85; };
  r.append(l, rr);
  r.fill = fill;
  r.setTitle = (txt) => { head.firstChild.textContent = txt; };
  return r;
}
function grid(title, items, compact, opts = {}) {
  const s = el('section', 'row');
  if (title) { const h = el('div', 'row-head'); h.appendChild(el('h2', null, title)); s.appendChild(h); }
  const g = el('div', 'grid' + (compact ? ' compact' : ''));
  items.forEach((it) => g.appendChild(card(it, items, opts)));
  s.appendChild(g);
  return s;
}

// ---------------- Acciones ----------------
async function openItem(item, rowItems) {
  if (item.kind === 'media') {
    if (item.isAudio) {
      const list = rowItems.filter((x) => x.kind === 'media' && x.isAudio);
      const q = list.length ? list : [item];
      const p = progress.get(item);
      play(q, Math.max(0, q.findIndex((x) => x.key === item.key)), p ? p.pos : 0);
    } else push({ type: 'details', item });
  } else if (item.kind === 'category') {
    if (item.key === 'SeriesGoodNews') push({ type: 'route', route: 'goodnews', title: item.name });
    else push({ type: 'route', route: 'category/' + item.key, title: item.name });
  } else if (item.kind === 'hit') {
    if (item.categoryKey) { push({ type: 'route', route: 'category/' + item.categoryKey, title: item.title }); return; }
    const m = await api('mediaItem', item.lang, item.lank);
    if (m) openItem(m, []); else toast(t('error_loading'));
  } else if (item.kind === 'tile') {
    const a = item.action || {};
    if (a.open) push({ type: 'route', route: a.open, title: a.title || item.title });
    else if (a.url) window.bp.openExternal(a.url);
    else if (a.play) { const m = a.play[a.index]; const p = m && progress.get(m); play(a.play, a.index, p ? p.pos : 0); }
    else if (a.images) openViewer(a.images, a.captions, a.index);
    else if (a.live) playLive();
    else if (a.jwstream) jwStreamDialog();
  }
}

// ---------------- Inicio ----------------
async function renderHome(token) {
  const lang = prefs.lang;
  // Destacados
  const hero = el('div', 'hero');
  view.appendChild(hero);
  api('featured', lang).then((items) => { if (!stale(token)) buildHero(hero, items); }).catch(() => hero.remove());

  view.appendChild(row(t('shortcuts'), await api('shortcuts', lang)));
  const shortcutsRow = view.lastChild;

  const cont = progress.list(lang);
  if (cont.length) view.appendChild(row(t('continue_watching'), cont));

  const favs = await loadFavorites();
  if (favs.length) view.appendChild(row('♥ ' + t('favorites'), favoriteCards(favs), { viewAll: { kind: 'tile', action: { open: 'favorites', title: t('favorites') } } }));

  // Serie destacada
  const gnRow = row('★ ' + t('gn_title'), null);
  view.appendChild(gnRow);
  api('gnHome', lang).then(async (gn) => {
    if (stale(token)) return;
    const fresh = goodNews.newEpisodes(gn.episodes);
    const eps = [...gn.episodes].reverse();
    gnRow.setTitle('★ ' + gn.name);
    if (fresh.length) { const b = el('span', 'badge-new', t('gn_new_badge')); gnRow.firstChild.insertBefore(b, gnRow.firstChild.children[1] || null); }
    const more = el('button', 'more', t('view_all') + ' ›');
    more.onclick = () => push({ type: 'route', route: 'goodnews', title: gn.name });
    gnRow.firstChild.appendChild(more);
    gnRow.fill(eps);
    shortcutsRow.fill(await api('shortcuts', lang)); // imagen del tráiler
    if (fresh.length) {
      const newest = fresh[fresh.length - 1];
      toast(t('gn_new_title') + ': ' + newest.title, t('gn_watch'), () => push({ type: 'route', route: 'goodnews', title: gn.name }));
      goodNews.notifyOnce(fresh);
    }
  }).catch(() => gnRow.remove());

  const latest = row(t('latest'), null);
  view.appendChild(latest);
  api('latest', lang).then((items) => { if (!stale(token)) items.length ? latest.fill(items) : latest.remove(); }).catch(() => latest.remove());

  const home = await api('home', lang);
  if (stale(token)) return;
  // Las filas de categorías se cargan cuando aparecen en pantalla.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const r = e.target;
      api('rowItems', lang, r.dataset.key, r.dataset.latest !== 'false').then((res) => {
        if (stale(token)) return;
        if (!res.items.length) { r.remove(); return; }
        r.fill(res.items);
        if (res.viewAll) {
          const more = el('button', 'more', t('view_all') + ' ›');
          more.onclick = () => openItem(res.viewAll, []);
          r.firstChild.appendChild(more);
        }
      }).catch(() => r.remove());
    }
  }, { root: view, rootMargin: '600px' });
  for (const h of home.rows) {
    const r = row(h.title, null);
    r.dataset.key = h.id;
    r.dataset.latest = h.latest === false ? 'false' : 'true';
    view.appendChild(r);
    io.observe(r);
  }
}

let heroTimer = null;
function buildHero(hero, items) {
  clearInterval(heroTimer);
  if (!items.length) { hero.remove(); return; }
  const slides = items.slice(0, 6);
  const info = el('div', 'hero-info');
  const dots = el('div', 'hero-dots');
  let current = 0;
  const show = (i) => {
    current = i;
    hero.querySelectorAll('.hero-slide').forEach((s, k) => s.classList.toggle('show', k === i));
    dots.querySelectorAll('span').forEach((d, k) => d.classList.toggle('on', k === i));
    const m = slides[i];
    info.innerHTML = '';
    info.appendChild(el('h1', null, m.title));
    if (m.description) info.appendChild(el('p', null, m.description));
    const b = el('button', 'btn btn-primary');
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    b.appendChild(document.createTextNode(t('play')));
    b.onclick = () => { const p = progress.get(m); play([m], 0, p ? p.pos : 0); };
    const d = el('button', 'btn btn-secondary', 'ⓘ');
    d.onclick = () => push({ type: 'details', item: m });
    info.append(b, document.createTextNode(' '), d);
  };
  slides.forEach((m, i) => {
    const s = el('div', 'hero-slide');
    s.style.backgroundImage = `url("${m.images.backdrop || m.images.card}")`;
    hero.appendChild(s);
    const dot = el('span'); dot.onclick = () => show(i); dots.appendChild(dot);
  });
  hero.append(info, dots);
  show(0);
  heroTimer = setInterval(() => { if (document.body.contains(hero)) show((current + 1) % slides.length); else clearInterval(heroTimer); }, 9000);
}

// Tráiler sin sonido que se repite arriba de la pantalla (Las buenas noticias, como en jw.org).
function previewHero(m) {
  const hero = el('div', 'hero preview-hero');
  const s = el('div', 'hero-slide show');
  s.style.backgroundImage = `url("${m.images.backdrop || m.images.card}")`;
  const files = m.files.filter((f) => f.height > 0 && f.height <= 480).sort((a, b) => b.height - a.height);
  const file = files[0] || m.files[0];
  const v = document.createElement('video');
  v.className = 'hero-video';
  v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true; v.preload = 'auto';
  v.src = file.url;
  v.addEventListener('playing', () => v.classList.add('on'));
  // Se detiene al cambiar de pantalla o si la ventana se minimiza.
  const vis = () => { if (!document.body.contains(hero)) { v.pause(); v.removeAttribute('src'); v.load(); document.removeEventListener('visibilitychange', vis); return; } if (document.hidden) v.pause(); else v.play().catch(() => {}); };
  document.addEventListener('visibilitychange', vis);
  // Mientras el reproductor está abierto, la vista previa espera; al cerrarlo, sigue.
  const watch = setInterval(() => {
    if (!document.body.contains(hero)) { clearInterval(watch); vis(); return; }
    const busy = !$('#player').hidden || document.hidden;
    if (busy && !v.paused) v.pause();
    else if (!busy && v.paused) v.play().catch(() => {});
  }, 1000);
  const info = el('div', 'hero-info');
  info.appendChild(el('h1', null, m.title));
  if (m.description) info.appendChild(el('p', null, m.description));
  const b = el('button', 'btn btn-primary');
  b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  b.appendChild(document.createTextNode(t('play')));
  b.onclick = () => { v.pause(); play([m], 0, 0); };
  info.appendChild(b);
  hero.append(s, v, info);
  return hero;
}

// ---------------- Pantallas (reunión, Biblia, categorías...) ----------------
async function renderRoute(route, title, token) {
  view.appendChild(el('div', 'page-title', title || ''));
  const loading = el('div', 'message', t('loading'));
  view.appendChild(loading);
  const data = await api('screen', prefs.lang, route);
  if (stale(token)) return;
  loading.remove();
  if (data.title && view.firstChild) view.firstChild.textContent = data.title;
  if (route === 'goodnews' && data.episodes) goodNews.markSeen(data.episodes);
  if (data.preview) view.appendChild(previewHero(data.preview));
  const rows = (data.rows || []).filter((r) => r.header || r.items.length);
  if (!rows.length) { view.appendChild(el('div', 'message', data.message || t('error_loading'))); return; }
  for (const r of rows) {
    if (r.header) view.appendChild(el('div', 'section-header', r.title));
    else if (r.grid) view.appendChild(grid(rows.length > 1 ? r.title : '', r.items, r.items.every((x) => x.kind === 'tile' && x.compact)));
    else view.appendChild(row(r.title, r.items, { viewAll: r.viewAll }));
  }
}

// ---------------- Ficha del video ----------------
function renderDetails(m) {
  const d = el('div', 'details');
  const bg = el('div', 'details-bg'); bg.style.backgroundImage = `url("${m.images.backdrop || m.images.card}")`;
  const body = el('div', 'details-body');
  body.appendChild(el('h1', null, m.title));
  body.appendChild(el('div', 'meta', [m.durationText, m.published].filter(Boolean).join('   ·   ')));
  const buttons = el('div', 'buttons');
  const p = progress.get(m);
  const playBtn = el('button', 'btn btn-primary');
  playBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  playBtn.appendChild(document.createTextNode(p ? t('resume', fmtTime(p.pos)) : t('play')));
  playBtn.onclick = () => play([m], 0, p ? p.pos : 0);
  buttons.appendChild(playBtn);
  if (p) { const r = el('button', 'btn btn-secondary', t('restart')); r.onclick = () => play([m], 0, 0); buttons.appendChild(r); }
  // ♥ Agregar a Mis favoritos / Quitar
  const favBtn = el('button', 'btn btn-secondary fav-detail');
  const paintFav = () => { favBtn.textContent = (isFav(m) ? '♥  ' : '♡  ') + t(isFav(m) ? 'fav_remove' : 'fav_add'); favBtn.classList.toggle('on', isFav(m)); };
  paintFav();
  favBtn.onclick = async () => { await toggleFav(m); paintFav(); };
  buttons.appendChild(favBtn);
  body.appendChild(buttons);
  if (m.description) body.appendChild(el('div', 'desc', m.description));
  d.append(bg, body);
  view.appendChild(d);
  setTimeout(() => playBtn.focus(), 50);
}

// ---------------- Buscar (palabras + filtros de tema y fecha) ----------------
const searchState = { q: '', topic: '', year: '', month: '', sort: 'newest' };
let searchOptionsCache = null;
function mkSelect(options, value, onChange, cls) {
  const sel = el('select', cls);
  options.forEach(([v, label]) => { const o = el('option', null, label); o.value = v; if (String(v) === String(value)) o.selected = true; sel.appendChild(o); });
  sel.onchange = () => onChange(sel.value);
  return sel;
}
async function renderSearch() {
  api('crawl', prefs.lang);
  const box = el('div', 'search-box');
  box.innerHTML = '<svg class="line-icon" viewBox="0 0 24 24" style="color:var(--muted)"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></svg>';
  const input = el('input'); input.placeholder = t('search_hint'); input.value = searchState.q;
  box.appendChild(input);
  view.appendChild(box);
  const filters = el('div', 'filters');
  view.appendChild(filters);
  const info = el('div', 'result-count');
  const results = el('div');
  view.append(info, results);
  let timer = null, seq = 0;
  const run = async () => {
    searchState.q = input.value.trim();
    const my = ++seq;
    results.innerHTML = ''; info.textContent = '';
    const active = searchState.q.length >= 2 || searchState.topic || searchState.year || searchState.month;
    clearBtn.hidden = !(searchState.topic || searchState.year || searchState.month || searchState.sort !== 'newest');
    if (!active) {
      let example = '';
      try { example = new Intl.DateTimeFormat(S._locale, { month: 'long', year: 'numeric' }).format(new Date(new Date().getFullYear(), 0, 15)); } catch (e) { example = String(new Date().getFullYear()); }
      results.appendChild(el('div', 'message', t('search_hint_filters', example)));
      return;
    }
    results.appendChild(el('div', 'message', t('search_preparing')));
    let r;
    try { r = await api('search', prefs.lang, { ...searchState, year: Number(searchState.year) || 0, month: Number(searchState.month) || 0 }); }
    catch (e) { if (my === seq) { results.innerHTML = ''; results.appendChild(el('div', 'message', t('error_loading'))); } return; }
    if (my !== seq) return;
    results.innerHTML = '';
    info.textContent = r.total ? plural('results_count', r.total) : '';
    if (r.typedDate) {
      // Fecha entendida de lo escrito ("enero 2025").
      let d = String(r.typedDate.year);
      try { d = new Intl.DateTimeFormat(S._locale, r.typedDate.month ? { month: 'long', year: 'numeric' } : { year: 'numeric' }).format(new Date(r.typedDate.year, (r.typedDate.month || 1) - 1, 15)); } catch (e) { /* año solo */ }
      const chip = el('span', 'date-chip');
      chip.innerHTML = '<svg class="line-icon" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
      chip.appendChild(document.createTextNode(d));
      info.appendChild(chip);
    }
    if (r.categories.length) results.appendChild(row(t('categories'), r.categories));
    if (r.results.length) results.appendChild(grid(r.categories.length ? t('search_results') : '', r.results, false, { date: true }));
    if (!r.categories.length && !r.results.length) results.appendChild(el('div', 'message', t('no_results')));
  };
  const wrap = (label, control) => { const l = el('label', null, label); l.appendChild(control); filters.appendChild(l); return control; };
  const clearBtn = el('button', 'clear', t('filters_clear'));
  try {
    if (!searchOptionsCache || searchOptionsCache.lang !== prefs.lang) searchOptionsCache = { lang: prefs.lang, ...(await api('searchOptions', prefs.lang)) };
    const o = searchOptionsCache;
    wrap(t('filter_topic'), mkSelect([['', t('filter_all_topics')]].concat(o.topics.map((x) => [x.key, x.name])), searchState.topic, (v) => { searchState.topic = v; run(); }));
    wrap(t('filter_year'), mkSelect([['', t('filter_any_year')]].concat(o.years.map((y) => [y, String(y)])), searchState.year, (v) => { searchState.year = v; run(); }));
    wrap(t('filter_month'), mkSelect([['', t('filter_any_month')]].concat(o.months.map((m) => [m.value, m.name])), searchState.month, (v) => { searchState.month = v; run(); }));
    wrap(t('filter_sort'), mkSelect([['newest', t('sort_newest')], ['oldest', t('sort_oldest')]], searchState.sort, (v) => { searchState.sort = v; run(); }));
  } catch (e) { /* sin filtros si el catálogo no carga */ }
  clearBtn.onclick = () => { Object.assign(searchState, { topic: '', year: '', month: '', sort: 'newest' }); render(); };
  filters.appendChild(clearBtn);
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 600); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
  setTimeout(() => input.focus(), 30);
  run();
}

// ---------------- Ajustes ----------------
async function renderSettings() {
  view.appendChild(el('div', 'page-title', t('settings')));
  const s = el('div', 'settings');
  const setting = (label, hint, control) => {
    const r = el('div', 'setting');
    const l = el('label', null, label); if (hint) l.appendChild(el('small', null, hint));
    r.append(l, control); s.appendChild(r);
  };
  // Idioma del contenido: abre un buscador con todos los idiomas de JW.ORG.
  const langs = await languageList();
  const current = langs.find((l) => l.code === prefs.lang);
  const langBtn = el('button', 'pill', current ? `${current.vern} (${current.name})` : prefs.lang);
  langBtn.onclick = () => languagePicker();
  setting(t('language_title'), null, langBtn);
  const uiLangs = await api('uiLanguages');
  setting(t('ui_language_title'), null, mkSelect([['', t('ui_language_auto')]].concat(uiLangs.map((l) => [l.code, l.name])), prefs.uiLang, async (v) => {
    prefs.uiLang = v; await applyLanguage(); setTab('settings');
  }));
  const seg = el('div', 'segmented');
  [['auto', 'theme_auto', AUTO], ['light', 'theme_day', SUN], ['dark', 'theme_night', MOON]].forEach(([v, key, icon]) => {
    const b = el('button', prefs.theme === v ? 'on' : '');
    b.innerHTML = icon; b.appendChild(document.createTextNode(t(key)));
    b.onclick = () => { setTheme(v); setTab('settings'); };
    seg.appendChild(b);
  });
  setting(t('theme_title'), null, seg);
  setting(t('quality_title'), null, mkSelect([1080, 720, 480, 360, 240].map((q) => [q, q + 'p']), prefs.quality, (v) => { prefs.quality = Number(v); }));
  const sw = el('button', 'switch' + (prefs.subtitles ? ' on' : ''));
  sw.onclick = () => { prefs.subtitles = !prefs.subtitles; sw.classList.toggle('on', prefs.subtitles); };
  setting(t('subtitles_title'), t('subtitles_summary'), sw);
  // Copia de seguridad de "Mis favoritos"
  s.appendChild(el('h3', 'settings-section', t('backup_title')));
  if (!WEB) {
    const ds = await api('driveStatus');
    const driveBtn = el('button', 'pill', ds.connected ? t('drive_connected', ds.email || '✓') : t('drive_connect'));
    driveBtn.onclick = () => driveDialog();
    setting('☁  Google Drive', t('drive_summary'), driveBtn);
  }
  const exp = el('button', 'pill', t('backup_export'));
  exp.onclick = async () => { const f = await window.bp.favExportFile(); if (f) toast(t('backup_exported', f)); };
  const imp = el('button', 'pill', t('backup_import'));
  imp.onclick = async () => {
    const n = await window.bp.favImportFile();
    if (n === null) return;
    if (n < 0) toast(t('backup_invalid')); else { await loadFavorites(); toast(t('backup_imported', n)); }
  };
  const fileBtns = el('div', 'pill-group'); fileBtns.append(exp, imp);
  setting('', null, fileBtns);
  if (!WEB) {
    const upd = el('button', 'pill', t('update_check'));
    upd.onclick = () => updates.check(true);
    setting(t('update_check'), null, upd);
  }
  const about = el('div', 'about');
  const logo = el('img'); logo.src = ASSETS + 'logo.png'; about.appendChild(logo);
  about.appendChild(el('p', null, t('about')));
  if (!WEB) about.appendChild(el('p', null, t('portable_note')));
  about.appendChild(el('p', null, t('version', await window.bp.version())));
  s.appendChild(about);
  view.appendChild(s);
}

// ---------------- Idiomas ----------------
let langCache = null;
async function languageList() { if (!langCache || langCache.ui !== S._ui) langCache = { ui: S._ui, list: await api('languages', prefs.lang) }; return langCache.list; }
async function languagePicker() {
  const langs = await languageList();
  const box = el('div', 'lang-picker');
  const input = el('input', 'lang-filter'); input.placeholder = t('language_search');
  const list = el('div', 'lang-list');
  box.append(input, list);
  const fill = () => {
    const q = input.value.trim().toLowerCase().normalize('NFD').replace(/\p{Mn}+/gu, '');
    const n = (x) => x.toLowerCase().normalize('NFD').replace(/\p{Mn}+/gu, '');
    const match = (l) => !q || n(l.vern).includes(q) || n(l.name).includes(q) || l.code.toLowerCase() === q;
    list.innerHTML = '';
    for (const [title, group] of [[t('languages_spoken'), langs.filter((l) => !l.sign)], [t('languages_sign'), langs.filter((l) => l.sign)]]) {
      const items = group.filter(match);
      if (!items.length) continue;
      list.appendChild(el('div', 'lang-group', title));
      for (const l of items.slice(0, 400)) {
        const b = el('button', l.code === prefs.lang ? 'on' : '');
        b.appendChild(el('span', null, l.vern));
        b.appendChild(el('small', null, l.name));
        b.onclick = async () => { closeDialog(); prefs.lang = l.code; await api('clearCache'); searchOptionsCache = null; await applyLanguage(); setTab(currentTab); };
        list.appendChild(b);
      }
    }
  };
  input.addEventListener('input', fill);
  fill();
  dialog(t('language_title'), [box]);
  setTimeout(() => input.focus(), 30);
}

// ---------------- Modo día / noche ----------------
const SUN = '<svg class="line-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/></svg>';
const MOON = '<svg class="line-icon" viewBox="0 0 24 24"><path d="M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z"/></svg>';
const AUTO = '<svg class="line-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>';
function setTheme(v) {
  prefs.theme = v;
  const real = resolveTheme(v);
  document.documentElement.dataset.theme = real;
  const b = $('#theme-btn');
  b.innerHTML = real === 'dark' ? SUN : MOON;
  b.title = real === 'dark' ? t('theme_day') : t('theme_night');
}
// El botón de la barra cambia entre día y noche; "Automático" se elige en Ajustes.
$('#lang-btn').onclick = () => languagePicker();
$('#theme-btn').onclick = () => setTheme(resolveTheme(prefs.theme) === 'dark' ? 'light' : 'dark');
darkQuery.addEventListener('change', () => { if (prefs.theme === 'auto') setTheme('auto'); });

// ---------------- Reproductor ----------------
const player = $('#player'), video = $('#video'), art = $('#player-art');
let queue = [], qIndex = 0, isLive = false, saveTimer = null, idleTimer = null;

function bestFile(m) {
  const q = prefs.quality;
  if (!m.files.length) return null;
  if (m.isAudio) return m.files.find((f) => !f.mime.startsWith('video')) || m.files[0];
  const vids = m.files.filter((f) => f.mime.startsWith('video') || /\.mp4$/i.test(f.url));
  const list = vids.length ? vids : m.files;
  const ok = list.filter((f) => f.height > 0 && f.height <= q).sort((a, b) => b.height - a.height);
  return ok[0] || [...list].sort((a, b) => (a.height || 1e9) - (b.height || 1e9))[0];
}

async function play(items, index, position, live = false) {
  if (!items.length) return;
  if (tv.connected) { tv.play(items, index, position); return; }
  queue = items; qIndex = Math.max(0, Math.min(index, items.length - 1)); isLive = live;
  player.hidden = false;
  await loadCurrent(position || 0);
}

async function playLive() {
  if (tv.connected) { tv.live(); return; }
  player.hidden = false;
  $('#player-title').innerHTML = `<span class="live">●</span>${t('live_badge')}`;
  const loading = $('#player-loading'); loading.hidden = false; $('p', loading).textContent = t('live_loading');
  video.removeAttribute('src'); video.load();
  try {
    const s = await api('live', prefs.lang);
    loading.hidden = true;
    if (!s) throw new Error();
    queue = s.items; qIndex = 0; isLive = true;
    await loadCurrent(s.position);
  } catch (e) { loading.hidden = true; closePlayer(); toast(t('error_loading')); }
}

async function loadCurrent(position) {
  const m = queue[qIndex];
  const file = bestFile(m);
  if (!file) { toast(t('playback_error')); return next(); }
  $('#player-loading').hidden = true;
  const title = $('#player-title');
  title.textContent = m.title;
  if (isLive) { const s = el('span', 'live', '● ' + t('live_badge') + '  '); title.prepend(s); }
  player.classList.toggle('audio', m.isAudio);
  art.hidden = !m.isAudio;
  if (m.isAudio) art.src = m.images.square || m.images.card || ASSETS + 'tile_bible_audio.png';
  $('#player-prev').hidden = qIndex === 0;
  $('#player-next').hidden = qIndex >= queue.length - 1;
  video.querySelectorAll('track').forEach((tr) => { if (tr.src.startsWith('blob:')) URL.revokeObjectURL(tr.src); tr.remove(); });
  video.src = file.url;
  const sub = file.subtitles || (m.files.find((f) => f.subtitles) || {}).subtitles;
  if (sub && !m.isAudio) {
    api('subtitles', sub).then((vtt) => {
      if (!vtt || queue[qIndex] !== m) return;
      const tr = el('track'); tr.kind = 'subtitles'; tr.label = 'Subtítulos'; tr.srclang = 'es';
      tr.src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      video.appendChild(tr);
      tr.track.mode = prefs.subtitles ? 'showing' : 'hidden';
    }).catch(() => {});
  }
  video.onloadedmetadata = () => { if (position > 0 && position < video.duration - 5) video.currentTime = position; };
  video.play().catch(() => {});
  clearInterval(saveTimer);
  saveTimer = setInterval(saveProgress, 10000);
  poke();
}
function saveProgress() {
  if (isLive || player.hidden) return;
  const m = queue[qIndex]; if (!m) return;
  const pos = video.currentTime, dur = video.duration || m.duration;
  if (!dur) return;
  if (pos >= dur - 30) progress.clear(m); else if (pos > 15) progress.save(m, pos, dur);
}
function next() { saveProgress(); if (qIndex < queue.length - 1) { if (!isLive) progress.clear(queue[qIndex]); qIndex++; loadCurrent(0); } else closePlayer(); }
function prev() { saveProgress(); if (qIndex > 0) { qIndex--; loadCurrent(0); } }
function closePlayer() {
  saveProgress();
  clearInterval(saveTimer);
  video.pause(); video.removeAttribute('src'); video.load();
  player.hidden = true;
  window.bp.setFullscreen(false);
  if (currentTab === 'home' && !stack.length) render(); // actualiza "Continuar viendo"
}
video.addEventListener('ended', () => { if (!isLive) progress.clear(queue[qIndex]); next(); });
video.addEventListener('error', () => { if (!player.hidden && video.getAttribute('src')) toast(t('playback_error')); });
$('#player-close').onclick = closePlayer;
$('#player-next').onclick = next;
$('#player-prev').onclick = prev;
$('#player-full').onclick = () => window.bp.setFullscreen(!document.fullscreenElement && !player.classList.contains('fs'));
window.bp.onFullscreen((on) => player.classList.toggle('fs', on));
$('#player-tv').onclick = () => {
  if (tv.connected) { const pos = video.currentTime; const q = queue, i = qIndex; closePlayer(); tv.play(q, i, pos); }
  else tv.dialog();
};
function poke() { player.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!video.paused) player.classList.add('idle'); }, 3000); }
player.addEventListener('mousemove', poke);

// ---------------- Visor de imágenes ----------------
const viewer = { urls: [], captions: [], i: 0 };
function openViewer(urls, captions, index) { viewer.urls = urls; viewer.captions = captions || []; viewer.i = index || 0; $('#viewer').hidden = false; showImage(); }
function viewerTarget() { return { kind: 'image', url: viewer.urls[viewer.i], caption: viewer.captions[viewer.i] || '', title: viewer.captions[viewer.i] || '' }; }
function paintViewerFav() {
  const b = $('#viewer-fav'); const on = isFav(viewerTarget());
  b.textContent = on ? HEART_ON : HEART_OFF; b.classList.toggle('on', on); b.title = t(on ? 'fav_remove' : 'fav_add');
}
function showImage() {
  setTimeout(paintViewerFav, 0);
  $('#viewer-img').src = viewer.urls[viewer.i];
  const c = viewer.captions[viewer.i] || '';
  $('#viewer-caption').textContent = c; $('#viewer-caption').hidden = !c;
  $('#viewer-count').textContent = `${viewer.i + 1} / ${viewer.urls.length}`;
  $('#viewer-prev').hidden = viewer.i === 0; $('#viewer-next').hidden = viewer.i >= viewer.urls.length - 1;
}
const moveImage = (d) => { const n = viewer.i + d; if (n >= 0 && n < viewer.urls.length) { viewer.i = n; showImage(); } };
$('#viewer-prev').onclick = () => moveImage(-1);
$('#viewer-next').onclick = () => moveImage(1);
$('#viewer-fav').onclick = async () => { await toggleFav(viewerTarget()); paintViewerFav(); };
$('#viewer-close').onclick = () => { $('#viewer').hidden = true; };

// ---------------- Teclado ----------------
document.addEventListener('keydown', (e) => {
  if (!$('#viewer').hidden) {
    if (e.key === 'ArrowRight') moveImage(1); else if (e.key === 'ArrowLeft') moveImage(-1); else if (e.key === 'Escape') $('#viewer').hidden = true;
    return;
  }
  if (!player.hidden) {
    poke();
    if (e.key === 'Escape') { if (player.classList.contains('fs')) window.bp.setFullscreen(false); else closePlayer(); }
    else if (e.key === 'f' || e.key === 'F') $('#player-full').click();
    else if (e.key === 'n' || e.key === 'N') next();
    return;
  }
  if (!$('#dialog-backdrop').hidden) { if (e.key === 'Escape') closeDialog(); return; }
  if ((e.key === 'Escape' || (e.key === 'Backspace' && document.activeElement.tagName !== 'INPUT')) && stack.length) back();
});

// ---------------- Avisos y diálogos ----------------
let toastTimer = null;
function toast(text, actionLabel, action) {
  const tEl = $('#toast'); tEl.innerHTML = ''; tEl.appendChild(el('span', null, text));
  if (actionLabel) { const b = el('button', null, actionLabel); b.onclick = () => { tEl.hidden = true; action(); }; tEl.appendChild(b); }
  tEl.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { tEl.hidden = true; }, actionLabel ? 9000 : 4000);
}
function dialog(title, bodyNodes, buttons) {
  const d = $('#dialog'); d.innerHTML = '';
  d.appendChild(el('h3', null, title));
  bodyNodes.forEach((n) => d.appendChild(n));
  const foot = el('div', 'foot');
  const list = buttons || [[t('close'), closeDialog]];
  // Con dos o más botones, el último es la acción principal (por ejemplo "Actualizar").
  list.forEach(([label, fn], i) => { const b = el('button', list.length > 1 && i === list.length - 1 ? 'btn btn-primary' : 'btn btn-secondary', label); b.onclick = fn; foot.appendChild(b); });
  d.appendChild(foot);
  $('#dialog-backdrop').hidden = false;
}
function closeDialog() { $('#dialog-backdrop').hidden = true; }
$('#dialog-backdrop').addEventListener('click', (e) => { if (e.target.id === 'dialog-backdrop') closeDialog(); });

// ---------------- Las buenas noticias según Jesús: episodios nuevos ----------------
const goodNews = {
  newEpisodes(eps) {
    if (!store.get('gn_init', false) && eps.length) {
      const old = eps.filter((e) => Date.now() - new Date(e.published).getTime() > 30 * 86400000).map((e) => e.key);
      store.set('gn_seen', old); store.set('gn_notified', eps.map((e) => e.key)); store.set('gn_init', true);
    }
    const seen = new Set(store.get('gn_seen', []));
    return eps.filter((e) => !seen.has(e.key));
  },
  markSeen(eps) { this.newEpisodes(eps); store.set('gn_seen', [...new Set(store.get('gn_seen', []).concat(eps.map((e) => e.key)))]); },
  notifyOnce(fresh) {
    const notified = new Set(store.get('gn_notified', []));
    const todo = fresh.filter((e) => !notified.has(e.key));
    if (!todo.length) return;
    store.set('gn_notified', [...notified, ...todo.map((e) => e.key)]);
    window.bp.notify(t('gn_new_title'), todo.length > 1 ? t('gn_new_many', todo.length) : todo[0].title);
  }
};
window.bp.onOpenRoute((route) => { setTab('home'); push({ type: 'route', route, title: t('gn_title') }); });

// ---------------- Mi TV (app Broadcasting Player en el televisor) ----------------
const tv = {
  connected: null,
  refresh() {
    const b = $('#tv-btn'); b.classList.toggle('on', !!this.connected);
    $('span', b).textContent = this.connected ? this.connected.name.replace(/^Broadcasting Player \(|\)$/g, '') : t('tv_send');
  },
  async dialog() {
    if (this.connected) return this.remote();
    dialog(t('tv_link_title'), [el('p', null, t('loading'))], [[t('close'), closeDialog]]);
    const list = await window.bp.tvList();
    if (!list.length) {
      dialog(t('tv_link_title'), [el('p', null, t('tv_none_found'))], [[t('close'), closeDialog], [t('retry'), () => this.dialog()]]);
      return;
    }
    const box = el('div', 'list');
    list.forEach((device) => {
      const b = el('button', null, device.name);
      b.onclick = () => {
        this.connected = device; this.refresh(); closeDialog(); toast(t('tv_connected', device.name));
        if (this.pendingWeb) { const url = this.pendingWeb; this.pendingWeb = null; this.send('/web', { url }, t('jwstream_sent', device.name)); }
      };
      box.appendChild(b);
    });
    dialog(t('tv_link_title'), [box]);
  },
  remote() {
    const box = el('div', 'list');
    const cmds = [['remote_toggle', { cmd: 'toggle' }], ['remote_back', { cmd: 'seek', deltaMs: -10000 }], ['remote_forward', { cmd: 'seek', deltaMs: 30000 }],
      ['remote_next', { cmd: 'next' }], ['remote_stop', { cmd: 'stop' }]];
    cmds.forEach(([label, body]) => { const b = el('button', null, t(label)); b.onclick = () => this.send('/control', body); box.appendChild(b); });
    const lv = el('button', null, t('remote_live')); lv.onclick = () => { this.live(); closeDialog(); }; box.appendChild(lv);
    const dc = el('button', null, t('disconnect')); dc.onclick = () => { this.connected = null; this.refresh(); closeDialog(); }; box.appendChild(dc);
    dialog(t('tv_connected', this.connected.name), [box]);
  },
  async send(path, body, okMsg) {
    const ok = await window.bp.tvSend(this.connected, path, body);
    if (ok) { if (okMsg) toast(okMsg); } else toast(t('tv_unreachable', this.connected.name));
  },
  async play(items, index, position) {
    const json = await api('toTvJson', items.slice(0, 80));
    this.send('/play', { lang: prefs.lang, index: Math.min(index, 79), position: Math.round((position || 0) * 1000), items: json }, t('playing_on', this.connected.name));
  },
  live() { this.send('/live', {}, t('playing_on', this.connected.name)); }
};
$('#tv-btn').onclick = () => tv.dialog();
$('#jworg-btn').onclick = async () => { const tiles = await api('shortcuts', prefs.lang); const j = tiles.find((x) => x.id === 'jworg'); window.bp.openExternal(j ? j.action.url : 'https://www.jw.org/'); };
$('#back').onclick = back;
document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });

// ---------------- Inicio de la app ----------------
async function applyLanguage() {
  await api('setUi', prefs.uiLang || null);
  S = await api('strings', prefs.lang);
  document.documentElement.lang = S._locale;
  document.documentElement.dir = S._rtl ? 'rtl' : 'ltr';
  const labels = { home: 'nav_home', explore: 'explore', search: 'search', settings: 'settings' };
  document.querySelectorAll('#tabs button').forEach((b) => { $('span', b).textContent = t(labels[b.dataset.tab]); });
  // Botón de idioma de la barra superior: muestra el idioma actual.
  const langBtn = $('#lang-btn');
  langBtn.title = t('language_title');
  languageList().then((list) => { const l = list.find((x) => x.code === prefs.lang); $('span', langBtn).textContent = l ? l.vern : prefs.lang; }).catch(() => {});
  $('#back').title = t('back');
  tv.refresh();
  setTheme(prefs.theme);
}
const loadStrings = applyLanguage;

// ---------------- JW Stream ----------------
const JWSTREAM_HOME = 'https://stream.jw.org/';
const findStreamUrl = (text) => { const m = /https:\/\/stream\.jw\.org[^\s"'<>]*/i.exec(text || ''); return m ? m[0].replace(/[.,)]+$/, '') : null; };
function jwStreamDialog() {
  const input = el('input', 'lang-filter'); input.placeholder = 'https://stream.jw.org/…';
  const go = (toTv) => {
    const text = input.value.trim();
    const url = text ? findStreamUrl(text) : JWSTREAM_HOME;
    if (!url) { toast(t('jwstream_invalid')); return; }
    closeDialog();
    if (!toTv) { window.bp.openExternal(url); return; }
    if (!tv.connected) { tv.pendingWeb = url; tv.dialog(); return; }
    tv.send('/web', { url }, t('jwstream_sent', tv.connected.name));
  };
  dialog(t('jwstream'), [el('p', null, t('jwstream_paste')), input], [
    [t('close'), closeDialog], [t('jwstream_open_here'), () => go(false)]].concat(WEB ? [] : [[t('jwstream_send_tv'), () => go(true)]]));
  setTimeout(() => input.focus(), 50);
}

// ---------------- Google Drive ----------------
async function driveDialog() {
  const st = await api('driveStatus');
  if (!st.configured) { toast(t('drive_not_configured')); return; }
  if (st.connected) {
    dialog(t('drive_connected', st.email || '✓'), [el('p', null, t('drive_summary'))], [
      [t('drive_disconnect'), async () => { await api('driveDisconnect'); closeDialog(); if (currentTab === 'settings') setTab('settings'); }],
      [t('close'), closeDialog],
      [t('drive_sync_now'), async () => { closeDialog(); await driveSyncNow(); }]
    ]);
    return;
  }
  let code;
  try { code = await window.bp.driveStart(); } catch (e) { toast(t('drive_error') + ' (' + String(e.message || e).replace(/^Error invoking remote method '[^']+': /, '').slice(0, 140) + ')'); return; }
  const big = el('div', 'device-code', code.userCode);
  dialog(t('drive_connect'), [el('p', null, t('drive_code', code.url.replace(/^https:\/\//, ''))), big, el('p', 'muted', t('drive_waiting'))], [[t('close'), closeDialog]]);
  const r = await window.bp.driveWait();
  closeDialog();
  if (!r.ok) { toast(t('drive_error')); return; }
  await afterSync(r.result);
  if (currentTab === 'settings') setTab('settings');
}
async function driveSyncNow() {
  try { await afterSync(await api('driveSync')); } catch (e) { toast(t('drive_error') + ' (' + String(e.message || e).replace(/^Error invoking remote method '[^']+': /, '').slice(0, 140) + ')'); }
}
async function afterSync(res) {
  await loadFavorites();
  if (!res) return;
  toast(res.restored > 0 ? t('drive_restored', res.restored) : t('drive_synced'));
  if (res.restored > 0 && currentTab === 'home' && !stack.length) render();
}

// ---------------- Actualizaciones ----------------
const updates = {
  /** auto = al abrir la app (respeta "Más tarde" por 24 horas); manual = botón de Ajustes. */
  async check(manual) {
    const r = await window.bp.updateCheck();
    if (!r.ok) { if (manual) toast(t('update_error')); return; }
    if (!r.info) { if (manual) toast(t('update_none')); return; }
    if (!manual && store.get('update_snooze', null) === r.info.version && Date.now() < store.get('update_snooze_until', 0)) return;
    const notes = r.info.notes[S._ui] || r.info.notes.E || '';
    const body = [el('p', null, t('update_message', r.info.version))];
    if (notes) body.push(el('p', 'update-notes', notes));
    dialog(t('update_title'), body, [
      [t('update_later'), () => { store.set('update_snooze', r.info.version); store.set('update_snooze_until', Date.now() + 86400000); closeDialog(); }],
      [t('update_now'), () => this.install(r.info, r.portable)]
    ]);
  },
  async install(info, portable) {
    if (!portable) { closeDialog(); window.bp.openExternal(info.url); return; }
    const bar = el('div', 'update-bar'); const fill = el('div'); bar.appendChild(fill);
    dialog(t('update_title'), [el('p', null, t('update_downloading')), bar], []);
    window.bp.onUpdateProgress((p) => { fill.style.width = p + '%'; });
    const r = await window.bp.updateDownload(info);
    if (!r.ok) { closeDialog(); toast(t('update_error')); return; }
    dialog(t('update_title'), [el('p', null, t('update_restart'))], []);
    setTimeout(() => window.bp.updateInstall(), 1500);
  }
};

(async () => {
  await loadStrings();
  setTab('home');
  if (WEB) { $('#tv-btn').hidden = true; $('#player-tv').hidden = true; return; }
  setTimeout(() => updates.check(false).catch(() => {}), 4000);
  // Favoritos: trae los cambios de Google Drive (por ejemplo, los marcados en la TV).
  api('driveAutoSync').then((r) => { if (r && r.restored > 0) afterSync(r); }).catch(() => {});
})();
