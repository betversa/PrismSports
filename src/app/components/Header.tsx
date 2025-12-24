// components/Header.tsx
import { useEffect, useRef, useState } from "react";
import { Menu, ChevronDown } from "lucide-react";

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
};

type SportKey = "NCAAB" | "NBA" | "NCAAF" | "NFL" | "NHL" | "MLB";
const SPORTS: SportKey[] = ["NCAAB", "NBA", "NCAAF", "NFL", "NHL", "MLB"];

const GOLD = "#d4af37";

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

function NavText({
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
        "relative text-sm font-semibold tracking-wide transition-colors",
        active ? "text-white" : "text-[#cfcfcf] hover:text-white",
      ].join(" ")}
    >
      {label}
      <span
        className="absolute left-0 -bottom-2 h-[2px] w-full rounded"
        style={{
          backgroundColor: GOLD,
          opacity: active ? 1 : 0,
        }}
      />
    </button>
  );
}

/**
 * Desktop hover dropdown:
 * - Opens on mouse enter
 * - Closes on mouse leave OR outside click (extra safe)
 */
function HoverDropdown({
  label,
  active,
  onPick,
}: {
  label: "Odds" | "Predictions";
  active?: boolean;
  onPick: (sport: SportKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useOutsideClick(wrapRef, () => setOpen(false));

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={[
          "relative flex items-center gap-1 text-sm font-semibold tracking-wide transition-colors",
          active ? "text-white" : "text-[#cfcfcf] hover:text-white",
        ].join(" ")}
        // click still works for trackpads / accessibility
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <ChevronDown className="w-4 h-4 opacity-80" />
        <span
          className="absolute left-0 -bottom-2 h-[2px] w-full rounded"
          style={{ backgroundColor: GOLD, opacity: active ? 1 : 0 }}
        />
      </button>

      {open && (
        <div className="absolute left-0 mt-3 w-60 rounded-xl border border-[#2a2a2a] bg-[#0b0b0b] shadow-2xl overflow-hidden z-50">
          <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-[#7a7a7a] border-b border-[#1d1d1d]">
            Choose Sport
          </div>

          {SPORTS.map((sport) => {
            const enabled = sport === "NCAAB";
            return (
              <button
                key={sport}
                type="button"
                disabled={!enabled}
                onClick={() => {
                  if (!enabled) return;
                  onPick(sport);
                  setOpen(false);
                }}
                className={[
                  "w-full text-left px-3 py-2.5 flex items-center justify-between",
                  enabled
                    ? "text-white hover:bg-[#141414]"
                    : "text-[#6f6f6f] cursor-not-allowed",
                ].join(" ")}
              >
                <span className="font-semibold">{sport}</span>
                {!enabled && (
                  <span className="font-extrabold text-[11px]" style={{ color: GOLD }}>
                    COMING SOON!
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

export function Header({ onOpenMenu, onNavigate, activeScreen }: HeaderProps) {
  const oddsActive = activeScreen === "odds";
  const predsActive = activeScreen === "monte-carlo";

  return (
    // Taller header to fit logo + nav underneath
    <header className="h-24 md:h-28 bg-[#0f0f0f] border-b border-[#2a2a2a] fixed top-0 left-0 right-0 z-50">
      <div className="h-full px-3 md:px-6 flex items-center justify-between">
        {/* LEFT: mobile menu + stacked logo/nav */}
        <div className="flex items-center gap-3 min-w-0">
          {/* Mobile sidebar toggle */}
          <button
            onClick={onOpenMenu}
            className="md:hidden p-2 rounded border border-[#2a2a2a] text-[#cfcfcf] hover:border-[#3a3a3a]"
            aria-label="Open menu"
            type="button"
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Stack logo over nav */}
          <div className="flex flex-col justify-left gap-2">
            {/* Bigger logo */}
            <img
              src="/logos/mainlogo.png"
              alt="PrismSports"
              className="h-25 md:h-27 w-auto object-contain select-none"
              draggable={false}
            />

            {/* Desktop nav under logo */}
            <nav className="hidden md:flex items-center gap-7">
              <HoverDropdown
                label="Odds"
                active={oddsActive}
                onPick={(sport) => {
                  if (sport === "NCAAB") onNavigate?.("odds");
                }}
              />
              <HoverDropdown
                label="Predictions"
                active={predsActive}
                onPick={(sport) => {
                  if (sport === "NCAAB") onNavigate?.("monte-carlo");
                }}
              />

              <div className="h-4 w-px bg-[#2a2a2a]" />

              <NavText
                label="Picks"
                active={activeScreen === "model"}
                onClick={() => onNavigate?.("model")}
              />
              <NavText
                label="Results"
                active={activeScreen === "results"}
                onClick={() => onNavigate?.("results")}
              />
              <NavText
                label="Settings"
                active={activeScreen === "settings"}
                onClick={() => onNavigate?.("settings")}
              />
            </nav>
          </div>
        </div>
      </div>
    </header>
  );
}
