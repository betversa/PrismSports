import React from "react";
import { ChevronRight } from "lucide-react";

export type ScreenShellStat = {
  label: string;
  value: string;
  helper?: string;
};

type ScreenShellProps = {
  title: string;
  subtitle?: string;
  status?: ScreenShellStat[];
  actions?: React.ReactNode;
  children: React.ReactNode;
};

export function ScreenShell({ title, subtitle, status, actions, children }: ScreenShellProps) {
  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.02] px-5 py-6 md:px-8 md:py-8">
        <div className="pointer-events-none absolute -left-20 top-0 h-48 w-48 rounded-full bg-[#d4af37]/15 blur-[120px]" />
        <div className="pointer-events-none absolute bottom-0 right-0 h-52 w-52 rounded-full bg-white/10 blur-[120px]" />
        <div className="relative z-10 flex flex-col gap-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-[#d4af37]">
                Prism Sports Intelligence
                <ChevronRight className="h-3 w-3" />
                Live Suite
              </div>
              <div>
                <h1 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">{title}</h1>
                {subtitle ? (
                  <p className="mt-2 text-sm text-white/60 md:text-base">{subtitle}</p>
                ) : null}
              </div>
            </div>
            {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
          </div>
          {status && status.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {status.map((item) => (
                <div
                  key={item.label}
                  className="rounded-2xl border border-white/10 bg-gradient-to-br from-white/10 via-white/5 to-transparent px-4 py-3"
                >
                  <p className="text-xs uppercase tracking-[0.2em] text-white/40">{item.label}</p>
                  <p className="mt-2 text-lg font-semibold text-white">{item.value}</p>
                  {item.helper ? (
                    <p className="mt-1 text-xs text-white/50">{item.helper}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>
      {children}
    </div>
  );
}

type SectionHeaderProps = {
  title: string;
  description?: string;
  action?: React.ReactNode;
};

export function SectionHeader({ title, description, action }: SectionHeaderProps) {
  return (
    <div className="flex flex-col gap-2 border-b border-white/10 pb-4 md:flex-row md:items-center md:justify-between">
      <div>
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        {description ? <p className="mt-1 text-sm text-white/50">{description}</p> : null}
      </div>
      {action ? <div className="flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

type SectionCardProps = {
  children: React.ReactNode;
  className?: string;
};

export function SectionCard({ children, className }: SectionCardProps) {
  return (
    <section
      className={`rounded-3xl border border-white/10 bg-white/[0.02] p-4 shadow-[0_20px_60px_-40px_rgba(0,0,0,0.6)] md:p-6 ${
        className ?? ""
      }`}
    >
      {children}
    </section>
  );
}
