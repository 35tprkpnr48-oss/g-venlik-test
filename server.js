const express = require("express");
const net = require("node:net");
const crypto = require("node:crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));
app.use(express.static("public"));

const reports = [];
const MAX_REPORTS = 500;

function normalizeIp(value) {
  if (typeof value !== "string") return "";
  let ip = value.trim();
  if (ip.toLowerCase().startsWith("::ffff:")) ip = ip.slice(7);
  if (!ip || ip.includes(",") || !net.isIP(ip)) return "";
  return ip;
}

function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 2 || b === 168)) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1" || s.startsWith("fc") ||
        s.startsWith("fd") || s.startsWith("fe8") ||
        s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) return false;
    if (s.startsWith("::ffff:")) {
      const mapped = normalizeIp(s);
      return mapped ? isPublicIp(mapped) : false;
    }
    return true;
  }
  return false;
}

async function lookupIpApi(ip) {
  const r = await fetch("https://ipapi.co/" + encodeURIComponent(ip) + "/json/", {
    headers: { "User-Agent": "MobilRaporPaneli/1.1", "Accept": "application/json" },
    signal: AbortSignal.timeout(5000)
  });
  if (!r.ok) throw new Error("ipapi.co HTTP " + r.status);
  const d = await r.json();
  if (d.error) throw new Error(d.reason || "ipapi.co error");
  return {
    source: "ipapi.co",
    city: typeof d.city === "string" ? d.city : null,
    region: typeof d.region === "string" ? d.region : null,
    country: typeof d.country_name === "string" ? d.country_name : null,
    latitude: typeof d.latitude === "number" ? d.latitude : null,
    longitude: typeof d.longitude === "number" ? d.longitude : null
  };
}

async function lookupIpWho(ip) {
  const r = await fetch("https://ipwho.is/" + encodeURIComponent(ip), {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(5000)
  });
  if (!r.ok) throw new Error("ipwho.is HTTP " + r.status);
  const d = await r.json();
  if (d.success === false) throw new Error(d.message || "ipwho.is error");
  return {
    source: "ipwho.is",
    city: typeof d.city === "string" ? d.city : null,
    region: typeof d.region === "string" ? d.region : null,
    country: typeof d.country === "string" ? d.country : null,
    latitude: typeof d.latitude === "number" ? d.latitude : null,
    longitude: typeof d.longitude === "number" ? d.longitude : null
  };
}

async function getLocation(ip) {
  if (!isPublicIp(ip)) {
    return {
      city: null, region: null, country: null, latitude: null, longitude: null,
      display: "Konum alınamadı: genel IP adresi değil",
      source: null, note: "IP özel/yerel veya geçersiz görünüyor."
    };
  }

  const results = await Promise.allSettled([lookupIpApi(ip), lookupIpWho(ip)]);
  const successful = results.filter(r => r.status === "fulfilled").map(r => r.value);
  const providerResults = results.map((r, i) => ({
    provider: i === 0 ? "ipapi.co" : "ipwho.is",
    ok: r.status === "fulfilled",
    city: r.status === "fulfilled" ? r.value.city : null,
    region: r.status === "fulfilled" ? r.value.region : null,
    country: r.status === "fulfilled" ? r.value.country : null
  }));

  if (!successful.length) {
    console.error("İki konum servisi de başarısız oldu.");
    return {
      city: null, region: null, country: null, latitude: null, longitude: null,
      display: "Konum servisine ulaşılamadı", source: null,
      note: "Her iki konum servisi de yanıt vermedi.", providerResults
    };
  }

  const best = successful.find(r => r.city || r.region) || successful[0];
  const places = [...new Set(successful.map(r =>
    [r.city, r.region, r.country].filter(Boolean).join(", ")
  ).filter(Boolean))];

  return {
    city: best.city, region: best.region, country: best.country,
    latitude: best.latitude, longitude: best.longitude,
    display: [best.city, best.region, best.country].filter(Boolean).join(", ") || "Konum bilgisi bulunamadı",
    source: best.source,
    note: places.length > 1
      ? "Servisler farklı sonuç verdi: " + places.join(" / ") + ". IP konumu tahminidir."
      : "IP tabanlı yaklaşık konum; GPS konumu değildir.",
    providerResults
  };
}

function safeText(value, max) {
  return typeof value === "string" ? value.slice(0, max) : null;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/reports", async (req, res) => {
  try {
    const body = req.body || {};
    if (body.consent !== true) {
      return res.status(400).json({ ok: false, error: "Rapor gönderilmeden önce bilgilendirme onayı gerekli." });
    }

    const username = typeof body.username === "string" ? body.username.trim().slice(0, 80) : "";
    if (!username) return res.status(400).json({ ok: false, error: "Kullanıcı adı gerekli." });

    const ip = normalizeIp(req.ip || "");
    const location = await getLocation(ip);

    const report = {
      id: Date.now() + "-" + crypto.randomBytes(4).toString("hex"),
      createdAt: new Date().toISOString(),
      username,
      ip: ip || "IP alınamadı",
      location: location.display,
      city: location.city,
      region: location.region,
      country: location.country,
      latitude: location.latitude,
      longitude: location.longitude,
      locationSource: location.source,
      locationNote: location.note,
      locationProviders: location.providerResults || [],
      deviceModel: safeText(body.deviceModel, 120),
      deviceBrand: safeText(body.deviceBrand, 120),
      userAgent: safeText(body.userAgent, 500),
      platform: safeText(body.platform, 120),
      language: safeText(body.language, 80),
      timezone: safeText(body.timezone, 100),
      screen: safeText(body.screen, 80),
      online: typeof body.online === "boolean" ? body.online : null,
      tests: Array.isArray(body.tests) ? body.tests.slice(0, 30) : []
    };

    reports.unshift(report);
    if (reports.length > MAX_REPORTS) reports.length = MAX_REPORTS;
    res.json({ ok: true, reportId: report.id });
  } catch (error) {
    console.error("Rapor kaydetme hatası:", error.message);
    res.status(500).json({ ok: false, error: "Rapor kaydedilemedi." });
  }
});

function constantTimeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

app.get("/api/reports", (req, res) => {
  const expected = process.env.PANEL_PASSWORD;
  if (!expected) {
    return res.status(503).json({ ok: false, error: "Render Environment bölümünde PANEL_PASSWORD ayarlanmamış." });
  }
  const supplied = req.get("x-panel-password") || "";
  if (!constantTimeEqual(supplied, expected)) {
    return res.status(401).json({ ok: false, error: "Panel şifresi hatalı." });
  }
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, reports });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Mobil rapor paneli sunucusu " + PORT + " portunda çalışıyor.");
});
