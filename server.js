
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BASE = (process.env.BASE_URL || 'https://folk-project.onrender.com').replace(/\/+$/, '');
const DATA_FILE = path.join(__dirname, 'data.json');
const HTML_FILE = path.join(__dirname, 'folkenstein.html');

let db = { links: {} };

try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (saved && saved.links && typeof saved.links === 'object') db = saved;
} catch (_) {}

function save() {
  const temp = DATA_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, DATA_FILE);
}

function newCode() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[crypto.randomInt(chars.length)];
    }
  } while (db.links[code]);
  return code;
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 20000) {
        reject(new Error('Solicitud demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function servePage(res) {
  fs.readFile(HTML_FILE, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No se encuentra folkenstein.html. Revisa los archivos de GitHub.');
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

function validDestination(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  let url;

  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_) {
    return json(res, { error: 'URL no válida' }, 400);
  }

  const route = url.pathname;

  if (req.method === 'GET' && (route === '/' || route === '/folkenstein.html')) {
    return servePage(res);
  }

  if (route === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && route === '/api/config') {
    return json(res, { base: BASE });
  }

  if (route === '/api/links' && req.method === 'GET') {
    const links = Object.values(db.links)
      .sort((a, b) => b.created - a.created)
      .map(link => ({
        code: link.code,
        dest: link.dest,
        label: link.label,
        created: link.created,
        clicks: link.clicks || 0,
        url: BASE + '/' + link.code
      }));

    return json(res, links);
  }

  if (route === '/api/links' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      let dest = String(body.dest || '').trim();
      const label = String(body.label || '').trim().slice(0, 100);

      if (!dest) {
        return json(res, { error: 'Escribe un destino' }, 400);
      }

      if (!/^https?:\/\//i.test(dest)) dest = 'https://' + dest;

      if (!validDestination(dest)) {
        return json(res, { error: 'El destino debe ser una URL HTTP o HTTPS válida' }, 400);
      }

      const code = newCode();

      db.links[code] = {
        code,
        dest,
        label,
        created: Date.now(),
        clicks: 0
      };

      save();

      return json(res, {
        ok: true,
        code,
        url: BASE + '/' + code
      }, 201);
    } catch (_) {
      return json(res, { error: 'No se pudo procesar la solicitud' }, 400);
    }
  }

  const match = route.match(/^\/api\/links\/([A-Za-z0-9]+)$/);

  if (match) {
    const code = match[1];
    const link = db.links[code];

    if (!link) return json(res, { error: 'No existe' }, 404);

    if (req.method === 'GET') {
      return json(res, {
        code: link.code,
        dest: link.dest,
        label: link.label,
        created: link.created,
        clicks: link.clicks || 0,
        url: BASE + '/' + code
      });
    }

    if (req.method === 'DELETE') {
      delete db.links[code];
      save();
      return json(res, { ok: true });
    }
  }

  if (req.method === 'GET' && route.length > 1) {
    const code = route.slice(1);

    if (!/^[A-Za-z0-9]{6}$/.test(code)) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }

    const link = db.links[code];

    if (!link) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }

    link.clicks = (link.clicks || 0) + 1;

    try {
      save();
    } catch (_) {}

    res.writeHead(302, {
      Location: link.dest,
      'Cache-Control': 'no-store'
    });
    return res.end();
  }

  return json(res, { error: 'Ruta no encontrada' }, 404);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('LinkTrace iniciado en el puerto ' + PORT);
});
