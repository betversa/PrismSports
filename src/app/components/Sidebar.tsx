// components/Sidebar.tsx
import { useMemo, useState } from "react";
import {
  ChartBar,
  Calculator,
  TrendingUp,
  Target,
  Settings,
  House,
  X,
  ChevronDown,
} from "lucide-react";
import type { Screen } from "../App";

interface SidebarProps {
  activeScreen: Screen;
  onNavigate: (screen: Screen) => void;
  variant?: "desktop" | "mobile";
  onClose?: () => void;
}

/**
 * Sidebar with sport dropdowns for Odds + Predictions (mobile + desktop sidebar)
 * - Mirrors desktop header behavior conceptually
 * - NCAAB enabled now; others show "COMING SOON" (same as header)
 * - Clicking a sport navigates to the base screen (odds / monte-carlo)
 *   (later you can add sport state routing without changing UI)
 */

type SportKey = "NCAAB" | "NBA" | "NCAAF" | "NFL" | "NHL" | "MLB";
const SPORTS: SportKey[] = ["NCAAB", "NBA", "NCAAF", "NFL", "NHL", "MLB"];

const GOLD = "#d4af37";

export function Sidebar({
  activeScreen,
  onNavigate,
  variant = "desktop",
  onClose,
}: SidebarProps) {
  const isMobile = variant === "mobile";

  const wrapperClass = isMobile
    ? "bg-[#0a0a0a] border-r border-[#2a2a2a] h-full flex flex-col overflow-hidden"
    : "w-64 bg-[#0a0a0a] border-r border-[#2a2a2a] h-screen fixed left-0 top-0 z-20 flex flex-col overflow-hidden";

  // dropdown open state (persist across renders)
  const [openOdds, setOpenOdds] = useState(false);
  const [openPreds, setOpenPreds] = useState(false);

  // highlight the parent item if either base screen is active
  const oddsActive = activeScreen === "odds";
  const predsActive = activeScreen === "monte-carlo";

  const baseItemClasses = (active: boolean) =>
    [
      "w-full flex items-center justify-between gap-3 px-4 py-2.5 rounded transition-colors",
      active
        ? "bg-[#d4af37] text-black"
        : "text-[#b0b0b0] hover:bg-[#1a1a1a] hover:text-white",
    ].join(" ");

  const subItemClasses = (enabled: boolean) =>
    [
      "w-full flex items-center justify-between px-4 py-2 rounded",
      "transition-colors",
      enabled ? "text-[#cfcfcf] hover:bg-[#141414] hover:text-white" : "text-[#6f6f6f] cursor-not-allowed",
    ].join(" ");

  const SectionDivider = () => <div className="my-2 h-px bg-[#1a1a1a]" />;

  return (
    <div className={wrapperClass}>
      {/* Mobile header */}
      {isMobile && (
        <div className="h-14 px-4 flex items-center justify-between border-b border-[#2a2a2a]">
          <div className="text-sm font-semibold text-white">Menu</div>
          <button
            onClick={onClose}
            className="p-2 rounded border border-[#2a2a2a] text-[#cfcfcf] hover:border-[#3a3a3a]"
            aria-label="Close menu"
            type="button"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 p-4 overflow-y-auto">
        <ul className="space-y-1">
          {/* Overview */}
          <li>
            <button
              onClick={() => onNavigate("overview")}
              className={baseItemClasses(activeScreen === "overview")}
              type="button"
            >
              <div className="flex items-center gap-3">
                <House className="w-4 h-4" />
                <span className="text-sm">Overview</span>
              </div>
            </button>
          </li>

          {/* Picks */}
          <li>
            <button
              onClick={() => onNavigate("model")}
              className={baseItemClasses(activeScreen === "model")}
              type="button"
            >
              <div className="flex items-center gap-3">
                <Target className="w-4 h-4" />
                <span className="text-sm">Picks</span>
              </div>
            </button>
          </li>

          <SectionDivider />

          {/* Predictions dropdown */}
          <li>
            <button
              type="button"
              onClick={() => {
                // collapse the other dropdown to keep it tidy
                setOpenOdds(false);
                setOpenPreds((v) => !v);
              }}
              className={baseItemClasses(predsActive)}
              aria-expanded={openPreds}
            >
              <div className="flex items-center gap-3">
                <Calculator className="w-4 h-4" />
                <span className="text-sm">Predictions</span>
              </div>
              <ChevronDown
                className={[
                  "w-4 h-4 transition-transform",
                  openPreds ? "rotate-180" : "rotate-0",
                  predsActive ? "text-black" : "text-[#9a9a9a]",
                ].join(" ")}
              />
            </button>

            {openPreds && (
              <div className="mt-2 ml-7 space-y-1">
                {SPORTS.map((sport) => {
                  const enabled = sport === "NCAAB" || sport === "NBA";
                  return (
                    <button
                      key={`preds-${sport}`}
                      type="button"
                      disabled={!enabled}
                      onClick={() => {
                        if (!enabled) return;
                        onNavigate("monte-carlo");
                        if (isMobile) onClose?.();
                      }}
                      className={subItemClasses(enabled)}
                      title={enabled ? `${sport} Predictions` : "Coming soon"}
                    >
                      <span className="text-[13px] font-medium">{sport} Predictions</span>
                      {!enabled && (
                        <span className="text-[10px] font-semibold" style={{ color: GOLD }}>
                          COMING SOON
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </li>

          {/* Odds dropdown */}
          <li>
            <button
              type="button"
              onClick={() => {
                setOpenPreds(false);
                setOpenOdds((v) => !v);
              }}
              className={baseItemClasses(oddsActive)}
              aria-expanded={openOdds}
            >
              <div className="flex items-center gap-3">
                <ChartBar className="w-4 h-4" />
                <span className="text-sm">Odds</span>
              </div>
              <ChevronDown
                className={[
                  "w-4 h-4 transition-transform",
                  openOdds ? "rotate-180" : "rotate-0",
                  oddsActive ? "text-black" : "text-[#9a9a9a]",
                ].join(" ")}
              />
            </button>

            {openOdds && (
              <div className="mt-2 ml-7 space-y-1">
                {SPORTS.map((sport) => {
                  const enabled = sport === "NCAAB";
                  return (
                    <button
                      key={`odds-${sport}`}
                      type="button"
                      disabled={!enabled}
                      onClick={() => {
                        if (!enabled) return;
                        onNavigate("odds");
                        if (isMobile) onClose?.();
                      }}
                      className={subItemClasses(enabled)}
                      title={enabled ? `${sport} Odds` : "Coming soon"}
                    >
                      <span className="text-[13px] font-medium">{sport} Odds</span>
                      {!enabled && (
                        <span className="text-[10px] font-semibold" style={{ color: GOLD }}>
                          COMING SOON
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </li>

          <SectionDivider />

          {/* Results */}
          <li>
            <button
              onClick={() => onNavigate("results")}
              className={baseItemClasses(activeScreen === "results")}
              type="button"
            >
              <div className="flex items-center gap-3">
                <TrendingUp className="w-4 h-4" />
                <span className="text-sm">Results</span>
              </div>
            </button>
          </li>

          {/* Settings */}
          <li>
            <button
              onClick={() => onNavigate("settings")}
              className={baseItemClasses(activeScreen === "settings")}
              type="button"
            >
              <div className="flex items-center gap-3">
                <Settings className="w-4 h-4" />
                <span className="text-sm">Settings</span>
              </div>
            </button>
          </li>
        </ul>
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-[#2a2a2a]">
        <div className="text-xs text-[#606060]">
          <div>Model v3.2.1</div>
          <div className="mt-1">Updated 12/20/24</div>
        </div>
      </div>
    </div>
  );
}
