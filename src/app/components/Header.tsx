// components/Header.tsx — FULL REWRITE (Prism Edge Glow)
// ---------------------------------------------------------------------------------------------------
// ✅ Black-first header (no background gradients)
// ✅ Thin prism edge-glow lines (top + bottom)
// ✅ Subtle outer glow bleed for premium feel
// ✅ Full-width tagline underline (desktop + mobile)
// ✅ Clicking logo returns to Overview
// ✅ Mobile-safe, desktop-clean

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Menu, ChevronDown } from "lucide-react";
import type { SportKey } from "../App";

type Screen =
  | "overview"
  | "model"
  | "monte-carlo"
  | "odds"
  | "results"
  | "calibration"
  | "settings";

type HeaderProps = {
  onOpenMenu?: () => void;
  onNavigate?: (screen: Screen) => void;
  activeScreen?: Screen;
  onHeightChange?: (px: number) => void;

  oddsSportKey: SportKey;
  onPickOddsSport: (k: SportKey) => void;

  predSportKey: SportKey;
  onPickPredSport: (k: SportKey) => void;
};

type UiSport = "NCAAB" | "NBA" | "NCAAF" | "NFL" | "NHL" | "MLB";
const SPORTS: UiSport[] = ["NCAAB", "NBA", "NCAAF", "NFL", "NHL", "MLB"];

const GOLD = "#d4af37";
const DROPDOWN_EVENT = "prism:header-dropdown-open";
const DROPDOWN_CLOSE_DELAY_MS = 240;

const TAGLINE = "Sports Models · Projections · Analysis";

/** =========================
 * SPORT MAPPING
 * ========================= */
function uiToDbSport(s: UiSport): SportKey {
  switch (s) {
    case "NCAAB":
      return "basketball_ncaab";
    case "NBA":
      return "basketball_nba";
    case "NCAAF":
      return "football_ncaaf";
    case "NFL":
      return "football_nfl";
    case "NHL":
      return "icehockey_nhl";
    case "MLB":
      return "baseball_mlb";
  }
}

function isEnabled(db: SportKey) {
  return db === "basketball_ncaab" || db === "basketball_nba";
}

function useOutsideClick(ref: React.RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ref, onClose]);
}

/* =========================
   NAV ITEMS
========================= */
function NavItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "relative px-1 py-1 text-[14px] md:text-[15px] font-medium",
        active ? "text-white" : "text-[#cfcfcf] hover:text-white",
      ].join(" ")}
    >
      {label}
      <span
        className="absolute left-0 -bottom-2 h-[2px] w-full rounded"
        style={{ backgroundColor: GOLD, opacity: active ? 1 : 0 }}
      />
    </button>
  );
}

/* =========================
   DROPDOWN
========================= */
function HoverDropdown({
  label,
  active,
  suffix,
  selectedDbSport,
  onPickDbSport,
}: {
  label: "Odds" | "Predictions";
  active?: boolean;
  suffix: "Odds" | "Predictions";
  selectedDbSport: SportKey;
  onPickDbSport: (sportKey: SportKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useOutsideClick(wrapRef, () => setOpen(false));

  const idRef = useRef(`${label}-${Math.random().toString(16).slice(2)}`);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        className={[
          "relative flex items-center gap-1 px-1 py-1",
          "text-[14px] md:text-[15px] font-medium transition-colors",
          active ? "text-white" : "text-[#cfcfcf] hover:text-white",
        ].join(" ")}
      >
        {label}
        <ChevronDown className="w-4 h-4 opacity-70" />
        <span
          className="absolute left-0 -bottom-2 h-[2px] w-full rounded"
          style={{ backgroundColor: GOLD, opacity: active ? 1 : 0 }}
        />
      </button>

      {open && (
        <div className="absolute left-0 mt-3 w-[280px] rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] shadow-2xl z-50">
          {SPORTS.map((ui) => {
            const db = uiToDbSport(ui);
            const enabled = isEnabled(db);
            const selected = selectedDbSport === db;

            return (
              <button
                key={ui}
                disabled={!enabled}
                onClick={() => {
                  if (!enabled) return;
                  onPickDbSport(db);
                  setOpen(false);
                }}
                className={[
                  "w-full px-4 py-3 flex justify-between text-left border-b border-[#141414]",
                  enabled ? "text-white hover:bg-[#141414]" : "text-[#6f6f6f]",
                  selected ? "bg-[#141414]" : "",
                ].join(" ")}
              >
                {ui} {suffix}
                {!enabled && (
                  <span className="text-[11px] font-semibold" style={{ color: GOLD }}>
                    COMING SOON
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* =========================
   HEADER
========================= */
export function Header({
  onOpenMenu,
  onNavigate,
  activeScreen,
  onHeightChange,

  oddsSportKey,
  onPickOddsSport,
  predSportKey,
  onPickPredSport,
}: HeaderProps) {
  const headerRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (!headerRef.current || !onHeightChange) return;
    const report = () => onHeightChange(headerRef.current!.offsetHeight);
    report();
    window.addEventListener("resize", report);
    return () => window.removeEventListener("resize", report);
  }, [onHeightChange]);

  return (
    <header
      ref={headerRef}
      className="fixed top-0 left-0 right-0 z-50 bg-black border-b border-[#1f1f1f]"
    >
      {/* PRISM EDGE GLOW */}
      <div className="pointer-events-none absolute inset-0">
        {/* top glow */}
        <div
          className="absolute top-0 left-0 right-0 h-[2px]"
          style={{
            background:
              "linear-gradient(90deg, rgba(0,0,0,0), rgba(0,146,255,0.45), rgba(0,200,120,0.45), rgba(212,175,55,0.55), rgba(255,140,0,0.45), rgba(255,60,60,0.40), rgba(170,70,255,0.40), rgba(0,0,0,0))",
          }}
        />

        {/* subtle bleed */}
        <div
          className="absolute top-0 left-0 right-0 h-6 opacity-30 blur-xl"
          style={{
            background:
              "linear-gradient(90deg, rgba(0,146,255,0.25), rgba(212,175,55,0.35), rgba(170,70,255,0.25))",
          }}
        />

        {/* bottom gold anchor */}
        <div
          className="absolute bottom-0 left-0 right-0 h-[1px]"
          style={{
            background:
              "linear-gradient(90deg, rgba(212,175,55,0), rgba(212,175,55,0.55), rgba(212,175,55,0))",
          }}
        />
      </div>

      <div className="relative px-3 md:px-6 pt-3 pb-2 flex justify-between">
        <div className="flex gap-3 items-start min-w-0">
          <button
            onClick={onOpenMenu}
            className="md:hidden mt-1.5 p-2 border border-[#2a2a2a] rounded text-[#cfcfcf]"
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex flex-col gap-2 min-w-0">
            <div className="flex gap-3 items-center min-w-0">
              <button onClick={() => onNavigate?.("overview")}>
                <img
                  src="/logos/mainlogo.png"
                  alt="PrismSports"
                  className="h-14 sm:h-16 md:h-20 w-auto"
                />
              </button>

              <div className="flex-1 min-w-0">
                <div className="text-[#9a9a9a] text-[12px] font-medium truncate">
                  {TAGLINE}
                </div>

                {/* FULL-WIDTH underline */}
                <div
                  className="mt-1 h-[2px] w-full rounded-full"
                  style={{
                    background:
                      "linear-gradient(90deg, rgba(0,146,255,0.5), rgba(0,200,120,0.5), rgba(212,175,55,0.7), rgba(255,140,0,0.5), rgba(170,70,255,0.5))",
                  }}
                />
              </div>
            </div>

            <nav className="hidden md:flex gap-7 pt-1">
              <HoverDropdown
                label="Odds"
                suffix="Odds"
                active={activeScreen === "odds"}
                selectedDbSport={oddsSportKey}
                onPickDbSport={(k) => {
                  onPickOddsSport(k);
                  onNavigate?.("odds");
                }}
              />
              <HoverDropdown
                label="Predictions"
                suffix="Predictions"
                active={activeScreen === "monte-carlo"}
                selectedDbSport={predSportKey}
                onPickDbSport={(k) => {
                  onPickPredSport(k);
                  onNavigate?.("monte-carlo");
                }}
              />
              <NavItem label="Picks" active={activeScreen === "model"} onClick={() => onNavigate?.("model")} />
              <NavItem label="Results" active={activeScreen === "results"} onClick={() => onNavigate?.("results")} />
              <NavItem label="Settings" active={activeScreen === "settings"} onClick={() => onNavigate?.("settings")} />
            </nav>
          </div>
        </div>
      </div>
    </header>
  );
}

