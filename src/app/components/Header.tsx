// components/Header.tsx — FULL REWRITE (PRISM LOGO THEME: Black + Gold + Slate)
// ---------------------------------------------------------------------------------------------------
// ✅ Theme matches provided Prism logo (black/gold/slate)
// ✅ Desktop nav centered; logo bigger (md:h-24)
// ✅ Clicking logo -> Overview
// ✅ Logo path: /logos/mainlogo.png (kept as-is)
// ✅ Mobile: hamburger remains (menu controlled by parent)
// ✅ Odds/Predictions are standard nav links (no dropdowns)

import React, { useLayoutEffect, useRef } from "react";
import { Menu } from "lucide-react";

type Screen =
  | "overview"
  | "model"
  | "props"
  | "parlay"
  | "calculator"
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
};

/** =========================
 * THEME (from logo palette)
 * ========================= */
const GOLD = "#d89211";
const GOLD_SOFT = "rgba(216, 146, 17, 0.18)";
const GOLD_GLOW = "rgba(216, 146, 17, 0.32)";
const PANEL = "#0b0b0b";
const BORDER = "#2a2a2a";

const TAGLINE = "Sports Models · Projections · Analysis";

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

export function Header({
  onOpenMenu,
  onNavigate,
  activeScreen,
  onHeightChange,
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
              <NavItem label="Odds" active={activeScreen === "odds"} onClick={() => onNavigate?.("odds")} />
              <NavItem
                label="Predictions"
                active={activeScreen === "monte-carlo"}
                onClick={() => onNavigate?.("monte-carlo")}
              />

              <div className="h-5 w-px" style={{ background: "#2a2a2a" }} />

              <NavItem label="Picks" active={activeScreen === "model"} onClick={() => onNavigate?.("model")} />
              <NavItem label="Props" active={activeScreen === "props"} onClick={() => onNavigate?.("props")} />
              <NavItem label="Parlay" active={activeScreen === "parlay"} onClick={() => onNavigate?.("parlay")} />

              <NavItem
                label="Calculator"
                active={activeScreen === "calculator"}
                onClick={() => onNavigate?.("calculator")}
              />

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
