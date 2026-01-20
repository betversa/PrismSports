import React, { useMemo, useState } from "react";
import {
  americanToDecimal,
  clampNumber,
  decimalToAmerican,
  evPercentFromDecimal,
  impliedProbFromAmerican,
  impliedProbFromDecimal,
  kellyFraction,
  payoutFromStakeDecimal,
  profitFromStakeDecimal,
  safeNumber,
} from "../../../lib/odds/math";
import { formatAmerican, formatDecimal, formatMoney, formatPercent } from "../../../lib/odds/format";
import { ScreenShell, SectionCard, SectionHeader } from "../ScreenShell";
import { hasSupabaseEnv, missingSupabaseVars } from "../../lib/supabaseClient";
import { DataSourceErrorPanel } from "../ui/PrismUI";

/**
 * CalculatorScreen.tsx — FULL NEW SCREEN (Prism calculators)
 * ----------------------------------------------------------
 * ✅ Mobile-first, dark glass panels + gold accents
 * ✅ Calculator selector + dynamic input forms
 * ✅ Instant calculations (no submit required)
 * ✅ Includes: Implied Prob, Odds Converter, Kelly, EV%, Parlay, Hedge
 */

type CalcKey = "implied" | "convert" | "kelly" | "ev" | "parlay" | "hedge";

type OddsFormat = "american" | "decimal";

const GOLD = "#d4af37";

function fmtNum(n: number, digits = 4) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#0f0f0f] p-4 md:p-5">
      <div
        className="pointer-events-none absolute inset-0 opacity-100"
        style={{
          background:
            "radial-gradient(720px 260px at 20% 0%, rgba(212,175,55,0.14), transparent 60%), radial-gradient(520px 220px at 88% 10%, rgba(255,255,255,0.05), transparent 60%)",
        }}
      />
      <div className="relative">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-white text-base md:text-lg tracking-tight">{title}</div>
            {subtitle ? <div className="text-[12px] text-[#9a9a9a] mt-1">{subtitle}</div> : null}
          </div>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-end justify-between gap-2">
        <div className="text-[11px] text-[#808080]">{label}</div>
        {hint ? <div className="text-[10px] text-[#505050]">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

function Input({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-lg border border-[#2a2a2a] bg-black/40 px-3 py-2 text-[13px] text-white placeholder:text-[#505050] outline-none focus:border-[#d4af37]/60"
    />
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-[#2a2a2a] bg-black/40 px-3 py-2 text-[13px] text-white outline-none focus:border-[#d4af37]/60"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-[#0b0b0b]">
          {o.label}
        </option>
      ))}
    </select>
  );
}

function StatBox({
  label,
  value,
  tone = "text-white",
  sub,
}: {
  label: string;
  value: string;
  tone?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-[#1f1f1f] bg-[#0a0a0a] px-3 py-3">
      <div className="text-[10px] text-[#606060]">{label}</div>
      <div className={`mt-1 text-[14px] font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub ? <div className="mt-1 text-[10px] text-[#606060]">{sub}</div> : null}
    </div>
  );
}

function Segmented({
  value,
  onChange,
  items,
}: {
  value: string;
  onChange: (v: string) => void;
  items: { value: string; label: string }[];
}) {
  return (
    <div className="inline-flex items-center rounded-xl border border-[#2a2a2a] bg-black/40 overflow-hidden">
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            onClick={() => onChange(it.value)}
            className={[
              "px-3 py-2 text-[12px] transition-colors",
              active ? "bg-[#141414] text-white" : "text-[#9a9a9a] hover:text-white hover:bg-[#111]",
            ].join(" ")}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

export function CalculatorScreen() {
  if (!hasSupabaseEnv) {
    return <DataSourceErrorPanel missing={missingSupabaseVars} />;
  }
  const [calc, setCalc] = useState<CalcKey>("implied");

  const modeLabel = useMemo(() => {
    const map: Record<CalcKey, string> = {
      implied: "Implied %",
      convert: "Convert Odds",
      kelly: "Kelly Bet",
      ev: "Expected Value",
      parlay: "Parlay",
      hedge: "Hedge",
    };
    return map[calc] ?? "—";
  }, [calc]);

  const inputCount = useMemo(() => {
    const map: Record<CalcKey, string> = {
      implied: "2 inputs",
      convert: "2 inputs",
      kelly: "3 inputs",
      ev: "3 inputs",
      parlay: "Multiple",
      hedge: "4 inputs",
    };
    return map[calc] ?? "Varies";
  }, [calc]);

  return (
    <ScreenShell
      title="Betting Calculator"
      subtitle="Instantly translate odds, implied probabilities, and expected value across formats."
      status={[
        {
          label: "Tools",
          value: "6 modules",
          helper: "Edge, odds, and ROI",
        },
        {
          label: "Mode",
          value: modeLabel,
          helper: "Active calculator",
        },
        {
          label: "Inputs",
          value: inputCount,
          helper: "Per calculation",
        },
        {
          label: "Precision",
          value: "High",
          helper: "Decimal + American",
        },
      ]}
    >
      <SectionCard>
        <SectionHeader
          title="Calculation Suite"
          description="Pick a calculator, enter inputs, and get instant results across formats."
          action={
            <Segmented
              value={calc}
              onChange={(v) => setCalc(v as CalcKey)}
              items={[
                { value: "implied", label: "Implied %" },
                { value: "convert", label: "Convert" },
                { value: "kelly", label: "Kelly" },
                { value: "ev", label: "EV%" },
                { value: "parlay", label: "Parlay" },
                { value: "hedge", label: "Hedge" },
              ]}
            />
          }
        />
        <div className="mt-6 grid gap-4">
          {calc === "implied" ? <ImpliedProbCalc /> : null}
          {calc === "convert" ? <OddsConverterCalc /> : null}
          {calc === "kelly" ? <KellyCalc /> : null}
          {calc === "ev" ? <EvCalc /> : null}
          {calc === "parlay" ? <ParlayCalc /> : null}
          {calc === "hedge" ? <HedgeCalc /> : null}
        </div>
      </SectionCard>
    </ScreenShell>
  );
}



function ImpliedProbCalc() {
  const [format, setFormat] = useState<OddsFormat>("american");
  const [odds, setOdds] = useState<string>("-110");

  const result = useMemo(() => {
    const o = safeNumber(odds, NaN);

    if (format === "american") {
      const p = impliedProbFromAmerican(o);
      const dec = americanToDecimal(o);
      return {
        impliedPct: Number.isFinite(p) ? p * 100 : NaN,
        decimal: dec,
        american: o,
      };
    } else {
      const d = safeNumber(odds, NaN);
      const p = impliedProbFromDecimal(d);
      const am = decimalToAmerican(d);
      return {
        impliedPct: Number.isFinite(p) ? p * 100 : NaN,
        decimal: d,
        american: am,
      };
    }
  }, [format, odds]);

  return (
    <Card title="Implied Probability" subtitle="Convert odds into implied win probability.">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Odds Format">
          <Select
            value={format}
            onChange={(v) => setFormat(v as OddsFormat)}
            options={[
              { value: "american", label: "American (e.g., -110, +120)" },
              { value: "decimal", label: "Decimal (e.g., 1.91, 2.20)" },
            ]}
          />
        </Field>

        <Field label={format === "american" ? "American Odds" : "Decimal Odds"} hint={format === "american" ? "Use +/-" : "Must be > 1.00"}>
          <Input value={odds} onChange={setOdds} placeholder={format === "american" ? "-110" : "1.91"} />
        </Field>

        <Field label="Result">
          <div className="grid grid-cols-2 gap-2">
            <StatBox
              label="Implied %"
              value={formatPercent(result.impliedPct, 2)}
              tone={Number.isFinite(result.impliedPct) ? "text-white" : "text-[#404040]"}
            />
            <StatBox
              label="Fair (Decimal)"
              value={formatDecimal(result.decimal)}
              tone={Number.isFinite(result.decimal) ? "text-white" : "text-[#404040]"}
            />
          </div>
        </Field>
      </div>

      <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
        <StatBox label="American" value={formatAmerican(result.american)} />
        <StatBox label="Decimal" value={formatDecimal(result.decimal)} />
        <StatBox
          label="Quick note"
          value="Implied % includes vig"
          tone="text-[#9a9a9a]"
          sub="Use true win% for Kelly/EV."
        />
      </div>
    </Card>
  );
}

function OddsConverterCalc() {
  const [from, setFrom] = useState<OddsFormat>("american");
  const [value, setValue] = useState<string>("-110");

  const out = useMemo(() => {
    if (from === "american") {
      const a = safeNumber(value, NaN);
      const dec = americanToDecimal(a);
      const imp = impliedProbFromAmerican(a) * 100;
      return { american: a, decimal: dec, impliedPct: imp };
    } else {
      const d = safeNumber(value, NaN);
      const am = decimalToAmerican(d);
      const imp = impliedProbFromDecimal(d) * 100;
      return { american: am, decimal: d, impliedPct: imp };
    }
  }, [from, value]);

  return (
    <Card title="Odds Converter" subtitle="Convert American ↔ Decimal and see implied % (vigged).">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Convert From">
          <Select
            value={from}
            onChange={(v) => setFrom(v as OddsFormat)}
            options={[
              { value: "american", label: "American" },
              { value: "decimal", label: "Decimal" },
            ]}
          />
        </Field>

        <Field label={from === "american" ? "American Odds" : "Decimal Odds"}>
          <Input value={value} onChange={setValue} placeholder={from === "american" ? "-110" : "1.91"} />
        </Field>

        <Field label="Outputs">
          <div className="grid grid-cols-3 gap-2">
            <StatBox label="American" value={formatAmerican(out.american)} />
            <StatBox label="Decimal" value={formatDecimal(out.decimal)} />
            <StatBox label="Implied %" value={formatPercent(out.impliedPct, 2)} tone="text-[#d4af37]" />
          </div>
        </Field>
      </div>
    </Card>
  );
}

function KellyCalc() {
  const [bankroll, setBankroll] = useState<string>("300");
  const [kellyFactor, setKellyFactor] = useState<string>("0.25"); // quarter-kelly default
  const [oddsFormat, setOddsFormat] = useState<OddsFormat>("american");
  const [odds, setOdds] = useState<string>("-110");
  const [trueWinPct, setTrueWinPct] = useState<string>("55"); // in %

  const calc = useMemo(() => {
    const br = safeNumber(bankroll, NaN);
    const kf = clampNumber(safeNumber(kellyFactor, NaN), 0, 1);
    const p = clampNumber(safeNumber(trueWinPct, NaN) / 100, 0, 1);

    const dec = oddsFormat === "american" ? americanToDecimal(safeNumber(odds, NaN)) : safeNumber(odds, NaN);
    const f = kellyFraction(p, dec);
    const fAdj = clampNumber(f * kf, 0, 1);

    const stake = Number.isFinite(br) ? br * fAdj : NaN;

    return {
      decimal: dec,
      rawKelly: f,
      adjKelly: fAdj,
      stake,
      stakePct: fAdj * 100,
      evPct: evPercentFromDecimal(p, dec),
    };
  }, [bankroll, kellyFactor, oddsFormat, odds, trueWinPct]);

  return (
    <Card title="Kelly Bet Size" subtitle="Compute stake size using your true win% and odds.">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Bankroll ($)">
          <Input value={bankroll} onChange={setBankroll} placeholder="300" />
        </Field>

        <Field label="Kelly Factor (0–1)" hint="0.25 = quarter Kelly">
          <Input value={kellyFactor} onChange={setKellyFactor} placeholder="0.25" />
        </Field>

        <Field label="True Win % (your edge)">
          <Input value={trueWinPct} onChange={setTrueWinPct} placeholder="55" />
        </Field>

        <Field label="Odds Format">
          <Select
            value={oddsFormat}
            onChange={(v) => setOddsFormat(v as OddsFormat)}
            options={[
              { value: "american", label: "American" },
              { value: "decimal", label: "Decimal" },
            ]}
          />
        </Field>

        <Field label={oddsFormat === "american" ? "American Odds" : "Decimal Odds"} hint={oddsFormat === "decimal" ? "Must be > 1.00" : "Use +/-"}>
          <Input value={odds} onChange={setOdds} placeholder={oddsFormat === "american" ? "-110" : "1.91"} />
        </Field>

        <Field label="Outputs">
          <div className="grid grid-cols-2 gap-2">
            <StatBox label="Recommended Stake" value={formatMoney(calc.stake, 2)} tone="text-[#d4af37]" />
            <StatBox label="Stake %" value={formatPercent(calc.stakePct, 2)} />
          </div>
        </Field>
      </div>

      <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-2">
        <StatBox label="Decimal Odds" value={formatDecimal(calc.decimal)} />
        <StatBox
          label="Raw Kelly f*"
          value={formatPercent(calc.rawKelly * 100, 2)}
          tone="text-white"
          sub="Before Kelly Factor"
        />
        <StatBox label="Adj Kelly" value={formatPercent(calc.adjKelly * 100, 2)} tone="text-white" sub="After Kelly Factor" />
        <StatBox
          label="EV%"
          value={formatPercent(calc.evPct, 2)}
          tone={Number.isFinite(calc.evPct) ? (calc.evPct >= 0 ? "text-emerald-400" : "text-red-400") : "text-[#404040]"}
        />
      </div>
    </Card>
  );
}

function EvCalc() {
  const [oddsFormat, setOddsFormat] = useState<OddsFormat>("american");
  const [odds, setOdds] = useState<string>("-110");
  const [trueWinPct, setTrueWinPct] = useState<string>("55");

  const out = useMemo(() => {
    const p = clampNumber(safeNumber(trueWinPct, NaN) / 100, 0, 1);
    const dec = oddsFormat === "american" ? americanToDecimal(safeNumber(odds, NaN)) : safeNumber(odds, NaN);
    const ev = evPercentFromDecimal(p, dec);
    const imp = impliedProbFromDecimal(dec) * 100;
    return { dec, evPct: ev, impliedPct: imp };
  }, [oddsFormat, odds, trueWinPct]);

  return (
    <Card title="Expected Value (EV%)" subtitle="EV% based on your true win probability and the offered odds.">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="True Win %">
          <Input value={trueWinPct} onChange={setTrueWinPct} placeholder="55" />
        </Field>

        <Field label="Odds Format">
          <Select
            value={oddsFormat}
            onChange={(v) => setOddsFormat(v as OddsFormat)}
            options={[
              { value: "american", label: "American" },
              { value: "decimal", label: "Decimal" },
            ]}
          />
        </Field>

        <Field label={oddsFormat === "american" ? "American Odds" : "Decimal Odds"}>
          <Input value={odds} onChange={setOdds} placeholder={oddsFormat === "american" ? "-110" : "1.91"} />
        </Field>
      </div>

      <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
        <StatBox label="Decimal Odds" value={formatDecimal(out.dec)} />
        <StatBox label="Implied %" value={formatPercent(out.impliedPct, 2)} tone="text-[#9a9a9a]" />
        <StatBox
          label="EV%"
          value={formatPercent(out.evPct, 2)}
          tone={Number.isFinite(out.evPct) ? (out.evPct >= 0 ? "text-emerald-400" : "text-red-400") : "text-[#404040]"}
          sub="Per $1 stake"
        />
      </div>

      <div className="mt-3 text-[11px] text-[#808080]">
        Formula: EV = p*(dec−1) − (1−p). Convert American → Decimal first.
      </div>
    </Card>
  );
}

function ParlayCalc() {
  const [stake, setStake] = useState<string>("25");
  const [format, setFormat] = useState<OddsFormat>("american");

  // up to 6 legs (easy to extend)
  const [legs, setLegs] = useState<string[]>(["-110", "-110"]);

  const addLeg = () => setLegs((prev) => (prev.length >= 10 ? prev : [...prev, "-110"]));
  const removeLeg = (idx: number) => setLegs((prev) => prev.filter((_, i) => i !== idx));
  const updateLeg = (idx: number, v: string) => setLegs((prev) => prev.map((x, i) => (i === idx ? v : x)));

  const out = useMemo(() => {
    const s = safeNumber(stake, NaN);
    const decimals = legs
      .map((x) => safeNumber(x, NaN))
      .map((o) => (format === "american" ? americanToDecimal(o) : o))
      .filter((d) => Number.isFinite(d) && d > 1);

    const validCount = decimals.length;

    const parlayDec = decimals.reduce((acc, d) => acc * d, 1);
    const parlayAm = decimalToAmerican(parlayDec);

    const payout = payoutFromStakeDecimal(s, parlayDec);
    const profit = profitFromStakeDecimal(s, parlayDec);

    // implied parlay prob (vigged) from decimal
    const imp = impliedProbFromDecimal(parlayDec) * 100;

    return { validCount, parlayDec, parlayAm, payout, profit, impliedPct: imp };
  }, [stake, format, legs]);

  return (
    <Card title="Parlay Calculator" subtitle="Enter legs and compute parlay odds + payout.">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Stake ($)">
          <Input value={stake} onChange={setStake} placeholder="25" />
        </Field>

        <Field label="Leg Odds Format">
          <Select
            value={format}
            onChange={(v) => setFormat(v as OddsFormat)}
            options={[
              { value: "american", label: "American" },
              { value: "decimal", label: "Decimal" },
            ]}
          />
        </Field>

        <Field label="Legs" hint="Add up to 10 legs">
          <div className="flex items-center gap-2">
            <div className="text-[12px] text-white">{legs.length} legs</div>
            <button
              type="button"
              onClick={addLeg}
              className="ml-auto rounded-lg border border-[#2a2a2a] bg-black/40 px-3 py-2 text-[12px] text-white hover:bg-[#111]"
            >
              + Add Leg
            </button>
          </div>
        </Field>
      </div>

      <div className="mt-3 space-y-2">
        {legs.map((v, idx) => (
          <div key={idx} className="grid grid-cols-[1fr_auto] gap-2 items-center">
            <Input
              value={v}
              onChange={(x) => updateLeg(idx, x)}
              placeholder={format === "american" ? "-110" : "1.91"}
            />
            <button
              type="button"
              onClick={() => removeLeg(idx)}
              className="rounded-lg border border-[#2a2a2a] bg-black/40 px-3 py-2 text-[12px] text-[#b0b0b0] hover:text-white hover:bg-[#111]"
              title="Remove leg"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-2">
        <StatBox label="Valid Legs" value={String(out.validCount)} />
        <StatBox label="Parlay (Decimal)" value={formatDecimal(out.parlayDec)} />
        <StatBox label="Parlay (American)" value={formatAmerican(out.parlayAm)} />
        <StatBox label="Implied %" value={formatPercent(out.impliedPct, 2)} tone="text-[#9a9a9a]" />
      </div>

      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
        <StatBox label="Total Payout" value={formatMoney(out.payout, 2)} tone="text-white" />
        <StatBox label="Profit" value={formatMoney(out.profit, 2)} tone="text-emerald-400" />
      </div>
    </Card>
  );
}

function HedgeCalc() {
  // Current position
  const [formatA, setFormatA] = useState<OddsFormat>("american");
  const [oddsA, setOddsA] = useState<string>("-110");
  const [stakeA, setStakeA] = useState<string>("100");

  // Hedge side
  const [formatB, setFormatB] = useState<OddsFormat>("american");
  const [oddsB, setOddsB] = useState<string>("-110");

  // Mode: lock profit or free-roll / equalize
  const [mode, setMode] = useState<"equalize" | "targetProfit">("equalize");
  const [targetProfit, setTargetProfit] = useState<string>("10");

  const out = useMemo(() => {
    const sA = safeNumber(stakeA, NaN);
    const decA = formatA === "american" ? americanToDecimal(safeNumber(oddsA, NaN)) : safeNumber(oddsA, NaN);
    const decB = formatB === "american" ? americanToDecimal(safeNumber(oddsB, NaN)) : safeNumber(oddsB, NaN);

    // If A wins: profitA = sA*(decA-1) - hedgeStake
    // If B wins: profitB = hedgeStake*(decB-1) - sA
    //
    // equalize => profitA = profitB => solve for hedgeStake
    // sA*(decA-1) - h = h*(decB-1) - sA
    // sA*decA - sA - h = h*decB - h - sA
    // sA*decA - sA - h = h*decB - h - sA  => sA*decA - h = h*decB
    // h = (sA*decA) / decB
    //
    // targetProfit => set min(profitA,profitB) = target; solve h for both constraints.
    // We'll compute the hedge that ensures profitB = target (B wins) then check profitA.
    // profitB = h*(decB-1) - sA = target => h = (target + sA) / (decB-1)
    // profitA = sA*(decA-1) - h

    if (!Number.isFinite(sA) || !Number.isFinite(decA) || decA <= 1 || !Number.isFinite(decB) || decB <= 1) {
      return {
        hedgeStake: NaN,
        profitIfA: NaN,
        profitIfB: NaN,
      };
    }

    let h = NaN;

    if (mode === "equalize") {
      h = (sA * decA) / decB;
    } else {
      const t = safeNumber(targetProfit, NaN);
      const denom = decB - 1;
      h = denom > 0 ? (t + sA) / denom : NaN;
    }

    const profitIfA = sA * (decA - 1) - h;
    const profitIfB = h * (decB - 1) - sA;

    return { hedgeStake: h, profitIfA, profitIfB };
  }, [formatA, oddsA, stakeA, formatB, oddsB, mode, targetProfit]);

  const toneA =
    Number.isFinite(out.profitIfA) ? (out.profitIfA >= 0 ? "text-emerald-400" : "text-red-400") : "text-[#404040]";
  const toneB =
    Number.isFinite(out.profitIfB) ? (out.profitIfB >= 0 ? "text-emerald-400" : "text-red-400") : "text-[#404040]";

  return (
    <Card title="Hedge Calculator" subtitle="Compute hedge stake and outcomes (profit if either side wins).">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="rounded-xl border border-[#1f1f1f] bg-[#0a0a0a] p-3">
          <div className="text-[12px] text-white font-semibold">Position A (Current Bet)</div>
          <div className="mt-3 space-y-2">
            <Field label="Odds Format">
              <Select
                value={formatA}
                onChange={(v) => setFormatA(v as OddsFormat)}
                options={[
                  { value: "american", label: "American" },
                  { value: "decimal", label: "Decimal" },
                ]}
              />
            </Field>
            <Field label={formatA === "american" ? "American Odds" : "Decimal Odds"}>
              <Input value={oddsA} onChange={setOddsA} placeholder={formatA === "american" ? "-110" : "1.91"} />
            </Field>
            <Field label="Stake ($)">
              <Input value={stakeA} onChange={setStakeA} placeholder="100" />
            </Field>
          </div>
        </div>

        <div className="rounded-xl border border-[#1f1f1f] bg-[#0a0a0a] p-3">
          <div className="text-[12px] text-white font-semibold">Hedge Side (B)</div>
          <div className="mt-3 space-y-2">
            <Field label="Odds Format">
              <Select
                value={formatB}
                onChange={(v) => setFormatB(v as OddsFormat)}
                options={[
                  { value: "american", label: "American" },
                  { value: "decimal", label: "Decimal" },
                ]}
              />
            </Field>
            <Field label={formatB === "american" ? "American Odds" : "Decimal Odds"}>
              <Input value={oddsB} onChange={setOddsB} placeholder={formatB === "american" ? "+105" : "2.05"} />
            </Field>
          </div>
        </div>

        <div className="rounded-xl border border-[#1f1f1f] bg-[#0a0a0a] p-3">
          <div className="text-[12px] text-white font-semibold">Hedge Mode</div>
          <div className="mt-3 space-y-2">
            <Field label="Mode">
              <Select
                value={mode}
                onChange={(v) => setMode(v as any)}
                options={[
                  { value: "equalize", label: "Equalize profit (same either way)" },
                  { value: "targetProfit", label: "Target profit if B wins" },
                ]}
              />
            </Field>
            {mode === "targetProfit" ? (
              <Field label="Target Profit ($)" hint="When B wins">
                <Input value={targetProfit} onChange={setTargetProfit} placeholder="10" />
              </Field>
            ) : (
              <div className="text-[11px] text-[#808080]">
                Equalize uses both decimal prices to set a hedge that makes profits match.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-2">
        <StatBox label="Recommended Hedge Stake (B)" value={formatMoney(out.hedgeStake, 2)} tone="text-[#d4af37]" />
        <StatBox label="Profit if A wins" value={formatMoney(out.profitIfA, 2)} tone={toneA} />
        <StatBox label="Profit if B wins" value={formatMoney(out.profitIfB, 2)} tone={toneB} />
      </div>

      <div className="mt-3 text-[11px] text-[#808080]">
        Note: assumes two-outcome market (A vs B). For props/splits, treat each side as the hedge outcome.
      </div>
    </Card>
  );
}

/** Also export default for safer routing imports */
export default CalculatorScreen;
