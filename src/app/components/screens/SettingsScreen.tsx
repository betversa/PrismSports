import { useEffect, useMemo, useState } from "react";
import { Settings as SettingsIcon, Bell, Database, Zap } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";

type ModelVersionRow = {
  version: string;
  release_date: string | null;
  status: string | null;
  simulations: number | null;
  calib_window: string | null;
  anchor_weight_min: number | null;
  anchor_weight_max: number | null;
  min_ev_threshold: number | null; // recommend storing as fraction (0.025)
  updated_at: string | null;
};

type AppSettingsRow = {
  id: number;
  max_units_per_play: number | null;

  notify_high_value: boolean | null;
  notify_line_movement: boolean | null;
  notify_model_updates: boolean | null;
  notify_results_summary: boolean | null;

  updated_at: string | null;
};

const GOLD = "#d4af37";

export function SettingsScreen() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [model, setModel] = useState<ModelVersionRow | null>(null);
  const [app, setApp] = useState<AppSettingsRow | null>(null);

  const [lastOddsSync, setLastOddsSync] = useState<string | null>(null);
  const [lastMcRun, setLastMcRun] = useState<string | null>(null);

  async function loadAll() {
    setLoading(true);
    setError(null);

    try {
      const modelQ = supabase
        .from("model_versions")
        .select(
          "version,release_date,status,simulations,calib_window,anchor_weight_min,anchor_weight_max,min_ev_threshold,updated_at"
        )
        .order("release_date", { ascending: false })
        .limit(1);

      const appQ = supabase
        .from("app_settings")
        .select(
          "id,max_units_per_play,notify_high_value,notify_line_movement,notify_model_updates,notify_results_summary,updated_at"
        )
        .eq("id", 1)
        .limit(1);

      // Real sync signals:
      // odds_snapshot -> latest ts
      const oddsQ = supabase
        .from("odds_snapshot")
        .select("ts")
        .order("ts", { ascending: false })
        .limit(1);

      // monte_carlo_runs -> latest created_at
      const mcQ = supabase
        .from("monte_carlo_runs")
        .select("created_at")
        .order("created_at", { ascending: false })
        .limit(1);

      const [modelRes, appRes, oddsRes, mcRes] = await Promise.all([modelQ, appQ, oddsQ, mcQ]);

      if (modelRes.error) {
        console.warn("[Settings] model_versions error:", modelRes.error.message);
        setModel(null);
      } else {
        setModel((modelRes.data?.[0] ?? null) as ModelVersionRow | null);
      }

      if (appRes.error) {
        // app_settings is optional — page still works read-only
        console.warn("[Settings] app_settings error:", appRes.error.message);
        setApp(null);
      } else {
        setApp((appRes.data?.[0] ?? null) as AppSettingsRow | null);
      }

      if (oddsRes.error) {
        console.warn("[Settings] odds_snapshot error:", oddsRes.error.message);
        setLastOddsSync(null);
      } else {
        setLastOddsSync((oddsRes.data?.[0] as any)?.ts ?? null);
      }

      if (mcRes.error) {
        console.warn("[Settings] monte_carlo_runs error:", mcRes.error.message);
        setLastMcRun(null);
      } else {
        setLastMcRun((mcRes.data?.[0] as any)?.created_at ?? null);
      }
    } catch (e: any) {
      setError(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    // realtime: refresh on updates
    const channel = supabase
      .channel("settings-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "model_versions" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "odds_snapshot" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "monte_carlo_runs" }, () => loadAll())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const modelParams = useMemo(() => {
    const minEv = model?.min_ev_threshold;
    const minEvPct =
      minEv == null
        ? "—"
        : minEv <= 1
        ? `${(minEv * 100).toFixed(1)}%`
        : `${Number(minEv).toFixed(1)}%`;

    const anchorMin = model?.anchor_weight_min;
    const anchorMax = model?.anchor_weight_max;
    const anchorRange =
      anchorMin != null && anchorMax != null
        ? `${anchorMin.toFixed(2)} – ${anchorMax.toFixed(2)}`
        : "—";

    return {
      minEv: minEvPct,
      sims: model?.simulations != null ? formatInt(model.simulations) : "—",
      calib: model?.calib_window ?? "—",
      anchor: anchorRange,
      maxUnits: app?.max_units_per_play != null ? Number(app.max_units_per_play).toFixed(2) : "—",
    };
  }, [model, app]);

  const books = useMemo(() => {
    // You can make this a real "books" table later.
    // For now we base "active" on whether odds have synced recently.
    const oddsAgeMin = lastOddsSync ? minutesSince(lastOddsSync) : null;
    const active = oddsAgeMin != null && oddsAgeMin <= 5;

    return [
      { name: "DraftKings", priority: "Primary", active },
      { name: "FanDuel", priority: "Primary", active },
      { name: "BetMGM", priority: "Primary", active },
      { name: "Pinnacle", priority: "Sharp", active },
      { name: "BetOnline", priority: "Secondary", active },
    ];
  }, [lastOddsSync]);

  const system = useMemo(() => {
    // Real fields we can show today:
    const oddsAge = lastOddsSync ? minutesSince(lastOddsSync) : null;
    const mcAge = lastMcRun ? minutesSince(lastMcRun) : null;

    return {
      lastFullSync: lastOddsSync ? formatRelativeMinutes(oddsAge) : "—",
      lastMcRun: lastMcRun ? formatRelativeMinutes(mcAge) : "—",
      oddsAgeMin: oddsAge,
      mcAgeMin: mcAge,
    };
  }, [lastOddsSync, lastMcRun]);

  async function updateSetting(patch: Partial<AppSettingsRow>) {
    if (!app) return; // read-only mode if app_settings not configured
    setSaving(true);
    setError(null);

    const next = { ...app, ...patch };
    setApp(next);

    const { error } = await supabase
      .from("app_settings")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", 1);

    if (error) {
      setError(error.message);
      // revert by reload
      await loadAll();
    }

    setSaving(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl text-white mb-1">Settings</h2>
          <p className="text-xs text-[#808080]">
            Live configuration & status {saving ? <span className="ml-2 text-[#606060]">· saving…</span> : null}
          </p>
        </div>

        <div className="text-xs text-[#606060]">
          {loading ? "Loading…" : model?.updated_at ? `Model updated ${formatTsShort(model.updated_at)}` : ""}
        </div>
      </div>

      {error ? (
        <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4 text-xs text-red-300">
          Supabase error: {error}
        </div>
      ) : null}

      {/* Model Parameters */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <SettingsIcon className="w-5 h-5 text-[#d4af37]" />
          <h3 className="text-sm text-white">Model Parameters</h3>
        </div>

        <div className="space-y-4">
          <SettingRow
            label="Minimum EV Threshold"
            value={loading ? "…" : modelParams.minEv}
            description="Minimum expected value to trigger a play recommendation"
          />
          <SettingRow
            label="Simulation Count"
            value={loading ? "…" : modelParams.sims}
            description="Number of Monte Carlo iterations per game"
          />
          <SettingRow
            label="Calibration Window"
            value={loading ? "…" : modelParams.calib}
            description="Historical period used for model calibration"
          />
          <SettingRow
            label="Anchor Weight Range"
            value={loading ? "…" : modelParams.anchor}
            description="Dynamic weight given to sharp market lines"
          />
          <SettingRow
            label="Max Units per Play"
            value={loading ? "…" : modelParams.maxUnits}
            description={app ? "Stored in app_settings" : "Enable by creating app_settings table"}
            editable={!!app}
            onEdit={(v) => updateSetting({ max_units_per_play: clampNum(v, 0, 5) })}
          />
        </div>
      </div>

      {/* Data Sources */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <Database className="w-5 h-5 text-[#d4af37]" />
          <h3 className="text-sm text-white">Data Sources</h3>
        </div>

        <div className="space-y-3">
          {books.map((b) => (
            <DataSourceRow
              key={b.name}
              name={b.name}
              status={b.active ? "Active" : "Stale"}
              updateFreq="60s"
              priority={b.priority === "Sharp" ? "Sharp" : undefined}
              dot={b.active ? "green" : "amber"}
            />
          ))}
        </div>

        <div className="mt-3 text-[11px] text-[#606060]">
          Status is based on the age of the latest <span className="text-white">odds_snapshot.ts</span> row.
        </div>
      </div>

      {/* Notifications */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <Bell className="w-5 h-5 text-[#d4af37]" />
          <h3 className="text-sm text-white">Notifications</h3>
        </div>

        <div className="space-y-3 text-xs">
          <NotificationRow
            label="New High-Value Plays"
            description="Alert when EV > 5% and PrismScore > 80"
            enabled={!!(app?.notify_high_value ?? true)}
            disabled={!app}
            onToggle={() => updateSetting({ notify_high_value: !(app?.notify_high_value ?? true) })}
          />
          <NotificationRow
            label="Line Movement"
            description="Notify on significant odds changes"
            enabled={!!(app?.notify_line_movement ?? false)}
            disabled={!app}
            onToggle={() => updateSetting({ notify_line_movement: !(app?.notify_line_movement ?? false) })}
          />
          <NotificationRow
            label="Model Updates"
            description="Alert when new model version is deployed"
            enabled={!!(app?.notify_model_updates ?? true)}
            disabled={!app}
            onToggle={() => updateSetting({ notify_model_updates: !(app?.notify_model_updates ?? true) })}
          />
          <NotificationRow
            label="Results Summary"
            description="Daily performance recap"
            enabled={!!(app?.notify_results_summary ?? true)}
            disabled={!app}
            onToggle={() => updateSetting({ notify_results_summary: !(app?.notify_results_summary ?? true) })}
          />

          {!app ? (
            <div className="pt-2 text-[11px] text-[#606060]">
              To persist toggles, create <span className="text-white">app_settings</span> (singleton row id=1).
            </div>
          ) : null}
        </div>
      </div>

      {/* System Status */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <Zap className="w-5 h-5 text-[#d4af37]" />
          <h3 className="text-sm text-white">System Status</h3>
        </div>

        <div className="grid grid-cols-4 gap-4 text-xs">
          <SystemStat label="Last Odds Sync" value={system.lastFullSync} valueTone={system.oddsAgeMin != null && system.oddsAgeMin <= 5 ? "good" : "warn"} />
          <SystemStat label="Last MC Run" value={system.lastMcRun} valueTone={system.mcAgeMin != null && system.mcAgeMin <= 30 ? "good" : "warn"} />
          <SystemStat label="Model Status" value={model?.status ?? "—"} valueTone={model?.status === "Production" ? "good" : "warn"} />
          <SystemStat label="Model Version" value={model?.version ?? "—"} valueTone={model?.version ? "good" : "warn"} />
        </div>

        <div className="mt-3 text-[11px] text-[#606060]">
          These are real timestamps from <span className="text-white">odds_snapshot</span> and{" "}
          <span className="text-white">monte_carlo_runs</span>.
        </div>
      </div>

      {/* Version Footer */}
      <div className="bg-[#0f0f0f] border border-[#2a2a2a] rounded-lg p-4">
        <div className="flex items-center justify-between text-xs">
          <div className="text-[#606060]">
            PrismSports Model {model?.version ?? "—"}
            {model?.release_date ? ` · Released ${formatDate(model.release_date)}` : ""}
          </div>
          <div className="text-[#808080]">© {new Date().getFullYear()} PrismSports Analytics</div>
        </div>
      </div>
    </div>
  );
}

/* Components */

function SettingRow({
  label,
  value,
  description,
  editable,
  onEdit,
}: {
  label: string;
  value: string;
  description: string;
  editable?: boolean;
  onEdit?: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#1a1a1a] last:border-0 gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-xs text-white mb-0.5">{label}</div>
        <div className="text-[10px] text-[#606060]">{description}</div>
      </div>

      {!editable ? (
        <div className="text-xs text-[#d4af37]">{value}</div>
      ) : (
        <InlineNumber
          value={value}
          onCommit={(n) => onEdit?.(n)}
        />
      )}
    </div>
  );
}

function InlineNumber({ value, onCommit }: { value: string; onCommit: (n: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  return editing ? (
    <div className="flex items-center gap-2">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="w-24 bg-[#0b0b0b] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-white outline-none focus:border-[#3a3a3a]"
        inputMode="decimal"
      />
      <button
        type="button"
        className="text-xs px-2 py-1 rounded border border-[#2a2a2a] hover:border-[#3a3a3a] text-[#cfcfcf] hover:text-white"
        onClick={() => {
          const n = Number(draft);
          if (Number.isFinite(n)) onCommit(n);
          setEditing(false);
        }}
      >
        Save
      </button>
    </div>
  ) : (
    <button
      type="button"
      className="text-xs text-[#d4af37] hover:opacity-80"
      onClick={() => setEditing(true)}
      title="Click to edit"
    >
      {value}
    </button>
  );
}

function DataSourceRow({
  name,
  status,
  updateFreq,
  priority,
  dot,
}: {
  name: string;
  status: string;
  updateFreq: string;
  priority?: string;
  dot?: "green" | "amber";
}) {
  const dotClass = dot === "amber" ? "bg-amber-400" : "bg-emerald-500";

  return (
    <div className="flex items-center justify-between py-2 text-xs border-b border-[#1a1a1a] last:border-0">
      <div className="flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full ${dotClass}`} />
        <div className="text-white">{name}</div>
        {priority && (
          <span className="px-2 py-0.5 bg-[#d4af37]/20 text-[#d4af37] rounded text-[10px] border border-[#d4af37]/40">
            {priority}
          </span>
        )}
      </div>
      <div className="flex items-center gap-4">
        <div className="text-[#606060]">Update: {updateFreq}</div>
        <div className={status === "Active" ? "text-emerald-500" : "text-amber-300"}>{status}</div>
      </div>
    </div>
  );
}

function NotificationRow({
  label,
  description,
  enabled,
  disabled,
  onToggle,
}: {
  label: string;
  description: string;
  enabled: boolean;
  disabled?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#1a1a1a] last:border-0 gap-4">
      <div className="flex-1">
        <div className="text-white mb-0.5">{label}</div>
        <div className="text-[10px] text-[#606060]">{description}</div>
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={onToggle}
        className={[
          "w-10 h-5 rounded-full relative transition-colors",
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
          enabled ? "bg-[#d4af37]" : "bg-[#2a2a2a]",
        ].join(" ")}
        aria-label={`${label} toggle`}
      >
        <div
          className={[
            "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all",
            enabled ? "right-0.5" : "left-0.5",
          ].join(" ")}
        />
      </button>
    </div>
  );
}

function SystemStat({
  label,
  value,
  valueTone,
}: {
  label: string;
  value: string;
  valueTone?: "good" | "warn";
}) {
  const tone =
    valueTone === "good" ? "text-emerald-500" : valueTone === "warn" ? "text-amber-300" : "text-white";

  return (
    <div>
      <div className="text-[#606060] mb-1">{label}</div>
      <div className={tone}>{value}</div>
    </div>
  );
}

/* helpers */

function formatInt(n: number) {
  try {
    return new Intl.NumberFormat().format(n);
  } catch {
    return String(n);
  }
}

function formatDate(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
}

function formatTsShort(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function minutesSince(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const diffMs = Date.now() - d.getTime();
  return Math.max(0, Math.round(diffMs / 60000));
}

function formatRelativeMinutes(mins: number | null) {
  if (mins == null) return "—";
  if (mins <= 0) return "just now";
  if (mins === 1) return "1 min ago";
  return `${mins} min ago`;
}

function clampNum(raw: number, min: number, max: number) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

