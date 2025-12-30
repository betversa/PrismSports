// components/Header.tsx — FULL REWRITE (Desktop tighter height / padding; mobile unchanged)
// ---------------------------------------------------------------------------------------------------
// ✅ Desktop: reduced vertical padding + slightly smaller logo to reclaim space
// ✅ Mobile: unchanged (same height + overlays)
// ✅ Tagline underline hugs tagline width
// ✅ Clicking logo -> Overview
// ✅ Logo path: /logos/Logo.png
// ✅ Everything else unchanged

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

/**
 * Subtle spectrum (existing look).
 */
const PRISM_DESKTOP = {
  blue: "rgba(0, 146, 255, 0.08)",
  teal: "rgba(0, 201, 255, 0.06)",
  green: "rgba(0, 200, 120, 0.07)",
  gold: "rgba(212, 175, 55, 0.09)",
  orange: "rgba(255, 140, 0, 0.07)",
  red: "rgba(255, 60, 60, 0.06)",
  violet: "rgba(170, 70, 255, 0.06)",
};

const PRISM_MOBILE = {
  blue: "rgba(0, 146, 255, 0.11)",
  teal: "rgba(0, 201, 255, 0.09)",
  green: "rgba(0, 200, 120, 0.10)",
  gold: "rgba(212, 175, 55, 0.12)",
  orange: "rgba(255, 140, 0, 0.10)",
  red: "rgba(255, 60, 60, 0.09)",
  violet: "rgba(170, 70, 255, 0.09)",
};

const BLACK_GLASS_DESKTOP = {
  top: "rgba(0,0,0,0.38)",
  mid: "rgba(0,0,0,0.60)",
  bottom: "rgba(0,0,0,0.82)",
};

const BLACK_GLASS_MOBILE = {
  top: "rgba(0,0,0,0.46)",
  mid: "rgba(0,0,0,0.74)",
  bottom: "rgba(0,0,0,0.90)",
};

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

  const P = PRISM_DESKTOP;
  const B = BLACK_GLASS_DESKTOP;

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
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background: [
                `radial-gradient(520px 160px at 18% 0%, ${P.blue}, transparent 62%)`,
                `radial-gradient(520px 160px at 34% 0%, ${P.teal}, transparent 64%)`,
                `radial-gradient(560px 180px at 50% 0%, ${P.green}, transparent 64%)`,
                `radial-gradient(560px 180px at 66% 0%, ${P.gold}, transparent 66%)`,
                `radial-gradient(560px 180px at 80% 0%, ${P.orange}, transparent 66%)`,
                `radial-gradient(560px 220px at 98% 30%, ${P.red}, transparent 68%)`,
                `radial-gradient(720px 300px at 70% 120%, ${P.violet}, transparent 62%)`,
                `linear-gradient(180deg, ${B.top}, ${B.mid} 55%, ${B.bottom} 100%)`,
                `linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.00) 60%)`,
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
    <header ref={headerRef} className="fixed top-0 left-0 right-0 z-50 border-b border-[#2a2a2a] bg-[#0f0f0f]">
      <div className="pointer-events-none absolute inset-0">
        {/* MOBILE overlay (full spectrum visible + MORE black) */}
        <div
          className="absolute inset-0 md:hidden"
          style={{
            background: [
              `linear-gradient(90deg,
                ${PRISM_MOBILE.blue} 0%,
                ${PRISM_MOBILE.teal} 16%,
                ${PRISM_MOBILE.green} 33%,
                ${PRISM_MOBILE.gold} 50%,
                ${PRISM_MOBILE.orange} 66%,
                ${PRISM_MOBILE.red} 82%,
                ${PRISM_MOBILE.violet} 100%
              )`,
              `radial-gradient(520px 180px at 18% 0%, ${PRISM_MOBILE.blue}, transparent 62%)`,
              `radial-gradient(520px 180px at 52% 0%, ${PRISM_MOBILE.gold}, transparent 64%)`,
              `radial-gradient(520px 200px at 88% 0%, ${PRISM_MOBILE.red}, transparent 66%)`,
              `linear-gradient(180deg, ${BLACK_GLASS_MOBILE.top}, ${BLACK_GLASS_MOBILE.mid} 52%, ${BLACK_GLASS_MOBILE.bottom} 100%)`,
              `linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.012) 55%, rgba(0,0,0,0) 100%)`,
            ].join(", "),
          }}
        />

        {/* DESKTOP overlay (extra subtle) */}
        <div
          className="absolute inset-0 hidden md:block"
          style={{
            background: [
              `radial-gradient(900px 240px at 14% 0%, ${PRISM_DESKTOP.blue}, transparent 66%)`,
              `radial-gradient(820px 240px at 30% 0%, ${PRISM_DESKTOP.teal}, transparent 68%)`,
              `radial-gradient(880px 260px at 48% 0%, ${PRISM_DESKTOP.green}, transparent 68%)`,
              `radial-gradient(900px 260px at 62% 0%, ${PRISM_DESKTOP.gold}, transparent 70%)`,
              `radial-gradient(920px 280px at 78% 0%, ${PRISM_DESKTOP.orange}, transparent 70%)`,
              `radial-gradient(860px 260px at 92% 10%, ${PRISM_DESKTOP.red}, transparent 72%)`,
              `radial-gradient(900px 340px at 60% 120%, ${PRISM_DESKTOP.violet}, transparent 66%)`,
              `linear-gradient(180deg, ${BLACK_GLASS_DESKTOP.top}, ${BLACK_GLASS_DESKTOP.mid} 52%, ${BLACK_GLASS_DESKTOP.bottom} 100%)`,
              `linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02) 55%, rgba(0,0,0,0) 100%)`,
            ].join(", "),
          }}
        />

        {/* Top hairline */}
        <div
          className="absolute left-0 right-0 top-0 h-[1px] opacity-72 md:opacity-55"
          style={{
            background:
              "linear-gradient(90deg, rgba(0,0,0,0), rgba(0,146,255,0.40), rgba(0,200,120,0.40), rgba(212,175,55,0.45), rgba(255,140,0,0.40), rgba(255,60,60,0.35), rgba(170,70,255,0.35), rgba(0,0,0,0))",
          }}
        />

        {/* Gold anchor */}
        <div
          className="absolute left-0 right-0 bottom-0 h-[1px] opacity-65"
          style={{
            background:
              "linear-gradient(90deg, rgba(212,175,55,0.0), rgba(212,175,55,0.42), rgba(212,175,55,0.0))",
          }}
        />
      </div>

      {/* ✅ DESKTOP padding tightened: md:pt-2 md:pb-1 (was bigger) */}
      <div className="relative w-full flex items-center justify-between px-3 md:px-6 pt-2.5 md:pt-2 pb-2 md:pb-1">
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
            {/* Brand row */}
            <div className="flex items-center gap-3 min-w-0 w-full">
              <button
                type="button"
                onClick={() => onNavigate?.("overview")}
                className="group flex items-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
                aria-label="Go to Overview"
              >
                <img
                  src="/logos/Logo.png"
                  alt="PrismSports"
                  className={[
                    // ✅ DESKTOP logo slightly smaller to reclaim space (mobile unchanged)
                    "h-14 sm:h-16 md:h-16 w-auto object-contain select-none flex-shrink-0",
                    "transition-transform duration-200 group-hover:scale-[1.01]",
                  ].join(" ")}
                  draggable={false}
                />
              </button>

              {/* underline hugs the tagline text width */}
              <div className="flex-1 min-w-0 w-full">
                <div className="inline-block w-fit max-w-full">
                  <div
                    className={[
                      "text-[#9a9a9a] font-medium tracking-wide leading-snug",
                      "text-[11px] sm:text-[12px] md:text-[12px]",
                      "truncate",
                    ].join(" ")}
                    title={TAGLINE}
                  >
                    {TAGLINE}
                  </div>

                  <span
                    className="block mt-1 h-[2px] w-full rounded-full opacity-60 md:opacity-45"
                    style={{
                      background:
                        "linear-gradient(90deg, rgba(0,146,255,0.52), rgba(0,200,120,0.52), rgba(212,175,55,0.70), rgba(255,140,0,0.52), rgba(255,60,60,0.42), rgba(170,70,255,0.42))",
                    }}
                  />
                </div>
              </div>
            </div>

            {/* ✅ DESKTOP nav spacing tightened a bit */}
            <nav className="hidden md:flex items-center gap-6 pb-1 pt-0.5">
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
              <NavItem label="Results" active={activeScreen === "results"} onClick={() => onNavigate?.("results")} />
              <NavItem label="Settings" active={activeScreen === "settings"} onClick={() => onNavigate?.("settings")} />
            </nav>
          </div>
        </div>

        <div className="hidden sm:flex items-center">
          <div
            className="flex items-center gap-2 rounded-full border border-[#2a2a2a] px-3 py-1"
            style={{
              background: "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))",
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
