
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const DATA_FILE = path.join(__dirname, "data.json");
const PUBLIC_DIR = __dirname;

let links = {};

try {
  if (fs.existsSync(DATA_FILE)) {
    links = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  }
} catch {
  links = {};
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(links, null, 2));
}

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function serveFile(res, filename) {
  const filePath = path.resolve(PUBLIC_DIR, filename);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, { error: "Acceso denegado" });
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      return send(res, 404, { error: "Archivo no encontrado" });
    }

    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".webp": "image/webp"
    };

    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });

    res.end(content);
  });
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 10000) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;

  if (origin && origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  let url;

  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    return send(res, 400, { error: "URL inválida" });
  }

  const pathname = decodeURIComponent(url.pathname);

  if (req.method === "GET" && pathname === "/") {
    return serveFile(res, "folk.html");
  }

  if (req.method === "GET" && pathname === "/folk.html") {
    return serveFile(res, "folk.html");
  }

  if (req.method === "GET" && pathname === "/folki.js") {
    return serveFile(res, "folki.js");
  }

  if (req.method === "GET" && pathname === "/api") {
    return send(res, 200, {
      name: "LinkTrace API",
      status: "online",
      message: "API disponible"
    });
  }

  if (req.method === "POST" && pathname === "/api/links") {
    let body;

    try {
      body = await getBody(req);
    } catch {
      return send(res, 400, { error: "JSON inválido" });
    }

    let destination;

    try {
      destination = new URL(body.url);
    } catch {
      return send(res, 400, { error: "URL inválida" });
    }

    if (!["http:", "https:"].includes(destination.protocol)) {
      return send(res, 400, {
        error: "Solo se permiten enlaces HTTP o HTTPS"
      });
    }

    const code = crypto.randomBytes(4).toString("hex");

    links[code] = {
      url: destination.href,
      createdAt: new Date().toISOString(),
      visits: []
    };

    try {
      saveData();
    } catch {
      delete links[code];
      return send(res, 500, {
        error: "No se pudo guardar el enlace"
      });
    }

    const base = process.env.PUBLIC_BASE_URL || "";

    return send(res, 201, {
      code,
      url: base
        ? `${base.replace(/\/$/, "")}/${code}`
        : `/${code}`
    });
  }

  const code = pathname.slice(1);

  if (
    req.method === "GET" &&
    /^[a-f0-9]{8}$/.test(code) &&
    links[code]
  ) {
    const link = links[code];

    link.visits.push({
      time: new Date().toISOString(),
      ip: req.socket.remoteAddress || null,
      userAgent: req.headers["user-agent"] || null,
      language: req.headers["accept-language"] || null,
      referer: req.headers.referer || null
    });

    try {
      saveData();
    } catch {}

    res.writeHead(302, {
      Location: link.url,
      "Cache-Control": "no-store"
    });

    return res.end();
  }

  return send(res, 404, { error: "Ruta no encontrada" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LinkTrace escuchando en el puerto ${PORT}`);
});
 
