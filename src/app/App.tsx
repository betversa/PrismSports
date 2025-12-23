// App.tsx
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

export default function App() {
  const [activeScreen, setActiveScreen] = useState<Screen>("overview");
  const [selectedDate, setSelectedDate] = useState<string>("2024-12-20");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Prevent body scroll when drawer is open (mobile)
  useEffect(() => {
    if (sidebarOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [sidebarOpen]);

  const screens = useMemo<Record<Screen, JSX.Element>>(
    () => ({
      overview: <OverviewScreen />,
      model: <ModelScreen />,
      "monte-carlo": <MonteCarloScreen />,
      odds: <OddsScreen />,
      results: <ResultsScreen />,
      calibration: <CalibrationScreen />,
      settings: <SettingsScreen />,
    }),
    []
  );

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Desktop sidebar */}
      <div className="hidden md:block">
        <Sidebar activeScreen={activeScreen} onNavigate={setActiveScreen} variant="desktop" />
      </div>

      {/* Mobile drawer */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-[60]">
          {/* Backdrop */}
          <button
            className="absolute inset-0 bg-black/60"
            aria-label="Close sidebar backdrop"
            onClick={() => setSidebarOpen(false)}
          />
          {/* Drawer */}
          <div className="absolute left-0 top-0 bottom-0 w-72 max-w-[85vw]">
            <Sidebar
              activeScreen={activeScreen}
              onNavigate={(s) => {
                setActiveScreen(s);
                setSidebarOpen(false);
              }}
              variant="mobile"
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Header (hamburger on mobile) */}
      <Header
        selectedDate={selectedDate}
        onChangeDate={setSelectedDate}
        onOpenMenu={() => setSidebarOpen(true)}
      />

      {/* Main Content */}
      <div className="pt-16 min-h-screen md:ml-64">
        <div className="p-3 md:p-6 pb-12">{screens[activeScreen]}</div>
      </div>
    </div>
  );
}
