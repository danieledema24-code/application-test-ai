// Evidence removed by the retention policy (design P5 §13.4, check 37): the record stays, the file is gone. Every
// viewer shows this placeholder (the API's `removed` text) instead of a broken image, video or download link.

/** The removal text when retention removed this evidence file, else null. */
export function removedText(ev: { removed?: string | null } | null | undefined): string | null {
  return ev?.removed || null;
}

export function RemovedEvidence({ text, className = "" }: { text: string; className?: string }) {
  return (
    <p data-testid="removed-evidence" className={`flex min-h-24 items-center justify-center rounded-md bg-overlay px-4 py-6 text-center text-small text-fg-muted ${className}`}>
      {text}
    </p>
  );
}
