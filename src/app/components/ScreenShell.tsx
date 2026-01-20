import React from "react";
import { PageFrame, PageHeader, Panel, StatusChip } from "./ui/PrismUI";

export type ScreenShellStat = StatusChip & { helper?: string };

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
      <PageHeader
        title={title}
        subtitle={subtitle}
        status={status?.map((item) => ({ label: item.label, value: item.value }))}
        actions={actions}
      />
      {children}
    </PageFrame>
  );
}

type SectionHeaderProps = {
  title: string;
  description?: string;
  action?: React.ReactNode;
};

export function SectionHeader({ title, description, action }: SectionHeaderProps) {
  return (
    <div className="flex flex-col gap-2 border-b border-[var(--border-subtle)] pb-4 md:flex-row md:items-center md:justify-between">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text)]">{title}</h2>
        {description ? <p className="mt-1 text-sm text-[var(--text-muted)]">{description}</p> : null}
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
  return <Panel className={className}>{children}</Panel>;
}
