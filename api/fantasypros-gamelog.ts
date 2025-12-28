// api/fantasypros-gamelog.ts
// Vercel Serverless Function (works even with Vite static builds)

import type { VercelRequest, VercelResponse } from "@vercel/node";
import * as cheerio from "cheerio";

function toSlug(playerName: string) {
  return playerName
    .toLowerCase()
    .trim()
    .replace(/[\u2019']/g, "")     // remove apostrophes
    .replace(/[^a-z0-9\s-]/g, " ") // punctuation -> space
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function pickGameLogTable($: cheerio.CheerioAPI) {
  const tables = $("table").toArray();
  // Choose the table whose header contains Date + OPP + MIN + PTS (FantasyPros NBA game log)
  for (const el of tables) {
    const headerText = $(el).find("thead").text().replace(/\s+/g, " ").toLowerCase();
    const fullText = $(el).text().replace(/\s+/g, " ").toLowerCase();
    const t = headerText || fullText;

    if (
      t.includes("date") &&
      (t.includes("opp") || t.includes("opponent")) &&
      t.includes("min") &&
      t.includes("pts")
    ) {
      return $(el);
    }
  }
  // fallback: first table
  return tables.length ? $(tables[0]) : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const player_name = String(req.query.player_name ?? "").trim();
    if (!player_name) {
      res.status(400).json({ ok: false, error: "Missing player_name" });
      return;
    }

    const slug = toSlug(player_name);
    const url = `https://www.fantasypros.com/nba/games/${slug}.php`;

    const r = await fetch(url, {
      headers: {
        // mimic browser (helps avoid some bot-blocking behaviors)
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
    });

    if (!r.ok) {
      res.status(200).json({ ok: false, error: `FantasyPros fetch failed (${r.status})`, slug, url });
      return;
    }

    const html = await r.text();
    const $ = cheerio.load(html);

    const table = pickGameLogTable($);
    if (!table) {
      res.status(200).json({ ok: false, error: "No table found on page", slug, url });
      return;
    }

    // parse header to locate columns safely
    const headers: string[] = [];
    table.find("thead tr th").each((_, th) => {
      headers.push($(th).text().trim().toLowerCase());
    });

    // fallback if thead missing (some FP tables are plain)
    if (!headers.length) {
      table.find("tr").first().find("th,td").each((_, c) => {
        headers.push($(c).text().trim().toLowerCase());
      });
    }

    const idx = (name: string) => headers.findIndex((h) => h === name);

    const iDate = idx("date");
    const iOpp = headers.findIndex((h) => h === "opp" || h === "opponent");
    const iScore = idx("score");
    const iMin = idx("min");
    const iPts = idx("pts");
    const iReb = idx("reb");
    const iAst = idx("ast");
    const i3pm = headers.findIndex((h) => h === "3pm" || h === "3pm" || h === "3pm " || h === "3pm");

    const rows: any[] = [];
    table.find("tbody tr").each((_, tr) => {
      const cols = $(tr).find("td").toArray().map((td) => $(td).text().trim());
      if (!cols.length) return;

      const get = (i: number) => (i >= 0 && i < cols.length ? cols[i] : "");

      // require at least date + pts/min to consider it a real row
      const date = get(iDate);
      const pts = get(iPts);
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
    });

    res.status(200).json({ ok: true, player_name, slug, url, rows });
  } catch (e: any) {
    res.status(200).json({ ok: false, error: e?.message ?? String(e) });
  }
}
