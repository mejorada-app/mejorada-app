require('dotenv').config(); // carga GEMINI_API_KEY (y otras) desde un archivo .env si existe
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const { GoogleGenAI, Type } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// Base de datos SQLite persistente en Railway
const db = new Database('mejorada.db');

// Crear tablas si no existen
db.exec(`
  CREATE TABLE IF NOT EXISTS cotizaciones (
    id TEXT PRIMARY KEY,
    fecha TEXT,
    vendedor TEXT,
    cliente TEXT,
    desc TEXT,
    subtotal REAL,
    estado TEXT,
    gFlete REAL DEFAULT 0,
    gMobiliario REAL DEFAULT 0,
    gSilleria REAL DEFAULT 0,
    gInstalaciones REAL DEFAULT 0,
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS facturas (
    id TEXT PRIMARY KEY,
    folio TEXT,
    fecha TEXT,
    cliente TEXT,
    rfc TEXT,
    cotizacionId TEXT,
    total REAL,
    vencimiento TEXT,
    pago TEXT DEFAULT 'pendiente',
    notas TEXT,
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    key TEXT PRIMARY KEY,
    name TEXT,
    pin TEXT,
    role TEXT,
    avatar TEXT
  );
`);

// Migración: agregar columna rfc a facturas si la base ya existía sin ella
try { db.exec('ALTER TABLE facturas ADD COLUMN rfc TEXT'); } catch (e) { /* la columna ya existe */ }

// Tabla de la llave de IA + medición de consumo de tokens (una sola fila, id = 1)
db.exec(`
  CREATE TABLE IF NOT EXISTS apikey (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT DEFAULT 'gemini',
    key TEXT DEFAULT '',
    token_limit INTEGER DEFAULT 1000000,
    tokens_used INTEGER DEFAULT 0,
    fingerprint TEXT DEFAULT '',
    updated_at TEXT
  );
`);
db.prepare('INSERT OR IGNORE INTO apikey (id, provider, token_limit, tokens_used) VALUES (1, ?, ?, 0)').run('gemini', 1000000);

// Insertar usuarios por defecto si no existen
const adminExists = db.prepare('SELECT key FROM users WHERE key = ?').get('admin');
if (!adminExists) {
  db.prepare('INSERT INTO users (key, name, pin, role, avatar) VALUES (?, ?, ?, ?, ?)').run('admin', 'Administrador', '1234', 'admin', '👨‍💼');
  db.prepare('INSERT INTO users (key, name, pin, role, avatar) VALUES (?, ?, ?, ?, ?)').run('vendedor', 'Vendedor', '5678', 'vendedor', '🧑‍💼');
}

// Insertar config por defecto si no existe
const configExists = db.prepare('SELECT key FROM config WHERE key = ?').get('commAdmin');
if (!configExists) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('commAdmin', '5');
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('commVendedor', '3');
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('commBase', 'total');
}

app.use(express.json({ limit: '25mb' })); // límite alto: los PDF/imágenes viajan en base64
app.use(express.static(path.join(__dirname, 'public')));

// =================== EXTRACCIÓN IA DE FACTURAS + MEDICIÓN DE TOKENS ===================
// Usa el SDK oficial de Google (Gemini). La llave se administra desde Config (tabla apikey),
// con respaldo a la variable de entorno GEMINI_API_KEY.
const EXTRACT_MODEL = process.env.EXTRACT_MODEL || 'gemini-2.5-flash';

const FACTURA_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    folio:   { type: Type.STRING, nullable: true, description: 'Serie y folio juntos, ej. "G-58".' },
    fecha:   { type: Type.STRING, nullable: true, description: 'Fecha de emisión en formato YYYY-MM-DD.' },
    cliente: { type: Type.STRING, nullable: true, description: 'Nombre del receptor (cliente al que se factura).' },
    rfc:     { type: Type.STRING, nullable: true, description: 'RFC del receptor (NO el del emisor).' },
    total:   { type: Type.NUMBER, nullable: true, description: 'Importe total a pagar (Total del CFDI, no el subtotal).' }
  },
  required: ['folio', 'fecha', 'cliente', 'rfc', 'total'],
  propertyOrdering: ['folio', 'fecha', 'cliente', 'rfc', 'total']
};

function getApiRow() { return db.prepare('SELECT * FROM apikey WHERE id = 1').get(); }
function currentApiKey() {
  const row = getApiRow();
  return (row && row.key) ? row.key : (process.env.GEMINI_API_KEY || '');
}
function fingerprint(key) {
  return key ? crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) : '';
}
function maskKey(key) {
  if (key) return '••••' + String(key).slice(-4);
  return process.env.GEMINI_API_KEY ? '•••• (desde .env)' : '';
}
function apiStatus() {
  const row = getApiRow();
  const usingEnv = !row.key && !!process.env.GEMINI_API_KEY;
  return {
    provider: row.provider || 'gemini',
    hasKey: !!(row.key || process.env.GEMINI_API_KEY),
    keyMasked: maskKey(row.key),
    source: row.key ? 'app' : (process.env.GEMINI_API_KEY ? 'env' : 'none'),
    tokenLimit: row.token_limit,
    tokensUsed: row.tokens_used,
    updatedAt: row.updated_at
  };
}

app.post('/api/extract-factura', async (req, res) => {
  const row = getApiRow();
  const apiKey = currentApiKey();
  if (!apiKey) {
    return res.status(503).json({ error: 'No hay una llave de IA configurada. Agrégala en Config → API de IA.' });
  }
  if ((row.provider || 'gemini') !== 'gemini') {
    return res.status(400).json({ error: 'Por ahora la lectura de facturas solo está implementada para Google Gemini.' });
  }
  const { dataBase64, mediaType } = req.body || {};
  if (!dataBase64 || !mediaType) {
    return res.status(400).json({ error: 'Falta el archivo (dataBase64 / mediaType).' });
  }
  if (mediaType !== 'application/pdf' && !mediaType.startsWith('image/')) {
    return res.status(400).json({ error: 'Tipo de archivo no soportado para IA: ' + mediaType });
  }

  try {
    const genai = new GoogleGenAI({ apiKey });
    const response = await genai.models.generateContent({
      model: EXTRACT_MODEL,
      contents: [
        { inlineData: { mimeType: mediaType, data: dataBase64 } },
        { text:
            'Esta es una factura (CFDI mexicano). Extrae estos datos según el esquema:\n' +
            '- folio: la serie y el folio juntos, ej. "G-58".\n' +
            '- fecha: la fecha de emisión en formato YYYY-MM-DD.\n' +
            '- cliente: el nombre del RECEPTOR (a quién se le factura), nunca el emisor.\n' +
            '- rfc: el RFC del RECEPTOR, nunca el del emisor.\n' +
            '- total: el TOTAL a pagar (no el subtotal ni los impuestos por separado).\n' +
            'Si algún dato no aparece en la factura, devuelve null en ese campo.' }
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: FACTURA_SCHEMA
      }
    });
    const text = response.text;
    if (!text) return res.status(502).json({ error: 'La IA no devolvió datos.' });

    // Medición EXACTA: Google reporta los tokens consumidos por esta llamada
    const used = (response.usageMetadata && response.usageMetadata.totalTokenCount) || 0;
    db.prepare('UPDATE apikey SET tokens_used = tokens_used + ? WHERE id = 1').run(used);
    const updated = getApiRow();

    res.json({
      ok: true,
      data: JSON.parse(text),
      usage: { lastCall: used, tokensUsed: updated.tokens_used, tokenLimit: updated.token_limit }
    });
  } catch (err) {
    console.error('extract-factura error:', err.status || '', err.message || err);
    res.status(502).json({ error: 'No se pudo procesar la factura con IA: ' + (err.message || 'error desconocido') });
  }
});

// =================== LLAVE DE IA / MEDIDOR DE TOKENS ===================
app.get('/api/apikey', (req, res) => {
  res.json(apiStatus());
});

app.post('/api/apikey', (req, res) => {
  const { provider, key, tokenLimit } = req.body || {};
  const row = getApiRow();
  let message = 'Cambios guardados.';

  // Si llega una llave nueva (no vacía y distinta), guardarla y reiniciar el medidor
  if (typeof key === 'string' && key.trim()) {
    const newKey = key.trim();
    const fp = fingerprint(newKey);
    if (fp !== row.fingerprint) {
      db.prepare('UPDATE apikey SET key = ?, fingerprint = ?, tokens_used = 0 WHERE id = 1').run(newKey, fp);
      message = 'Llave nueva guardada. El medidor se reinició a 0 y mide desde cero.';
    } else {
      message = 'La llave es la misma; el medidor se conserva.';
    }
  }
  if (provider) db.prepare('UPDATE apikey SET provider = ? WHERE id = 1').run(String(provider));
  if (tokenLimit != null && !isNaN(parseInt(tokenLimit, 10))) {
    db.prepare('UPDATE apikey SET token_limit = ? WHERE id = 1').run(parseInt(tokenLimit, 10));
  }
  db.prepare("UPDATE apikey SET updated_at = datetime('now') WHERE id = 1").run();
  res.json(Object.assign({ ok: true, message }, apiStatus()));
});

app.post('/api/apikey/reset', (req, res) => {
  db.prepare("UPDATE apikey SET tokens_used = 0, updated_at = datetime('now') WHERE id = 1").run();
  res.json(Object.assign({ ok: true }, apiStatus()));
});

// =================== USERS ===================
app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT * FROM users').all();
  const result = {};
  users.forEach(u => result[u.key] = u);
  res.json(result);
});

app.put('/api/users/:key', (req, res) => {
  const { name, pin } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE key = ?').get(req.params.key);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (name) db.prepare('UPDATE users SET name = ? WHERE key = ?').run(name, req.params.key);
  if (pin && pin.length >= 4) db.prepare('UPDATE users SET pin = ? WHERE key = ?').run(pin, req.params.key);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { userKey, pin } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE key = ?').get(userKey);
  if (!user || user.pin !== pin) return res.status(401).json({ error: 'PIN incorrecto' });
  res.json({ ok: true, user });
});

// =================== CONFIG ===================
app.get('/api/config', (req, res) => {
  const rows = db.prepare('SELECT * FROM config').all();
  const result = {};
  rows.forEach(r => result[r.key] = r.value);
  res.json(result);
});

app.post('/api/config', (req, res) => {
  const entries = Object.entries(req.body);
  const upsert = db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  entries.forEach(([k, v]) => upsert.run(k, String(v)));
  res.json({ ok: true });
});

// =================== COTIZACIONES ===================
app.get('/api/cotizaciones', (req, res) => {
  const rows = db.prepare('SELECT * FROM cotizaciones ORDER BY createdAt DESC').all();
  res.json(rows);
});

app.post('/api/cotizaciones', (req, res) => {
  const c = req.body;
  db.prepare(`
    INSERT INTO cotizaciones (id, fecha, vendedor, cliente, desc, subtotal, estado, gFlete, gMobiliario, gSilleria, gInstalaciones)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(c.id, c.fecha, c.vendedor, c.cliente, c.desc||'', c.subtotal, c.estado, c.gFlete||0, c.gMobiliario||0, c.gSilleria||0, c.gInstalaciones||0);
  res.json({ ok: true });
});

app.put('/api/cotizaciones/:id', (req, res) => {
  const c = req.body;
  db.prepare(`
    UPDATE cotizaciones SET fecha=?, vendedor=?, cliente=?, desc=?, subtotal=?, estado=?, gFlete=?, gMobiliario=?, gSilleria=?, gInstalaciones=?
    WHERE id=?
  `).run(c.fecha, c.vendedor, c.cliente, c.desc||'', c.subtotal, c.estado, c.gFlete||0, c.gMobiliario||0, c.gSilleria||0, c.gInstalaciones||0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/cotizaciones/:id', (req, res) => {
  db.prepare('DELETE FROM cotizaciones WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// =================== FACTURAS ===================
app.get('/api/facturas', (req, res) => {
  const rows = db.prepare('SELECT * FROM facturas ORDER BY createdAt DESC').all();
  res.json(rows);
});

app.post('/api/facturas', (req, res) => {
  const f = req.body;
  db.prepare(`
    INSERT INTO facturas (id, folio, fecha, cliente, rfc, cotizacionId, total, vencimiento, pago, notas)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(f.id, f.folio, f.fecha, f.cliente, f.rfc||null, f.cotizacionId||null, f.total, f.vencimiento||null, f.pago, f.notas||'');
  res.json({ ok: true });
});

app.put('/api/facturas/:id', (req, res) => {
  const f = req.body;
  db.prepare(`
    UPDATE facturas SET folio=?, fecha=?, cliente=?, rfc=?, cotizacionId=?, total=?, vencimiento=?, pago=?, notas=?
    WHERE id=?
  `).run(f.folio, f.fecha, f.cliente, f.rfc||null, f.cotizacionId||null, f.total, f.vencimiento||null, f.pago, f.notas||'', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/facturas/:id', (req, res) => {
  db.prepare('DELETE FROM facturas WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// =================== RESET ===================
app.delete('/api/reset', (req, res) => {
  db.prepare('DELETE FROM cotizaciones').run();
  db.prepare('DELETE FROM facturas').run();
  res.json({ ok: true });
});

// =================== IMPORT ===================
app.post('/api/import', (req, res) => {
  const { cotizaciones, facturas, config } = req.body;

  if (cotizaciones) {
    db.prepare('DELETE FROM cotizaciones').run();
    const ins = db.prepare(`INSERT OR REPLACE INTO cotizaciones (id, fecha, vendedor, cliente, desc, subtotal, estado, gFlete, gMobiliario, gSilleria, gInstalaciones) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    cotizaciones.forEach(c => ins.run(c.id, c.fecha, c.vendedor, c.cliente, c.desc||'', c.subtotal, c.estado, c.gFlete||0, c.gMobiliario||0, c.gSilleria||0, c.gInstalaciones||0));
  }

  if (facturas) {
    db.prepare('DELETE FROM facturas').run();
    const ins = db.prepare(`INSERT OR REPLACE INTO facturas (id, folio, fecha, cliente, rfc, cotizacionId, total, vencimiento, pago, notas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    facturas.forEach(f => ins.run(f.id, f.folio, f.fecha, f.cliente, f.rfc||null, f.cotizacionId||null, f.total, f.vencimiento||null, f.pago, f.notas||''));
  }

  if (config) {
    const upsert = db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    Object.entries(config).forEach(([k, v]) => upsert.run(k, String(v)));
  }

  res.json({ ok: true });
});

// Servir index.html para cualquier ruta no definida
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Grupo Mejorada 1910 – Servidor corriendo en puerto ${PORT}`);
});
