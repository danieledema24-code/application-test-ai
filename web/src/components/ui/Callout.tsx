import { AlertTriangle, CircleCheck, CircleX, Info, type LucideIcon } from "lucide-react";

type CalloutTone = "info" | "warning" | "success" | "danger" | "neutral";

const STYLES: Record<CalloutTone, { box: string; icon: LucideIcon; iconCls: string }> = {
  info: { box: "bg-info-bg ring-info-line", icon: Info, iconCls: "text-info-fg" },
  warning: { box: "bg-warning-bg ring-warning-line", icon: AlertTriangle, iconCls: "text-warning-fg" },
  success: { box: "bg-success-bg ring-success-line", icon: CircleCheck, iconCls: "text-success-fg" },
  danger: { box: "bg-danger-bg ring-danger-line", icon: CircleX, iconCls: "text-danger-fg" },
  neutral: { box: "bg-elevated ring-line-strong", icon: Info, iconCls: "text-fg-muted" },
};

/** Info / warning / success / danger banner. Body text stays fg-strong on the tint for contrast. */
export function Callout({
  tone = "info",
  title,
  children,
  actions,
  role,
  className = "",
  icon,
}: {
  tone?: CalloutTone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  /** "alert" or "status" when the callout appears in response to an action. */
  role?: "alert" | "status";
  className?: string;
  icon?: LucideIcon;
}) {
  const s = STYLES[tone];
  const Icon = icon ?? s.icon;
  return (
    <div role={role} className={`flex flex-wrap items-start gap-3 rounded-lg px-4 py-3 ring-1 ring-inset ${s.box} ${className}`}>
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${s.iconCls}`} aria-hidden />
      <div className="min-w-0 flex-1 text-body text-fg-strong">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5 text-fg" : ""}>{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
