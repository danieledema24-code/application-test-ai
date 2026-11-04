export function Table({ children, className = "", label }: { children: React.ReactNode; className?: string; label?: string }) {
  return (
    <div className={`scrollbar-thin overflow-x-auto ${className}`}>
      <table className="min-w-full divide-y divide-line text-sm" aria-label={label}>
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return <thead className="bg-elevated/80">{children}</thead>;
}

export function Th({ children, className = "", srOnly }: { children?: React.ReactNode; className?: string; srOnly?: boolean }) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-fg-muted ${className}`}
    >
      {srOnly ? <span className="sr-only">{children}</span> : children}
    </th>
  );
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-line bg-surface">{children}</tbody>;
}

export function Td({ children, className = "", colSpan }: { children?: React.ReactNode; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={`px-4 py-3 align-middle text-fg ${className}`}>
      {children}
    </td>
  );
}

export function Tr({ children, className = "", onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  return (
    <tr className={`hover:bg-elevated/70 ${onClick ? "cursor-pointer" : ""} ${className}`} onClick={onClick}>
      {children}
    </tr>
  );
}
