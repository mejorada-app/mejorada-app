const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    INSERT INTO facturas (id, folio, fecha, cliente, cotizacionId, total, vencimiento, pago, notas)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(f.id, f.folio, f.fecha, f.cliente, f.cotizacionId||null, f.total, f.vencimiento||null, f.pago, f.notas||'');
  res.json({ ok: true });
});

app.put('/api/facturas/:id', (req, res) => {
  const f = req.body;
  db.prepare(`
    UPDATE facturas SET folio=?, fecha=?, cliente=?, cotizacionId=?, total=?, vencimiento=?, pago=?, notas=?
    WHERE id=?
  `).run(f.folio, f.fecha, f.cliente, f.cotizacionId||null, f.total, f.vencimiento||null, f.pago, f.notas||'', req.params.id);
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
    const ins = db.prepare(`INSERT OR REPLACE INTO facturas (id, folio, fecha, cliente, cotizacionId, total, vencimiento, pago, notas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    facturas.forEach(f => ins.run(f.id, f.folio, f.fecha, f.cliente, f.cotizacionId||null, f.total, f.vencimiento||null, f.pago, f.notas||''));
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
