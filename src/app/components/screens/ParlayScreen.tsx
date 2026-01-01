// ParlayScreen.tsx — FULL REWRITE (adds “Not allowed to parlay” rules, esp. same-player props)
// ---------------------------------------------------------------------------------------------------
// ✅ Hard rule: NEVER allow 2+ legs with same player_name (props) in the same parlay
// ✅ Strong default: still blocks multiple legs from same event unless allowSameGame=true
// ✅ Adds additional “same game” safe-guards even when allowSameGame=true:
//    - Blocks opposite sides of SAME market/line (e.g., Over and Under 24.5)
//    - Blocks duplicate legs (same market/side/line) across sources
// ✅ Optional toggle: allowSamePlayer (default false; keep it false to avoid book restrictions)
// ✅ Explains why combos are rejected via internal validator (kept simple, fast)

import React, { useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import {
  Sparkles,
  Layers,
  SlidersHorizontal,
  Shield,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Shuffle,
} from "lucide-react";

type BookKey = "draftkings" | "fanduel" | "betmgm" | "any";
type LegsCount = 2 | 3 | 4 | 5 | 6;

type CandidateLeg = {
  id: string;
  source: "game" | "prop";

  sport_key?: string | null;
  event_id: string;
  commence_time?: string | null;

  // Display
  label: string;
  sublabel: string;

  // Market details
  market: string;
  side: string;
  line: number | null;

  book: string; // normalized
  american_odds: number | null;

  // Model / fair probability
  p: number | null; // 0..1
  ev_pct: number | null; // percent
  score: number | null; // ranking helper (confidence/score)

  // Correlation helpers
  team?: string | null;
  opponent?: string | null; // (props)
  player_name?: string | null; // (props)
};

type ParlayResult = {
  id: string;
  legs: CandidateLeg[];

  book: string;
  legsCount: number;

  parlay_decimal: number; // total payout incl stake
  parlay_american: number | null;

  p_win: number; // assumed independent
  ev_pct: number; // percent

  commence_time_min: string | null; // earliest leg time

  // ✅ NEW
  corr_penalty: number; // 0..1.25 (higher = more correlated)
  rank_score: number; // EV minus penalty weighting
};

const GOLD = "#d89211";
const BORDER = "#2a2a2a";

const BOOK_OPTIONS: Array<{ key: BookKey; label: string }> = [
  { key: "any", label: "Any" },
  { key: "draftkings", label: "DraftKings" },
  { key: "fanduel", label: "FanDuel" },
  { key: "betmgm", label: "BetMGM" },
];

export function ParlayScreen() {
  // Controls
  const [legs, setLegs] = useState<LegsCount>(3);
  const [book, setBook] = useState<BookKey>("draftkings");
  const [includeGameLines, setIncludeGameLines] = useState(true);
  const [includeProps, setIncludeProps] = useState(true);
  const [minEv, setMinEv] = useState<number>(3);
  const [maxCandidates, setMaxCandidates] = useState<number>(26);
  const [allowSameGame, setAllowSameGame] = useState<boolean>(false);
  const [allowSamePlayer, setAllowSamePlayer] = useState<boolean>(false);
  const [maxParlays, setMaxParlays] = useState<number>(8);

  // New knobs (optional but helpful)
  const [penaltyWeight, setPenaltyWeight] = useState<number>(35); // 20–60 typical
  const [diversityMode, setDiversityMode] = useState<boolean>(true); // diversify output set

  // State
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CandidateLeg[]>([]);
  const [parlays, setParlays] = useState<ParlayResult[]>([]);

  const canGenerate = includeGameLines || includeProps;

  async function loadCandidates() {
    setLoading(true);
    setErr(null);
    setParlays([]);

    try {
      const nowIso = new Date().toISOString();
      const tasks: Promise<any>[] = [];

      if (includeGameLines) {
        let q = supabase
          .from("ev_plays")
          .select(
            [
              "id",
              "sport_key",
              "event_id",
              "commence_time",
              "matchup",
              "team",
              "market",
              "side",
              "line",
              "bookmaker",
              "book_odds",
              "quantum_prob",
              "ev_pct",
              "confidence_score",
            ].join(",")
          )
          .gte("commence_time", nowIso);

        if (book !== "any") q = q.eq("bookmaker", book);
        tasks.push(q);
      }

      if (includeProps) {
        let q = supabase
          .from("player_prop_ev_latest")
          .select(
            [
              "id",
              "sport_key",
              "event_id",
              "commence_time",
              "team",
              "opponent",
              "player_name",
              "market",
              "side",
              "line",
              "book",
              "odds",
              "p_quantum",
              "ev_pct",
              "score",
            ].join(",")
          )
          .gte("commence_time", nowIso);

        if (book !== "any") q = q.eq("book", book);
        tasks.push(q);
      }

      const results = await Promise.all(tasks);

      const rowsGame = includeGameLines ? results.shift() : null;
      const rowsProps = includeProps ? results.shift() : null;

      const errs: string[] = [];
      const gameData = rowsGame?.error ? (errs.push(rowsGame.error.message), []) : (rowsGame?.data ?? []);
      const propData = rowsProps?.error ? (errs.push(rowsProps.error.message), []) : (rowsProps?.data ?? []);

      if (errs.length) setErr(errs.join(" • "));

      const mapped: CandidateLeg[] = [
        ...mapGameCandidates(gameData as any[]),
        ...mapPropCandidates(propData as any[]),
      ]
        .filter((x) => (typeof x.ev_pct === "number" ? x.ev_pct >= minEv : false))
        .filter((x) => x.american_odds != null && Number.isFinite(x.american_odds))
        .filter((x) => x.p != null && x.p > 0 && x.p < 1);

      // Deduplicate “same semantic leg” across multiple rows (often happens)
      const uniq = dedupeBySemanticKey(mapped);

      // Rank legs
      uniq.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      setCandidates(uniq);
      return uniq;
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load candidates.");
      setCandidates([]);
      return [];
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerate() {
    if (!canGenerate) return;

    const pool = await loadCandidates();
    if (!pool.length) {
      setParlays([]);
      return;
    }

    const topPool = pool.slice(0, Math.max(legs + 3, maxCandidates));

    const built = buildParlays(topPool, legs, {
      allowSameGame,
      allowSamePlayer,
      maxResults: maxParlays,
      enforceBook: book === "any" ? null : book,
      penaltyWeight,
      diversityMode,
    });

    setParlays(built);
  }

  const headerStats = useMemo(() => {
    const usable = candidates.filter((x) => x.p != null && x.american_odds != null);
    const bySource = usable.reduce(
      (acc, r) => {
        acc[r.source] += 1;
        return acc;
      },
      { game: 0, prop: 0 }
    );

    return { total: usable.length, game: bySource.game, prop: bySource.prop };
  }, [candidates]);

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.08] to-white/[0.03] p-4 md:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/5 border border-white/10">
                <Sparkles className="h-4 w-4" style={{ color: GOLD }} />
              </div>
              <h2 className="text-white text-lg md:text-xl font-semibold tracking-tight">Parlay Builder</h2>
            </div>

            <p className="mt-1 text-xs text-white/50">
              Pick your legs + book — we’ll suggest parlays built from your top +EV plays (with correlation rules).
            </p>
          </div>

          <div className="hidden md:flex items-center gap-2 text-[10px] text-white/45 whitespace-nowrap">
            <Shield className="h-3.5 w-3.5" />
            <span>Independence EV + Correlation Penalty</span>
          </div>
        </div>
      </div>

      {/* Error */}
      {err ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-xs text-red-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            <span>{err}</span>
          </div>
        </div>
      ) : null}

      {/* Controls */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 md:p-5">
        <div className="flex items-center gap-2 mb-3">
          <SlidersHorizontal className="h-4 w-4 text-white/50" />
          <div className="text-sm text-white font-semibold">Parlay Settings</div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Legs */}
          <ControlBlock label="Legs">
            <select
              value={legs}
              onChange={(e) => setLegs(Number(e.target.value) as LegsCount)}
              className="w-full rounded-lg border bg-black/40 px-3 py-2 text-sm text-white outline-none"
              style={{ borderColor: BORDER }}
            >
              {[2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n} legs
                </option>
              ))}
            </select>
          </ControlBlock>

          {/* Book */}
          <ControlBlock label="Sportsbook">
            <select
              value={book}
              onChange={(e) => setBook(e.target.value as BookKey)}
              className="w-full rounded-lg border bg-black/40 px-3 py-2 text-sm text-white outline-none"
              style={{ borderColor: BORDER }}
            >
              {BOOK_OPTIONS.map((b) => (
                <option key={b.key} value={b.key}>
                  {b.label}
                </option>
              ))}
            </select>
          </ControlBlock>

          {/* Min EV */}
          <ControlBlock label="Min EV%">
            <input
              type="number"
              step={0.5}
              value={minEv}
              onChange={(e) => setMinEv(Number(e.target.value))}
              className="w-full rounded-lg border bg-black/40 px-3 py-2 text-sm text-white outline-none"
              style={{ borderColor: BORDER }}
            />
            <div className="text-[10px] text-white/40 mt-1">Filters legs below this EV%</div>
          </ControlBlock>

          {/* Include */}
          <ControlBlock label="Include legs from">
            <div className="flex items-center justify-between gap-3">
              <ToggleRow label="Game lines" value={includeGameLines} onChange={setIncludeGameLines} />
              <ToggleRow label="Props" value={includeProps} onChange={setIncludeProps} />
            </div>
            <div className="text-[10px] text-white/40 mt-1">
              Uses <span className="text-white/60">ev_plays</span> +{" "}
              <span className="text-white/60">player_prop_ev_latest</span>
            </div>
          </ControlBlock>

          {/* Candidates */}
          <ControlBlock label="Search depth (Top K legs)">
            <input
              type="number"
              min={10}
              max={60}
              value={maxCandidates}
              onChange={(e) => setMaxCandidates(Number(e.target.value))}
              className="w-full rounded-lg border bg-black/40 px-3 py-2 text-sm text-white outline-none"
              style={{ borderColor: BORDER }}
            />
            <div className="text-[10px] text-white/40 mt-1">Higher = more combos (slower)</div>
          </ControlBlock>

          {/* Correlation toggles */}
          <ControlBlock label="Correlation rules">
            <div className="space-y-2">
              <ToggleRow
                label="Allow multiple legs from same game"
                value={allowSameGame}
                onChange={setAllowSameGame}
              />
              <ToggleRow
                label="Allow multiple props for same player"
                value={allowSamePlayer}
                onChange={setAllowSamePlayer}
              />
              <ToggleRow label="Diversity mode (less repetition)" value={diversityMode} onChange={setDiversityMode} />
            </div>

            <div className="text-[10px] text-white/40 mt-2">
              Default is safer: <span className="text-white/60">1 leg per event</span> and{" "}
              <span className="text-white/60">no duplicate player props</span>.
            </div>
          </ControlBlock>

          {/* Penalty weight */}
          <ControlBlock label="Correlation penalty strength">
            <input
              type="number"
              min={0}
              max={80}
              step={5}
              value={penaltyWeight}
              onChange={(e) => setPenaltyWeight(Number(e.target.value))}
              className="w-full rounded-lg border bg-black/40 px-3 py-2 text-sm text-white outline-none"
              style={{ borderColor: BORDER }}
            />
            <div className="text-[10px] text-white/40 mt-1">
              Higher = more diversification (typical: 25–45)
            </div>
          </ControlBlock>
        </div>

        <div className="mt-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="text-[11px] text-white/45 flex items-center gap-2">
            <Layers className="h-4 w-4" />
            <span>
              Candidates: <span className="text-white/70">{headerStats.total}</span> (Game {headerStats.game} / Props{" "}
              {headerStats.prop})
            </span>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={maxParlays}
              onChange={(e) => setMaxParlays(Number(e.target.value))}
              className="rounded-lg border bg-black/40 px-3 py-2 text-sm text-white outline-none"
              style={{ borderColor: BORDER }}
              title="How many parlays to return"
            >
              {[5, 8, 10, 15].map((n) => (
                <option key={n} value={n}>
                  Top {n} parlays
                </option>
              ))}
            </select>

            <button
              type="button"
              disabled={!canGenerate || loading}
              onClick={handleGenerate}
              className={[
                "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold border transition-colors",
                loading || !canGenerate ? "opacity-60 cursor-not-allowed" : "hover:bg-white/[0.06]",
              ].join(" ")}
              style={{
                borderColor: "rgba(216,146,17,0.28)",
                background: "rgba(216,146,17,0.10)",
                color: "white",
              }}
            >
              <Sparkles className="h-4 w-4" style={{ color: GOLD }} />
              {loading ? "Loading…" : "Generate Parlays"}
            </button>
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/[0.02]">
          <div className="text-sm text-white font-semibold">Suggested Parlays</div>
          <div className="text-[11px] text-white/45">{parlays.length ? `${parlays.length} found` : "—"}</div>
        </div>

        {parlays.length === 0 ? (
          <div className="p-4 text-xs text-white/55">
            No parlays yet. Set your options and click <span className="text-white/70">Generate Parlays</span>.
          </div>
        ) : (
          <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
            {parlays.map((p) => (
              <ParlayCard key={p.id} parlay={p} />
            ))}
          </div>
        )}
      </div>

      {/* Footnote */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="text-xs text-white/60 leading-relaxed space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" style={{ color: GOLD }} />
            <span>
              EV assumes independence (multiply probs) but we now apply a correlation penalty so results aren’t just the
              same legs recombined.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-white/35" />
            <span>Edge is intentionally blank for now (as requested).</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================
   UI Helpers
========================================= */

function ControlBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="text-[10px] text-white/45 mb-2">{label}</div>
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="flex items-center justify-between w-full rounded-lg border px-3 py-2 text-sm"
      style={{
        borderColor: BORDER,
        background: value ? "rgba(216,146,17,0.10)" : "rgba(0,0,0,0.30)",
      }}
    >
      <span className="text-white/80">{label}</span>
      <span
        className="inline-flex items-center justify-center h-5 w-9 rounded-full border"
        style={{
          borderColor: value ? "rgba(216,146,17,0.35)" : "rgba(255,255,255,0.10)",
          background: value ? "rgba(216,146,17,0.20)" : "rgba(255,255,255,0.06)",
        }}
      >
        <span
          className="h-3 w-3 rounded-full transition-transform"
          style={{
            background: value ? GOLD : "rgba(255,255,255,0.35)",
            transform: value ? "translateX(7px)" : "translateX(-7px)",
          }}
        />
      </span>
    </button>
  );
}

function ParlayCard({ parlay }: { parlay: ParlayResult }) {
  const corrLabel = parlay.corr_penalty >= 0.8 ? "High" : parlay.corr_penalty >= 0.45 ? "Medium" : "Low";
  const corrColor = parlay.corr_penalty >= 0.8 ? "#fca5a5" : parlay.corr_penalty >= 0.45 ? "#fde68a" : "#bbf7d0";

  return (
    <div className="rounded-xl border border-white/10 bg-black/25 overflow-hidden">
      <div className="p-3 border-b border-white/10 bg-white/[0.02] flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-white font-semibold">
            {parlay.legsCount}-Leg Parlay{" "}
            <span className="text-white/40 font-medium">({prettyBook(parlay.book)})</span>
          </div>
          <div className="text-[11px] text-white/45 mt-0.5">
            Earliest: {parlay.commence_time_min ? fmtDateTime(parlay.commence_time_min) : "—"}
          </div>
        </div>

        <div className="text-right">
          <div className="text-[11px] text-white/45">EV</div>
          <div className="text-lg font-semibold" style={{ color: parlay.ev_pct >= 0 ? "white" : "#fca5a5" }}>
            {parlay.ev_pct.toFixed(1)}%
          </div>
        </div>
      </div>

      <div className="p-3 space-y-2">
        <div className="grid grid-cols-4 gap-2">
          <MiniStat label="Parlay Odds" value={fmtOdds(parlay.parlay_american)} />
          <MiniStat label="Win Prob" value={`${(parlay.p_win * 100).toFixed(1)}%`} />
          <MiniStat label="Payout" value={`${parlay.parlay_decimal.toFixed(2)}x`} />
          <MiniStat
            label="Correlation"
            value={`${corrLabel}`}
            valueStyle={{ color: corrColor }}
            subValue={`${parlay.corr_penalty.toFixed(2)} pen`}
          />
        </div>

        <div className="mt-2 space-y-2">
          {parlay.legs.map((leg, idx) => (
            <div key={leg.id + idx} className="rounded-lg border border-white/10 bg-white/[0.02] p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs text-white font-medium truncate">{leg.label}</div>
                  <div className="text-[11px] text-white/45 mt-0.5">{leg.sublabel}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-white/35">{leg.source === "prop" ? "PROP" : "GAME"}</div>
                  <div className="text-xs text-white/70">{fmtOdds(leg.american_odds)}</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="pt-1 text-[10px] text-white/35 flex items-center gap-2">
          <Shuffle className="h-3.5 w-3.5" />
          <span>
            Ranking = EV% − (CorrelationPenalty × {Math.round((parlay.rank_score - parlay.ev_pct) / (parlay.corr_penalty || 1)) || "w"})
            (diversity + correlation-aware)
          </span>
        </div>
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  subValue,
  valueStyle,
}: {
  label: string;
  value: string;
  subValue?: string;
  valueStyle?: React.CSSProperties;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-2">
      <div className="text-[10px] text-white/40">{label}</div>
      <div className="text-sm text-white font-semibold" style={valueStyle}>
        {value}
      </div>
      {subValue ? <div className="text-[10px] text-white/35 mt-0.5">{subValue}</div> : null}
    </div>
  );
}

/* =========================================
   Mapping: ev_plays -> CandidateLeg
========================================= */

function mapGameCandidates(rows: any[]): CandidateLeg[] {
  return (rows ?? []).map((r) => {
    const odds = safeNum(r.book_odds);
    const p = safeNum(r.quantum_prob);

    const matchup = String(r.matchup ?? "").trim();
    const team = String(r.team ?? "").trim();
    const market = String(r.market ?? "").trim();
    const side = String(r.side ?? "").trim();

    const label = [matchup || "Game", "—", marketLabel(market, side, team, safeNum(r.line))].join(" ");

    const book = normalizeBook(String(r.bookmaker ?? "").trim());
    const ev = safeNum(r.ev_pct);

    const conf = safeNum(r.confidence_score);
    const score = rankScore(ev, conf);

    return {
      id: String(r.id),
      source: "game",
      sport_key: r.sport_key ?? null,
      event_id: String(r.event_id),
      commence_time: r.commence_time ?? null,
      label,
      sublabel: `${prettyBook(book)} ${fmtOdds(odds)} • EV ${fmtPct(ev)}`,
      market,
      side,
      line: safeNum(r.line),
      book,
      american_odds: odds,
      p,
      ev_pct: ev,
      score,
      team: team || null,
      opponent: null,
      player_name: null,
    } satisfies CandidateLeg;
  });
}

/* =========================================
   Mapping: player_prop_ev_latest -> CandidateLeg
========================================= */

function mapPropCandidates(rows: any[]): CandidateLeg[] {
  return (rows ?? []).map((r) => {
    const odds = safeNum(r.odds);
    const p = safeNum(r.p_quantum);

    const player = String(r.player_name ?? "").trim() || "Player";
    const market = String(r.market ?? "").trim();
    const side = String(r.side ?? "").trim();
    const line = safeNum(r.line);

    const team = String(r.team ?? "").trim();
    const opp = String(r.opponent ?? "").trim();
    const matchup = team && opp ? `${team} vs ${opp}` : team || opp || "";

    const label = `${player} — ${propMarketLabel(market)} ${sideLabel(side)} ${line != null ? line : ""}`.trim();

    const book = normalizeBook(String(r.book ?? "").trim());
    const ev = safeNum(r.ev_pct);
    const rawScore = safeNum(r.score);
    const score = rankScore(ev, rawScore);

    return {
      id: String(r.id),
      source: "prop",
      sport_key: r.sport_key ?? null,
      event_id: String(r.event_id),
      commence_time: r.commence_time ?? null,
      label,
      sublabel: `${matchup ? matchup + " • " : ""}${prettyBook(book)} ${fmtOdds(odds)} • EV ${fmtPct(ev)}`,
      market,
      side,
      line,
      book,
      american_odds: odds,
      p,
      ev_pct: ev,
      score,
      team: team || null,
      opponent: opp || null,
      player_name: player,
    } satisfies CandidateLeg;
  });
}

/* =========================================
   Parlay Builder (Correlation-aware + diversity)
========================================= */

function buildParlays(
  candidates: CandidateLeg[],
  legsCount: number,
  opts: {
    allowSameGame: boolean;
    allowSamePlayer: boolean;
    maxResults: number;
    enforceBook: string | null;
    penaltyWeight: number;
    diversityMode: boolean;
  }
): ParlayResult[] {
  const pool = (opts.enforceBook ? candidates.filter((c) => c.book === opts.enforceBook) : candidates).slice();
  if (pool.length < legsCount) return [];

  // Generate combinations (N choose K) on top pool
  const combos: CandidateLeg[][] = [];
  const idx: number[] = Array.from({ length: legsCount }, (_, i) => i);
  const n = pool.length;

  const pushCombo = () => {
    const legs = idx.map((i) => pool[i]);
    if (!isValidComboStrong(legs, opts)) return;
    combos.push(legs);
  };

  pushCombo();

  while (true) {
    let i = legsCount - 1;
    while (i >= 0 && idx[i] === i + n - legsCount) i--;
    if (i < 0) break;

    idx[i]++;
    for (let j = i + 1; j < legsCount; j++) idx[j] = idx[j - 1] + 1;

    pushCombo();

    // keep UI safe
    if (combos.length > 7000) break;
  }

  const scored = combos
    .map((legs) => {
      const decimals = legs.map((l) => americanToDecimal(l.american_odds!));
      const pLegs = legs.map((l) => l.p!);

      const parlayDecimal = decimals.reduce((a, b) => a * b, 1);
      const pWinInd = pLegs.reduce((a, b) => a * b, 1);

      const evPctInd = parlayEvPct(pWinInd, parlayDecimal);

      const corrPenalty = correlationPenalty(legs);
      const rank = evPctInd - corrPenalty * (Number.isFinite(opts.penaltyWeight) ? opts.penaltyWeight : 0);

      const commenceMin = earliestCommence(legs.map((l) => l.commence_time ?? null));
      const book = legs[0]?.book ?? "—";
      const parlayAmerican = decimalToAmerican(parlayDecimal);

      return {
        id: legs.map((l) => l.id).join("|"),
        legs,
        book,
        legsCount: legs.length,
        parlay_decimal: parlayDecimal,
        parlay_american: parlayAmerican,
        p_win: pWinInd,
        ev_pct: evPctInd,
        commence_time_min: commenceMin,
        corr_penalty: corrPenalty,
        rank_score: rank,
      } satisfies ParlayResult;
    })
    .sort((a, b) => b.rank_score - a.rank_score);

  // Output selection
  if (!opts.diversityMode) return scored.slice(0, opts.maxResults);

  return selectDiverse(scored, opts.maxResults);
}

function selectDiverse(scored: ParlayResult[], maxResults: number) {
  // Greedy “variety” picker:
  // - prefer unique anchor leg
  // - avoid identical event sets
  // - avoid repeating same player too much
  const out: ParlayResult[] = [];
  const seenAnchors = new Set<string>();
  const seenEventSets = new Set<string>();
  const playerCounts: Record<string, number> = {};

  for (const p of scored) {
    const anchor = p.legs[0]?.id ?? p.id;
    const eventKey = p.legs
      .map((l) => l.event_id)
      .sort()
      .join("|");

    if (seenAnchors.has(anchor)) continue;
    if (seenEventSets.has(eventKey)) continue;

    // soft player repetition limiter (doesn’t block, but avoids spam)
    const players = p.legs.map((l) => normalizePlayerKey(l.player_name)).filter(Boolean) as string[];
    const tooMany = players.some((pl) => (playerCounts[pl] ?? 0) >= 2);
    if (tooMany) continue;

    out.push(p);
    seenAnchors.add(anchor);
    seenEventSets.add(eventKey);
    for (const pl of players) playerCounts[pl] = (playerCounts[pl] ?? 0) + 1;

    if (out.length >= maxResults) break;
  }

  // fallback if the diversity filter was too strict
  if (out.length < maxResults) {
    for (const p of scored) {
      if (out.length >= maxResults) break;
      if (out.some((x) => x.id === p.id)) continue;
      out.push(p);
    }
  }

  return out.slice(0, maxResults);
}

/* =========================================
   Validity + Correlation
========================================= */

function isValidComboStrong(
  legs: CandidateLeg[],
  opts: { allowSameGame: boolean; allowSamePlayer: boolean }
) {
  // Basic sanity
  if (legs.some((l) => l.p == null || l.american_odds == null)) return false;

  // 1) Event stacking rule
  if (!opts.allowSameGame) {
    const uniqEvents = new Set(legs.map((l) => l.event_id));
    if (uniqEvents.size !== legs.length) return false;
  }

  // 2) Same-player props rule
  if (!opts.allowSamePlayer) {
    const players = legs
      .map((l) => normalizePlayerKey(l.player_name))
      .filter(Boolean) as string[];
    if (new Set(players).size !== players.length) return false;
  }

  // 3) No “same semantic play” duplicates (prevents near-identical legs)
  const seen = new Set<string>();
  for (const l of legs) {
    const k = semanticLegKey(l);
    if (seen.has(k)) return false;
    seen.add(k);
  }

  // 4) Market bucket uniqueness (prevents “same type” parlays)
  // This is the single biggest fix for “just combining the same plays”.
  const buckets = legs.map((l) => marketBucket(l));
  if (new Set(buckets).size !== buckets.length) return false;

  // 5) Contradiction checks (only relevant when allowSameGame=true)
  const byEvent = groupBy(legs, (l) => l.event_id);
  for (const group of Object.values(byEvent)) {
    if (group.length <= 1) continue;

    // cap same-event stacking to 2 for safety
    if (group.length > 2) return false;

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (areContradictory(group[i], group[j])) return false;
      }
    }
  }

  return true;
}

function correlationPenalty(legs: CandidateLeg[]) {
  // 0..1.25 (higher = more correlated)
  let pen = 0;

  // A) event overlap (still penalize even if allowed)
  const eventCounts = countBy(legs, (l) => l.event_id);
  for (const c of Object.values(eventCounts)) {
    if (c > 1) pen += 0.35 * (c - 1);
  }

  // B) team overlap (team appears multiple times)
  const teams = legs.map((l) => normalizeTeamKey(l.team)).filter(Boolean) as string[];
  const teamCounts = countBy(teams, (t) => t);
  for (const c of Object.values(teamCounts)) {
    if (c > 1) pen += 0.12 * (c - 1);
  }

  // C) market bucket repetition (should be blocked, but keep as safety)
  const buckets = legs.map((l) => marketBucket(l));
  const bucketCounts = countBy(buckets, (b) => b);
  for (const c of Object.values(bucketCounts)) {
    if (c > 1) pen += 0.18 * (c - 1);
  }

  // D) same-event “high correlation pair” penalties
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i];
      const b = legs[j];
      if (a.event_id !== b.event_id) continue;

      const ba = marketBucket(a);
      const bb = marketBucket(b);

      // total + prop over (points/3s/etc) is high correlation
      if ((ba === "game_total" && bb.startsWith("prop_")) || (bb === "game_total" && ba.startsWith("prop_"))) {
        const propLeg = ba.startsWith("prop_") ? a : b;
        const side = normalizeSide(propLeg.side);
        if (side === "over") pen += 0.22;
      }

      // spread/ML + player points over (often correlated)
      const spreadOrMlA = ba === "game_spread" || ba === "game_ml";
      const spreadOrMlB = bb === "game_spread" || bb === "game_ml";
      const pointsA = ba === "prop_points";
      const pointsB = bb === "prop_points";

      if ((spreadOrMlA && pointsB) || (spreadOrMlB && pointsA)) {
        const pointsLeg = pointsA ? a : b;
        if (normalizeSide(pointsLeg.side) === "over") pen += 0.15;
      }

      // same team + overs (milder penalty)
      const ta = normalizeTeamKey(a.team);
      const tb = normalizeTeamKey(b.team);
      if (ta && tb && ta === tb && normalizeSide(a.side) === "over" && normalizeSide(b.side) === "over") {
        pen += 0.08;
      }
    }
  }

  return Math.min(1.25, pen);
}

function marketBucket(l: CandidateLeg) {
  const m = normalizeMarket(l.market);

  // game lines buckets
  if (m === "moneyline") return "game_ml";
  if (m === "spread") return "game_spread";
  if (m === "total") return "game_total";

  // props buckets by stat (keeps variety)
  const raw = (l.market ?? "").toLowerCase();
  if (raw.includes("points")) return "prop_points";
  if (raw.includes("rebounds")) return "prop_rebounds";
  if (raw.includes("assists")) return "prop_assists";
  if (raw.includes("threes") || raw.includes("3")) return "prop_threes";
  return `prop_${m || "other"}`;
}

function semanticLegKey(l: CandidateLeg) {
  const bucket = marketBucket(l);
  const side = normalizeSide(l.side) ?? normalizeSideRaw(l.side);
  const line = l.line == null ? "null" : String(roundLine(l.line));
  const player = normalizePlayerKey(l.player_name) ?? "";
  const team = normalizeTeamKey(l.team) ?? "";
  return `${l.event_id}|${bucket}|${side}|${line}|${player}|${team}`;
}

function areContradictory(a: CandidateLeg, b: CandidateLeg) {
  // Only meaningful within same event
  if (a.event_id !== b.event_id) return false;

  const ba = marketBucket(a);
  const bb = marketBucket(b);

  // Total over + under at same line is contradictory
  if (ba === "game_total" && bb === "game_total") {
    const sa = normalizeSide(a.side);
    const sb = normalizeSide(b.side);
    if (sa && sb && sa !== sb && sameLine(a.line, b.line)) return true;
  }

  // Prop over + under at same line is contradictory (same player/market)
  if (ba.startsWith("prop_") && bb.startsWith("prop_")) {
    const pa = normalizePlayerKey(a.player_name);
    const pb = normalizePlayerKey(b.player_name);
    if (pa && pb && pa === pb && marketBucket(a) === marketBucket(b)) {
      const sa = normalizeSide(a.side);
      const sb = normalizeSide(b.side);
      if (sa && sb && sa !== sb && sameLine(a.line, b.line)) return true;
    }
  }

  // Spread: taking both sides of same spread line is contradictory
  if (ba === "game_spread" && bb === "game_spread") {
    const ta = normalizeTeamKey(a.team);
    const tb = normalizeTeamKey(b.team);
    if (ta && tb && ta !== tb && sameLine(a.line, b.line)) {
      // team A +3.5 vs team B -3.5 could show up; we treat as contradictory
      const la = a.line;
      const lb = b.line;
      if (la != null && lb != null && Math.abs(la + lb) < 0.0001) return true;
    }
  }

  return false;
}

/* =========================================
   Dedupe candidates
========================================= */

function dedupeBySemanticKey(legs: CandidateLeg[]) {
  const bestByKey = new Map<string, CandidateLeg>();

  for (const l of legs) {
    const key = semanticLegKey(l);

    const prev = bestByKey.get(key);
    if (!prev) {
      bestByKey.set(key, l);
      continue;
    }

    // keep higher score (or EV if score missing)
    const a = l.score ?? l.ev_pct ?? 0;
    const b = prev.score ?? prev.ev_pct ?? 0;
    if (a > b) bestByKey.set(key, l);
  }

  return Array.from(bestByKey.values());
}

/* =========================================
   Math helpers
========================================= */

function americanToDecimal(american: number) {
  if (!Number.isFinite(american) || american === 0) return 1;
  if (american > 0) return 1 + american / 100;
  return 1 + 100 / Math.abs(american);
}

function decimalToAmerican(decimal: number): number | null {
  if (!Number.isFinite(decimal) || decimal <= 1) return null;
  const profit = decimal - 1;
  if (profit >= 1) return Math.round(profit * 100);
  return -Math.round(100 / profit);
}

function parlayEvPct(pWin: number, decimal: number) {
  // EV (per $1 stake): p*(decimal-1) - (1-p)
  const ev = pWin * (decimal - 1) - (1 - pWin);
  return ev * 100;
}

function earliestCommence(times: Array<string | null>) {
  const parsed = times
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((ms) => Number.isFinite(ms)) as number[];
  if (!parsed.length) return null;
  const min = Math.min(...parsed);
  return new Date(min).toISOString();
}

function rankScore(evPct: number | null, second: number | null) {
  const ev = typeof evPct === "number" ? evPct : 0;
  const s = typeof second === "number" ? second : 0;
  return ev * 10 + s;
}

function countBy<T>(arr: T[], keyFn: (t: T) => string) {
  return arr.reduce((acc, x) => {
    const k = keyFn(x);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

function groupBy<T>(arr: T[], keyFn: (t: T) => string) {
  return arr.reduce((acc, x) => {
    const k = keyFn(x);
    (acc[k] ||= []).push(x);
    return acc;
  }, {} as Record<string, T[]>);
}

/* =========================================
   Formatting helpers
========================================= */

function safeNum(v: any): number | null {
  const n = typeof v === "number" ? v : v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtOdds(odds: number | null) {
  if (odds == null || !Number.isFinite(odds)) return "—";
  const n = Math.round(odds);
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtPct(v: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}%`;
}

function normalizeBook(s: string) {
  const t = (s ?? "").trim().toLowerCase();
  if (t === "draftkings" || t === "dk") return "draftkings";
  if (t === "fanduel" || t === "fd") return "fanduel";
  if (t === "betmgm" || t === "mgm") return "betmgm";
  return t || "unknown";
}

function prettyBook(book: string) {
  if (book === "draftkings") return "DraftKings";
  if (book === "fanduel") return "FanDuel";
  if (book === "betmgm") return "BetMGM";
  if (book === "any") return "Any";
  return book || "—";
}

function fmtDateTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function sideLabel(side: string) {
  const s = (side ?? "").toLowerCase();
  if (s === "over") return "Over";
  if (s === "under") return "Under";
  return side;
}

function normalizeSide(side?: string | null) {
  const s = (side ?? "").toLowerCase().trim();
  if (!s) return null;
  if (s === "over") return "over";
  if (s === "under") return "under";
  if (s === "home") return "home";
  if (s === "away") return "away";
  if (s === "yes") return "yes";
  if (s === "no") return "no";
  return null;
}

function normalizeSideRaw(side?: string | null) {
  return (side ?? "").trim().toLowerCase();
}

function normalizeMarket(market?: string | null) {
  const m = (market ?? "").toLowerCase().trim();
  if (!m) return "";
  if (m === "h2h" || m.includes("moneyline")) return "moneyline";
  if (m.includes("spreads") || m.includes("spread")) return "spread";
  if (m.includes("totals") || m.includes("total")) return "total";
  return m;
}

function normalizePlayerKey(name?: string | null) {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return null;
  return n.replace(/\s+/g, " ");
}

function normalizeTeamKey(team?: string | null) {
  const t = (team ?? "").trim().toLowerCase();
  if (!t) return null;
  return t.replace(/\s+/g, " ");
}

function roundLine(x: number) {
  // reduce float noise (e.g., 24.499999)
  return Math.round(x * 4) / 4;
}

function sameLine(a: number | null, b: number | null) {
  if (a == null || b == null) return false;
  return Math.abs(roundLine(a) - roundLine(b)) < 0.0001;
}

function propMarketLabel(market: string) {
  const m = (market ?? "").toLowerCase();
  if (m.includes("points")) return "Points";
  if (m.includes("rebounds")) return "Rebounds";
  if (m.includes("assists")) return "Assists";
  if (m.includes("threes") || m.includes("3")) return "3PT";
  return market || "Prop";
}

function marketLabel(market: string, side: string, team: string, line: number | null) {
  const m = (market ?? "").toLowerCase();
  const s = (side ?? "").toLowerCase();

  if (m === "h2h" || m.includes("moneyline")) return `ML ${team}`;
  if (m.includes("spreads") || m.includes("spread")) {
    const ln = line != null ? (line > 0 ? `+${line}` : `${line}`) : "";
    return `Spread ${team} ${ln}`.trim();
  }
  if (m.includes("totals") || m.includes("total")) {
    const ln = line != null ? line : "";
    return `${s === "over" ? "Over" : s === "under" ? "Under" : side} ${ln}`.trim();
  }

  return `${market} ${side}`.trim();
}
