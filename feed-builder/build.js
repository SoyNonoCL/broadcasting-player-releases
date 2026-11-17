'use strict';
// Prepara las reuniones de cada semana para la app de Roku (que no puede abrir las publicaciones JWPUB).
// Uso: node build.js carpeta_salida [idiomas separados por coma]
const fs = require('fs');
const os = require('os');
const path = require('path');
const api = require('./app/data/api');
const pubs = require('./app/data/pubs');
const i18n = require('./app/i18n.json');

const out = process.argv[2] || 'out';
const langs = (process.argv[3] || Object.keys(i18n).join(',')).split(',').filter(Boolean);
pubs.init(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-')));
fs.mkdirSync(path.join(out, 'meetings'), { recursive: true });

// Elemento en el formato del catálogo (el que lee la app de Roku).
const raw = (m) => ({
  naturalKey: m.naturalKey || m.key, languageAgnosticNaturalKey: m.key, type: m.type || 'video',
  title: m.title, description: m.description || '', duration: m.duration || 0, firstPublished: m.published || '',
  images: m.rawImages || {},
  files: (m.files || []).map((f) => ({ progressiveDownloadURL: f.url, label: f.label || (f.height ? f.height + 'p' : ''), mimetype: f.mime || 'video/mp4', subtitles: f.subtitles ? { url: f.subtitles } : undefined }))
});
const num = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

async function forLang(lang) {
  const weeks = [];
  for (const offset of [0, 7, 14]) {
    const d = new Date(); d.setDate(d.getDate() + offset);
    const date = num(d);
    const [mon, sun] = api._test.weekBounds(date);
    const rows = [];
    const [mid, st] = await Promise.all([pubs.midweek(lang, date).catch(() => ({ week: null })), pubs.study(lang, date).catch(() => null)]);
    if (mid.week && mid.week.items.length) rows.push({ kind: 'midweek', title: mid.week.title, items: mid.week.items.map(raw) });
    if (st && (st.items.length || st.pictures.length)) rows.push({ kind: 'weekend', title: st.title, items: st.items.map(raw), pictures: st.pictures });
    if (rows.length) weeks.push({ monday: num(mon), sunday: num(sun), range: api._test.weekRange(lang, mon, sun), rows });
  }
  return weeks;
}

(async () => {
  let ok = 0;
  for (const lang of langs) {
    try {
      const weeks = await forLang(lang);
      if (!weeks.length) { console.log(lang, 'sin datos'); continue; }
      fs.writeFileSync(path.join(out, 'meetings', lang + '.json'), JSON.stringify({ updated: new Date().toISOString(), weeks }));
      console.log(lang, weeks.length, 'semanas');
      ok++;
    } catch (e) { console.log(lang, 'error', e.message); }
  }
  if (!ok) process.exit(1);
})();
