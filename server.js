
const express = require("express");
const https = require("https");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Render'ın proxy yapılandırması üzerinden istemci IP'si
app.set("trust proxy", 1);

app.use(express.json({ limit: "30kb" }));
app.use(express.static("public"));

const reports = [];
const MAX_REPORTS = 500;

function isPrivateIp(ip) {
  if (!ip) return true;

  ip = ip.replace(/^::ffff:/, "");

  return (
    ip === "::1" ||
    ip === "127.0.0.1" ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^fc/i.test(ip) ||
    /^fd/i.test(ip) ||
    /^fe80:/i.test(ip)
  );
}

function getLocation(ip) {
  return new Promise((resolve) => {
    if (!ip || isPrivateIp(ip)) {
      return resolve(null);
    }

    const url =
      "https://ipapi.co/" +
      encodeURIComponent(ip) +
      "/json/";

    const request = https.get(
      url,
      { timeout: 5000 },
      (response) => {
        let data = "";

        response.setEncoding("utf8");
        response.on("data", chunk => data += chunk);

        response.on("end", () => {
          try {
            const result = JSON.parse(data);

            if (result.error) return resolve(null);

            resolve({
              country: result.country_name || null,
              region: result.region || null,
              city: result.city || null,
              source: "IP tabanlı yaklaşık konum"
            });
          } catch {
            resolve(null);
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });

    request.on("error", () => resolve(null));
  });
}

app.post("/api/reports", async (req, res) => {
  try {
    const body = req.body || {};

    if (body.consent !== true) {
      return res.status(400).json({
        error: "Rapor gönderimi için onay gerekli."
      });
    }

    const username =
      typeof body.username === "string"
        ? body.username.trim().slice(0, 60)
        : "";

    if (!username) {
      return res.status(400).json({
        error: "Rapor adı girilmedi."
      });
    }

    // Express, güvenilen proxy yapılandırmasına göre IP'yi belirler.
    let ip = String(req.ip || "").trim();

    if (ip.startsWith("::ffff:")) {
      ip = ip.slice(7);
    }

    const location = await getLocation(ip);

    const report = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      username,
      ip: ip || "Belirlenemedi",
      ipIsPrivate: isPrivateIp(ip),
      location,

      device: {
        model: safeText(body.deviceModel, 100),
        brand: safeText(body.deviceBrand, 60),
        userAgent: safeText(body.userAgent, 400),
        platform: safeText(body.platform, 100),
        language: safeText(body.language, 40),
        timezone: safeText(body.timezone, 80),

        screen: {
          width: safeNumber(body.screen?.width),
          height: safeNumber(body.screen?.height)
        },

        online: body.online === true
      },

      tests: Array.isArray(body.tests)
        ? body.tests.slice(0, 30).map(test => ({
            name: safeText(test?.name, 80),
            detail: safeText(test?.detail, 200)
          }))
        : []
    };

    reports.unshift(report);

    if (reports.length > MAX_REPORTS) {
      reports.length = MAX_REPORTS;
    }

    res.json({
      ok: true,
      message: "Rapor kaydedildi.",
      id: report.id
    });
  } catch {
    res.status(500).json({
      error: "Rapor işlenirken bir sunucu hatası oluştu."
    });
  }
});

function safeText(value, maxLength) {
  return typeof value === "string"
    ? value.slice(0, maxLength)
    : "Belirlenemedi";
}

function safeNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) && number >= 0
    ? Math.min(Math.round(number), 10000)
    : 0;
}

app.get("/api/reports", (req, res) => {
  const expected = process.env.PANEL_PASSWORD;
  const provided = req.get("x-panel-password") || "";

  if (!expected) {
    return res.status(503).json({
      error: "PANEL_PASSWORD Render ortamında ayarlanmamış."
    });
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return res.status(401).json({
      error: "Panel şifresi hatalı."
    });
  }

  res.json({ reports });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
