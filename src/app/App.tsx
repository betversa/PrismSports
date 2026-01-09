// App.tsx — FULL REWRITE (adds Calculator screen; keeps everything else unchanged)
// ---------------------------------------------------------------------------------------------------
// ✅ Adds "calculator" to Screen union + routing map
// ✅ Imports + mounts CalculatorScreen
// ✅ Keeps separate Odds vs Predictions sport selectors
// ✅ Keeps mobile drawer behavior + header height padding
// ✅ Keeps Sidebar/Header prop contracts (no extra props)
// ✅ Leaves selectedDate in place for ModelScreen (as your code expects)

import React, { useMemo, useState, useEffect, useCallback } from "react";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";

import { OverviewScreen } from "./components/screens/OverviewScreen";
import { ModelScreen } from "./components/screens/ModelScreen";
import { PropsScreen } from "./components/screens/PropsScreen";
import { ParlayScreen } from "./components/screens/ParlayScreen";
import { CalculatorScreen } from "./components/screens/CalculatorScreen"; // ✅ NEW
import { MonteCarloScreen } from "./components/screens/MonteCarloScreen";
import { OddsScreen } from "./components/screens/OddsScreen";
import { ResultsScreen } from "./components/screens/ResultsScreen";
import { CalibrationScreen } from "./components/screens/CalibrationScreen";
import { SettingsScreen } from "./components/screens/SettingsScreen";

export type Screen =
  | "overview"
  | "model"
  | "props"
  | "parlay"
  | "calculator" // ✅ NEW
  | "monte-carlo"
  | "odds"
  | "results"
  | "calibration"
  | "settings";

// ✅ match your DB / Odds API sport keys
export type SportKey =
  | "basketball_ncaab"
  | "basketball_nba"
  | "football_ncaaf"
  | "football_nfl"
  | "icehockey_nhl"
  | "baseball_mlb";

const CT_TZ = "America/Chicago";
const ROUTE_MAP: Record<Screen, string> = {
  overview: "/",
  model: "/model",
  props: "/props",
  parlay: "/parlay",
  calculator: "/calculator",
  "monte-carlo": "/monte-carlo",
  odds: "/odds",
  results: "/results",
  calibration: "/calibration",
  settings: "/settings",
};
const PATH_TO_SCREEN: Record<string, Screen> = Object.fromEntries(
  Object.entries(ROUTE_MAP).map(([screen, path]) => [path, screen as Screen])
) as Record<string, Screen>;

// YYYY-MM-DD in Central Time
function ctYmd(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}

function isPredScreen(s: Screen) {
  return s === "model" || s === "monte-carlo";
}

export default function App() {
  const [activeScreen, setActiveScreen] = useState<Screen>("overview");
  const [selectedDate] = useState<string>(() => ctYmd(new Date()));

  // ✅ Separate sport selectors (Odds vs Predictions)
  const [oddsSportKey, setOddsSportKey] = useState<SportKey>("basketball_ncaab");
  const [predSportKey, setPredSportKey] = useState<SportKey>("basketball_ncaab");

  // Mobile drawer state
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Dynamic top padding based on actual header height
  const [headerH, setHeaderH] = useState(120);

  // Prevent body scroll when drawer is open (mobile)
  useEffect(() => {
    document.body.style.overflow = sidebarOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [sidebarOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const applyPath = () => {
      const path = window.location.pathname || "/";
      const next = PATH_TO_SCREEN[path] ?? "overview";
      setActiveScreen(next);
    };
    applyPath();
    window.addEventListener("popstate", applyPath);
    return () => {
      window.removeEventListener("popstate", applyPath);
    };
  }, []);

  const navigateTo = useCallback((screen: Screen) => {
    setActiveScreen(screen);
    if (typeof window === "undefined") return;
    const nextPath = ROUTE_MAP[screen] ?? "/";
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, "", nextPath);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, []);

  // --- Sport pick handlers (IMPORTANT: do NOT force wrong screen) ---
  const handlePickOddsSport = useCallback(
    (k: SportKey) => {
      setOddsSportKey(k);

      // If you're on Odds already, stay.
      if (activeScreen === "odds") return;

      // If user is on Overview/Results/etc and picks Odds sport from header,
      // it's reasonable to take them to Odds.
      if (!isPredScreen(activeScreen)) navigateTo("odds");
    },
    [activeScreen, navigateTo]
  );

  const handlePickPredSport = useCallback(
    (k: SportKey) => {
      setPredSportKey(k);

      // If you're already on a prediction screen, stay on it (Model stays Model)
      if (isPredScreen(activeScreen)) return;

      // If user is on Overview/Odds/etc and picks Predictions sport, take them to Monte Carlo
      navigateTo("monte-carlo");
    },
    [activeScreen, navigateTo]
  );

  const screens = useMemo<Record<Screen, JSX.Element>>(
    () => ({
      overview: <OverviewScreen />,

      // ✅ Model uses predSportKey + selectedDate
      model: <ModelScreen selectedDate={selectedDate} sportKey={predSportKey} />,

      // ✅ Props screen (pulls its own data internally)
      props: <PropsScreen />,

      // ✅ Parlay screen (fetches both tables internally)
      parlay: <ParlayScreen />,

      // ✅ NEW: Calculator screen (pure UI math tools)
      calculator: <CalculatorScreen />,

      // ✅ Predictions sport wired here
      "monte-carlo": <MonteCarloScreen sportKey={predSportKey} />,

      // ✅ Odds sport wired here
      odds: <OddsScreen sportKey={oddsSportKey} onPickSport={handlePickOddsSport} />,

      results: <ResultsScreen />,
      calibration: <CalibrationScreen />,
      settings: <SettingsScreen />,
    }),
    [selectedDate, oddsSportKey, predSportKey, handlePickOddsSport]
  );

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Mobile drawer sidebar ONLY */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-[60]">
          <button
            className="absolute inset-0 bg-black/60"
            aria-label="Close sidebar backdrop"
            onClick={() => setSidebarOpen(false)}
            type="button"
          />
          <div className="absolute left-0 top-0 bottom-0 w-72 max-w-[85vw]">
            <Sidebar
              activeScreen={activeScreen}
              onNavigate={(s) => {
                navigateTo(s);
                setSidebarOpen(false);
              }}
              variant="mobile"
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Header */}
      <Header
        onOpenMenu={() => setSidebarOpen(true)}
        onNavigate={(screen) => {
          navigateTo(screen);
          setSidebarOpen(false);
        }}
        activeScreen={activeScreen}
        onHeightChange={(px) => setHeaderH(Math.ceil(px))}
      />

      {/* Main Content scroll container */}
      <div
        className="h-screen overflow-y-auto overflow-x-hidden"
        style={{ paddingTop: headerH, "--app-header-h": `${headerH}px` } as React.CSSProperties}
      >
        <div className="p-3 md:p-6 pb-12">{screens[activeScreen]}</div>
      </div>
    </div>
  );
}
