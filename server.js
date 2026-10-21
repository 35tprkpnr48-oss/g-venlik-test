'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'reports.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render proxy; only use this when deployed behind the configured platform proxy.
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));
function readReports() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; } }
function writeReports(rows) { fs.writeFileSync(DATA_FILE, JSON.stringify(rows.slice(0, 1000), null, 2), { mode: 0o600 }); }
function auth(req, res, next) {
  if (!PANEL_PASSWORD) return res.status(503).send('Panel password is not configured. Set PANEL_PASSWORD in the hosting environment.');
  const h = req.headers.authorization || '';
  const [scheme, token] = h.split(' ');
  if (scheme !== 'Basic' || !token) { res.set('WWW-Authenticate', 'Basic realm="Private report panel"'); return res.status(401).send('Sign in required'); }
  let pair = ''; try { pair = Buffer.from(token, 'base64').toString('utf8'); } catch {}
  const i = pair.indexOf(':');
  const user = i < 0 ? '' : pair.slice(0, i), pass = i < 0 ? '' : pair.slice(i + 1);
  const a = Buffer.from(user), b = Buffer.from(PANEL_USER), c = Buffer.from(pass), d = Buffer.from(PANEL_PASSWORD);
  const userOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  const passOk = c.length === d.length && crypto.timingSafeEqual(c, d);
  if (!userOk || !passOk) { res.set('WWW-Authenticate', 'Basic realm="Private report panel"'); return res.status(401).send('Invalid credentials'); }
  next();
}
const recent = new Map();
app.post('/api/reports', async (req, res) => {
  const ip = String(req.ip || req.socket.remoteAddress || 'unknown').slice(0, 100);
  const now = Date.now();
  if (recent.has(ip) && now - recent.get(ip) < 3000) return res.status(429).json({ error: 'Lütfen birkaç saniye sonra tekrar deneyin.' });
  recent.set(ip, now);
  if (recent.size > 2000) for (const [k, t] of recent) if (now - t > 60000) recent.delete(k);
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim().slice(0, 32) : '';
  if (!username) return res.status(400).json({ error: 'Kullanıcı adı gerekli.' });
  const allowed = body.diagnostics && typeof body.diagnostics === 'object' ? body.diagnostics : {};
  const diagnostics = {};
  for (const key of ['userAgent','language','platform','timezone','online','screen','viewport','pixelRatio','touchPoints','hardwareConcurrency','deviceMemory','connectionType','downlink','testDurationMs','testResults','errors']) {
    if (Object.prototype.hasOwnProperty.call(allowed, key)) diagnostics[key] = allowed[key];
  }
  const report = {
    id: crypto.randomUUID(), username,
    receivedAt: new Date().toISOString(),
    ipAddress: ip,
    location: null,
    diagnostics
  };
  // Approximate IP-based location; no GPS is requested. The provider receives the IP for lookup.
  // If lookup fails, the report still succeeds and location remains unavailable.
  try {
    const cleanIp = ip.replace(/^::ffff:/, '');
    if (cleanIp && cleanIp !== 'unknown' && cleanIp !== '::1' && !/^127\./.test(cleanIp) && !/^10\./.test(cleanIp) && !/^192\.168\./.test(cleanIp) && !/^172\.(1[6-9]|2\d|3[01])\./.test(cleanIp)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const r = await fetch(`https://ipapi.co/${encodeURIComponent(cleanIp)}/json/`, { signal: controller.signal, headers: { 'User-Agent': 'MobileReportPanel/1.1' } });
      clearTimeout(timer);
      if (r.ok) {
        const g = await r.json();
        if (!g.error) report.location = { city: String(g.city || '').slice(0, 80), region: String(g.region || '').slice(0, 80), country: String(g.country_name || '').slice(0, 80), source: 'IP-based approximate location' };
      }
    }
  } catch {}
  const rows = readReports(); rows.unshift(report); writeReports(rows);
  res.status(201).json({ ok: true, id: report.id });
});
app.get('/api/reports', auth, (req, res) => res.json(readReports()));
app.get('/api/export', auth, (req, res) => { res.type('application/json').attachment('reports.json').send(JSON.stringify(readReports(), null, 2)); });
app.get('/panel', auth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'panel.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Mobile report panel listening on ${PORT}`));
