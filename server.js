const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD;

if (!PANEL_PASSWORD) {
  console.warn("UYARI: PANEL_PASSWORD ortam değişkeni ayarlanmamış. Panel API'si kullanılamaz.");
}

// Render gibi proxy arkasındaki servislerde istemci IP'sini almak için tek proxy katmanı.
app.set("trust proxy", 1);
app.use(express.json({ limit: "30kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Demo depolama: sunucu yeniden başlatıldığında bellekteki raporlar silinir.
// Kalıcı saklama gerekiyorsa veritabanı/kalıcı disk eklenmelidir.
const reports = [];
let nextId = 1;

function requirePanelPassword(req, res, next) {
  const supplied = req.get("x-panel-password");
  if (!PANEL_PASSWORD || !supplied || supplied !== PANEL_PASSWORD) {
    return res.status(401).json({ error: "Panel parolası yanlış veya ayarlanmamış." });
  }
  next();
}

app.post("/api/reports", async (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === "string" ? body.username.trim().slice(0, 60) : "";
  if (!body.consent || !username) {
    return res.status(400).json({ error: "Kullanıcı adı ve açık onay gereklidir." });
  }

  const ip = (req.ip || "").replace(/^::ffff:/, "").slice(0, 100);
  let geo = null;

  // IP tabanlı yaklaşık konum sorgusu; GPS değildir ve kesin olmayabilir.
  // Ziyaretçi onay kutusunu işaretlemeden bu uç noktaya istek gönderilmemelidir.
  try {
    const response = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      headers: { "User-Agent": "MobilRaporPaneli/1.0" },
      signal: AbortSignal.timeout(3500)
    });
    if (response.ok) {
      const data = await response.json();
      if (!data.error) {
        geo = {
          city: typeof data.city === "string" ? data.city.slice(0, 100) : "",
          region: typeof data.region === "string" ? data.region.slice(0, 100) : "",
          country: typeof data.country_name === "string" ? data.country_name.slice(0, 100) : ""
        };
      }
    }
  } catch (_) {
    // Konum hizmeti yanıt vermezse rapor yine kaydedilir.
  }

  const report = {
    id: nextId++,
    receivedAt: new Date().toISOString(),
    username,
    ip,
    approximateLocation: geo,
    userAgent: String(body.userAgent || "").slice(0, 500),
    platform: String(body.platform || "").slice(0, 100),
    language: String(body.language || "").slice(0, 50),
    timezone: String(body.timezone || "").slice(0, 100),
    screen: body.screen && typeof body.screen === "object" ? {
      width: Number(body.screen.width) || 0,
      height: Number(body.screen.height) || 0
    } : null,
    viewport: body.viewport && typeof body.viewport === "object" ? {
      width: Number(body.viewport.width) || 0,
      height: Number(body.viewport.height) || 0
    } : null,
    online: Boolean(body.online),
    tests: Array.isArray(body.tests) ? body.tests.slice(0, 20).map(t => ({
      name: String(t.name || "").slice(0, 100),
      result: String(t.result || "").slice(0, 100)
    })) : []
  };

  reports.unshift(report);
  if (reports.length > 500) reports.length = 500;
  res.status(201).json({ ok: true, message: "Rapor alındı." });
});

app.get("/api/reports", requirePanelPassword, (req, res) => {
  res.json({ reports });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor.`));
