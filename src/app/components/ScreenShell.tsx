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
    <PageFrame>
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-4 shadow-[0_16px_40px_-32px_rgba(0,0,0,0.7)] sm:px-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#d4af37]">
              Prism
              <ChevronRight className="h-3 w-3" />
              Command
            </div>
            <h1 className="mt-1 text-xl font-semibold text-white md:text-2xl">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-white/60">{subtitle}</p> : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {status?.map((item) => (
              <div
                key={item.label}
                className="flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3 py-1 text-xs text-white/70"
              >
                <span className="text-white/40">{item.label}</span>
                <span className="font-semibold text-white">{item.value}</span>
              </div>
            ))}
            {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
          </div>
        </div>
      </section>

      {children}
    </PageFrame>
  );
}

type PageFrameProps = {
  children: React.ReactNode;
};

export function PageFrame({ children }: PageFrameProps) {
  return <div className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col gap-6">{children}</div>;
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
