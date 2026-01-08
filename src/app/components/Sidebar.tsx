// components/Sidebar.tsx — FULL REWRITE (adds Parlay + Props + Calculator nav item)
// ---------------------------------------------------------------------------------------------------
// ✅ Adds Parlay + Props + NEW Calculator to sidebar nav (desktop + mobile)
// ✅ Keeps styling + enabled sport logic unchanged

import React from "react";
import {
  ChartBar,
  Calculator,
  TrendingUp,
  Target,
  Settings,
  House,
  X,
  Layers,
  User,
} from "lucide-react";
import type { Screen } from "../App";

interface SidebarProps {
  activeScreen: Screen;
  onNavigate: (screen: Screen) => void;
  variant?: "desktop" | "mobile";
  onClose?: () => void;
}

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

  const baseItemClasses = (active: boolean) =>
    [
      "w-full flex items-center justify-between gap-3 px-4 py-2.5 rounded transition-colors",
      active
        ? "bg-[#d4af37] text-black"
        : "text-[#b0b0b0] hover:bg-[#1a1a1a] hover:text-white",
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
              onClick={() => {
                onNavigate("overview");
                if (isMobile) onClose?.();
              }}
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
              onClick={() => {
                onNavigate("model");
                if (isMobile) onClose?.();
              }}
              className={baseItemClasses(activeScreen === "model")}
              type="button"
            >
              <div className="flex items-center gap-3">
                <Target className="w-4 h-4" />
                <span className="text-sm">Picks</span>
              </div>
            </button>
          </li>

          {/* Props */}
          <li>
            <button
              onClick={() => {
                onNavigate("props");
                if (isMobile) onClose?.();
              }}
              className={baseItemClasses(activeScreen === "props")}
              type="button"
            >
              <div className="flex items-center gap-3">
                <User className="w-4 h-4" />
                <span className="text-sm">Props</span>
              </div>
            </button>
          </li>

          {/* Parlay */}
          <li>
            <button
              onClick={() => {
                onNavigate("parlay");
                if (isMobile) onClose?.();
              }}
              className={baseItemClasses(activeScreen === "parlay")}
              type="button"
            >
              <div className="flex items-center gap-3">
                <Layers className="w-4 h-4" />
                <span className="text-sm">Parlay</span>
              </div>
            </button>
          </li>

          {/* ✅ NEW: Calculator */}
          <li>
            <button
              onClick={() => {
                onNavigate("calculator");
                if (isMobile) onClose?.();
              }}
              className={baseItemClasses(activeScreen === "calculator")}
              type="button"
            >
              <div className="flex items-center gap-3">
                <Calculator className="w-4 h-4" />
                <span className="text-sm">Calculator</span>
              </div>
            </button>
          </li>

          <SectionDivider />

          {/* Predictions */}
          <li>
            <button
              onClick={() => {
                onNavigate("monte-carlo");
                if (isMobile) onClose?.();
              }}
              className={baseItemClasses(activeScreen === "monte-carlo")}
              type="button"
            >
              <div className="flex items-center gap-3">
                <Calculator className="w-4 h-4" />
                <span className="text-sm">Predictions</span>
              </div>
            </button>
          </li>

          {/* Odds */}
          <li>
            <button
              onClick={() => {
                onNavigate("odds");
                if (isMobile) onClose?.();
              }}
              className={baseItemClasses(activeScreen === "odds")}
              type="button"
            >
              <div className="flex items-center gap-3">
                <ChartBar className="w-4 h-4" />
                <span className="text-sm">Odds</span>
              </div>
            </button>
          </li>

          <SectionDivider />

          {/* Results */}
          <li>
            <button
              onClick={() => {
                onNavigate("results");
                if (isMobile) onClose?.();
              }}
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
              onClick={() => {
                onNavigate("settings");
                if (isMobile) onClose?.();
              }}
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
