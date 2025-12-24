// components/Header.tsx
import { useEffect, useRef, useState } from "react";
import { Menu, ChevronDown } from "lucide-react";

type Screen =
  | "overview"
  | "model" // Picks
  | "monte-carlo" // Predictions
  | "odds"
  | "results"
  | "calibration"
  | "settings";

type HeaderProps = {
  onOpenMenu?: () => void; // mobile sidebar toggle
  onNavigate?: (screen: Screen) => void; // app navigation
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

function Dropdown({
  label,
  onPick,
}: {
  label: "Odds" | "Predictions";
  onPick: (sport: SportKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useOutsideClick(wrapRef, () => setOpen(false));

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-2 rounded bg-[#141414] border border-[#2a2a2a] text-[#d0d0d0] hover:border-[#3a3a3a]"
      >
        <span className="text-sm font-semibold">{label}</span>
        <ChevronDown className="w-4 h-4 text-[#a0a0a0]" />
      </button>

      {open && (
        <div className="absolute mt-2 w-56 rounded-lg border border-[#2a2a2a] bg-[#0f0f0f] shadow-xl overflow-hidden z-50">
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
                  "w-full text-left px-3 py-2 flex items-center justify-between",
                  enabled ? "text-white hover:bg-[#171717]" : "text-[#6f6f6f] cursor-not-allowed",
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

function NavButton({
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
        "px-3 py-2 rounded border text-sm font-semibold transition-colors",
        active
          ? "bg-[#d4af37] text-black border-[#d4af37]"
          : "bg-[#141414] text-[#d0d0d0] border-[#2a2a2a] hover:border-[#3a3a3a] hover:text-white",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

export function Header({ onOpenMenu, onNavigate }: HeaderProps) {
  return (
    <div className="h-16 bg-[#0f0f0f] border-b border-[#2a2a2a] fixed top-0 right-0 left-0 md:left-64 z-10 flex items-center justify-between px-3 md:px-6">
      <div className="flex items-center gap-3 min-w-0">
        {/* Mobile: keep sidebar toggle */}
        <button
          onClick={onOpenMenu}
          className="md:hidden p-2 rounded border border-[#2a2a2a] text-[#cfcfcf] hover:border-[#3a3a3a]"
          aria-label="Open menu"
          type="button"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* Logo */}
        <img
          src="/logos/mainlogo.png"
          alt="PrismSports"
          className="h-8 w-auto object-contain select-none"
          draggable={false}
        />

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-3 ml-2">
          <Dropdown
            label="Odds"
            onPick={(sport) => {
              if (sport === "NCAAB") onNavigate?.("odds");
            }}
          />
          <Dropdown
            label="Predictions"
            onPick={(sport) => {
              if (sport === "NCAAB") onNavigate?.("monte-carlo");
            }}
          />

          <div className="w-px h-7 bg-[#2a2a2a] mx-1" />

          <NavButton label="Picks" onClick={() => onNavigate?.("model")} />
          <NavButton label="Results" onClick={() => onNavigate?.("results")} />
          <NavButton label="Settings" onClick={() => onNavigate?.("settings")} />
        </div>
      </div>

      <div className="hidden sm:flex items-center gap-4 text-xs text-[#808080]">
        <div>Live</div>
        <div className="w-2 h-2 rounded-full bg-emerald-500" title="Live" />
      </div>
    </div>
  );
}


