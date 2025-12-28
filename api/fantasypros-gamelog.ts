// api/fantasypros-gamelog.ts
// Vercel Serverless Function (NO @vercel/node types required)
// ✅ Fixes TS2322 (never return number from cheerio .each callbacks)
// ✅ More robust table picking + header parsing
// ✅ Safe JSON response + better error/debug payload

import * as cheerio from "cheerio";

type FantasyProsLogRow = {
  date: string;
  opp: string;
  score: string;
  min: string;
  pts: string;
  reb: string;
  ast: string;
  threes: string;
};

type OkResp = { ok: true; player_name: string; slug: string; url: string; rows: FantasyProsLogRow[] };
type ErrResp = { ok: false; error: string; slug?: string; url?: string; debug?: any };

function toSlug(playerName: string) {
  return playerName
    .toLowerCase()
    .trim()
    .replace(/[\u2019']/g, "") // remove apostrophes
    .replace(/[^a-z0-9\s-]/g, " ") // punctuation -> space
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeHeader(h: string) {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

function pickGameLogTable($: cheerio.CheerioAPI) {
  const tables = $("table").toArray();

  // Choose table whose header contains Date + Opp + Min + Pts (FantasyPros NBA game log pattern)
  for (const el of tables) {
    const $t = $(el);
    const headerText = $t.find("thead").text().replace(/\s+/g, " ").toLowerCase();
    const fullText = $t.text().replace(/\s+/g, " ").toLowerCase();
    const t = (headerText || fullText || "").trim();

    if (
      t.includes("date") &&
      (t.includes("opp") || t.includes("opponent")) &&
      t.includes("min") &&
      (t.includes("pts") || t.includes("points"))
    ) {
      return $t;
    }
  }

  // fallback: first table if nothing matches
  return tables.length ? $(tables[0]) : null;
}

function safeSend(res: any, status: number, json: OkResp | ErrResp) {
  try {
    res.status(status).json(json);
  } catch {
    // last-ditch fallback
    res.status(status).send(JSON.stringify(json));
  }
}

export default async function handler(req: any, res: any) {
  try {
    const player_name = String(req?.query?.player_name ?? "").trim();
    if (!player_name) {
      safeSend(res, 400, { ok: false, error: "Missing player_name" });
      return;
    }

    const slug = toSlug(player_name);
    const url = `https://www.fantasypros.com/nba/games/${slug}.php`;

    const r = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
      // @ts-ignore (node fetch supports it; harmless if ignored)
      redirect: "follow",
    });

    if (!r.ok) {
      safeSend(res, 200, {
        ok: false,
        error: `FantasyPros fetch failed (${r.status})`,
        slug,
        url,
      });
      return;
    }

    const html = await r.text();
    const $ = cheerio.load(html);

    const table = pickGameLogTable($);
    if (!table) {
      safeSend(res, 200, { ok: false, error: "No table found on page", slug, url });
      return;
    }

    // -----------------------------
    // Headers
    // -----------------------------
    const headers: string[] = [];

    // IMPORTANT: do NOT return rows.push(...) etc. from .each callbacks
    table.find("thead tr th").each((_, th) => {
      headers.push(normalizeHeader($(th).text()));
      // return void
    });

    // If no thead, attempt first row as header
    if (!headers.length) {
      table
        .find("tr")
        .first()
        .find("th,td")
        .each((_, c) => {
          headers.push(normalizeHeader($(c).text()));
          // return void
        });
    }

    // Sometimes headers include empty cells; filter them but preserve order-ish
    const cleanedHeaders = headers.map((h) => h.trim()).filter((h) => h.length > 0);

    const findIdx = (...names: string[]) => {
      const needles = names.map((n) => normalizeHeader(n));
      for (const n of needles) {
        const i = cleanedHeaders.findIndex((h) => h === n);
        if (i >= 0) return i;
      }
      return -1;
    };

    const iDate = findIdx("date");
    const iOpp = findIdx("opp", "opponent");
    const iScore = findIdx("score");
    const iMin = findIdx("min", "minutes");
    const iPts = findIdx("pts", "points");
    const iReb = findIdx("reb", "rebounds", "trb");
    const iAst = findIdx("ast", "assists");
    const i3pm = findIdx("3pm", "3ptm", "3pt", "3pt made", "3ptm");

    const rows: FantasyProsLogRow[] = [];

    table.find("tbody tr").each((_, tr) => {
      const cols = $(tr)
        .find("td")
        .toArray()
        .map((td) => $(td).text().trim());

      if (!cols.length) return;

      const get = (i: number) => (i >= 0 && i < cols.length ? cols[i] : "");

      const date = get(iDate);
      const pts = get(iPts);

      // Require at least date+pts to treat as a row
      if (!date || !pts) return;

      rows.push({
        date,
        opp: get(iOpp),
        score: get(iScore),
        min: get(iMin),
        pts,
        reb: get(iReb),
        ast: get(iAst),
        threes: get(i3pm),
      });
      // return void
    });

    safeSend(res, 200, { ok: true, player_name, slug, url, rows });
  } catch (e: any) {
    safeSend(res, 200, { ok: false, error: e?.message ?? String(e) });
  }
}
