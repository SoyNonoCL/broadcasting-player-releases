'use strict';
// "Mi TV": encuentra Broadcasting Player abierto en un televisor de la misma red wifi
// y le envía órdenes (el mismo protocolo que usa la app del teléfono).
const { net } = require('electron');

const found = new Map();
let browser = null;

function start() {
  if (browser) return;
  try {
    const { Bonjour } = require('bonjour-service');
    const bonjour = new Bonjour();
    browser = bonjour.find({ type: 'bplayer', protocol: 'tcp' });
    browser.on('up', (s) => {
      const host = (s.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || s.host;
      if (host) found.set(s.name, { name: s.name, host, port: s.port });
    });
    browser.on('down', (s) => found.delete(s.name));
  } catch (e) {
    browser = null;
  }
}

// ---------------- Roku (SSDP + ECP en el puerto 8060) ----------------
const http = require('http');
function httpText(url, method) {
  return new Promise((resolve) => {
    const req = http.request(url, { method: method || 'GET', timeout: 4000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, text: data }));
    });
    req.on('error', () => resolve({ ok: false, text: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, text: '' }); });
    req.end();
  });
}
function findRokus() {
  return new Promise((resolve) => {
    const hosts = new Set();
    let sock;
    try { sock = require('dgram').createSocket({ type: 'udp4', reuseAddr: true }); } catch (e) { resolve([]); return; }
    const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHost: 239.255.255.250:1900\r\nMan: "ssdp:discover"\r\nST: roku:ecp\r\nMX: 2\r\n\r\n');
    sock.on('message', (m) => { const r = /^location:\s*http:\/\/([^:/\s]+):8060/im.exec(m.toString()); if (r) hosts.add(r[1]); });
    sock.on('error', () => {});
    sock.bind(() => { try { sock.send(msg, 1900, '239.255.255.250'); sock.send(msg, 1900, '239.255.255.250'); } catch (e) { /* nada */ } });
    setTimeout(async () => {
      try { sock.close(); } catch (e) { /* nada */ }
      const out = [];
      for (const host of hosts) {
        const apps = await httpText(`http://${host}:8060/query/apps`);
        if (!apps.ok || !apps.text.includes('id="dev"')) continue; // sin Broadcasting Player instalado
        const info = (await httpText(`http://${host}:8060/query/device-info`)).text;
        const label = ['user-device-name', 'friendly-device-name', 'model-name']
          .map((t) => (new RegExp(`<${t}>([^<]+)</${t}>`).exec(info) || [])[1]).find((x) => x && x.trim()) || host;
        out.push({ name: `Broadcasting Player (Roku · ${label.trim()})`, host, port: 8060, roku: true });
      }
      resolve(out);
    }, 2800);
  });
}
async function sendRoku(tv, path, body) {
  body = body || {};
  const e = encodeURIComponent;
  let q;
  if (path === '/play') {
    const keys = (body.items || []).map((m) => m.languageAgnosticNaturalKey || m.naturalKey).filter(Boolean);
    const list = keys.slice(Math.min(body.index || 0, Math.max(keys.length - 1, 0))).slice(0, 25);
    if (!list.length) return false;
    q = `launch/dev?contentId=${e(list[0])}&lang=${e(body.lang || 'S')}&list=${e(list.join(','))}&pos=${Math.round((body.position || 0) / 1000)}`;
  } else if (path === '/live') q = 'launch/dev?contentId=live&live=1';
  else if (path === '/control') q = body.cmd === 'seek' ? `input?cmd=seek&delta=${Math.round((body.deltaMs || 0) / 1000)}` : `input?cmd=${e(body.cmd || '')}`;
  else return false; // JW Stream necesita un navegador; el Roku no tiene
  return (await httpText(`http://${tv.host}:8060/${q}`, 'POST')).ok;
}

async function list() {
  start();
  const rokus = findRokus();
  // Da un momento para que respondan los televisores la primera vez.
  if (!found.size) await new Promise((r) => setTimeout(r, 2500));
  return [...found.values(), ...(await rokus)];
}

async function send(tv, path, body) {
  if (!tv || !/^[\d.]+$|^[a-z0-9.-]+$/i.test(tv.host)) return false;
  if (tv.roku) return sendRoku(tv, path, body);
  try {
    const res = await net.fetch(`http://${tv.host}:${tv.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body || {})
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

module.exports = { list, send };
