import Link from "next/link";

/** A labelled number (design spec §5, §8.1). Promoted from the dashboard's Kpi. Never a live region. */
export function StatTile({
  label,
  value,
  hint,
  icon,
  href,
  size = "md",
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  /** Makes the whole tile a link (e.g. to a filtered list). */
  href?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className={`${size === "sm" ? "text-small" : "text-body"} font-medium text-fg-muted`}>{label}</p>
        {icon && (
          <span className="text-fg-muted" aria-hidden>
            {icon}
          </span>
        )}
      </div>
      <p className={`${size === "sm" ? "mt-1 text-h2" : "mt-2 text-display"} font-semibold tabular-nums tracking-tight text-fg-strong`}>{value}</p>
      {hint && <p className="mt-1 text-small text-fg-muted">{hint}</p>}
    </>
  );
  const cls = `block min-w-0 rounded-lg border border-line bg-surface shadow-xs ${size === "sm" ? "px-4 py-3" : "p-5"} ${className}`;
  if (href)
    return (
      <Link href={href} className={`${cls} transition-colors duration-150 hover:border-line-strong hover:bg-elevated`}>
        {body}
      </Link>
    );
  return <div className={cls}>{body}</div>;
}
