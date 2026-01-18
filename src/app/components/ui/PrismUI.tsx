import React from "react";

export type StatusChip = { label: string; value: string };

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] -z-10"
        style={{
          background:
            "radial-gradient(1200px 420px at 10% -10%, rgba(212,175,55,0.18), transparent 55%), radial-gradient(900px 420px at 88% 0%, rgba(255,255,255,0.05), transparent 60%), linear-gradient(180deg, rgba(255,255,255,0.04), rgba(7,7,7,0.98) 60%, rgba(7,7,7,1) 100%)",
        }}
      />
      {children}
    </div>
  );
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
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-1)] px-4 py-4 shadow-[var(--shadow-soft)] sm:px-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--gold)]">Prism Suite</div>
          <h1 className="mt-1 text-xl font-semibold text-[var(--text)] md:text-2xl">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm text-[var(--text-muted)]">{subtitle}</p> : null}
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
      className={`rounded-3xl border border-[var(--border-subtle)] bg-[var(--surface-1)] p-4 shadow-[var(--shadow-soft)] md:p-6 ${
        className ?? ""
      }`}
    >
      {children}
    </section>
  );
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-2)] p-4 ${className ?? ""}`}>
      {children}
    </div>
  );
}

export function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3 py-1 text-xs text-white/70">
      <span className="text-white/40">{label}</span>
      <span className="font-semibold text-white">{value}</span>
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
    <div className="overflow-hidden rounded-3xl border border-[var(--border-subtle)] bg-[var(--surface-1)] shadow-[var(--shadow-soft)]">
      {children}
    </div>
  );
}
