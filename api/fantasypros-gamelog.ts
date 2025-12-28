// api/fantasypros-gamelog.ts
// Vercel Serverless Function (no @vercel/node types required)

import * as cheerio from "cheerio";

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

function pickGameLogTable($: cheerio.CheerioAPI) {
  const tables = $("table").toArray();

  // Choose the table whose header contains Date + Opp + Min + Pts (FantasyPros NBA game log pattern)
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

  // fallback: first table if nothing matches
  return tables.length ? $(tables[0]) : null;
}

function normalizeHeader(h: string) {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

export default async function handler(req: any, res: any) {
  try {
    const player_name = String(req?.query?.player_name ?? "").trim();
    if (!player_name) {
      res.status(400).json({ ok: false, error: "Missing player_name" });
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
    });

    if (!r.ok) {
      res.status(200).json({
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
      res.status(200).json({ ok: false, error: "No table found on page", slug, url });
      return;
    }

    // Get headers
    const headers: string[] = [];
    table.find("thead tr th").each((_, th) => headers.push(normalizeHeader($(th).text())));

    // If no thead, attempt first row as header
    if (!headers.length) {
      table
        .find("tr")
        .first()
        .find("th,td")
        .each((_, c) => headers.push(normalizeHeader($(c).text())));
    }

    const findIdx = (...names: string[]) => {
      for (const n of names) {
        const i = headers.findIndex((h) => h === normalizeHeader(n));
        if (i >= 0) return i;
      }
      return -1;
    };

    const iDate = findIdx("date");
    const iOpp = findIdx("opp", "opponent");
    const iScore = findIdx("score");
    const iMin = findIdx("min");
    const iPts = findIdx("pts");
    const iReb = findIdx("reb");
    const iAst = findIdx("ast");
    const i3pm = findIdx("3pm", "3ptm", "3pt");

    const rows: any[] = [];

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
    });

    res.status(200).json({ ok: true, player_name, slug, url, rows });
  } catch (e: any) {
    res.status(200).json({ ok: false, error: e?.message ?? String(e) });
  }
}

