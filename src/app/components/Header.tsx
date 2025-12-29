// components/Header.tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Menu, ChevronDown } from "lucide-react";
import type { SportKey } from "../App"; // <-- adjust if your path differs (e.g. "../../App")

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

  // ✅ drive sport selection from App.tsx
  oddsSportKey: SportKey;
  onPickOddsSport: (k: SportKey) => void;

  predSportKey: SportKey;
  onPickPredSport: (k: SportKey) => void;
};

type UiSport = "NCAAB" | "NBA" | "NCAAF" | "NFL" | "NHL" | "MLB";
const SPORTS: UiSport[] = ["NCAAB", "NBA", "NCAAF", "NFL", "NHL", "MLB"];

/**
 * Prism palette tuned to the logo spectrum.
 * (Keep GOLD for underline + selected accents, but add the full rainbow glow for backgrounds.)
 */
const GOLD = "#d4af37";

// Spectrum accents (approx logo hues)
const PRISM_BLUE = "rgba(  0, 146, 255, 0.18)";
const PRISM_TEAL = "rgba(  0, 201, 255, 0.14)";
const PRISM_GREEN = "rgba(  0, 200, 120, 0.16)";
const PRISM_GOLD = "rgba(212, 175,  55, 0.18)";
const PRISM_ORANGE = "rgba(255, 140,   0, 0.16)";
const PRISM_RED = "rgba(255,  60,  60, 0.14)";
const PRISM_VIOLET = "rgba(170,  70, 255, 0.14)";

const DROPDOWN_EVENT = "prism:header-dropdown-open";
const DROPDOWN_CLOSE_DELAY_MS = 240;

// ✅ simple, distinct from dratings
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

/** Enable only what you have live */
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
        style={{ backgroundColor: GOLD, opacity: active ? 1 : 0 }}
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
          style={{ backgroundColor: GOLD, opacity: active ? 1 : 0 }}
        />
      </button>

      {open && (
        <div
          className="absolute left-0 mt-3 w-[280px] rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] shadow-2xl overflow-hidden z-50"
          onMouseEnter={openNow}
          onMouseLeave={scheduleClose}
        >
          {/* Prism-spectrum background wash */}
          <div
            className="pointer-events-none absolute inset-0 opacity-90"
            style={{
              background: [
                // top glow bands (spectrum)
                `radial-gradient(620px 170px at 12% 0%, ${PRISM_BLUE}, transparent 58%)`,
                `radial-gradient(520px 160px at 32% 0%, ${PRISM_TEAL}, transparent 62%)`,
                `radial-gradient(560px 180px at 50% 0%, ${PRISM_GREEN}, transparent 60%)`,
                `radial-gradient(560px 180px at 66% 0%, ${PRISM_GOLD}, transparent 62%)`,
                `radial-gradient(620px 190px at 82% 0%, ${PRISM_ORANGE}, transparent 62%)`,
                // subtle corner warmth + violet depth
                `radial-gradient(520px 220px at 98% 35%, ${PRISM_RED}, transparent 60%)`,
                `radial-gradient(680px 260px at 70% 110%, ${PRISM_VIOLET}, transparent 58%)`,
                // faint sheen
                `linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.00) 55%)`,
              ].join(", "),
            }}
          />

          <div className="relative">
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
                    "transition-colors border-b border-[#141414] last:border-b-0",
                    enabled ? "text-white hover:bg-[#141414]" : "text-[#6f6f6f] cursor-not-allowed",
                    selected ? "bg-[#141414]" : "",
                  ].join(" ")}
                >
                  <span className="text-[14px] font-medium leading-tight">{title}</span>

                  {!enabled ? (
                    <span className="font-semibold text-[11px]" style={{ color: GOLD }}>
                      COMING SOON
                    </span>
                  ) : null}
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

  const oddsActive = activeScreen === "odds";
  const predsActive = activeScreen === "monte-carlo";

  return (
    <header
      ref={headerRef}
      className="fixed top-0 left-0 right-0 z-50 border-b border-[#2a2a2a] bg-[#0f0f0f]"
    >
      {/* Prism-spectrum header background */}
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0 opacity-90"
          style={{
            background: [
              // spectrum glow across the top edge
              `radial-gradient(900px 240px at 12% 0%, ${PRISM_BLUE}, transparent 62%)`,
              `radial-gradient(820px 240px at 30% 0%, ${PRISM_TEAL}, transparent 64%)`,
              `radial-gradient(880px 260px at 48% 0%, ${PRISM_GREEN}, transparent 62%)`,
              `radial-gradient(900px 260px at 62% 0%, ${PRISM_GOLD}, transparent 64%)`,
              `radial-gradient(920px 280px at 78% 0%, ${PRISM_ORANGE}, transparent 64%)`,
              `radial-gradient(860px 260px at 92% 10%, ${PRISM_RED}, transparent 66%)`,
              // violet depth from below (subtle)
              `radial-gradient(900px 340px at 60% 120%, ${PRISM_VIOLET}, transparent 58%)`,
              // soft glass sheen
              `linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.02) 55%, rgba(0,0,0,0) 100%)`,
            ].join(", "),
          }}
        />

        {/* Thin top highlight line (spectrum instead of only gold) */}
        <div
          className="absolute left-0 right-0 top-0 h-[1px]"
          style={{
            background:
              "linear-gradient(90deg, rgba(0,146,255,0.0), rgba(0,146,255,0.55), rgba(0,200,120,0.55), rgba(212,175,55,0.55), rgba(255,140,0,0.55), rgba(255,60,60,0.55), rgba(170,70,255,0.55), rgba(170,70,255,0.0))",
          }}
        />

        {/* Bottom “gold spine” kept (brand anchor) */}
        <div
          className="absolute left-0 right-0 bottom-0 h-[1px] opacity-70"
          style={{
            background:
              "linear-gradient(90deg, rgba(212,175,55,0.0), rgba(212,175,55,0.45), rgba(212,175,55,0.0))",
          }}
        />
      </div>

      <div className="relative w-full flex items-center justify-between px-3 md:px-6 pt-2.5 md:pt-3 pb-2">
        <div className="flex items-start min-w-0">
          <button
            onClick={onOpenMenu}
            className="md:hidden mt-1.5 p-2 rounded border border-[#2a2a2a] text-[#cfcfcf] hover:border-[#3a3a3a] mr-3"
            aria-label="Open menu"
            type="button"
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex flex-col items-start gap-2 min-w-0">
            {/* Brand row: logo + tagline */}
            <div className="flex items-center gap-3 min-w-0 w-full">
              {/* ✅ Clicking logo returns to Overview */}
              <button
                type="button"
                onClick={() => onNavigate?.("overview")}
                className="group flex items-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
                style={{ boxShadow: "0 0 0 rgba(0,0,0,0)" }}
                aria-label="Go to Overview"
              >
                <img
                  src="/logos/Logo.png"
                  alt="PrismSports"
                  className={[
                    "h-14 sm:h-16 md:h-20 w-auto object-contain select-none flex-shrink-0",
                    "transition-transform duration-200 group-hover:scale-[1.01]",
                  ].join(" ")}
                  draggable={false}
                />
              </button>

              <div className="flex-1 min-w-0">
                <div
                  className={[
                    "text-[#9a9a9a] font-medium tracking-wide leading-snug",
                    "text-[11px] sm:text-[12px] md:text-[12px]",
                    "line-clamp-2",
                    "sm:line-clamp-1 sm:truncate",
                  ].join(" ")}
                >
                  {TAGLINE}
                </div>

                {/* subtle spectrum micro-accent under tagline */}
                <div
                  className="mt-1 h-[2px] w-[160px] max-w-full rounded-full opacity-70"
                  style={{
                    background:
                      "linear-gradient(90deg, rgba(0,146,255,0.8), rgba(0,200,120,0.8), rgba(212,175,55,0.85), rgba(255,140,0,0.8), rgba(255,60,60,0.75), rgba(170,70,255,0.75))",
                  }}
                />
              </div>
            </div>

            {/* Desktop nav */}
            <nav className="hidden md:flex items-center gap-7 pb-2 pt-1">
              <HoverDropdown
                label="Odds"
                suffix="Odds"
                active={oddsActive}
                selectedDbSport={oddsSportKey}
                onPickDbSport={(k) => {
                  onPickOddsSport(k);
                  onNavigate?.("odds");
                }}
              />

              <HoverDropdown
                label="Predictions"
                suffix="Predictions"
                active={predsActive}
                selectedDbSport={predSportKey}
                onPickDbSport={(k) => {
                  onPickPredSport(k);
                  onNavigate?.("monte-carlo");
                }}
              />

              <div className="h-5 w-px bg-[#2a2a2a]" />

              <NavItem label="Picks" active={activeScreen === "model"} onClick={() => onNavigate?.("model")} />
              <NavItem
                label="Results"
                active={activeScreen === "results"}
                onClick={() => onNavigate?.("results")}
              />
              <NavItem
                label="Settings"
                active={activeScreen === "settings"}
                onClick={() => onNavigate?.("settings")}
              />
            </nav>
          </div>
        </div>

        <div className="hidden sm:flex items-center">
          <div
            className="flex items-center gap-2 rounded-full border border-[#2a2a2a] px-3 py-1"
            style={{
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.02))",
            }}
          >
            <div className="text-[12px] text-[#9a9a9a] font-medium">Live</div>
            <div className="w-2 h-2 rounded-full bg-emerald-500" title="Live" />
          </div>
        </div>
      </div>
    </header>
  );
}
