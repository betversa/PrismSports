// components/Header.tsx — FULL REWRITE (PRISM LOGO THEME: Black + Gold + Slate) + Parlay tab
// ---------------------------------------------------------------------------------------------------
// ✅ Theme matches provided Prism logo (black/gold/slate) — removes rainbow prism gradients
// ✅ Fix retained: first dropdown item no longer “pre-highlighted”
//    - No selected-row background
//    - Subtle gold dot for selected instead
// ✅ Desktop nav centered; logo bigger (md:h-24)
// ✅ Clicking logo -> Overview
// ✅ Logo path: /logos/Logo.png (you currently use /logos/mainlogo.png — kept as-is)
// ✅ NEW: Adds "Parlay" section to nav
// ✅ Everything else unchanged (API + behavior)

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Menu, ChevronDown } from "lucide-react";
import type { SportKey } from "../App";

type Screen =
  | "overview"
  | "model"
  | "parlay"
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

/** =========================
 * THEME (from logo palette)
 * ========================= */
const GOLD = "#d89211";
const GOLD_SOFT = "rgba(216, 146, 17, 0.18)";
const GOLD_GLOW = "rgba(216, 146, 17, 0.32)";
const SLATE = "#575a62";
const PANEL = "#0b0b0b";
const PANEL_2 = "#101010";
const BORDER = "#2a2a2a";

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
        "relative px-1 py-1 text-[14px] md:text-[15px] font-medium tracking-normal",
        "transition-colors",
        active ? "text-white" : "text-[#cfcfcf] hover:text-white",
      ].join(" ")}
    >
      {label}
      <span
        className="absolute left-0 -bottom-2 h-[2px] w-full rounded"
        style={{
          background:
            "linear-gradient(90deg, rgba(216,146,17,0.0), rgba(216,146,17,0.95), rgba(216,146,17,0.0))",
          opacity: active ? 1 : 0,
        }}
      />
    </button>
  );
}

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

  const idRef = useRef<string>(`${label}-${Math.random().toString(16).slice(2)}`);

  const closeTimer = useRef<number | null>(null);
  const clearTimer = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const closeNow = () => {
    clearTimer();
    setOpen(false);
  };

  const scheduleClose = () => {
    clearTimer();
    closeTimer.current = window.setTimeout(() => setOpen(false), DROPDOWN_CLOSE_DELAY_MS);
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ id: string }>;
      const openedId = ev?.detail?.id;
      if (!openedId) return;
      if (openedId !== idRef.current) closeNow();
    };
    window.addEventListener(DROPDOWN_EVENT, handler as EventListener);
    return () => window.removeEventListener(DROPDOWN_EVENT, handler as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNow = () => {
    clearTimer();
    window.dispatchEvent(new CustomEvent(DROPDOWN_EVENT, { detail: { id: idRef.current } }));
    setOpen(true);
  };

  return (
    <div ref={wrapRef} className="relative" onMouseEnter={openNow} onMouseLeave={scheduleClose}>
      <button
        type="button"
        className={[
          "relative flex items-center gap-1 px-1 py-1",
          "text-[14px] md:text-[15px] font-medium tracking-normal transition-colors",
          active ? "text-white" : "text-[#cfcfcf] hover:text-white",
        ].join(" ")}
        onMouseEnter={openNow}
        onClick={() => {
          window.dispatchEvent(new CustomEvent(DROPDOWN_EVENT, { detail: { id: idRef.current } }));
          setOpen((v) => !v);
        }}
      >
        {label}
        <ChevronDown className="w-4 h-4 opacity-70" />
        <span
          className="absolute left-0 -bottom-2 h-[2px] w-full rounded"
          style={{
            background:
              "linear-gradient(90deg, rgba(216,146,17,0.0), rgba(216,146,17,0.95), rgba(216,146,17,0.0))",
            opacity: active ? 1 : 0,
          }}
        />
      </button>

      {open && (
        <div
          className="absolute left-0 mt-3 w-[280px] rounded-xl border shadow-2xl overflow-hidden z-50"
          style={{
            borderColor: BORDER,
            background: PANEL,
          }}
          onMouseEnter={openNow}
          onMouseLeave={scheduleClose}
        >
          <div
            className="pointer-events-none absolute inset-0 z-0"
            style={{
              background: [
                `radial-gradient(520px 220px at 14% 0%, ${GOLD_GLOW}, transparent 62%)`,
                `radial-gradient(560px 260px at 72% -10%, rgba(87,90,98,0.28), transparent 64%)`,
                `radial-gradient(720px 340px at 70% 120%, rgba(0,0,0,0.75), transparent 62%)`,
                `linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02) 55%, rgba(0,0,0,0.0) 100%)`,
                `linear-gradient(180deg, rgba(0,0,0,0.22), rgba(0,0,0,0.64) 55%, rgba(0,0,0,0.86) 100%)`,
              ].join(", "),
            }}
          />

          <div
            className="pointer-events-none absolute left-0 right-0 top-0 h-[1px] opacity-80"
            style={{
              background:
                "linear-gradient(90deg, rgba(216,146,17,0.0), rgba(216,146,17,0.62), rgba(216,146,17,0.0))",
            }}
          />

          <div className="relative z-10">
            {SPORTS.map((ui) => {
              const db = uiToDbSport(ui);
              const enabled = isEnabled(db);
              const title = `${ui} ${suffix}`;
              const selected = selectedDbSport === db;

              return (
                <button
                  key={ui}
                  type="button"
                  disabled={!enabled}
                  onClick={() => {
                    if (!enabled) return;
                    onPickDbSport(db);
                    setOpen(false);
                  }}
                  className={[
                    "w-full text-left px-4 py-3 flex items-center justify-between",
                    "transition-colors border-b last:border-b-0",
                    enabled ? "text-white hover:bg-[#141414]" : "text-[#6f6f6f] cursor-not-allowed",
                  ].join(" ")}
                  style={{ borderBottomColor: "#141414" }}
                >
                  <span className="text-[14px] font-medium leading-tight">{title}</span>

                  {!enabled ? (
                    <span className="font-semibold text-[11px]" style={{ color: GOLD }}>
                      COMING SOON
                    </span>
                  ) : selected ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="text-[11px] text-[#8a8a8a] hidden sm:inline">Selected</span>
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{
                          backgroundColor: GOLD,
                          boxShadow: `0 0 0 2px rgba(216,146,17,0.18), 0 0 18px rgba(216,146,17,0.18)`,
                        }}
                        aria-label="Selected"
                      />
                    </span>
                  ) : (
                    <span className="w-2 h-2" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

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
    const el = headerRef.current;

    const report = () => onHeightChange(Math.ceil(el.getBoundingClientRect().height));
    report();

    const ro = new ResizeObserver(() => report());
    ro.observe(el);
    window.addEventListener("resize", report);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [onHeightChange]);

  return (
    <header
      ref={headerRef}
      className="fixed top-0 left-0 right-0 z-50 border-b"
      style={{
        borderColor: BORDER,
        background: PANEL,
      }}
    >
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0"
          style={{
            background: [
              `radial-gradient(900px 340px at 22% 0%, ${GOLD_GLOW}, transparent 62%)`,
              `radial-gradient(980px 360px at 70% -20%, rgba(87,90,98,0.24), transparent 66%)`,
              `linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.018) 55%, rgba(0,0,0,0.0) 100%)`,
              `linear-gradient(180deg, rgba(0,0,0,0.28), rgba(0,0,0,0.64) 52%, rgba(0,0,0,0.86) 100%)`,
            ].join(", "),
          }}
        />

        <div
          className="absolute left-0 right-0 top-0 h-[1px] opacity-70"
          style={{
            background:
              "linear-gradient(90deg, rgba(0,0,0,0), rgba(216,146,17,0.42), rgba(0,0,0,0))",
          }}
        />

        <div
          className="absolute left-0 right-0 bottom-0 h-[1px] opacity-75"
          style={{
            background:
              "linear-gradient(90deg, rgba(216,146,17,0.0), rgba(216,146,17,0.55), rgba(216,146,17,0.0))",
          }}
        />
      </div>

      <div className="relative w-full px-3 md:px-6 pt-2 md:pt-2 pb-2 md:pb-1">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] items-center gap-2">
          {/* LEFT */}
          <div className="flex items-start min-w-0">
            <button
              onClick={onOpenMenu}
              className="md:hidden mt-1.5 p-2 rounded border text-[#cfcfcf] hover:border-[#3a3a3a] mr-3"
              style={{ borderColor: BORDER, background: "rgba(255,255,255,0.02)" }}
              aria-label="Open menu"
              type="button"
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="flex flex-col items-start gap-2 min-w-0">
              <div className="flex items-center gap-3 min-w-0 w-full">
                <button
                  type="button"
                  onClick={() => onNavigate?.("overview")}
                  className="group flex items-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
                  style={{ outlineColor: GOLD }}
                  aria-label="Go to Overview"
                >
                  <img
                    src="/logos/mainlogo.png"
                    alt="PrismSports"
                    className={[
                      "h-16 sm:h-20 md:h-24 w-auto object-contain select-none flex-shrink-0",
                      "transition-transform duration-200 group-hover:scale-[1.01]",
                      "drop-shadow-[0_10px_26px_rgba(0,0,0,0.55)]",
                    ].join(" ")}
                    draggable={false}
                  />
                </button>

                <div className="flex-1 min-w-0 w-full">
                  <div className="inline-block w-fit max-w-full">
                    <div
                      className={[
                        "font-medium tracking-wide leading-snug",
                        "text-[11px] sm:text-[12px] md:text-[12px]",
                        "truncate",
                      ].join(" ")}
                      style={{ color: "rgba(242,241,243,0.62)" }}
                      title={TAGLINE}
                    >
                      {TAGLINE}
                    </div>

                    <span
                      className="block mt-1 h-[2px] w-full rounded-full opacity-70 md:opacity-55"
                      style={{
                        background:
                          "linear-gradient(90deg, rgba(216,146,17,0.0), rgba(216,146,17,0.90), rgba(216,146,17,0.0))",
                        boxShadow: `0 0 18px ${GOLD_SOFT}`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* CENTER */}
          <div className="hidden md:flex justify-center">
            <nav className="flex items-center gap-7 pb-1 pt-0.5">
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

              <div className="h-5 w-px" style={{ background: "#2a2a2a" }} />

              <NavItem label="Picks" active={activeScreen === "model"} onClick={() => onNavigate?.("model")} />
              <NavItem label="Parlay" active={activeScreen === "parlay"} onClick={() => onNavigate?.("parlay")} />
              <NavItem label="Results" active={activeScreen === "results"} onClick={() => onNavigate?.("results")} />
              <NavItem label="Settings" active={activeScreen === "settings"} onClick={() => onNavigate?.("settings")} />
            </nav>
          </div>

          {/* RIGHT */}
          <div className="hidden md:flex items-center justify-end">
            <div
              className="flex items-center gap-2 rounded-full border px-3 py-1"
              style={{
                borderColor: BORDER,
                background: "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015))",
              }}
            >
              <div className="text-[12px] font-medium" style={{ color: "rgba(242,241,243,0.55)" }}>
                Live
              </div>
              <div
                className="w-2 h-2 rounded-full"
                title="Live"
                style={{
                  background: "rgba(34,197,94,0.95)",
                  boxShadow: "0 0 0 2px rgba(34,197,94,0.14)",
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

