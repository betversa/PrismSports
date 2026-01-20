// App.tsx — FULL REWRITE (adds Calculator screen; keeps everything else unchanged)
// ---------------------------------------------------------------------------------------------------
// ✅ Adds "calculator" to Screen union + routing map
// ✅ Imports + mounts CalculatorScreen
// ✅ Keeps separate Odds vs Predictions sport selectors
// ✅ Keeps mobile drawer behavior + header height padding
// ✅ Keeps Sidebar/Header prop contracts (no extra props)
// ✅ Leaves selectedDate in place for ModelScreen (as your code expects)

import React, { Suspense, useEffect, useMemo, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";
import { AppShell, PageFrame, Panel } from "./components/ui/PrismUI";

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

class AppErrorBoundary extends React.Component<
  { routeLabel: string; children: React.ReactNode },
  { error: Error | null; errorInfo: React.ErrorInfo | null }
> {
  state = { error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error) {
    return { error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[PrismErrorBoundary] Route crash:", error, errorInfo);
    this.setState({ error, errorInfo });
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error, errorInfo } = this.state;
    if (!error) return this.props.children;

    return (
      <PageFrame>
        <Panel>
          <div className="space-y-3">
            <div className="text-xs uppercase tracking-[0.2em] text-red-300">Route Error</div>
            <div className="text-lg font-semibold text-white">Something went wrong.</div>
            <div className="text-sm text-white/70">
              Route: <span className="font-semibold text-white">{this.props.routeLabel}</span>
            </div>
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-100">
              <div className="font-semibold">Message</div>
              <div className="mt-1 whitespace-pre-wrap break-words">{error.message}</div>
            </div>
            {errorInfo?.componentStack ? (
              <div className="rounded-xl border border-white/10 bg-black/40 p-3 text-[11px] text-white/60">
                <div className="font-semibold text-white/80">Component stack</div>
                <pre className="mt-2 whitespace-pre-wrap">{errorInfo.componentStack.trim()}</pre>
              </div>
            ) : null}
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex items-center rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white hover:bg-white/10"
            >
              Reload
            </button>
          </div>
        </Panel>
      </PageFrame>
    );
  }
}

function PrismLoading() {
  return (
    <PageFrame>
      <Panel>
        <div className="flex items-center gap-3 text-sm text-white/70">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#d4af37]" />
          Loading…
        </div>
      </Panel>
    </PageFrame>
  );
}

function ThemeProbe() {
  const [value, setValue] = useState({ body: "", shell: "" });

  useEffect(() => {
    const bodyBg = window.getComputedStyle(document.body).backgroundColor;
    const shell = document.querySelector("[data-theme-shell]") as HTMLElement | null;
    const shellBg = shell ? window.getComputedStyle(shell).backgroundColor : "missing";
    setValue({ body: bodyBg, shell: shellBg });
    // eslint-disable-next-line no-console
    console.log("[ThemeProbe] body:", bodyBg, "shell:", shellBg);
  }, []);

  if (!import.meta.env.DEV) return null;

  return (
    <div className="fixed bottom-2 right-2 z-[9999] rounded border border-white/10 bg-black/70 px-2 py-1 text-[10px] text-white/70">
      body: {value.body} · shell: {value.shell}
    </div>
  );
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

  // --- Sport pick handlers (IMPORTANT: do NOT force wrong screen) ---
  const handlePickOddsSport = (k: SportKey) => {
    setOddsSportKey(k);

    // If you're on Odds already, stay.
    if (activeScreen === "odds") return;

    // If user is on Overview/Results/etc and picks Odds sport from header,
    // it's reasonable to take them to Odds.
    if (!isPredScreen(activeScreen)) setActiveScreen("odds");
  };

  const handlePickPredSport = (k: SportKey) => {
    setPredSportKey(k);

    // If you're already on a prediction screen, stay on it (Model stays Model)
    if (isPredScreen(activeScreen)) return;

    // If user is on Overview/Odds/etc and picks Predictions sport, take them to Monte Carlo
    setActiveScreen("monte-carlo");
  };

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
    [selectedDate, oddsSportKey, predSportKey]
  );

  return (
    <AppShell>
      <ThemeProbe />
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
      />

      {/* Main Content scroll container */}
      <div
        className="relative z-10 h-screen overflow-y-auto overflow-x-hidden"
        style={{ paddingTop: headerH, "--app-header-h": `${headerH}px` } as React.CSSProperties}
      >
        <div className="p-3 md:p-6 pb-12">
          <AppErrorBoundary routeLabel={`/${activeScreen}`}>
            <Suspense fallback={<PrismLoading />}>{screens[activeScreen]}</Suspense>
          </AppErrorBoundary>
        </div>
      </div>
    </AppShell>
  );
}
