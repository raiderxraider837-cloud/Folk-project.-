/* ============================================================
   linktrace — rastreador de enlaces (Node puro, sin dependencias)
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BASE = (process.env.BASE_URL || 'https://folk-project.onrender.com').replace(/\/+$/, '');
const PAGE = process.env.PAGE || 'folkenstein.html';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const MAX_VISITS = 1000;

/* ---------- almacenamiento ---------- */
let db = { links: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) {}
if (!db || typeof db !== 'object' || !db.links) db = { links: {} };
function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('No se pudo guardar:', e.message); }
}

/* ---------- utilidades ---------- */
const ALPHA = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(n = 6) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHA[crypto.randomInt(ALPHA.length)];
  return s;
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const json = (res, o, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(o));
};
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
const linkURL = c => BASE + '/' + c;

function normalizeDest(d) {
  d = String(d || '').trim();
  if (!d) return null;
  if (!/^https?:\/\//i.test(d)) d = 'https://' + d;
  try { new URL(d); } catch (_) { return null; }
  return d;
}

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
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch('http://ip-api.com/json/' + encodeURIComponent(ip) +
      '?fields=status,country,countryCode,regionName,city,zip,isp,org,as,timezone', { signal: ctl.signal });
    clearTimeout(t);
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

/* ---------- registro de visitas ---------- */
function recordVisit(link, req, extra) {
  const ip = clientIP(req);
  const ua = req.headers['user-agent'] || '';
  const v = {
    ip, time: Date.now(), ua,
    lang: req.headers['accept-language'] || '',
    ref: req.headers['referer'] || req.headers['referrer'] || '',
    ...parseUA(ua),
    ...(extra || {})
  };
  link.visits.unshift(v);
  if (link.visits.length > MAX_VISITS) link.visits.length = MAX_VISITS;
  save();
  geoLookup(ip).then(g => { if (g) { v.geo = g; save(); } });
  return v;
}

function redirect(res, dest) {
  res.writeHead(302, { Location: dest, 'Cache-Control': 'no-store, max-age=0' });
  res.end();
}

/* ---------- página intermedia (modo captura de navegador) ---------- */
function clientPage(code, dest) {
  const safeDest = JSON.stringify(dest).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(dest)}</title>
<style>html,body{height:100%;margin:0}body{background:#fff}</style>
<noscript><meta http-equiv="refresh" content="0;url=${esc(dest)}"></noscript>
</head><body><script>
(function(){
  var DEST=${safeDest}, going=false, sent=false;
  function go(){ if(going) return; going=true; location.replace(DEST); }
  var d={ pantalla: screen.width+'x'+screen.height, dpr: window.devicePixelRatio||1,
    zonaHoraria: (Intl.DateTimeFormat().resolvedOptions()||{}).timeZone||'',
    idiomaNavegador: navigator.language, idiomas: (navigator.languages||[]).join(', '),
    plataforma: navigator.platform||'', nucleos: navigator.hardwareConcurrency||0,
    tactil: ('ontouchstart' in window) };
  function send(){ if(sent) return; sent=true;
    try{ fetch('/api/hit/${code}',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(d),keepalive:true}).finally(go); }catch(e){ go(); } }
  try{ if(navigator.getBattery){ navigator.getBattery().then(function(b){
      d.bateria=Math.round(b.level*100)+'%'; d.cargando=b.charging; send(); }, send); } else send();
  }catch(e){ send(); }
  setTimeout(go, 800);
})();
</script></body></html>`;
}

/* ---------- handlers ---------- */
function servePage(res) {
  fs.readFile(path.join(__dirname, PAGE), (e, buf) => {
    if (e) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>linktrace</h1><p>Falta el archivo ' + esc(PAGE) + '</p>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

function listLinks(res) {
  json(res, Object.values(db.links).sort((a, b) => b.created - a.created).map(l => ({
    code: l.code, dest: l.dest, label: l.label, client: !!l.client,
    created: l.created, clicks: l.visits.length, url: linkURL(l.code)
  })));
}

async function createLink(req, res) {
  let o = {}; try { o = JSON.parse(await readBody(req) || '{}'); } catch (_) {}
  const dest = normalizeDest(o.dest);
  if (!dest) return json(res, { error: 'Destino no válido' }, 400);
  const c = newCode();
  db.links[c] = {
    code: c, dest, label: String(o.label || '').trim().slice(0, 80),
    client: !!o.client, created: Date.now(), visits: []
  };
  save();
  json(res, { ok: true, code: c, url: linkURL(c) });
}

async function linkRoutes(rest, req, res) {
  const c = rest.replace(/\/+$/, '');
  const l = db.links[c];
  if (!l) return json(res, { error: 'No existe' }, 404);
  if (req.method === 'GET') return json(res, { ...l, url: linkURL(c) });
  if (req.method === 'DELETE') { delete db.links[c]; save(); return json(res, { ok: true }); }
  json(res, { error: 'Método no permitido' }, 405);
}

async function hit(rest, req, res) {
  const c = rest.replace(/\/+$/, '');
  const l = db.links[c];
  if (l) {
    let extra = {};
    try { extra = JSON.parse(await readBody(req) || '{}'); } catch (_) {}
    delete extra.ua;
    recordVisit(l, req, { client: extra });
  }
  res.writeHead(204, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end();
}

function track(raw, req, res) {
  const code = raw.replace(/^\/+/, '');
  const l = db.links[code];
  if (!l) { res.writeHead(302, { Location: '/' }); return res.end(); }
  if (l.client) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(clientPage(code, l.dest));
  }
  recordVisit(l, req);
  redirect(res, l.dest);
}

/* ---------- servidor ---------- */
const server = http.createServer(async (req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://' + (req.headers.host || 'localhost')).pathname); }
  catch (_) { p = '/'; }

  try {
    if (p === '/' || p === '/' + PAGE || p === '/index.html') return servePage(res);
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p === '/healthz') return json(res, { ok: true, uptime: Math.round(process.uptime()) });
    if (p === '/api/config') return json(res, { base: BASE });

    if (p === '/api/links') {
      if (req.method === 'GET') return listLinks(res);
      if (req.method === 'POST') return await createLink(req, res);
    }
    if (p.startsWith('/api/hit/')) return await hit(p.slice('/api/hit/'.length), req, res);
    if (p.startsWith('/api/links/')) return await linkRoutes(p.slice('/api/links/'.length), req, res);

    return track(p, req, res);
  } catch (e) {
    console.error(e);
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, () => console.log('linktrace escuchando en el puerto ' + PORT + '  (base: ' + BASE + ')'));
