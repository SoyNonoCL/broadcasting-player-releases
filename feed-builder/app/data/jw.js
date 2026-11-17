'use strict';
// Acceso al catálogo público de videos y audios (el mismo que usa la web).
const { net } = require('electron');

const MEDIATOR = 'https://b.jw-cdn.org/apis/mediator/v1';
const TOKEN_URL = 'https://b.jw-cdn.org/tokens/jworg.jwt';
const SEARCH = 'https://b.jw-cdn.org/apis/search/results';
const CACHE_MS = 30 * 60 * 1000;

// ---------------- Red ----------------
let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= 4) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; const next = waiting.shift(); if (next) next(); }
}

class HttpError extends Error {
  constructor(status, url) { super(`HTTP ${status} en ${url}`); this.status = status; }
}

async function fetchRaw(url, opts = {}) {
  return withSlot(async () => {
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await net.fetch(url, {
          method: opts.method || 'GET',
          headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) BroadcastingPlayer/1.0', Accept: 'application/json, text/plain, */*' }, opts.headers || {}),
          body: opts.body
        });
        if (!res.ok) throw new HttpError(res.status, url);
        return opts.binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
      } catch (e) {
        last = e;
        if (e instanceof HttpError && e.status === 404) throw e;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
      }
    }
    throw last;
  });
}
const getText = (url, headers) => fetchRaw(url, { headers });
const getJson = async (url, headers) => JSON.parse(await getText(url, headers));
const getBinary = (url) => fetchRaw(url, { binary: true });

// ---------------- Modelos ----------------
const isHttp = (u) => typeof u === 'string' && u.startsWith('http');

function pickImage(images, types, sizes) {
  for (const t of types) {
    const bySize = images[t];
    if (!bySize) continue;
    for (const s of sizes) if (isHttp(bySize[s])) return bySize[s];
    const any = Object.values(bySize).find(isHttp);
    if (any) return any;
  }
  return null;
}
function anyImage(images) {
  for (const v of Object.values(images || {})) for (const u of Object.values(v || {})) if (isHttp(u)) return u;
  return null;
}
function imageSet(images) {
  images = images || {};
  const card = pickImage(images, ['wsr', 'wss', 'lsr', 'lss', 'pnr', 'sqr', 'sqs', 'cvr'], ['lg', 'md', 'xl', 'sm', 'xs']) || anyImage(images);
  const backdrop = pickImage(images, ['pnr', 'wsr', 'lsr', 'wss', 'lss'], ['xl', 'lg', 'md', 'sm']) || card;
  const square = pickImage(images, ['sqr', 'sqs', 'cvr'], ['lg', 'xl', 'md', 'sm']) || card;
  return { card, backdrop, square };
}

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Convierte un elemento del catálogo en un objeto simple para la interfaz. */
function normalize(o, lang) {
  if (!o) return null;
  const natural = o.naturalKey || '';
  const lank = o.languageAgnosticNaturalKey || '';
  if (!natural && !lank) return null;
  let files = (o.files || []).map((f) => {
    const url = f.progressiveDownloadURL || f.url;
    if (!url) return null;
    const m = /(\d{3,4})[pP]/.exec(f.label || '');
    return {
      url,
      label: f.label || '',
      height: m ? parseInt(m[1], 10) : (f.frameHeight || 0),
      mime: f.mimetype || '',
      subtitles: (f.subtitles && f.subtitles.url) || null
    };
  }).filter(Boolean);
  const useful = files.filter((f) => !f.mime.includes('3gp'));
  if (useful.length) files = useful;
  const duration = Number(o.duration) || 0;
  const isVideoFile = (f) => f.mime.startsWith('video') || /\.(mp4|m3u8)$/i.test(f.url);
  const isAudio = (o.type || '').toLowerCase() === 'audio' || (files.length > 0 && !files.some(isVideoFile));
  return {
    kind: 'media',
    key: lank || natural,
    naturalKey: natural,
    lang,
    type: o.type || '',
    title: o.title || '',
    description: o.description || '',
    duration,
    durationText: duration > 0 ? formatTime(duration) : (o.durationFormattedMinSec || ''),
    published: (o.firstPublished || '').slice(0, 10),
    images: imageSet(o.images),
    rawImages: o.images || {},
    files,
    isAudio
  };
}

/** Formato compacto que entiende la app de TV ("Mi TV"). */
function toTvJson(m) {
  return {
    naturalKey: m.naturalKey || m.key,
    languageAgnosticNaturalKey: m.key,
    type: m.type || (m.isAudio ? 'audio' : 'video'),
    title: m.title,
    description: m.description,
    duration: m.duration,
    firstPublished: m.published,
    images: m.rawImages || {},
    files: m.files.map((f) => Object.assign(
      { progressiveDownloadURL: f.url, label: f.label, frameHeight: f.height, mimetype: f.mime },
      f.subtitles ? { subtitles: { url: f.subtitles } } : {}))
  };
}

function parseCategory(o, lang) {
  return {
    key: o.key || '',
    name: o.name || '',
    description: o.description || '',
    type: o.type || '',
    images: imageSet(o.images),
    subcategories: (o.subcategories || []).filter((s) => s.key).map((s) => parseCategory(s, lang)),
    media: (o.media || []).map((m) => normalize(m, lang)).filter(Boolean)
  };
}

function categoryImage(c) {
  if (c.images.card) return c.images.card;
  const latest = [...c.media].sort((a, b) => b.published.localeCompare(a.published))[0];
  if (latest && latest.images.card) return latest.images.card;
  for (const s of c.subcategories) { const i = categoryImage(s); if (i) return i; }
  return null;
}

function latestMedia(c, limit) {
  const all = [...c.media, ...c.subcategories.flatMap((s) => s.media)];
  const seen = new Set();
  return all.filter((m) => !seen.has(m.key) && seen.add(m.key))
    .sort((a, b) => b.published.localeCompare(a.published))
    .slice(0, limit);
}

// ---------------- Índice en memoria y catálogo ----------------
const index = new Map();
const catTop = new Map(); // "lang|categoría" → tema principal (subcategoría de VideoOnDemand o Audio)
function addToIndex(m, top) {
  if (!m) return;
  const prev = index.get(`${m.lang}|${m.key}`);
  if (prev && prev !== m) m.topics = prev.topics;
  if (!m.topics) m.topics = [];
  if (top && !m.topics.includes(top)) m.topics.push(top);
  index.set(`${m.lang}|${m.key}`, m);
  if (m.naturalKey) index.set(`${m.lang}|${m.naturalKey}`, m);
}
function indexCategory(c, lang, top) {
  if (top) catTop.set(`${lang}|${c.key}`, top);
  c.media.forEach((m) => addToIndex(m, top));
  c.subcategories.forEach((s) => indexCategory(s, lang, top));
}
const fromIndex = (lang, key) => index.get(`${lang}|${key}`) || null;
const TOP_ROOTS = ['VideoOnDemand', 'Audio'];
/** Tema principal de una categoría ya vista (null si no se sabe). */
const topOf = (lang, key) => catTop.get(`${lang}|${key}`) || null;
function setTop(lang, key, top) { catTop.set(`${lang}|${key}`, top); }
function indexedMedia(lang) {
  const seen = new Set();
  const out = [];
  for (const [k, m] of index) if (k.startsWith(lang + '|') && !seen.has(m.key) && seen.add(m.key)) out.push(m);
  return out;
}

const cache = new Map();
const pending = new Map();

async function category(lang, key, force = false) {
  const ck = `${lang}/${key}`;
  const hit = cache.get(ck);
  if (!force && hit && Date.now() - hit.t < CACHE_MS) return hit.c;
  if (!force && pending.has(ck)) return pending.get(ck);
  const p = (async () => {
    const json = await getJson(`${MEDIATOR}/categories/${lang}/${encodeURIComponent(key)}?detailed=1&clientType=www`);
    if (!json.category) throw new Error('Categoría no encontrada: ' + key);
    const c = parseCategory(json.category, lang);
    if (key === 'Audio') setTop(lang, key, 'Audio');
    if (key === 'VideoOnDemand') c.subcategories.forEach((sc) => setTop(lang, sc.key, sc.key));
    indexCategory(c, lang, topOf(lang, key));
    cache.set(ck, { t: Date.now(), c });
    return c;
  })();
  pending.set(ck, p);
  try { return await p; } finally { pending.delete(ck); }
}
const cachedCategory = (lang, key) => (cache.get(`${lang}/${key}`) || {}).c || null;
function clearCache() { cache.clear(); }

async function mediaItem(lang, key) {
  const known = fromIndex(lang, key);
  if (known) return known;
  try {
    const json = await getJson(`${MEDIATOR}/media-items/${lang}/${encodeURIComponent(key)}?clientType=www`);
    const m = normalize((json.media || [])[0], lang);
    addToIndex(m);
    return m;
  } catch (e) {
    return null;
  }
}

// ---------------- Búsqueda ----------------
let token = null, tokenAt = 0;
const clean = (t) => String(t || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
function collectHits(node, lang, out) {
  if (Array.isArray(node)) { node.forEach((n) => collectHits(n, lang, out)); return; }
  if (!node || typeof node !== 'object') return;
  const lank = node.lank || node.languageAgnosticNaturalKey;
  const title = clean(node.title);
  if (lank && title && !out.has(lank)) {
    const img = (node.image && isHttp(node.image.url) && node.image.url) || imageSet(node.images).card;
    out.set(lank, { kind: 'hit', lank, title, snippet: clean(node.snippet), image: img, lang, categoryKey: lank.startsWith('mc-') ? lank.slice(3) : null });
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') collectHits(v, lang, out);
}
/** Búsqueda en el buscador de la web (varias páginas de videos y una de audio). */
async function search(lang, query) {
  if (!token || Date.now() - tokenAt > 15 * 60 * 1000) { token = (await getText(TOKEN_URL)).trim(); tokenAt = Date.now(); }
  const hits = new Map();
  const pages = [['videos', 0], ['videos', 24], ['videos', 48], ['audio', 0]];
  await Promise.all(pages.map(async ([filter, offset]) => {
    try {
      const body = await getJson(`${SEARCH}/${lang}/${filter}?q=${encodeURIComponent(query)}&offset=${offset}`, { Authorization: `Bearer ${token}` });
      collectHits(body.results || body, lang, hits);
    } catch (e) { /* se sigue con lo encontrado */ }
  }));
  return [...hits.values()];
}

// Coincidencia por palabras: sin tildes ni mayúsculas, palabra completa (se aceptan plurales cortos:
// "enero" encuentra "enero" y "eneros", pero no "género" ni "queremos").
const NO_SPACES = /[\u0E00-\u0E7F\u0E80-\u0EFF\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/;
function normText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/\p{Mn}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function queryWords(q) { return normText(q).split(' ').filter(Boolean); }
function matchesWords(text, words) {
  if (!words.length) return true;
  const norm = normText(text);
  const tokens = norm.split(' ');
  return words.every((w) => {
    if (NO_SPACES.test(w)) return norm.includes(w);
    // Palabras que empiezan así ("familia" → familia, familias, familiar). Las de 1-2 letras deben ser exactas.
    return tokens.some((tk) => tk === w || (w.length >= 3 && tk.startsWith(w)));
  });
}

module.exports = {
  HttpError, getText, getJson, getBinary, normalize, toTvJson, formatTime, imageSet,
  category, cachedCategory, clearCache, mediaItem, search, addToIndex, fromIndex, indexedMedia, topOf, setTop,
  normText, queryWords, matchesWords,
  categoryImage, latestMedia
};
