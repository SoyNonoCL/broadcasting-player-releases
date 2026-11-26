'use strict';
// Funciones que la interfaz puede pedir al proceso principal (pantallas y datos).
const jw = require('./jw');
const favorites = require('./favorites');
const drive = require('./drive');
const pubs = require('./pubs');
const i18n = require('../i18n.json');
const bookNames = require('./bible_books.json');
const study = require('./study_bible_videos.json');

const ALL_LANGS = require('./languages.json');
const LANG_BY_CODE = new Map(ALL_LANGS.map((l) => [l.code, l]));
const MAX_ROW = 40;
const GN = { KEY: 'SeriesGoodNews', KEY_AD: 'SeriesGoodNewsAD', TRAILER: 'pub-gnj_900_VIDEO', TRAILER_AD: 'pub-gnj_950_VIDEO' };
const COLOR = { hebrew: '#3F5F8F', greek: '#3E7066', study: '#5D4F80', older: '#7B5B3B', accent: '#4A6DA7' };

// Idioma de los menús: el del contenido si está traducido; si no, uno cercano; si no, inglés.
const UI_BY_LOCALE = { es: 'S', en: 'E', pt: 'T', ru: 'U', fr: 'F', de: 'X', it: 'I', ja: 'J', ko: 'KO', nl: 'O', pl: 'P', uk: 'K', ro: 'M',
  hu: 'H', cs: 'B', el: 'G', tr: 'TK', ar: 'A', id: 'IN', tl: 'TG', fil: 'TG', vi: 'VT', th: 'SI', hi: 'HI', sw: 'SW', sv: 'Z', no: 'N', nb: 'N', nn: 'N', da: 'D', fi: 'FI' };
const SIGN_HINTS = [
  [/argentin|bolivi|chile|colombi|costa ric|cuba|dominican|ecuador|salvador|guatemal|hondur|mexic|nicaragu|panam|paragua|peru|puerto ric|spanish|spain|urugua|venezuel/, 'S'],
  [/brazil|portug|angol|mozambi/, 'T'], [/french|quebec|ivor|congo|camero|senegal|haiti|burkina|benin|gabon|togo|madagas/, 'F'],
  [/german|austria|swiss/, 'X'], [/italian/, 'I'], [/russian/, 'U'], [/ukrain/, 'K'], [/japanese/, 'J'], [/korean/, 'KO'],
  [/chinese|taiwan|hong kong/, 'CH'], [/dutch|flemish/, 'O'], [/polish/, 'P'], [/romanian/, 'M'], [/hungarian/, 'H'], [/czech/, 'B'],
  [/greek/, 'G'], [/turkish/, 'TK'], [/indonesian/, 'IN'], [/filipino|philippine/, 'TG'], [/vietnam/, 'VT'], [/thai/, 'SI'],
  [/indian/, 'HI'], [/kenyan|tanzanian/, 'SW'], [/swedish/, 'Z'], [/norwegian/, 'N'], [/danish/, 'D'], [/finnish/, 'FI'],
  [/arab|egypt|jordan|leban|syria|iraq|saudi|moroc|tunisi|algeri|libya|sudan/, 'A']
];
let uiOverride = null;
function ui(lang) {
  if (uiOverride && i18n[uiOverride]) return uiOverride;
  if (i18n[lang]) return lang;
  const info = LANG_BY_CODE.get(lang);
  if (!info) return 'E';
  if (info.locale === 'cmn_hans') return 'CHS';
  if (/^(cmn|yue)/.test(info.locale)) return 'CH';
  if (info.sign) { const hit = SIGN_HINTS.find(([re]) => re.test(info.name.toLowerCase())); return hit ? hit[1] : 'E'; }
  return UI_BY_LOCALE[info.locale.split('_')[0]] || 'E';
}
/** Código de idioma para fechas y números (Intl). */
function intlLocale(code) {
  const info = LANG_BY_CODE.get(code);
  if (!info || info.sign) return code === 'E' ? 'en' : intlLocale(ui(code) === code ? 'E' : ui(code));
  const map = { cmn_hans: 'zh-Hans', cmn_hant: 'zh-Hant', yue_hant: 'zh-Hant-HK', yue_hans: 'zh-Hans' };
  return map[info.locale] || info.locale.replace(/_/g, '-');
}
const webLocale = (lang) => ((LANG_BY_CODE.get(lang) || { locale: 'en' }).locale).replace(/_/g, '-');

function t(lang, key, ...args) {
  const u = ui(lang);
  let s = (i18n[u] || {})[key] || i18n.E[key] || key;
  args.forEach((a, i) => { s = s.split(`{${i + 1}}`).join(String(a)); });
  return s;
}
function plural(lang, key, n) {
  const u = ui(lang);
  const forms = (i18n[u] || {})['pl_' + key] || i18n.E['pl_' + key] || {};
  let q = 'other';
  try { q = new Intl.PluralRules(intlLocale(u)).select(n); } catch (e) { q = n === 1 ? 'one' : 'other'; }
  return (forms[q] || forms.other || '{1}').split('{1}').join(String(n));
}
function strings(lang) { return Object.assign({}, i18n.E, i18n[ui(lang)] || {}, { _ui: ui(lang), _locale: intlLocale(ui(lang)), _rtl: ui(lang) === 'A' }); }
const localNames = new Map();
/** Todos los idiomas de JW.ORG, con el nombre en el idioma de los menús cuando se puede. */
async function languages(lang) {
  const u = ui(lang || 'E');
  if (!localNames.has(u) && u !== 'E') {
    try {
      const json = await jw.getJson(`https://b.jw-cdn.org/apis/mediator/v1/languages/${u}/all?clientType=www`);
      localNames.set(u, new Map((json.languages || []).map((l) => [l.code, l.name])));
    } catch (e) { /* se usan los nombres en inglés */ }
  }
  const names = localNames.get(u);
  const loc = intlLocale(u);
  return ALL_LANGS.map((l) => ({ code: l.code, name: (names && names.get(l.code)) || l.name, vern: l.vern, sign: l.sign, rtl: l.rtl }))
    .sort((a, b) => a.name.localeCompare(b.name, loc));
}

const catCard = (c, viewAll = false) => ({ kind: 'category', key: c.key, name: c.name, image: jw.categoryImage(c), viewAll });
const tile = (o) => Object.assign({ kind: 'tile', subtitle: '', icon: null, image: null, text: null, color: '#2A3446', compact: false }, o);

// ---------------- Catálogo ----------------
async function rowItems(lang, key, latest = true) {
  const c = await jw.category(lang, key);
  let items = [];
  if (c.media.length) {
    const seen = new Set();
    items = c.media.filter((m) => !seen.has(m.key) && seen.add(m.key)).slice(0, MAX_ROW);
  } else if (latest) items = jw.latestMedia(c, MAX_ROW);
  if (!items.length) items = c.subcategories.map((s) => catCard(s));
  const viewAll = c.subcategories.length || c.media.length > MAX_ROW ? catCard(c, true) : null;
  return { name: c.name, items, viewAll };
}

async function mediaOf(lang, keys) {
  const all = [];
  for (const k of keys) {
    try { const c = await jw.category(lang, k); all.push(...(c.media.length ? c.media : c.subcategories.flatMap((s) => s.media))); } catch (e) { /* nada */ }
  }
  const seen = new Set();
  return all.filter((m) => !seen.has(m.key) && seen.add(m.key)).slice(0, MAX_ROW);
}

async function home(lang) {
  const vod = await jw.category(lang, 'VideoOnDemand');
  return {
    rows: vod.subcategories.map((s) => ({ id: s.key, title: s.name })).concat([{ id: 'Audio', title: t(lang, 'audio'), latest: false }])
  };
}

async function categoryScreen(lang, key) {
  const c = await jw.category(lang, key);
  if (!c.subcategories.length) {
    const seen = new Set();
    return { title: c.name, rows: [{ id: 'grid', title: '', grid: true, items: c.media.filter((m) => !seen.has(m.key) && seen.add(m.key)) }] };
  }
  const rows = [];
  if (c.media.length) rows.push({ id: '_own', title: c.name, items: c.media });
  for (const s of c.subcategories) {
    if (s.media.length) rows.push({ id: s.key, title: s.name, items: s.media, viewAll: catCard(s, true) });
    else {
      const r = await rowItems(lang, s.key, false).catch(() => null);
      if (r && r.items.length) rows.push({ id: s.key, title: s.name, items: r.items, viewAll: r.viewAll });
    }
  }
  return { title: c.name, rows };
}

// ---------------- Pantallas especiales ----------------
function cachedTrailerImage(lang) {
  const m = jw.fromIndex(lang, GN.TRAILER) || jw.fromIndex(lang, GN.TRAILER_AD);
  return m ? m.images.card : null;
}
function shortcuts(lang) {
  const img = cachedTrailerImage(lang);
  return [
    tile({ id: 'goodnews', title: t(lang, 'gn_title'), subtitle: t(lang, 'gn_subtitle'), image: img, icon: img ? null : 'tile_goodnews.png', action: { open: 'goodnews', title: t(lang, 'gn_title') } }),
    tile({ id: 'live', title: t(lang, 'live'), subtitle: t(lang, 'live_subtitle'), icon: 'tile_live.png', action: { live: true } }),
    tile({ id: 'meeting', title: t(lang, 'meeting'), subtitle: t(lang, 'meeting_subtitle'), icon: 'tile_meeting.png', action: { open: 'meeting', title: t(lang, 'meeting') } }),
    tile({ id: 'favorites', title: t(lang, 'favorites'), subtitle: t(lang, 'favorites_subtitle'), icon: 'tile_favorites.png', action: { open: 'favorites', title: t(lang, 'favorites') } }),
    tile({ id: 'categories', title: t(lang, 'categories'), icon: 'tile_categories.png', action: { open: 'categories', title: t(lang, 'categories') } }),
    tile({ id: 'bible', title: t(lang, 'bible_audio'), icon: 'tile_bible_audio.png', action: { open: 'bible', title: t(lang, 'bible_audio') } }),
    tile({ id: 'study', title: t(lang, 'study_bible'), icon: 'tile_bible_study.png', action: { open: 'study', title: t(lang, 'study_bible') } }),
    tile({ id: 'jwstream', title: t(lang, 'jwstream'), subtitle: t(lang, 'jwstream_subtitle'), icon: 'tile_jwstream.png', action: { jwstream: true } }),
    tile({ id: 'jworg', title: t(lang, 'jworg'), subtitle: t(lang, 'jworg_subtitle'), icon: 'tile_jworg.png', action: { url: `https://www.jw.org/${webLocale(lang)}/` } })
  ];
}

/** "Mis favoritos": videos, audios e imágenes marcados (de cualquier idioma). */
function favoritesScreen(lang) {
  const all = favorites.list();
  const title = t(lang, 'favorites');
  if (!all.length) return { title, rows: [], message: t(lang, 'fav_empty') + '\n' + t(lang, 'fav_hint_pc') };
  const media = all.filter((x) => x.kind === 'media');
  const images = all.filter((x) => x.kind === 'image');
  const rows = [];
  const vids = media.filter((m) => !m.isAudio), auds = media.filter((m) => m.isAudio);
  if (vids.length) rows.push({ id: 'fav_videos', title: t(lang, 'fav_videos'), grid: true, items: vids });
  if (auds.length) rows.push({ id: 'fav_audio', title: t(lang, 'audio'), grid: true, items: auds });
  if (images.length) {
    const urls = images.map((x) => x.url), caps = images.map((x) => x.caption);
    rows.push({ id: 'fav_images', title: t(lang, 'fav_images'), grid: true, items: images.map((x, i) =>
      tile({ id: 'favimg' + i, title: x.caption || x.title, subtitle: x.title, image: x.url, action: { images: urls, captions: caps, index: i } })) });
  }
  return { title, rows };
}

async function categoryCards(lang) {
  const vod = await jw.category(lang, 'VideoOnDemand');
  const audio = await jw.category(lang, 'Audio').catch(() => null);
  return vod.subcategories.map((s) => catCard(s)).concat(audio ? [catCard(audio)] : []);
}

function today(plusDays = 0) {
  const d = new Date(); d.setDate(d.getDate() + plusDays);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function weekBounds(date) {
  const mon = new Date(Math.floor(date / 10000), Math.floor(date / 100) % 100 - 1, date % 100);
  while (mon.getDay() !== 1) mon.setDate(mon.getDate() - 1);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return [mon, sun];
}
function weekRange(lang, mon, sun) {
  const u = ui(lang);
  const loc = intlLocale(u);
  const f = (d, opts) => new Intl.DateTimeFormat(loc, opts).format(d);
  const same = mon.getMonth() === sun.getMonth();
  const wd = (d) => f(d, { weekday: 'long' });
  const day = (d) => d.getDate();
  const month = (d) => f(d, { month: 'long' });
  const monthGen = (d) => f(d, { day: 'numeric', month: 'long' }); // ruso: "19 октября"
  switch (u) {
    case 'S': return `del ${wd(mon)} ${day(mon)}${same ? '' : ' de ' + month(mon)} al ${wd(sun)} ${day(sun)} de ${month(sun)}`;
    case 'E': return `${f(mon, { weekday: 'long', month: 'long', day: 'numeric' })} – ${f(sun, { weekday: 'long', month: 'long', day: 'numeric' })}`;
    case 'U': return `с ${same ? day(mon) : monthGen(mon)} по ${monthGen(sun)}`;
    case 'T': return `de ${wd(mon)} ${day(mon)}${same ? '' : ' de ' + month(mon)} a ${wd(sun)} ${day(sun)} de ${month(sun)}`;
    default:
      try { return new Intl.DateTimeFormat(loc, { weekday: /^(ja|ko|zh)/.test(loc) ? 'short' : 'long', day: 'numeric', month: 'long' }).formatRange(mon, sun); }
      catch (e) { return t(lang, 'meeting_week', monthGen(mon), monthGen(sun)); }
  }
}

async function meeting(lang) {
  const rows = [];
  let error = null;
  for (const [offset, label] of [[0, 'this_week'], [7, 'next_week']]) {
    const date = today(offset);
    const [mon, sun] = weekBounds(date);
    const weekRows = [];
    const [mid, st] = await Promise.all([pubs.midweek(lang, date).catch((e) => ({ week: null, error: e.message })), pubs.study(lang, date).catch(() => null)]);
    if (mid.week && mid.week.items.length) weekRows.push({ id: 'mid' + offset, title: t(lang, 'meeting_midweek', mid.week.title), items: mid.week.items });
    else if (offset === 0) error = mid.error;
    if (st) {
      const pics = st.pictures.map((p, i) => tile({
        id: `img${offset}-${i}`, title: p.caption || t(lang, 'picture_n', i + 1), subtitle: t(lang, 'picture_n', i + 1), image: p.thumb,
        action: { images: st.pictures.map((x) => x.url), captions: st.pictures.map((x) => x.caption), index: i }
      }));
      const items = st.items.concat(pics);
      if (items.length) weekRows.push({ id: 'wt' + offset, title: t(lang, 'meeting_weekend', st.title), items });
    }
    if (weekRows.length) {
      rows.push({ id: 'week' + offset, title: `${t(lang, label)} · ${weekRange(lang, mon, sun)}`, header: true, items: [] });
      rows.push(...weekRows);
    }
  }
  return { title: t(lang, 'meeting'), rows, message: rows.length ? null : t(lang, 'meeting_empty') + (error ? `\n\n(${error})` : '') };
}

/** Nombres de los libros en el idioma del contenido (de la lista incluida o de la Biblia en audio). */
async function namesFor(lang) {
  if (bookNames[lang]) return bookNames[lang];
  const fromAudio = await pubs.bookNames(lang).catch(() => null);
  const base = bookNames[ui(lang)] || bookNames.E;
  return fromAudio ? base.map((n, i) => fromAudio[i + 1] || n) : base;
}
const isHebrew = (b) => b >= 1 && b <= 39;

async function bibleScreen(lang, parts) {
  if (parts.length === 1) {
    const eds = await pubs.editions(lang);
    if (!eds.length) return { title: t(lang, 'bible_audio'), rows: [], message: t(lang, 'not_available') };
    const items = eds.map((e, i) => tile({
      id: 'ed-' + e.pub, title: e.name, subtitle: t(lang, i === 0 ? 'edition_current' : 'edition_previous'),
      text: (/(1[89]\d\d|20\d\d)/.exec(e.name) || [e.name])[0], color: i === 0 ? COLOR.hebrew : COLOR.older,
      action: { open: `bible/${e.pub}`, title: e.name }
    }));
    return { title: t(lang, 'bible_audio'), rows: [{ id: 'editions', title: t(lang, 'choose_edition'), grid: true, items }] };
  }
  const pub = parts[1];
  const chapters = await pubs.bible(lang, pub);
  const n = await namesFor(lang);
  if (parts.length === 2) {
    const mk = (range) => range.filter((b) => chapters[b]).map((b) => tile({
      id: 'b' + b, title: n[b - 1], subtitle: plural(lang, 'chapters_count', chapters[b].length), text: n[b - 1],
      color: isHebrew(b) ? COLOR.hebrew : COLOR.greek, compact: true, action: { open: `bible/${pub}/${b}`, title: n[b - 1] }
    }));
    const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
    const eds = await pubs.editions(lang);
    return {
      title: (eds.find((e) => e.pub === pub) || {}).name || t(lang, 'bible_audio'),
      rows: [
        { id: 'heb', title: t(lang, 'hebrew_scriptures'), grid: true, items: mk(range(1, 39)) },
        { id: 'grk', title: t(lang, 'greek_scriptures'), grid: true, items: mk(range(40, 66)) }
      ].filter((r) => r.items.length)
    };
  }
  const book = parseInt(parts[2], 10);
  const list = chapters[book] || [];
  const color = isHebrew(book) ? COLOR.hebrew : COLOR.greek;
  const items = [tile({ id: 'all', title: t(lang, 'play_whole_book'), subtitle: t(lang, 'play_whole_book'), text: '▶', color: COLOR.accent, compact: true, action: { play: list, index: 0 } })]
    .concat(list.map((m, i) => tile({ id: 'c' + (i + 1), title: t(lang, 'chapter_n', i + 1), subtitle: m.durationText, text: String(i + 1), color, compact: true, action: { play: list, index: i } })));
  return { title: n[book - 1], rows: [{ id: 'ch', title: n[book - 1], grid: true, items }] };
}

async function studyScreen(lang, parts) {
  const n = await namesFor(lang);
  const byBook = {};
  for (const e of study.videos) (byBook[e.b] = byBook[e.b] || []).push(e);
  if (parts.length === 1) {
    const mk = (b) => tile({
      id: 's' + b, title: b === 0 ? t(lang, 'bible_info') : n[b - 1],
      subtitle: (study.studyBooks.includes(b) ? '◆ ' : '') + plural(lang, 'videos_count', byBook[b].length),
      text: b === 0 ? t(lang, 'bible_info') : n[b - 1], color: b === 0 ? COLOR.study : study.studyBooks.includes(b) ? COLOR.greek : COLOR.hebrew,
      compact: true, action: { open: `study/${b}`, title: b === 0 ? t(lang, 'bible_info') : n[b - 1] }
    });
    const books = Object.keys(byBook).map(Number).sort((a, b) => a - b);
    return {
      title: t(lang, 'study_bible'),
      rows: [
        { id: 'notes', title: t(lang, 'study_with_notes'), grid: true, items: study.studyBooks.filter((b) => byBook[b]).map(mk) },
        { id: 'intro', title: t(lang, 'study_intros'), grid: true, items: books.filter((b) => !study.studyBooks.includes(b)).map(mk) }
      ]
    };
  }
  const book = parseInt(parts[1], 10);
  const entries = byBook[book] || [];
  const resolved = await Promise.all(entries.map(async (e) => [e, await jw.mediaItem(lang, e.k)]));
  const byChapter = {};
  for (const [e, m] of resolved) if (m) (byChapter[e.c] = byChapter[e.c] || []).push(m);
  const rows = Object.keys(byChapter).map(Number).sort((a, b) => a - b).map((c) => ({
    id: 'c' + c, title: c === 0 ? t(lang, 'introduction') : t(lang, 'chapter_n', c), items: byChapter[c]
  }));
  return { title: book === 0 ? t(lang, 'bible_info') : n[book - 1], rows };
}

// ---------------- Las buenas noticias según Jesús ----------------
function episodeNumber(m) {
  const r = /pub-gnj_(\d+)_VIDEO/.exec(m.key);
  if (!r) return 0;
  const n = parseInt(r[1], 10);
  return n >= 501 && n <= 899 ? n - 500 : n;
}
async function gnEpisodes(lang, force = false) {
  const c = await jw.category(lang, GN.KEY, force);
  const seen = new Set();
  return c.media.filter((m) => { const n = episodeNumber(m); return n >= 1 && n <= 499 && m.key !== GN.TRAILER && !seen.has(m.key) && seen.add(m.key); })
    .sort((a, b) => episodeNumber(a) - episodeNumber(b));
}
async function goodNews(lang) {
  const [episodes, ad, trailer, trailerAd] = await Promise.all([
    gnEpisodes(lang),
    jw.category(lang, GN.KEY_AD).then((c) => c.media).catch(() => []),
    jw.mediaItem(lang, GN.TRAILER),
    jw.mediaItem(lang, GN.TRAILER_AD)
  ]);
  const rows = [{ id: 'eps', title: t(lang, 'gn_episodes'), items: episodes }];
  const adAll = [...ad].sort((a, b) => episodeNumber(a) - episodeNumber(b)).concat(trailerAd ? [trailerAd] : []);
  if (adAll.length) rows.push({ id: 'ad', title: t(lang, 'gn_ad'), items: adAll });
  if (trailer) rows.push({ id: 'trailer', title: t(lang, 'gn_trailer'), items: [trailer] });
  const cat = jw.cachedCategory(lang, GN.KEY);
  // preview: el tráiler se reproduce sin sonido arriba, como en jw.org
  return { title: (cat && cat.name) || t(lang, 'gn_title'), rows, preview: trailer && trailer.files.length ? trailer : null, episodes: episodes.map((e) => ({ key: e.key, published: e.published, title: e.title })) };
}

// ---------------- En vivo ----------------
function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
async function live(lang, nowMs = Date.now()) {
  const vod = await jw.category(lang, 'VideoOnDemand');
  // Sin la categoría de audiodescripciones (son versiones repetidas de otros videos).
  const keys = vod.subcategories.map((s) => s.key).filter((k) => !/AudioDescription/i.test(k));
  const cats = await Promise.all(keys.map((k) => jw.category(lang, k).catch(() => null)));
  const seen = new Set();
  const pool = cats.filter(Boolean).flatMap((c) => jw.latestMedia(c, 100000))
    .filter((m) => !m.isAudio && !/audiodescrip|audio description|audiodescri|тифлокоммент/i.test(m.title) && m.duration >= 60 && m.duration <= 7200 && m.files.length && !seen.has(m.key) && seen.add(m.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  if (!pool.length) return null;
  const now = new Date(nowMs);
  const start = new Date(now.getFullYear(), 0, 0);
  const day = now.getFullYear() * 1000 + Math.floor((now - start) / 86400000);
  const rnd = seeded(day);
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const total = shuffled.reduce((s, m) => s + m.duration * 1000, 0);
  let elapsed = (nowMs - midnight) % total;
  let idx = 0;
  while (idx < shuffled.length && elapsed >= shuffled[idx].duration * 1000) { elapsed -= shuffled[idx].duration * 1000; idx++; }
  idx = Math.min(idx, shuffled.length - 1);
  const queue = Array.from({ length: Math.min(60, shuffled.length) }, (_, k) => shuffled[(idx + k) % shuffled.length]);
  return { items: queue, index: 0, position: elapsed / 1000 };
}

async function screen(lang, route) {
  const parts = route.split('/');
  switch (parts[0]) {
    case 'explore': return { title: t(lang, 'explore'), rows: [{ id: 'shortcuts', title: t(lang, 'shortcuts'), items: shortcuts(lang) }, { id: 'cats', title: t(lang, 'categories'), grid: true, items: await categoryCards(lang) }] };
    case 'categories': return { title: t(lang, 'categories'), rows: [{ id: 'cats', title: t(lang, 'categories'), grid: true, items: await categoryCards(lang) }] };
    case 'meeting': return meeting(lang);
    case 'favorites': return favoritesScreen(lang);
    case 'bible': return bibleScreen(lang, parts);
    case 'study': return studyScreen(lang, parts);
    case 'goodnews': return goodNews(lang);
    case 'category': return categoryScreen(lang, parts.slice(1).join('/'));
    default: throw new Error('Pantalla desconocida: ' + route);
  }
}

/** Recorre todo el catálogo (temas y sus subcategorías) para buscar por palabra, tema o fecha. */
const crawls = new Map();
function crawl(lang) {
  const hit = crawls.get(lang);
  if (hit && Date.now() - hit.t < 30 * 60 * 1000) return hit.p;
  const p = (async () => {
    const vod = await jw.category(lang, 'VideoOnDemand');
    const roots = vod.subcategories.map((s) => s.key).concat(['Audio']);
    const deeper = [];
    await Promise.all(roots.map(async (k) => {
      const c = await jw.category(lang, k).catch(() => null);
      if (c) for (const sc of c.subcategories) if (!sc.media.length) deeper.push(sc.key);
    }));
    const deeper2 = [];
    await Promise.all(deeper.map(async (k) => {
      const c = await jw.category(lang, k).catch(() => null);
      if (c) for (const sc of c.subcategories) if (!sc.media.length) deeper2.push(sc.key);
    }));
    await Promise.all(deeper2.map((k) => jw.category(lang, k).catch(() => null)));
    return true;
  })();
  p.catch(() => crawls.delete(lang));
  crawls.set(lang, { t: Date.now(), p });
  return p;
}
const AD_RE = /audiodescri|audio descri|audiodeskri|audiodeskrip|тифлокоммент|аудіоопис|syntolk|synstolk|kuvailutulk|音声解説|화면 해설|口述影像|وصف صوتي|ακουστική περιγραφή|sesli betimle|deskripsi audio|audio description|mô tả bằng âm thanh|เสียงบรรยายภาพ|ऑडियो विवरण|maelezo ya sauti|hangalámond|audiopopis|audiodeskrypc|descriere audio|audiodescrição/i;
const isCatalogItem = (m) => m && m.kind === 'media' && !m.key.startsWith('bible-');

/** Temas, años y meses para los filtros de búsqueda. */
async function searchOptions(lang) {
  const vod = await jw.category(lang, 'VideoOnDemand');
  const audio = await jw.category(lang, 'Audio').catch(() => null);
  const topics = vod.subcategories.filter((s) => !/AudioDescription/i.test(s.key)).map((s) => ({ key: s.key, name: s.name }))
    .concat(audio ? [{ key: 'Audio', name: audio.name || t(lang, 'audio') }] : []);
  const now = new Date().getFullYear();
  const years = [];
  for (let y = now; y >= 2012; y--) years.push(y);
  const loc = intlLocale(ui(lang));
  const months = Array.from({ length: 12 }, (_, i) => {
    let name = new Intl.DateTimeFormat(loc, { month: 'long' }).format(new Date(2024, i, 15));
    return { value: i + 1, name: name.charAt(0).toLocaleUpperCase(loc) + name.slice(1) };
  });
  return { topics, years, months };
}

/**
 * Busca por palabras (palabras que empiezan así, sin tildes) y filtra por tema, año y mes.
 * opts: { q, topic, year, month, sort: 'newest' | 'oldest' }
 */
/**
 * Detecta una fecha escrita en el buscador: "enero 2025", "enero de 2025", "2024".
 * Un mes solo ("enero") se busca como palabra. Devuelve { year, month, rest }.
 */
function dateInQuery(lang, q) {
  const num = /(\d{4})\s*(?:年|년|[-./])\s*(\d{1,2})\s*(?:月|월)?|(\d{1,2})\s*[/.-]\s*(\d{4})/.exec(q);
  if (num) {
    const year = Number(num[1] || num[4]), month = Number(num[2] || num[3]);
    if (year >= 1900 && month >= 1 && month <= 12) return { year, month, monthWord: null, rest: jw.queryWords(q.replace(num[0], ' ')).join(' ') };
  }
  const cjkYear = /(\d{4})\s*(?:年|년)/.exec(q);
  if (cjkYear) return { year: Number(cjkYear[1]), month: null, monthWord: null, rest: jw.queryWords(q.replace(cjkYear[0], ' ')).join(' ') };
  const words = jw.queryWords(q);
  const yi = words.findIndex((w) => /^(19|20)\d\d$/.test(w));
  if (yi < 0) return null;
  const locales = [...new Set([webLocale(lang), intlLocale(ui(lang)), 'es', 'en'])];
  const monthOf = new Map();
  for (const loc of locales) {
    for (let i = 0; i < 12; i++) {
      for (const style of ['long', 'short']) {
        try {
          const d = new Date(2024, i, 15);
          const names = [new Intl.DateTimeFormat(loc, { month: style }).format(d)];
          // Nombre del mes dentro de una fecha (ruso "января", polaco "stycznia"...).
          const inDate = new Intl.DateTimeFormat(loc, { day: 'numeric', month: style }).formatToParts(d).find((x) => x.type === 'month');
          if (inDate) names.push(inDate.value);
          for (const n of names) { const k = jw.normText(n).replace(/\.$/, ''); if (k.length >= 3 && !/^\d+$/.test(k)) monthOf.set(k, i + 1); }
        } catch (e) { /* idioma sin datos de fecha */ }
      }
    }
  }
  const year = Number(words[yi]);
  const mi = words.findIndex((w, i) => i !== yi && monthOf.has(w));
  const used = new Set([yi]);
  if (mi >= 0) {
    used.add(mi);
    // Conectores entre el mes y el año ("enero de 2025", "January of 2025").
    for (let i = Math.min(mi, yi) + 1; i < Math.max(mi, yi); i++) if (words[i].length <= 3) used.add(i);
  }
  return { year, month: mi >= 0 ? monthOf.get(words[mi]) : null, monthWord: mi >= 0 ? words[mi] : null, rest: words.filter((_, i) => !used.has(i)).join(' ') };
}

async function searchAll(lang, opts) {
  if (typeof opts === 'string') opts = { q: opts };
  opts = Object.assign({}, opts);
  let q = (opts.q || '').trim();
  // Fecha escrita: se usa como filtro, salvo que ya haya un filtro de fecha elegido.
  const typed = !opts.year && !opts.month ? dateInQuery(lang, q) : null;
  if (typed) { opts.year = typed.year; if (typed.month) opts.month = typed.month; q = typed.rest; }
  const words = jw.queryWords(q);
  const filtered = !!(opts.topic || opts.year || opts.month);
  if (!words.length && !filtered) return { categories: [], results: [], total: 0 };
  await Promise.race([crawl(lang).catch(() => null), new Promise((r) => setTimeout(r, 25000))]);

  const found = new Map();
  for (const m of jw.indexedMedia(lang)) {
    if (isCatalogItem(m) && jw.matchesWords(m.title + ' ' + m.description, words)) found.set(m.key, m);
  }
  let categories = [];
  if (words.length) {
    const hits = await jw.search(lang, q).catch(() => []);
    if (!filtered) {
      categories = hits.filter((h) => h.categoryKey && jw.matchesWords(h.title, words)).map((h) => {
        const c = jw.cachedCategory(lang, h.categoryKey);
        return { kind: 'category', key: h.categoryKey, name: h.title, image: (c && jw.categoryImage(c)) || h.image };
      });
    }
    // Resultados del buscador de la web que contienen las palabras (se completan con fecha y tema).
    const extra = hits.filter((h) => !h.categoryKey && !found.has(h.lank) && jw.matchesWords(h.title, words)).slice(0, 40);
    const resolved = await Promise.all(extra.map((h) => jw.fromIndex(lang, h.lank) || jw.mediaItem(lang, h.lank)));
    resolved.forEach((m) => { if (isCatalogItem(m) && jw.matchesWords(m.title + ' ' + m.description, words)) found.set(m.key, m); });
  }
  let results = [...found.values()];
  if (opts.topic) results = results.filter((m) => (m.topics || []).includes(opts.topic));
  // Con una fecha escrita, también los videos cuyo título la nombra ("JW Broadcasting: Enero de 2025").
  const named = typed && typed.monthWord
    ? results.filter((m) => {
      const tk = jw.queryWords(m.title);
      return tk.some((w, i) => w === typed.monthWord && tk.slice(i + 1, i + 3).includes(String(typed.year)));
    })
    : [];
  if (opts.year) results = results.filter((m) => m.published.startsWith(String(opts.year)));
  if (opts.month) results = results.filter((m) => m.published.slice(5, 7) === String(opts.month).padStart(2, '0'));
  if (named.length) results = [...new Set(named.concat(results))];
  // Sin las versiones con audiodescripción (repiten otros videos), salvo que se busquen.
  if (!AD_RE.test(q) && !/AudioDescription/i.test(opts.topic || '')) {
    results = results.filter((m) => !AD_RE.test(m.title) && !((m.topics || []).length && m.topics.every((k) => /AudioDescription/i.test(k))));
  }
  const dir = opts.sort === 'oldest' ? 1 : -1;
  results.sort((a, b) => dir * (a.published || '').localeCompare(b.published || '') || a.title.localeCompare(b.title));
  return { categories, results: results.slice(0, 400), total: results.length, typedDate: typed ? { year: typed.year, month: typed.month } : null };
}

module.exports = {
  init: (dir) => { pubs.init(dir); drive.init(dir); favorites.init(dir, drive.changed); },
  handlers: {
    languages,
    strings,
    setUi: (code) => { uiOverride = code && i18n[code] ? code : null; return true; },
    uiLanguages: () => Object.keys(i18n).map((c) => ({ code: c, name: (LANG_BY_CODE.get(c) || {}).vern || c })).sort((a, b) => a.name.localeCompare(b.name)),
    searchOptions,
    home,
    rowItems: (lang, key, latest) => rowItems(lang, key, latest !== false),
    featured: (lang) => mediaOf(lang, ['FeaturedLibraryLanding', 'StudioFeatured']),
    latest: (lang) => mediaOf(lang, ['LatestVideos']),
    shortcuts,
    screen,
    search: searchAll,
    crawl,
    mediaItem: (lang, key) => jw.mediaItem(lang, key),
    live,
    gnEpisodes: async (lang) => (await gnEpisodes(lang, true)).map((e) => ({ key: e.key, published: e.published, title: e.title })),
    gnHome: async (lang) => {
      await jw.mediaItem(lang, GN.TRAILER);
      const eps = await gnEpisodes(lang);
      const cat = jw.cachedCategory(lang, GN.KEY);
      return { name: (cat && cat.name) || t(lang, 'gn_title'), episodes: eps, image: cachedTrailerImage(lang) };
    },
    subtitles: (url) => (/^https:\/\/([a-z0-9-]+\.)*jw-cdn\.org\//i.test(url) ? jw.getText(url) : ''),
    toTvJson: (items) => items.map(jw.toTvJson),
    clearCache: () => jw.clearCache(),
    // Mis favoritos
    favToggle: (item) => favorites.toggle(item),
    favState: (items) => (items || []).map((x) => favorites.isFavorite(x)),
    favList: () => favorites.list(),
    favImport: (text) => favorites.importText(text),
    favExport: () => favorites.exportText(),
    // Google Drive
    driveStatus: () => drive.status(),
    driveSync: () => drive.sync(),
    driveAutoSync: () => drive.autoSync(),
    driveDisconnect: () => drive.disconnect()
  },
  _test: { dateInQuery, weekRange, weekBounds, episodeNumber, ui, intlLocale, plural }
};
