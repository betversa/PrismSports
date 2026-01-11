import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type CalibrationRow = {
  sport_key: string | null;
  event_id: string;
  run_id: string;
  game_date: string | null;
  status: string | null;
  final_home_score: number | null;
  final_away_score: number | null;
  actual_total: number | null;
  actual_margin_home: number | null;
  spread_line_home: number | null;
  total_line: number | null;
  home_win_prob: number | null;
  away_win_prob: number | null;
  home_cover_prob: number | null;
  away_cover_prob: number | null;
  over_prob: number | null;
  under_prob: number | null;
};

type PlattParams = { a: number; b: number; n: number };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.");
}

const sportKeyFilter = process.env.SPORT_KEY ?? null;
const startDate = process.env.START_DATE ?? null;
const endDate = process.env.END_DATE ?? null;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(p / (1 - p));

function fitPlatt(data: Array<{ p: number; y: number }>): PlattParams {
  if (!data.length) return { a: 1, b: 0, n: 0 };

  let a = 1;
  let b = 0;
  const lr = 0.1;
  const maxIter = 500;

  for (let i = 0; i < maxIter; i += 1) {
    let gradA = 0;
    let gradB = 0;

    for (const { p, y } of data) {
      const lp = logit(clamp(p, 1e-6, 1 - 1e-6));
      const pred = sigmoid(a * lp + b);
      const diff = pred - y;
      gradA += diff * lp;
      gradB += diff;
    }

    const n = data.length;
    a -= (lr * gradA) / n;
    b -= (lr * gradB) / n;
  }

  return { a, b, n: data.length };
}

async function fetchCalibrationRows(): Promise<CalibrationRow[]> {
  const cols = [
    "sport_key",
    "event_id",
    "run_id",
    "game_date",
    "status",
    "final_home_score",
    "final_away_score",
    "actual_total",
    "actual_margin_home",
    "spread_line_home",
    "total_line",
    "home_win_prob",
    "away_win_prob",
    "home_cover_prob",
    "away_cover_prob",
    "over_prob",
    "under_prob",
  ].join(",");

  const pageSize = 1000;
  let offset = 0;
  let out: CalibrationRow[] = [];

  while (true) {
    let q = supabase
      .from("game_model_results")
      .select(cols)
      .eq("status", "final")
      .range(offset, offset + pageSize - 1);

    if (sportKeyFilter) q = q.eq("sport_key", sportKeyFilter);
    if (startDate) q = q.gte("game_date", startDate);
    if (endDate) q = q.lte("game_date", endDate);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as CalibrationRow[];
    out = out.concat(rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return out;
}

function buildCalibrationSets(rows: CalibrationRow[]) {
  const win: Array<{ p: number; y: number }> = [];
  const awayWin: Array<{ p: number; y: number }> = [];
  const cover: Array<{ p: number; y: number }> = [];
  const awayCover: Array<{ p: number; y: number }> = [];
  const over: Array<{ p: number; y: number }> = [];
  const under: Array<{ p: number; y: number }> = [];

  for (const r of rows) {
    const finalHome = r.final_home_score;
    const finalAway = r.final_away_score;
    if (finalHome == null || finalAway == null) continue;

    const margin = r.actual_margin_home ?? finalHome - finalAway;
    const total = r.actual_total ?? finalHome + finalAway;

    if (r.home_win_prob != null) {
      win.push({ p: r.home_win_prob, y: finalHome > finalAway ? 1 : 0 });
    }

    if (r.away_win_prob != null) {
      awayWin.push({ p: r.away_win_prob, y: finalAway > finalHome ? 1 : 0 });
    }

    if (r.spread_line_home != null) {
      if (r.home_cover_prob != null && margin !== r.spread_line_home) {
        cover.push({ p: r.home_cover_prob, y: margin > r.spread_line_home ? 1 : 0 });
      }
      if (r.away_cover_prob != null && margin !== r.spread_line_home) {
        awayCover.push({ p: r.away_cover_prob, y: margin < r.spread_line_home ? 1 : 0 });
      }
    }

    if (r.total_line != null) {
      if (r.over_prob != null && total !== r.total_line) {
        over.push({ p: r.over_prob, y: total > r.total_line ? 1 : 0 });
      }
      if (r.under_prob != null && total !== r.total_line) {
        under.push({ p: r.under_prob, y: total < r.total_line ? 1 : 0 });
      }
    }
  }

  return { win, awayWin, cover, awayCover, over, under };
}

async function run() {
  const rows = await fetchCalibrationRows();
  if (!rows.length) {
    console.log("No final rows found for calibration.");
    return;
  }

  const sets = buildCalibrationSets(rows);

  const params = {
    method: "platt",
    fields: {
      home_win: fitPlatt(sets.win),
      away_win: fitPlatt(sets.awayWin),
      home_cover: fitPlatt(sets.cover),
      away_cover: fitPlatt(sets.awayCover),
      over: fitPlatt(sets.over),
      under: fitPlatt(sets.under),
    },
  };

  const sampleCounts = {
    home_win: sets.win.length,
    away_win: sets.awayWin.length,
    home_cover: sets.cover.length,
    away_cover: sets.awayCover.length,
    over: sets.over.length,
    under: sets.under.length,
  };

  if (sportKeyFilter) {
    await supabase
      .from("ai_model_versions")
      .update({ active: false })
      .eq("sport_key", sportKeyFilter)
      .eq("active", true);
  } else {
    await supabase.from("ai_model_versions").update({ active: false }).eq("active", true);
  }

  const { error } = await supabase.from("ai_model_versions").insert({
    sport_key: sportKeyFilter,
    model_type: "platt",
    active: true,
    trained_from: startDate,
    trained_to: endDate,
    params,
    sample_counts: sampleCounts,
  });

  if (error) throw new Error(error.message);

  console.log("Calibration trained and stored.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
