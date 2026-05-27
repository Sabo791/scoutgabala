const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

function clean(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function normalizePosition(pos) {
  const p = clean(pos).toLowerCase().replace(/-/g, " ");
  if (p.includes("goalkeeper")) return "GK";
  if (p.includes("centre back") || p.includes("center back")) return "CB";
  if (p.includes("left back")) return "LB";
  if (p.includes("right back")) return "RB";
  if (p.includes("defensive midfield")) return "DM";
  if (p.includes("central midfield")) return "CM";
  if (p.includes("attacking midfield")) return "AM";
  if (p.includes("left winger")) return "LW";
  if (p.includes("right winger")) return "RW";
  if (p.includes("centre forward") || p.includes("center forward") || p.includes("striker")) return "ST";
  return pos;
}

function getPlayerId(url) {
  const m = String(url).match(/spieler\/(\d+)/);
  return m ? m[1] : "";
}

function getText(html, label) {
  const r = new RegExp(label + ":[\\s\\S]{0,1000}?<span[^>]*>([^<]+)<\\/span>", "i");
  return clean(html.match(r)?.[1] || "");
}

function getTitle(html, label) {
  const r = new RegExp(label + ":[\\s\\S]{0,1500}?title=\"([^\"]+)\"", "i");
  return clean(html.match(r)?.[1] || "");
}

function heightToCm(text) {
  const m = clean(text).replace(",", ".").match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return "";
  const n = Number(m[1]);
  return n < 3 ? String(Math.round(n * 100)) : String(Math.round(n));
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  const html = await res.text();

  if (!res.ok || html.length < 1000 || /Access denied|captcha|blocked/i.test(html)) {
    throw new Error("Transfermarkt blokladı və ya cavab vermədi");
  }

  return html;
}

function parseProfile(html, url) {
  const $ = cheerio.load(html);

  let name = clean($("h1.data-header__headline-wrapper").first().text()).replace(/^#\d+\s*/, "");

  if (!name) {
    name = clean($("meta[property='og:title']").attr("content"))
      .replace(/- Player profile.*$/i, "")
      .replace(/\| Transfermarkt.*$/i, "");
  }

  const dobAge = getText(html, "Date of birth/Age");
  const age = dobAge.match(/\((\d+)\)/)?.[1] || "";

  const positionFull = getText(html, "Position");

  return {
    playerId: getPlayerId(url),
    name,
    age,
    dateOfBirth: dobAge,
    country: getTitle(html, "Citizenship") || getText(html, "Citizenship"),
    club: getTitle(html, "Current club") || getText(html, "Current club"),
    position: normalizePosition(positionFull),
    positionFull,
    foot: getText(html, "Foot"),
    height: heightToCm(getText(html, "Height")),
    contractEnd: getText(html, "Contract expires"),
    joined: getText(html, "Joined"),
    agent: getTitle(html, "Player agent") || getText(html, "Player agent"),
    marketValue: clean($(".data-header__market-value-wrapper").first().text()),
    transfermarkt: url
  };
}

function parseCareerStats(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $("table.items tbody tr").each((_, tr) => {
    const cells = $(tr).find("td").map((__, td) => clean($(td).text())).get().filter(Boolean);
    const line = cells.join(" | ");
    if (line && /\d{4}|Total|Club career/i.test(line)) rows.push({ cells });
  });

  return rows.slice(0, 30);
}

function parseTransferHistory(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $("table.items tbody tr, .tm-player-transfer-history-grid").each((_, tr) => {
    const text = clean($(tr).text());
    if (text && /(Transfer|Loan|free transfer|€|End of loan|Back from loan)/i.test(text)) {
      rows.push(text);
    }
  });

  return [...new Set(rows)].slice(0, 20);
}

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Transfermarkt backend işləyir" });
});

app.post("/api/transfermarkt", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url || !url.includes("transfermarkt")) {
      return res.status(400).json({ error: "Transfermarkt linki düzgün deyil" });
    }

    const playerId = getPlayerId(url);
    const html = await fetchHtml(url);
    const profile = parseProfile(html, url);

    let careerStats = [];
    let transferHistory = [];

    if (playerId) {
      try {
        const perfUrl = `https://www.transfermarkt.com/player/leistungsdaten/spieler/${playerId}`;
        careerStats = parseCareerStats(await fetchHtml(perfUrl));
      } catch {}

      try {
        const transferUrl = `https://www.transfermarkt.com/player/transfers/spieler/${playerId}`;
        transferHistory = parseTransferHistory(await fetchHtml(transferUrl));
      } catch {}
    }

    profile.careerStats = careerStats;
    profile.transferHistory = transferHistory;

    profile.notes = [
      "Transfermarkt açıq məlumat importu",
      profile.positionFull ? `Transfermarkt mövqesi: ${profile.positionFull}` : "",
      profile.dateOfBirth ? `Doğum tarixi: ${profile.dateOfBirth}` : "",
      profile.joined ? `Kluba qoşulma: ${profile.joined}` : "",
      profile.agent ? `Agent: ${profile.agent}` : "",
      profile.contractEnd ? `Müqavilə sonu: ${profile.contractEnd}` : "",
      transferHistory.length ? `Transfer tarixçəsi: ${transferHistory.slice(0, 5).join(" | ")}` : ""
    ].filter(Boolean).join("\n");

    res.json(profile);
  } catch (err) {
    res.status(500).json({
      error: "Transfermarkt import alınmadı",
      detail: String(err.message || err)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Transfermarkt backend: http://localhost:${PORT}`);
});