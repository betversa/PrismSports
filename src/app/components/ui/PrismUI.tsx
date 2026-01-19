import React from "react";

export type StatusChip = { label: string; value: string };

export function AppShell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">{children}</div>;
}

export function PageFrame({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col gap-6">{children}</div>;
}

export function PageHeader({
  title,
  subtitle,
  status,
  actions,
}: {
  title: string;
  subtitle?: string;
  status?: StatusChip[];
  actions?: React.ReactNode;
}) {
  return (
    <div className="border-b border-[var(--border-subtle)] pb-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-[var(--text)] md:text-xl">{title}</h1>
          {subtitle ? <p className="mt-0.5 text-xs text-[var(--text-muted)]">{subtitle}</p> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {status?.map((item) => (
            <Chip key={item.label} label={item.label} value={item.value} />
          ))}
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </div>
    </div>
  );
}

export function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3 shadow-[var(--shadow-soft)] md:p-4 ${
        className ?? ""
      }`}
    >
      {children}
    </section>
  );
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3 ${className ?? ""}`}>
      {children}
    </div>
  );
}

export function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-1)] px-2.5 py-1 text-[11px] text-[var(--text-muted)]">
      <span>{label}</span>
      <span className="font-semibold text-[var(--text)]">{value}</span>
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost";
  disabled?: boolean;
}) {
  const base =
    "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(212,175,55,0.35)]";
  const variants = {
    primary: "border-[rgba(212,175,55,0.5)] bg-[rgba(212,175,55,0.12)] text-white hover:bg-[rgba(212,175,55,0.18)]",
    ghost: "border-white/10 bg-white/5 text-white/80 hover:bg-white/10",
  };
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]}`}>
      {children}
    </button>
  );
}

export function IconButton({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/70 hover:bg-white/10"
    >
      {children}
    </button>
  );
}

export function TableFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-1)] shadow-[var(--shadow-soft)]">
      {children}
    </div>
  );
}

export function DataSourceErrorPanel({ missing }: { missing: string[] }) {
  return (
    <PageFrame>
      <Panel>
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--gold)]">Configuration</div>
          <div className="text-lg font-semibold text-[var(--text)]">
            Data source not configured. Supabase environment variables missing.
          </div>
          <div className="text-sm text-[var(--text-muted)]">
            Add the following environment variables to enable data-backed screens.
          </div>
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-2)] p-3 text-xs text-white/80">
            <div className="font-semibold text-[var(--text)]">Missing</div>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-white/70">
              {missing.map((item) => `- ${item}`).join("\n")}
            </pre>
          </div>
        </div>
      </Panel>
    </PageFrame>
  );
}
