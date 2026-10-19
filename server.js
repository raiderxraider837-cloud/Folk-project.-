/* ============================================================
   LinkTrace — servidor Node.js
   Almacenamiento: Upstash Redis REST o archivo local.
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BASE = (
  process.env.BASE_URL || 'https://folk-project.onrender.com'
).replace(/\/+$/, '');
const PAGE = process.env.PAGE || 'folkenstein.html';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const MAX_VISITS = 1000;

/* ms que se queda la página intermedia antes de saltar (modo captura) */
const CLIENT_DELAY_MS = Number(process.env.CLIENT_DELAY_MS || 250);

/* ---------- Redis ---------- */

const REDIS_URL = (
  process.env.UPSTASH_REDIS_REST_URL || ''
).replace(/\/+$/, '');

const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_KEY = process.env.REDIS_KEY || 'linktrace:db';
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);

let redisConnected = false;
let redisLastError = null;
let db = { links: {} };
let saveTimer = null;
let saveQueue = Promise.resolve();

async function redisCmd(args) {
  if (!useRedis) {
    throw new Error('Redis no está configurado');
  }

  const response = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + REDIS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error('Redis HTTP ' + response.status);
  }

  const result = await response.json();

  if (result.error) {
    throw new Error(String(result.error));
  }

  redisConnected = true;
  redisLastError = null;

  return result;
}

async function writeRedis() {
  const snapshot = JSON.stringify(db);

  try {
    await redisCmd(['SET', REDIS_KEY, snapshot]);
    return true;
  } catch (error) {
    redisConnected = false;
    redisLastError = error.message;
    console.error('Error guardando en Redis:', error.message);
    return false;
  }
}

function save() {
  if (useRedis) {
    clearTimeout(saveTimer);

    saveTimer = setTimeout(() => {
      saveQueue = saveQueue.then(writeRedis);
    }, 250);

    return;
  }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (error) {
    console.error('No se pudo guardar:', error.message);
  }
}

async function loadState() {
  redisConnected = false;
  redisLastError = null;

  if (useRedis) {
    try {
      const result = await redisCmd(['GET', REDIS_KEY]);

      if (typeof result.result === 'string' && result.result) {
        const parsed = JSON.parse(result.result);

        if (parsed && typeof parsed === 'object' &&
            parsed.links && typeof parsed.links === 'object') {
          db = parsed;
        } else {
          throw new Error('Formato de datos de Redis no válido');
        }
      }

      redisConnected = true;
      redisLastError = null;

      console.log(
        'Almacén: Redis (' +
        Object.keys(db.links).length +
        ' enlaces)'
      );
    } catch (error) {
      redisConnected = false;
      redisLastError = error.message;
      console.error('No se pudo cargar de Redis:', error.message);
    }
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

      if (parsed && typeof parsed === 'object' && parsed.links) {
        db = parsed;
      }
    } catch (_) {
      db = { links: {} };
    }

    console.log('Almacén: archivo local');
  }

  if (!db || typeof db !== 'object' || !db.links) {
    db = { links: {} };
  }
}

/* ---------- Utilidades ---------- */

const ALPHA =
  'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode(length = 6) {
  let code = '';

  for (let i = 0; i < length; i++) {
    code += ALPHA[crypto.randomInt(ALPHA.length)];
  }

  return code;
}

const esc = value =>
  String(value == null ? '' : value).replace(/[&<>"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[char]));

const json = (res, data, status = 200) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });

  res.end(JSON.stringify(data));
};

const readBody = req => new Promise((resolve, reject) => {
  let body = '';
  let size = 0;

  req.on('data', chunk => {
    size += chunk.length;

    if (size > 100000) {
      reject(new Error('Solicitud demasiado grande'));
      req.destroy();
      return;
    }

    body += chunk;
  });

  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const linkURL = code => BASE + '/' + code;

function normalizeDest(destination) {
  let value = String(destination || '').trim();

  if (!value) return null;

  if (!/^https?:\/\//i.test(value)) {
    value = 'https://' + value;
  }

  try {
    const parsed = new URL(value);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }

    return value;
  } catch (_) {
    return null;
  }
}

function clientIP(req) {
  const forwarded = (
    req.headers['x-forwarded-for'] || ''
  ).split(',')[0].trim();

  let ip = forwarded || req.socket.remoteAddress || '';

  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  return ip;
}

const isPrivate = ip =>
  !ip ||
  ip === '::1' ||
  ip.startsWith('127.') ||
  ip.startsWith('10.') ||
  ip.startsWith('192.168.') ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

async function geoLookup(ip) {
  if (isPrivate(ip)) return null;

  try {
    const response = await fetch(
      'http://ip-api.com/json/' +
      encodeURIComponent(ip) +
      '?fields=status,country,countryCode,regionName,city,isp,timezone',
      { signal: AbortSignal.timeout(4000) }
    );

    const data = await response.json();

    if (data.status !== 'success') return null;

    return {
      country: data.country,
      cc: data.countryCode,
      region: data.regionName,
      city: data.city,
      isp: data.isp,
      timezone: data.timezone
    };
  } catch (_) {
    return null;
  }
}

function parseUA(ua) {
  const result = {
    browser: 'Desconocido',
    os: 'Desconocido',
    device: 'Escritorio'
  };

  if (/Edg\//.test(ua)) result.browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) result.browser = 'Opera';
  else if (/Firefox\//.test(ua)) result.browser = 'Firefox';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) {
    result.browser = 'Chrome';
  } else if (/Safari\//.test(ua) && /Version\//.test(ua)) {
    result.browser = 'Safari';
  }

  if (/Windows NT 10/.test(ua)) result.os = 'Windows 10/11';
  else if (/Windows/.test(ua)) result.os = 'Windows';
  else if (/Android/.test(ua)) result.os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) result.os = 'iOS';
  else if (/Mac OS X/.test(ua)) result.os = 'macOS';
  else if (/Linux/.test(ua)) result.os = 'Linux';

  if (/iPad|Tablet/.test(ua)) result.device = 'Tablet';
  else if (/Mobile|Android|iPhone/.test(ua)) result.device = 'Móvil';

  return result;
}

/* ---------- Visitas ---------- */

function recordVisit(link, req, extra = {}) {
  const ua = req.headers['user-agent'] || '';

  const visit = {
    vid: crypto.randomUUID(),
    ip: clientIP(req),
    time: Date.now(),
    ua,
    lang: req.headers['accept-language'] || '',
    ref: req.headers.referer || '',
    ...parseUA(ua),
    ...extra
  };

  link.visits.unshift(visit);

  if (link.visits.length > MAX_VISITS) {
    link.visits.length = MAX_VISITS;
  }

  save();

  geoLookup(visit.ip).then(geo => {
    if (geo) {
      visit.geo = geo;
      save();
    }
  });

  return visit;
}

/* fusiona los datos extra del navegador en la visita ya registrada */
function mergeVisit(link, req, extra) {
  const vid = extra && extra.vid;

  if (vid) {
    const visit = link.visits.find(v => v.vid === vid);

    if (visit) {
      const datos = { ...extra };
      delete datos.vid;
      delete datos.ua;

      visit.client = Object.assign(visit.client || {}, datos);
      save();

      return visit;
    }
  }

  /* si no aparece (JS tardío, reinicio...), se registra normal */
  return recordVisit(link, req, extra ? { client: extra } : {});
}

function redirect(res, destination) {
  res.writeHead(302, {
    Location: destination,
    'Cache-Control': 'no-store, max-age=0'
  });

  res.end();
}

/* ---------- Página intermedia (invisible) ---------- */

function clientPage(code, destination, vid) {
  const safeDestination = JSON.stringify(destination)
    .replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{height:100%;margin:0;background:#fff}</style>
<noscript><meta http-equiv="refresh" content="0;url=${esc(destination)}"></noscript>
</head>
<body>
<script>
(function () {
  var destination = ${safeDestination};
  var vid = ${JSON.stringify(vid)};
  var going = false;

  function go() {
    if (going) return;
    going = true;
    location.replace(destination);
  }

  function send(datos) {
    try {
      fetch('/api/hit/${code}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ vid: vid }, datos)),
        keepalive: true
      }).catch(function () {});
    } catch (_) {}
  }

  send({
    pantalla: screen.width + 'x' + screen.height,
    dpr: window.devicePixelRatio || 1,
    zonaHoraria: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '',
    idiomaNavegador: navigator.language,
    idiomas: (navigator.languages || []).join(', '),
    plataforma: navigator.platform || '',
    nucleos: navigator.hardwareConcurrency || 0,
    tactil: ('ontouchstart' in window)
  });

  try {
    if (navigator.getBattery) {
      navigator.getBattery().then(function (b) {
        send({
          bateria: Math.round(b.level * 100) + '%',
          cargando: b.charging
        });
      });
    }
  } catch (_) {}

  setTimeout(go, ${CLIENT_DELAY_MS});
})();
</script>
</body>
</html>`;
}

/* ---------- Página y API ---------- */

function servePage(res) {
  fs.readFile(path.join(__dirname, PAGE), (error, buffer) => {
    if (error) {
      res.writeHead(404, {
        'Content-Type': 'text/html; charset=utf-8'
      });

      return res.end(
        '<h1>LinkTrace</h1><p>No se encontró el archivo de la página.</p>'
      );
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });

    res.end(buffer);
  });
}

function listLinks(res) {
  const links = Object.values(db.links)
    .sort((a, b) => b.created - a.created)
    .map(link => ({
      code: link.code,
      dest: link.dest,
      label: link.label,
      client: !!link.client,
      created: link.created,
      clicks: link.visits.length,
      url: linkURL(link.code)
    }));

  json(res, links);
}

async function createLink(req, res) {
  let input = {};

  try {
    input = JSON.parse(await readBody(req) || '{}');
  } catch (_) {
    return json(res, { error: 'JSON no válido' }, 400);
  }

  const destination = normalizeDest(input.dest);

  if (!destination) {
    return json(res, { error: 'Destino no válido' }, 400);
  }

  const code = newCode();

  db.links[code] = {
    code,
    dest: destination,
    label: String(input.label || '').trim().slice(0, 80),
    client: !!input.client,
    created: Date.now(),
    visits: []
  };

  save();

  json(res, {
    ok: true,
    code,
    url: linkURL(code)
  });
}

async function linkRoutes(rest, req, res) {
  const code = rest.replace(/\/+$/, '');
  const link = db.links[code];

  if (!link) {
    return json(res, { error: 'No existe' }, 404);
  }

  if (req.method === 'GET') {
    return json(res, { ...link, url: linkURL(code) });
  }

  if (req.method === 'DELETE') {
    delete db.links[code];
    save();

    return json(res, { ok: true });
  }

  json(res, { error: 'Método no permitido' }, 405);
}

async function hit(rest, req, res) {
  const code = rest.replace(/\/+$/, '');
  const link = db.links[code];

  if (link && req.method === 'POST') {
    let extra = {};

    try {
      extra = JSON.parse(await readBody(req) || '{}');
    } catch (_) {}

    mergeVisit(link, req, extra);
  }

  res.writeHead(204, {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });

  res.end();
}

function track(raw, req, res) {
  const code = raw.replace(/^\/+/, '');
  const link = db.links[code];

  if (!link) {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  /* la visita se registra UNA vez; en modo captura se fusiona luego por vid */
  const visit = recordVisit(link, req);

  if (link.client) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });

    return res.end(clientPage(code, link.dest, visit.vid));
  }

  redirect(res, link.dest);
}

/* ---------- Servidor ---------- */

const server = http.createServer(async (req, res) => {
  let pathname;

  try {
    pathname = decodeURIComponent(
      new URL(req.url, 'http://' + (req.headers.host || 'localhost')).pathname
    );
  } catch (_) {
    pathname = '/';
  }

  try {
    if (pathname === '/' ||
        pathname === '/' + PAGE ||
        pathname === '/index.html') {
      return servePage(res);
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    if (pathname === '/healthz') {
      return json(res, {
        ok: true,
        uptime: Math.round(process.uptime()),
        store: useRedis ? 'redis' : 'file',
        redisConfigured: useRedis,
        redisConnected: useRedis ? redisConnected : false,
        redisError: redisLastError
      });
    }

    if (pathname === '/api/config') {
      return json(res, { base: BASE });
    }

    if (pathname === '/api/links') {
      if (req.method === 'GET') return listLinks(res);
      if (req.method === 'POST') return await createLink(req, res);

      return json(res, { error: 'Método no permitido' }, 405);
    }

    if (pathname.startsWith('/api/hit/')) {
      return await hit(pathname.slice('/api/hit/'.length), req, res);
    }

    if (pathname.startsWith('/api/links/')) {
      return await linkRoutes(
        pathname.slice('/api/links/'.length),
        req,
        res
      );
    }

    return track(pathname, req, res);
  } catch (error) {
    console.error('Error en solicitud:', error.message);

    if (!res.headersSent) {
      return json(res, { error: 'Error interno del servidor' }, 500);
    }

    res.end();
  }
});

/* ---------- Arranque y cierre ---------- */

(async () => {
  await loadState();

  server.listen(PORT, () => {
    console.log(
      'LinkTrace en el puerto ' + PORT +
      ' (base: ' + BASE + ')'
    );
  });
})();

process.on('SIGTERM', async () => {
  clearTimeout(saveTimer);

  try {
    await saveQueue;

    if (useRedis) {
      await writeRedis();
    }
  } finally {
    server.close(() => process.exit(0));
  }
});
