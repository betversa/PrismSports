import assert from "node:assert/strict";
import {
  americanToDecimal,
  decimalToAmerican,
  evPercentFromDecimal,
  impliedProbFromAmerican,
  impliedProbFromDecimal,
  kellyFraction,
  median,
  probToAmerican,
  toProb01,
} from "../src/lib/odds/math";
import { formatAmerican } from "../src/lib/odds/format";

const legacyAmericanToDecimal = (odds: number) => {
  if (!Number.isFinite(odds) || odds === 0) return NaN;
  if (odds > 0) return 1 + odds / 100;
  return 1 + 100 / Math.abs(odds);
};

const legacyDecimalToAmerican = (dec: number) => {
  if (!Number.isFinite(dec) || dec <= 1) return NaN;
  const profit = dec - 1;
  if (profit >= 1) return Math.round(profit * 100);
  return -Math.round(100 / profit);
};

const legacyImpliedProbFromAmerican = (odds: number) => {
  if (!Number.isFinite(odds) || odds === 0) return NaN;
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
};

const legacyImpliedProbFromDecimal = (dec: number) => {
  if (!Number.isFinite(dec) || dec <= 1) return NaN;
  return 1 / dec;
};

const legacyEvPercentFromDecimal = (trueProb: number, dec: number) => {
  if (!Number.isFinite(trueProb) || !Number.isFinite(dec) || dec <= 1) return NaN;
  const p = Math.max(0, Math.min(1, trueProb));
  const ev = p * (dec - 1) - (1 - p);
  return ev * 100;
};

const legacyKellyFraction = (trueProb: number, dec: number) => {
  if (!Number.isFinite(trueProb) || !Number.isFinite(dec) || dec <= 1) return NaN;
  const p = Math.max(0, Math.min(1, trueProb));
  const q = 1 - p;
  const b = dec - 1;
  return (b * p - q) / b;
};

const legacyMedian = (values: number[]) => {
  const a = values.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

const legacyProbToAmerican = (prob: number | null) => {
  if (prob == null || prob <= 0 || prob >= 1) return "—";
  if (prob >= 0.5) {
    const a = -Math.round((prob / (1 - prob)) * 100);
    return String(a);
  }
  const a = Math.round(((1 - prob) / prob) * 100);
  return `+${a}`;
};

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

const oddsCases = [-220, -110, -101, 100, 135, 240];
for (const odds of oddsCases) {
  assert.ok(close(americanToDecimal(odds), legacyAmericanToDecimal(odds)));
  assert.ok(close(impliedProbFromAmerican(odds), legacyImpliedProbFromAmerican(odds)));
}

const decimalCases = [1.5, 1.91, 2.0, 2.4, 3.2];
for (const dec of decimalCases) {
  assert.ok(close(decimalToAmerican(dec), legacyDecimalToAmerican(dec)));
  assert.ok(close(impliedProbFromDecimal(dec), legacyImpliedProbFromDecimal(dec)));
}

const samplePlays = [
  { trueProb: 0.53, odds: -110 },
  { trueProb: 0.61, odds: -145 },
  { trueProb: 0.47, odds: 140 },
  { trueProb: 0.58, odds: 105 },
];

for (const play of samplePlays) {
  const dec = americanToDecimal(play.odds);
  assert.ok(close(evPercentFromDecimal(play.trueProb, dec), legacyEvPercentFromDecimal(play.trueProb, dec)));
  assert.ok(close(kellyFraction(play.trueProb, dec), legacyKellyFraction(play.trueProb, dec)));
}

const medianCases = [
  [101, 105, 98, 102],
  [1.5, 1.7, 1.6],
  [null, NaN, 12, 18, 16].filter((n) => typeof n === "number") as number[],
];

for (const values of medianCases) {
  assert.strictEqual(median(values), legacyMedian(values));
}

const probCases = [0.39, 0.5, 0.61, 0.75];
for (const prob of probCases) {
  assert.strictEqual(probToAmerican(prob), legacyProbToAmerican(prob));
}

const normalized = toProb01(62);
assert.ok(close(normalized ?? 0, 0.62));
assert.strictEqual(formatAmerican(110), "+110");

console.log("Math parity checks passed.");
