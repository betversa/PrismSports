// components/Header.tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  onHeightChange?: (px: number) => void;
};

type SportKey = "NCAAB" | "NBA" | "NCAAF" | "NFL" | "NHL" | "MLB";
const SPORTS: SportKey[] = ["NCAAB", "NBA", "NCAAF", "NFL", "NHL", "MLB"];

const GOLD = "#d4af37";
const DROPDOWN_EVENT = "prism:header-dropdown-open";
const DROPDOWN_CLOSE_DELAY_MS = 240;

// ✅ simple, distinct from dratings
const TAGLINE = "Sports Models · Projections · Analysis";

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
  onPick,
}: {
  label: "Odds" | "Predictions";
  active?: boolean;
  suffix: "Odds" | "Predictions";
  onPick: (sport: SportKey) => void;
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
          <div
            className="pointer-events-none absolute inset-0 opacity-80"
            style={{
              background:
                "radial-gradient(700px 160px at 20% 0%, rgba(212,175,55,0.14), transparent 60%), radial-gradient(520px 140px at 90% 20%, rgba(255,255,255,0.05), transparent 55%)",
            }}
          />
          <div className="relative">
            {SPORTS.map((sport) => {
              const enabled = sport === "NCAAB";
              const title = `${sport} ${suffix}`;

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
                    "w-full text-left px-4 py-3 flex items-center justify-between",
                    "transition-colors border-b border-[#141414] last:border-b-0",
                    enabled ? "text-white hover:bg-[#141414]" : "text-[#6f6f6f] cursor-not-allowed",
                  ].join(" ")}
                >
                  <span className="text-[14px] font-medium leading-tight">{title}</span>

                  {!enabled && (
                    <span className="font-semibold text-[11px]" style={{ color: GOLD }}>
                      COMING SOON
                    </span>
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

export function Header({ onOpenMenu, onNavigate, activeScreen, onHeightChange }: HeaderProps) {
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
        <div
          className="absolute inset-0 opacity-80"
          style={{
            background:
              "radial-gradient(900px 220px at 18% 0%, rgba(212,175,55,0.14), transparent 60%), radial-gradient(700px 200px at 82% 10%, rgba(255,255,255,0.05), transparent 60%)",
          }}
        />
        <div
          className="absolute left-0 right-0 top-0 h-[1px]"
          style={{
            background:
              "linear-gradient(90deg, rgba(212,175,55,0.0), rgba(212,175,55,0.55), rgba(212,175,55,0.0))",
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
              <img
                src="/logos/mainlogo.png"
                alt="PrismSports"
                className="h-14 sm:h-16 md:h-20 w-auto object-contain select-none flex-shrink-0"
                draggable={false}
              />

              {/* ✅ Key fix: flex-1 + 2-line wrap on mobile, 1-line truncate on sm+ */}
              <div className="flex-1 min-w-0">
                <div
                  className={[
                    "text-[#9a9a9a] font-medium tracking-wide leading-snug",
                    "text-[11px] sm:text-[12px] md:text-[12px]",
                    // Mobile: allow up to 2 lines (no truncation)
                    "line-clamp-2",
                    // sm+: force single line and truncate for cleanliness
                    "sm:line-clamp-1 sm:truncate",
                  ].join(" ")}
                >
                  {TAGLINE}
                </div>
              </div>
            </div>

            {/* Desktop nav */}
            <nav className="hidden md:flex items-center gap-7 pb-2 pt-1">
              <HoverDropdown
                label="Odds"
                suffix="Odds"
                active={oddsActive}
                onPick={(sport) => {
                  if (sport === "NCAAB") onNavigate?.("odds");
                }}
              />
              <HoverDropdown
                label="Predictions"
                suffix="Predictions"
                active={predsActive}
                onPick={(sport) => {
                  if (sport === "NCAAB") onNavigate?.("monte-carlo");
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
