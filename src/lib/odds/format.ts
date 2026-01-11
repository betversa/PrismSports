import { americanToDecimal } from "./math";

export function formatAmerican(odds: number) {
  if (!Number.isFinite(odds)) return "—";
  const o = Math.round(odds);
  return o > 0 ? `+${o}` : `${o}`;
}

export function formatDecimal(dec: number) {
  if (!Number.isFinite(dec)) return "—";
  return dec.toFixed(3);
}

export function formatMoney(value: number, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

export function formatPercent(value: number, digits = 1) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function formatOddsPrice(odds: number | null, fmt: "american" | "decimal") {
  if (odds == null) return "—";
  if (fmt === "american") return String(odds);
  const dec = americanToDecimal(odds);
  if (!Number.isFinite(dec)) return "—";
  return dec.toFixed(2);
}

export function formatSignedNumber(value: number | null, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "—";
  const v = Math.round(value * 10) / 10;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
}

export function formatLinePlain(value: number | null, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "—";
  const v = Math.round(value * 10) / 10;
  return v.toFixed(digits);
}

export function formatOuLine(value: number | null, kind: "o" | "u") {
  if (value == null || !Number.isFinite(value)) return "—";
  const v = Math.round(value * 10) / 10;
  return `${kind}${v.toFixed(1)}`;
}

export function formatMaybeNumber(value: any, digits = 2) {
  const x = Number(value);
  if (!Number.isFinite(x)) return "—";
  return x.toFixed(digits);
}

export function formatMaybeInt(value: any) {
  const x = Number(value);
  if (!Number.isFinite(x)) return "—";
  return String(Math.round(x));
}

export function formatOddsLine(value?: number | null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n > 0 ? `+${n}` : `${n}`;
}

export function formatOddsShort(value?: number | null) {
  if (value == null) return "—";
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n === 0) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}
