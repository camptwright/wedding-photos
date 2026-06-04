import express from 'express';
import multer from 'multer';
import initSqlJs from 'sql.js';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const MAX_UPLOADS_PER_GUEST = parseInt(process.env.MAX_UPLOADS_PER_GUEST || '50');
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '100');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme2026';
const COUPLE_NAMES = process.env.COUPLE_NAMES || 'Claire & Campbell';
const WEDDING_DATE = process.env.WEDDING_DATE || 'June 13, 2026';
const WALL_TOKEN = process.env.WALL_TOKEN || 'wallpass2026';
const WALL_SLIDE_SECONDS = parseInt(process.env.WALL_SLIDE_SECONDS || '7');
const DB_PATH = path.join(__dirname, 'wedding.db');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── Database ──────────────────────────────────────────────────────────────
const SQL = await initSqlJs();
let db;

if (fs.existsSync(DB_PATH)) {
  const buf = fs.readFileSync(DB_PATH);
  db = new SQL.Database(buf);
} else {
  db = new SQL.Database();
}

db.run(`
  CREATE TABLE IF NOT EXISTS guests (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    table_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    guest_id TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    uploaded_at TEXT DEFAULT (datetime('now')),
    synced_at TEXT,
    FOREIGN KEY (guest_id) REFERENCES guests(id)
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_uploads_guest ON uploads(guest_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_uploads_synced ON uploads(synced_at)`);

function saveDb() {
  const data = db.export();
  const buf = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buf);
}

// Auto-save every 10 seconds
setInterval(saveDb, 10000);
process.on('exit', saveDb);
process.on('SIGINT', () => { saveDb(); process.exit(); });
process.on('SIGTERM', () => { saveDb(); process.exit(); });

// Helper to run queries and get results as objects
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// ─── Photo Wall: live update broadcasting (SSE) ──────────────────────────────
const wallClients = new Set();

function broadcastNewPhotos(photos) {
  const payload = `event: newphotos\ndata: ${JSON.stringify(photos)}\n\n`;
  for (const client of wallClients) {
    try { client.write(payload); } catch (e) { /* client gone */ }
  }
}

// Heartbeat keeps SSE connections alive through proxies/tunnels
setInterval(() => {
  for (const client of wallClients) {
    try { client.write(': keep-alive\n\n'); } catch (e) { /* ignore */ }
  }
}, 20000);

// ─── Multer Setup ──────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const guestDir = path.join(UPLOAD_DIR, req.guestId || 'unknown');
    fs.mkdirSync(guestDir, { recursive: true });
    cb(null, guestDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /^(image\/(jpeg|jpg|png|heic|heif|webp|gif)|video\/(mp4|mov|quicktime|avi|webm))$/i;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error(`File type ${file.mimetype} not allowed. Please upload photos or videos.`));
  }
});

// ─── App ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    coupleNames: COUPLE_NAMES,
    weddingDate: WEDDING_DATE,
    maxUploads: MAX_UPLOADS_PER_GUEST,
    maxFileSizeMB: MAX_FILE_SIZE_MB,
  });
});

// ─── Guest Registration ────────────────────────────────────────────────────
app.post('/api/guest', (req, res) => {
  const { name, tableId } = req.body;
  if (!name || name.trim().length < 1) return res.status(400).json({ error: 'Name is required' });

  const trimmedName = name.trim();
  const tbl = (tableId || 'general').trim();

  let guest = queryOne('SELECT * FROM guests WHERE name = ? AND table_id = ?', [trimmedName, tbl]);
  if (!guest) {
    const id = randomUUID();
    run('INSERT INTO guests (id, name, table_id) VALUES (?, ?, ?)', [id, trimmedName, tbl]);
    guest = { id, name: trimmedName, table_id: tbl };
  }

  const row = queryOne('SELECT COUNT(*) as count FROM uploads WHERE guest_id = ?', [guest.id]);
  res.json({ ...guest, uploadCount: row.count, maxUploads: MAX_UPLOADS_PER_GUEST });
});

// ─── Upload ────────────────────────────────────────────────────────────────
app.post('/api/upload', (req, res, next) => {
  req.guestId = req.headers['x-guest-id'];
  if (!req.guestId) return res.status(401).json({ error: 'Guest ID required' });

  const row = queryOne('SELECT COUNT(*) as count FROM uploads WHERE guest_id = ?', [req.guestId]);
  if (row.count >= MAX_UPLOADS_PER_GUEST) {
    return res.status(429).json({ error: `Upload limit reached (${MAX_UPLOADS_PER_GUEST} files max)`, count: row.count, max: MAX_UPLOADS_PER_GUEST });
  }
  next();
}, upload.array('files', 10), (req, res) => {
  const guestId = req.guestId;
  const currentCount = queryOne('SELECT COUNT(*) as count FROM uploads WHERE guest_id = ?', [guestId]).count;
  const remaining = MAX_UPLOADS_PER_GUEST - currentCount;

  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const guestName = (queryOne('SELECT name FROM guests WHERE id = ?', [guestId]) || {}).name || 'Guest';
  const filesToSave = req.files.slice(0, remaining);
  const saved = [];
  const wallPhotos = [];

  for (const file of filesToSave) {
    const id = randomUUID();
    run('INSERT INTO uploads (id, guest_id, original_name, stored_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?)',
      [id, guestId, file.originalname, file.filename, file.mimetype, file.size]);
    saved.push({ id, name: file.originalname, size: file.size });
    wallPhotos.push({ id, guest_id: guestId, guest_name: guestName, stored_name: file.filename, mime_type: file.mimetype });
  }

  for (let i = remaining; i < req.files.length; i++) {
    fs.unlinkSync(req.files[i].path);
  }

  // Push the freshly uploaded photos to any live photo walls
  if (wallPhotos.length > 0) broadcastNewPhotos(wallPhotos);

  const newCount = queryOne('SELECT COUNT(*) as count FROM uploads WHERE guest_id = ?', [guestId]).count;
  res.json({ uploaded: saved.length, rejected: req.files.length - saved.length, totalUploads: newCount, remaining: MAX_UPLOADS_PER_GUEST - newCount });
});

// ─── Guest's Uploads ───────────────────────────────────────────────────────
app.get('/api/uploads/:guestId', (req, res) => {
  const uploads = queryAll('SELECT * FROM uploads WHERE guest_id = ? ORDER BY uploaded_at DESC', [req.params.guestId]);
  const row = queryOne('SELECT COUNT(*) as count FROM uploads WHERE guest_id = ?', [req.params.guestId]);
  res.json({ uploads, count: row.count, max: MAX_UPLOADS_PER_GUEST });
});

// ─── Delete Upload ─────────────────────────────────────────────────────────
app.delete('/api/upload/:uploadId', (req, res) => {
  const guestId = req.headers['x-guest-id'];
  if (!guestId) return res.status(401).json({ error: 'Guest ID required' });

  const upl = queryOne('SELECT * FROM uploads WHERE id = ? AND guest_id = ?', [req.params.uploadId, guestId]);
  if (!upl) return res.status(404).json({ error: 'Upload not found' });

  const filePath = path.join(UPLOAD_DIR, guestId, upl.stored_name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  run('DELETE FROM uploads WHERE id = ?', [req.params.uploadId]);
  const row = queryOne('SELECT COUNT(*) as count FROM uploads WHERE guest_id = ?', [guestId]);
  res.json({ deleted: true, totalUploads: row.count, remaining: MAX_UPLOADS_PER_GUEST - row.count });
});

// ─── Admin ─────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Invalid admin password' });
  next();
}

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const stats = queryOne('SELECT (SELECT COUNT(*) FROM guests) as total_guests, (SELECT COUNT(*) FROM uploads) as total_uploads, (SELECT COALESCE(SUM(size_bytes), 0) FROM uploads) as total_bytes');
  const guests = queryAll('SELECT g.*, COUNT(u.id) as upload_count FROM guests g LEFT JOIN uploads u ON g.id = u.guest_id GROUP BY g.id ORDER BY g.created_at DESC');
  res.json({ ...stats, totalSizeMB: (stats.total_bytes / (1024 * 1024)).toFixed(1), maxPerGuest: MAX_UPLOADS_PER_GUEST, guests });
});

app.get('/api/admin/unsynced', adminAuth, (req, res) => {
  const uploads = queryAll('SELECT u.*, g.name as guest_name FROM uploads u JOIN guests g ON u.guest_id = g.id WHERE u.synced_at IS NULL ORDER BY u.uploaded_at ASC');
  res.json({ uploads });
});

app.post('/api/admin/mark-synced', adminAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  for (const id of ids) run('UPDATE uploads SET synced_at = datetime("now") WHERE id = ?', [id]);
  res.json({ marked: ids.length });
});

app.get('/api/admin/file/:guestId/:filename', adminAuth, (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.guestId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});

// ─── Photo Wall ──────────────────────────────────────────────────────────────
// Token-gated so the wall URL can be opened on a display without exposing
// photos to anyone who guesses the domain. Token is passed as ?key= because
// <img> and EventSource cannot send custom headers.
function wallAuth(req, res, next) {
  const key = req.query.key || req.headers['x-wall-token'];
  if (key !== WALL_TOKEN) return res.status(403).json({ error: 'Invalid wall token' });
  next();
}

// Wall config (couple names, slide timing) — also gated so it only works with the token
app.get('/api/wall/config', wallAuth, (req, res) => {
  res.json({ coupleNames: COUPLE_NAMES, weddingDate: WEDDING_DATE, slideSeconds: WALL_SLIDE_SECONDS });
});

// Full list of photos for the wall (newest first)
app.get('/api/wall/photos', wallAuth, (req, res) => {
  const photos = queryAll(
    'SELECT u.id, u.guest_id, u.stored_name, u.mime_type, u.uploaded_at, g.name as guest_name ' +
    'FROM uploads u JOIN guests g ON u.guest_id = g.id ORDER BY u.uploaded_at DESC'
  );
  res.json({ photos, total: photos.length });
});

// Serve an individual photo/video file for the wall
app.get('/api/wall/file/:guestId/:filename', wallAuth, (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.guestId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});

// Server-Sent Events stream: pushes new photos to the wall in real time
app.get('/api/wall/stream', wallAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  res.write(': connected\n\n');

  wallClients.add(res);
  req.on('close', () => { wallClients.delete(res); });
});

// ─── Error Handling ────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File too large. Max size is ${MAX_FILE_SIZE_MB}MB.` });
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
});

// Photo wall display page
app.get('/wall', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'wall.html')); });

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🎊 Wedding Photo Booth running on http://0.0.0.0:${PORT}`);
  console.log(`  📸 Upload limit: ${MAX_UPLOADS_PER_GUEST} files per guest`);
  console.log(`  📂 Uploads stored in: ${UPLOAD_DIR}`);
  console.log(`  🔑 Admin password: ${ADMIN_PASSWORD}`);
  console.log(`  🖼  Photo wall: http://0.0.0.0:${PORT}/wall?key=${WALL_TOKEN}\n`);
});
