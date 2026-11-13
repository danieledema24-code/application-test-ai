/** A data table. Its scroll container is focusable and labelled so keyboard users can scroll it (§11). */
export function Table({ children, className = "", label }: { children: React.ReactNode; className?: string; label?: string }) {
  return (
    <div className={`scrollbar-thin relative overflow-x-auto ${className}`} tabIndex={label ? 0 : undefined} role={label ? "region" : undefined} aria-label={label}>
      <table className="min-w-full divide-y divide-line text-small" aria-label={label}>
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return <thead className="bg-elevated">{children}</thead>;
}

export function Th({ children, className = "", srOnly }: { children?: React.ReactNode; className?: string; srOnly?: boolean }) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap px-4 py-2.5 text-left text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted ${className}`}
    >
      {srOnly ? <span className="sr-only">{children}</span> : children}
    </th>
  );
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-line bg-surface">{children}</tbody>;
}

export function Td({ children, className = "", colSpan, rowHeader }: { children?: React.ReactNode; className?: string; colSpan?: number; rowHeader?: boolean }) {
  if (rowHeader)
    return (
      <th scope="row" colSpan={colSpan} className={`px-4 py-3 text-left align-middle font-medium text-fg-strong ${className}`}>
        {children}
      </th>
    );
  return (
    <td colSpan={colSpan} className={`px-4 py-3 align-middle text-fg ${className}`}>
      {children}
    </td>
  );
}

export function Tr({ children, className = "", onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  return (
    <tr className={`hover:bg-overlay ${onClick ? "cursor-pointer" : ""} ${className}`} onClick={onClick}>
      {children}
    </tr>
  );
}
