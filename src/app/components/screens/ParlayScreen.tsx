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

  book: string;
  american_odds: number | null;

  // Model / fair probability
  p: number | null; // 0..1
  ev_pct: number | null; // percent
  score: number | null;

  // correlation keys
  team?: string | null;
  player_name?: string | null;
};

type ParlayResult = {
  id: string;
  legs: CandidateLeg[];

  book: string;
  legsCount: number;

  parlay_decimal: number;
  parlay_american: number | null;

  p_win: number;
  ev_pct: number;

  commence_time_min: string | null;
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
  const [maxCandidates, setMaxCandidates] = useState<number>(24);
  const [allowSameGame, setAllowSameGame] = useState<boolean>(false);
  const [allowSamePlayer, setAllowSamePlayer] = useState<boolean>(false); // ✅ NEW (default false)
  const [maxParlays, setMaxParlays] = useState<number>(8);

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

      mapped.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      setCandidates(mapped);
      return mapped;
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

    const topPool = pool.slice(0, Math.max(legs + 2, maxCandidates));

    const built = buildParlays(topPool, legs, {
      allowSameGame,
      allowSamePlayer,
      maxResults: maxParlays,
      enforceBook: book === "any" ? null : book,
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
              Pick your legs + book — we’ll suggest parlays built from your top +EV plays.
            </p>
          </div>

          <div className="hidden md:flex items-center gap-2 text-[10px] text-white/45 whitespace-nowrap">
            <Shield className="h-3.5 w-3.5" />
            <span>Independence EV (v1)</span>
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

          {/* Rules */}
          <ControlBlock label="Parlay rules">
            <ToggleRow
              label="Allow multiple legs from same game"
              value={allowSameGame}
              onChange={setAllowSameGame}
            />
            <div className="mt-2">
              <ToggleRow
                label="Allow multiple legs with same player (props)"
                value={allowSamePlayer}
                onChange={setAllowSamePlayer}
              />
            </div>

            <div className="text-[10px] text-white/40 mt-2 space-y-1">
              <div>
                • Default is safest: <span className="text-white/60">1 leg per game</span> and{" "}
                <span className="text-white/60">no same-player props</span>.
              </div>
              <div>• Even if same-game is allowed, we still block “impossible” combos.</div>
            </div>
          </ControlBlock>
        </div>

        <div className="mt-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="text-[11px] text-white/45 flex items-center gap-2">
            <Layers className="h-4 w-4" />
            <span>
              Candidates: <span className="text-white/70">{headerStats.total}</span> (Game{" "}
              {headerStats.game} / Props {headerStats.prop})
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
            No parlays yet. Set your options and click{" "}
            <span className="text-white/70">Generate Parlays</span>.
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
            <span>EV assumes legs are independent (v1). Correlation rules can be expanded later.</span>
          </div>
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-white/35" />
            <span>
              Current restrictions: no duplicate/contradictory legs, and (by default) no same-player props.
            </span>
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
        <div className="grid grid-cols-3 gap-2">
          <MiniStat label="Parlay Odds" value={fmtOdds(parlay.parlay_american)} />
          <MiniStat label="Win Prob" value={`${(parlay.p_win * 100).toFixed(1)}%`} />
          <MiniStat label="Payout" value={`${parlay.parlay_decimal.toFixed(2)}x`} />
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

        <div className="pt-1 text-[10px] text-white/35">
          * EV assumes independence. We also filter “not allowed” combos (same-player props, contradictions, duplicates).
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-2">
      <div className="text-[10px] text-white/40">{label}</div>
      <div className="text-sm text-white font-semibold">{value}</div>
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
      player_name: player,
    } satisfies CandidateLeg;
  });
}

/* =========================================
   Parlay Builder (WITH NOT-ALLOWED RULES)
========================================= */

function buildParlays(
  candidates: CandidateLeg[],
  legsCount: number,
  opts: {
    allowSameGame: boolean;
    allowSamePlayer: boolean;
    maxResults: number;
    enforceBook: string | null;
  }
): ParlayResult[] {
  const pool = (opts.enforceBook ? candidates.filter((c) => c.book === opts.enforceBook) : candidates).slice();
  if (pool.length < legsCount) return [];

  // Combo generator (N choose K) with pruning via isValidCombo
  const combos: CandidateLeg[][] = [];
  const idx: number[] = Array.from({ length: legsCount }, (_, i) => i);
  const n = pool.length;

  const pushCombo = () => {
    const legs = idx.map((i) => pool[i]);
    if (!isValidCombo(legs, opts)) return;
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

    // Safety cutoff
    if (combos.length > 4500) break;
  }

  const scored: ParlayResult[] = combos
    .map((legs) => {
      const decimals = legs.map((l) => americanToDecimal(l.american_odds!));
      const pLegs = legs.map((l) => l.p!);

      const parlayDecimal = decimals.reduce((a, b) => a * b, 1);
      const pWin = pLegs.reduce((a, b) => a * b, 1);
      const evPct = parlayEvPct(pWin, parlayDecimal);

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
        p_win: pWin,
        ev_pct: evPct,
        commence_time_min: commenceMin,
      } satisfies ParlayResult;
    })
    .sort((a, b) => b.ev_pct - a.ev_pct);

  // Variety filter
  const out: ParlayResult[] = [];
  const seenFirst = new Set<string>();
  for (const p of scored) {
    const key = p.legs[0]?.id ?? p.id;
    if (seenFirst.has(key)) continue;
    out.push(p);
    seenFirst.add(key);
    if (out.length >= opts.maxResults) break;
  }

  return out;
}

function isValidCombo(legs: CandidateLeg[], opts: { allowSameGame: boolean; allowSamePlayer: boolean }) {
  // 1) Default: only 1 leg per event unless allowSameGame
  if (!opts.allowSameGame) {
    const uniqEvents = new Set(legs.map((l) => l.event_id));
    if (uniqEvents.size !== legs.length) return false;
  }

  // 2) Same-player restriction (props) — many books block this outright
  if (!opts.allowSamePlayer) {
    const players = legs
      .map((l) => normalizePlayerKey(l.player_name))
      .filter(Boolean) as string[];
    const uniq = new Set(players);
    if (uniq.size !== players.length) return false;
  }

  // 3) No duplicates / near-duplicates (same event + market + side + line)
  //    Helps when the same play appears from different sources or mapping differences.
  const seenExact = new Set<string>();
  for (const l of legs) {
    const key = legKey(l);
    if (seenExact.has(key)) return false;
    seenExact.add(key);
  }

  // 4) No contradictions inside same event:
  //    - Over vs Under same line same market
  //    - ML both sides, Spread both sides, Total both sides, etc.
  //    - Same player/market/line but opposite side (even if allowSamePlayer=true)
  const byEvent = groupBy(legs, (l) => l.event_id);
  for (const [eventId, group] of Object.entries(byEvent)) {
    if (group.length <= 1) continue;

    // Check pairwise contradictions within the event group
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (areContradictory(group[i], group[j])) return false;
      }
    }

    // If allowSameGame=true, still avoid “messy stacks”:
    // - More than 2 legs from the same event tends to be disallowed/limited on many books.
    //   (You can remove this if you want.)
    if (opts.allowSameGame && group.length > 2) return false;
  }

  return true;
}

function areContradictory(a: CandidateLeg, b: CandidateLeg) {
  // Same event, same market, same line, opposite side => contradiction
  const sameEvent = a.event_id === b.event_id;
  if (!sameEvent) return false;

  const ma = normalizeMarket(a.market);
  const mb = normalizeMarket(b.market);
  if (ma !== mb) return false;

  const la = a.line ?? null;
  const lb = b.line ?? null;
  const sameLine =
    la == null || lb == null ? false : Math.abs(la - lb) < 1e-9;

  // Prop contradiction: same player + market + same line + opposite side
  const pa = normalizePlayerKey(a.player_name);
  const pb = normalizePlayerKey(b.player_name);
  const samePlayer = !!pa && pa === pb;

  const sa = normalizeSide(a.side);
  const sb = normalizeSide(b.side);

  // totals: over vs under same line
  if (isTotalMarket(ma) && sameLine && sa && sb && sa !== sb) return true;

  // spreads: if line exists and sides are opposites on same team can conflict;
  // we can treat same market+line+opposite side as contradiction.
  if (isSpreadMarket(ma) && sameLine && sa && sb && sa !== sb) return true;

  // moneyline: "home"/"away" (or team names) are sides; if opposite, contradiction.
  if (isMoneylineMarket(ma) && sa && sb && sa !== sb) return true;

  // props: over/under same line same player
  if (samePlayer && sameLine && sa && sb && sa !== sb) return true;

  return false;
}

function legKey(l: CandidateLeg) {
  const m = normalizeMarket(l.market);
  const s = normalizeSide(l.side) ?? normalizeSideRaw(l.side);
  const line = l.line == null ? "null" : String(roundLine(l.line));
  const p = normalizePlayerKey(l.player_name) ?? "";
  return `${l.event_id}|${m}|${s}|${line}|${p}`;
}

function normalizePlayerKey(name?: string | null) {
  const t = (name ?? "").trim().toLowerCase();
  if (!t) return null;
  return t.replace(/\s+/g, " ");
}

function normalizeMarket(market: string) {
  const m = (market ?? "").trim().toLowerCase();
  if (m === "h2h" || m.includes("moneyline")) return "moneyline";
  if (m.includes("spread")) return "spread";
  if (m.includes("total")) return "total";
  // player props bucket by raw market string
  return m;
}

function normalizeSide(side: string) {
  const s = (side ?? "").trim().toLowerCase();
  if (s === "over") return "over";
  if (s === "under") return "under";
  // common moneyline sides
  if (s === "home") return "home";
  if (s === "away") return "away";
  return null;
}

function normalizeSideRaw(side: string) {
  return (side ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isTotalMarket(m: string) {
  return m === "total" || m.includes("total") || m.includes("totals");
}

function isSpreadMarket(m: string) {
  return m === "spread" || m.includes("spread") || m.includes("spreads");
}

function isMoneylineMarket(m: string) {
  return m === "moneyline" || m.includes("moneyline") || m === "h2h";
}

function roundLine(x: number) {
  // keep half/quarter lines stable
  return Math.round(x * 1000) / 1000;
}

function groupBy<T>(arr: T[], keyFn: (t: T) => string) {
  return arr.reduce((acc, item) => {
    const k = keyFn(item);
    (acc[k] ||= []).push(item);
    return acc;
  }, {} as Record<string, T[]>);
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

/* =========================================
   Formatting + misc helpers
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
