'use strict';
// "Mis favoritos" en Windows. Mismo formato que en Android (para respaldar y sincronizar entre equipos):
// cada elemento recuerda cuándo se agregó y cuándo se quitó; al juntar respaldos gana lo más reciente.
const fs = require('fs');
const path = require('path');
const jw = require('./jw');

let file = null;
let data = {};
let onChanged = () => {};

function init(dir, changed) {
  file = path.join(dir, 'favorites.json');
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { data = {}; }
  if (changed) onChanged = changed;
}
function save(notify = true) {
  try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { /* sin espacio o sin permiso */ }
  if (notify) onChanged();
}
const alive = (e) => (e.added || 0) > (e.removed || 0);
const stamp = (e) => Math.max(e.added || 0, e.removed || 0);

/** Clave y datos de algo marcable: video/audio (media) o imagen ({image:url, caption, title}). */
function entryOf(item) {
  if (!item) return null;
  if (item.kind === 'media') return ['m:' + item.lang + '|' + item.key, { type: 'media', lang: item.lang, media: jw.toTvJson(item) }];
  if (item.kind === 'image') return ['i:' + item.url, { type: 'image', url: item.url, caption: item.caption || '', title: item.title || '' }];
  return null;
}

function isFavorite(item) { const e = entryOf(item); return !!(e && data[e[0]] && alive(data[e[0]])); }

function toggle(item) {
  const e = entryOf(item);
  if (!e) return false;
  const [key, value] = e;
  const now = Date.now();
  const on = !(data[key] && alive(data[key]));
  data[key] = on ? Object.assign(value, { added: now, removed: 0 }) : Object.assign(data[key], { removed: now });
  save();
  return on;
}

/** Favoritos vigentes (más recientes primero): objetos media normalizados o {kind:'image', ...}. */
function list() {
  return Object.values(data).filter(alive).sort((a, b) => b.added - a.added).map((e) => {
    if (e.type === 'media') return jw.normalize(e.media, e.lang);
    if (e.type === 'image') return { kind: 'image', url: e.url, caption: e.caption, title: e.title };
    return null;
  }).filter(Boolean);
}

function exportText() {
  return JSON.stringify({ app: 'Broadcasting Player', kind: 'favorites', version: 1, exported: Date.now(), items: data }, null, 2);
}

/** Junta un respaldo con lo de este equipo. Devuelve el total, o -1 si no es válido. */
function importText(text, notify = true) {
  let j;
  try { j = JSON.parse(text); } catch (e) { return -1; }
  const incoming = j && (j.items || (!j.kind ? j : null));
  if (!incoming || typeof incoming !== 'object') return -1;
  let changed = false;
  for (const [k, e] of Object.entries(incoming)) {
    if (!e || !e.type) continue;
    if (!data[k] || stamp(e) > stamp(data[k])) { data[k] = e; changed = true; }
  }
  if (changed) save(notify);
  return list().length;
}

const itemsSignature = () => JSON.stringify(data);

module.exports = { init, isFavorite, toggle, list, exportText, importText, itemsSignature, count: () => list().length, _data: () => data };
