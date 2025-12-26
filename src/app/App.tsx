// App.tsx — FULL REWRITE (fixes Predictions sport selector + consistent behavior)
import { useMemo, useState, useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";

import { OverviewScreen } from "./components/screens/OverviewScreen";
import { ModelScreen } from "./components/screens/ModelScreen";
import { MonteCarloScreen } from "./components/screens/MonteCarloScreen";
import { OddsScreen } from "./components/screens/OddsScreen";
import { ResultsScreen } from "./components/screens/ResultsScreen";
import { CalibrationScreen } from "./components/screens/CalibrationScreen";
import { SettingsScreen } from "./components/screens/SettingsScreen";

export type Screen =
  | "overview"
  | "model"
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
  const [selectedDate, setSelectedDate] = useState<string>(() => ctYmd(new Date()));

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

  // --- Sport pick handlers (IMPORTANT: do NOT force wrong screen) ---
  const handlePickOddsSport = (k: SportKey) => {
    setOddsSportKey(k);

    // If you're on an Odds-related page already, keep you there.
    // If you're on a prediction screen, don't hijack navigation.
    if (activeScreen === "odds") return;

    // If user is on Overview/Results/etc and picks Odds sport from header,
    // it's reasonable to take them to Odds (same behavior you had before).
    if (!isPredScreen(activeScreen)) setActiveScreen("odds");
  };

  const handlePickPredSport = (k: SportKey) => {
    setPredSportKey(k);

    // If you're already on a prediction screen, stay on it (Model stays Model)
    if (isPredScreen(activeScreen)) return;

    // If user is on Overview/Odds/etc and picks Predictions sport, take them to Monte Carlo
    // (the main "predictions" landing page).
    setActiveScreen("monte-carlo");
  };

  const screens = useMemo<Record<Screen, JSX.Element>>(
    () => ({
      overview: <OverviewScreen />,

      // ✅ FIX: ModelScreen MUST receive the predSportKey
      model: <ModelScreen selectedDate={selectedDate} sportKey={predSportKey} />,

      // ✅ Predictions sport already wired here
      "monte-carlo": <MonteCarloScreen sportKey={predSportKey} />,

      // ✅ Odds sport wired here
      odds: <OddsScreen sportKey={oddsSportKey} />,

      results: <ResultsScreen />,
      calibration: <CalibrationScreen />,
      settings: <SettingsScreen />,
    }),
    [selectedDate, oddsSportKey, predSportKey]
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
                setActiveScreen(s);
                setSidebarOpen(false);
              }}
              variant="mobile"
              onClose={() => setSidebarOpen(false)}
              selectedDate={selectedDate}
              onPickDate={setSelectedDate}
              oddsSportKey={oddsSportKey}
              onPickOddsSport={handlePickOddsSport}
              predSportKey={predSportKey}
              onPickPredSport={handlePickPredSport}
            />
          </div>
        </div>
      )}

      {/* Header */}
      <Header
        onOpenMenu={() => setSidebarOpen(true)}
        onNavigate={(screen) => {
          setActiveScreen(screen);
          setSidebarOpen(false);
        }}
        activeScreen={activeScreen}
        onHeightChange={(px) => setHeaderH(Math.ceil(px))}
        selectedDate={selectedDate}
        onPickDate={setSelectedDate}
        oddsSportKey={oddsSportKey}
        onPickOddsSport={handlePickOddsSport}
        predSportKey={predSportKey}
        onPickPredSport={handlePickPredSport}
      />

      {/* Main Content scroll container */}
      <div className="h-screen overflow-y-auto overflow-x-hidden" style={{ paddingTop: headerH }}>
        <div className="p-3 md:p-6 pb-12">{screens[activeScreen]}</div>
      </div>
    </div>
  );
}
