'use strict';
// Publicaciones: guía de actividades, La Atalaya (JWPUB) y Biblia en audio.
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');
const jw = require('./jw');

const PUBMEDIA = 'https://b.jw-cdn.org/apis/pub-media/GETPUBMEDIALINKS';
let dataDir = null;
let SQL = null;

function init(dir) { dataDir = dir; }

async function sql() {
  if (SQL) return SQL;
  const initSqlJs = require('sql.js');
  const wasm = require.resolve('sql.js/dist/sql-wasm.wasm').replace('app.asar', 'app.asar.unpacked');
  SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasm) });
  return SQL;
}

// ---------------- pub-media ----------------
/** Devuelve el JSON de la publicación o null si no existe (404). Los errores de red se propagan. */
async function links(params) {
  const q = new URLSearchParams(Object.assign({}, params, { output: 'json', alllangs: '0' })).toString();
  try {
    const body = await jw.getText(`${PUBMEDIA}?${q}`);
    return body.trimStart().startsWith('[') ? null : JSON.parse(body);
  } catch (e) {
    if (e instanceof jw.HttpError && e.status === 404) return null;
    throw e;
  }
}
function files(json, format) {
  const out = [];
  for (const byFmt of Object.values((json && json.files) || {})) for (const f of (byFmt[format] || [])) out.push(f);
  return out;
}
const fileUrl = (f) => (f && f.file && /^http/.test(f.file.url) ? f.file.url : null);
const pubName = (json) => String((json && json.pubName) || '').replace(/&nbsp;/g, ' ').replace(/<[^>]*>/g, '').trim();

/** Video referenciado en una publicación (símbolo+pista o documento). */
function lankOf(ref) {
  if (!ref.keySymbol && ref.docId) return `docid-${ref.docId}_${ref.track > 0 ? ref.track : 1}_VIDEO`;
  if (ref.issueTag > 0) return `pub-${ref.keySymbol}_${Math.floor(ref.issueTag / 100)}_${ref.track}_VIDEO`;
  return `pub-${ref.keySymbol}_${ref.track}_VIDEO`;
}
async function resolveRef(lang, ref) {
  const lank = lankOf(ref);
  const m = await jw.mediaItem(lang, lank);
  if (m) return m;
  // Respaldo: buscar el archivo directamente en pub-media.
  const params = { langwritten: lang, fileformat: 'MP4' };
  if (ref.keySymbol) params.pub = ref.keySymbol; else if (ref.docId) params.docid = String(ref.docId); else return null;
  if (ref.track > 0) params.track = String(ref.track);
  if (ref.issueTag > 0) params.issue = String(Math.floor(ref.issueTag / 100));
  const json = await links(params).catch(() => null);
  const fs_ = files(json, 'MP4');
  if (!fs_.length) return null;
  const item = jw.normalize({
    naturalKey: lank, languageAgnosticNaturalKey: lank, type: 'video',
    title: fs_[0].title || pubName(json), duration: fs_[0].duration || 0,
    images: fs_[0].trackImage && fs_[0].trackImage.url ? { wss: { lg: fs_[0].trackImage.url } } : {},
    files: fs_.map((f) => ({ progressiveDownloadURL: fileUrl(f), label: f.label, frameHeight: f.frameHeight, mimetype: f.mimetype || 'video/mp4', subtitles: f.subtitles }))
  }, lang);
  jw.addToIndex(item);
  return item;
}

// ---------------- JWPUB ----------------
const dbCache = new Map();

/** Descarga (una vez) la publicación, extrae su base SQLite y la abre. null si no existe. */
async function jwpub(pub, lang, issue) {
  const id = `${pub}_${lang}_${issue}`;
  if (dbCache.has(id)) return dbCache.get(id);
  const dir = path.join(dataDir, 'jwpub');
  fs.mkdirSync(dir, { recursive: true });
  const dbFile = path.join(dir, id + '.db');
  let bytes = null;
  if (fs.existsSync(dbFile) && fs.statSync(dbFile).size > 0) {
    bytes = fs.readFileSync(dbFile);
  } else {
    const json = await links({ pub, issue: String(issue), langwritten: lang, fileformat: 'JWPUB' });
    const url = files(json, 'JWPUB').map(fileUrl).find(Boolean);
    if (!url) return null;
    const archive = await jw.getBinary(url);
    // Un JWPUB es un ZIP que contiene otro ZIP ("contents") con la base de datos.
    const outer = await JSZip.loadAsync(archive);
    const contents = outer.file('contents');
    if (!contents) throw new Error('El archivo no contiene "contents"');
    const inner = await JSZip.loadAsync(await contents.async('nodebuffer'));
    const dbEntry = Object.values(inner.files).find((f) => f.name.endsWith('.db'));
    if (!dbEntry) throw new Error('El archivo no contiene la base de datos');
    bytes = await dbEntry.async('nodebuffer');
    fs.writeFileSync(dbFile, bytes);
    cleanup(dir);
  }
  const SQLjs = await sql();
  const db = new SQLjs.Database(new Uint8Array(bytes));
  dbCache.set(id, db);
  return db;
}
function cleanup(dir) {
  const limit = Date.now() - 150 * 24 * 3600 * 1000;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try { if (fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p); } catch (e) { /* nada */ }
  }
}
function rows(db, query, params) {
  const st = db.prepare(query);
  st.bind(params || []);
  const out = [];
  while (st.step()) out.push(st.get());
  st.free();
  return out;
}

function issue(y, m) { while (m < 1) { m += 12; y -= 1; } return y * 100 + m; }

function videoRefs(db, docId) {
  const refs = rows(db,
    'SELECT m.KeySymbol, m.Track, m.MepsDocumentId, m.IssueTagNumber FROM DocumentMultimedia dm ' +
    'JOIN Multimedia m ON m.MultimediaId = dm.MultimediaId WHERE dm.DocumentId = ? AND m.MimeType LIKE \'video%\' ' +
    'ORDER BY dm.BeginParagraphOrdinal, dm.DocumentMultimediaId', [docId])
    .map(([k, t, d, i]) => ({ keySymbol: k || null, track: t || 0, docId: d || null, issueTag: i || 0 }));
  const seen = new Set();
  return refs.filter((r) => { const l = lankOf(r); return !seen.has(l) && seen.add(l); });
}

async function resolveAll(lang, refs) {
  const items = await Promise.all(refs.map((r) => resolveRef(lang, r).catch(() => null)));
  const seen = new Set();
  return items.filter((m) => m && !seen.has(m.key) && seen.add(m.key));
}

/** Videos de la reunión Vida y Ministerio Cristianos de la semana de [date] (AAAAMMDD). */
async function midweek(lang, date) {
  const y = Math.floor(date / 10000), m = Math.floor(date / 100) % 100;
  const odd = m % 2 === 1 ? m : m - 1;
  let lastError = null;
  for (const iss of [issue(y, odd), issue(y, odd - 2)]) {
    let db;
    try { db = await jwpub('mwb', lang, iss); } catch (e) { lastError = `mwb ${iss}: ${e.message}`; continue; }
    if (!db) continue;
    const found = rows(db,
      'SELECT d.DocumentId, d.Title FROM DatedText t JOIN Document d ON d.DocumentId = t.DocumentId ' +
      'WHERE t.FirstDateOffset <= ? AND ifnull(t.LastDateOffset, t.FirstDateOffset + 6) >= ? LIMIT 1', [date, date])[0];
    if (!found) continue;
    const items = await resolveAll(lang, videoRefs(db, found[0]));
    return { week: { title: found[1] || '', items }, error: items.length ? null : 'sin videos' };
  }
  return { week: null, error: lastError || 'semana no encontrada' };
}

/** Estudio de La Atalaya de la semana: título, videos e imágenes. */
async function study(lang, date) {
  const y = Math.floor(date / 10000), m = Math.floor(date / 100) % 100;
  for (let back = 1; back <= 4; back++) {
    let db;
    try { db = await jwpub('w', lang, issue(y, m - back)); } catch (e) { continue; }
    if (!db) continue;
    const dated = rows(db,
      'SELECT DocumentId, BeginParagraphOrdinal, EndParagraphOrdinal, FirstDateOffset FROM DatedText ' +
      'WHERE FirstDateOffset <= ? AND ifnull(LastDateOffset, FirstDateOffset + 6) >= ? LIMIT 1', [date, date])[0];
    if (!dated) continue;
    let doc = (rows(db,
      'SELECT d.DocumentId FROM DocumentInternalLink dil JOIN InternalLink il ON il.InternalLinkId = dil.InternalLinkId ' +
      'JOIN Document d ON d.MepsDocumentId = il.MepsDocumentId WHERE dil.DocumentId = ? AND dil.BeginParagraphOrdinal BETWEEN ? AND ? LIMIT 1',
      [dated[0], dated[1], dated[2]])[0] || [])[0];
    if (doc == null) {
      const weekIndex = rows(db, 'SELECT COUNT(*) FROM DatedText WHERE FirstDateOffset < ?', [dated[3]])[0][0];
      doc = (rows(db, "SELECT DocumentId FROM Document WHERE Class = '40' ORDER BY DocumentId LIMIT 1 OFFSET ?", [weekIndex])[0] || [])[0];
    }
    if (doc == null) continue;
    const title = (rows(db, 'SELECT Title FROM Document WHERE DocumentId = ?', [doc])[0] || [''])[0] || '';
    const pictures = rows(db,
      'SELECT m.FilePath, m.Caption, m.Label FROM DocumentMultimedia dm JOIN Multimedia m ON m.MultimediaId = dm.MultimediaId ' +
      "WHERE dm.DocumentId = ? AND m.MimeType LIKE 'image%' AND m.CategoryType = 8 ORDER BY dm.BeginParagraphOrdinal, dm.DocumentMultimediaId", [doc])
      .map(([file, caption, label]) => {
        const base = String(file || '').replace(/\.[^.]+$/, '');
        const parts = base.split('_');
        if (parts.length < 3) return null;
        const root = `https://cms-imgp.jw-cdn.org/img/p/${parts[0]}/${parts[1]}/art/${base}`;
        const text = String(caption || label || '').replace(/<[^>]*>/g, '').replace(/ /g, ' ').trim();
        return { url: `${root}_xl.jpg`, thumb: `${root}_lg.jpg`, caption: text };
      }).filter(Boolean);
    const items = await resolveAll(lang, videoRefs(db, doc));
    return { title, items, pictures };
  }
  return null;
}

// ---------------- Biblia en audio ----------------
const bibleCache = new Map();
const editionNames = new Map();
const bookNameCache = new Map();

function markerDuration(f) {
  if (Number(f.duration) > 0) return Number(f.duration);
  const marks = (f.markers && f.markers.markers) || [];
  const last = marks[marks.length - 1];
  if (!last) return 0;
  const sec = (s) => { const p = String(s || '').split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : 0; };
  return sec(last.startTime) + sec(last.duration);
}

/** Capítulos de la edición [pub] ("nwt" actual o "bi12" anterior), agrupados por libro. */
async function bible(lang, pub) {
  const ck = `${lang}/${pub}`;
  if (bibleCache.has(ck)) return bibleCache.get(ck);
  const json = await links({ pub, langwritten: lang, fileformat: 'MP3' });
  if (!json) return {};
  const edition = pubName(json);
  editionNames.set(ck, edition);
  const byBook = {};
  for (const f of files(json, 'MP3')) {
    const url = fileUrl(f);
    const book = f.booknum || 0, chapter = f.track || 0;
    if (!url || book < 1 || book > 66 || chapter < 1) continue;
    const parts = String(f.title || '').replace(/&nbsp;/g, ' ').split(' - ');
    if (parts.length > 1) { const names = bookNameCache.get(lang) || {}; if (!names[book]) names[book] = parts[0].trim(); bookNameCache.set(lang, names); }
    const item = jw.normalize({
      naturalKey: `bible-${pub}-${lang}-${book}-${chapter}`, languageAgnosticNaturalKey: `bible-${pub}-${book}-${chapter}`,
      type: 'audio', title: String(f.title || '').replace(/&nbsp;/g, ' ').replace(' - ', ' · '), description: edition, duration: markerDuration(f),
      files: [{ progressiveDownloadURL: url, mimetype: 'audio/mpeg' }]
    }, lang);
    jw.addToIndex(item);
    (byBook[book] = byBook[book] || []).push(item);
  }
  if (Object.keys(byBook).length) bibleCache.set(ck, byBook);
  return byBook;
}
async function editions(lang) {
  const out = [];
  for (const pub of ['nwt', 'bi12']) {
    if (!editionNames.has(`${lang}/${pub}`)) await bible(lang, pub).catch(() => null);
    const name = editionNames.get(`${lang}/${pub}`);
    if (name) out.push({ pub, name });
  }
  return out;
}

/** Nombres de los libros tomados de la Biblia en audio ({1: "Génesis", ...}) o null. */
async function bookNames(lang) {
  if (!bookNameCache.has(lang)) { await bible(lang, 'nwt').catch(() => null); if (!bookNameCache.has(lang)) await bible(lang, 'bi12').catch(() => null); }
  return bookNameCache.get(lang) || null;
}

module.exports = { init, links, midweek, study, bible, editions, bookNames };
