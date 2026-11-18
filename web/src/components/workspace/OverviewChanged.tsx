"use client";

// Overview "Application changed" banner (design P6 §4.5, P6-06): directly under the header while the latest rescan's
// change set has open impact items. Not dismissible; it goes away when the open count reaches 0. Everyone sees it; the
// button is a link, so viewers can open the change set too.

import Link from "next/link";
import { changedBanner, g2EverApproved, type ChangeSetList } from "@/lib/change";
import { fmtShortDate } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { Callout } from "@/components/ui";
import { useProject } from "./ProjectContext";

export function ChangedBanner() {
  const p = useProject();
  // Rescans exist only after Gate 2 (D25); before it there is nothing to compare. Same key as the Changes tab.
  const q = useApi<ChangeSetList>(g2EverApproved(p.workflow) ? `/projects/${p.id}/changes` : null, undefined, { shouldRetryOnError: false });
  const b = changedBanner(q.data?.items, fmtShortDate);
  if (!b) return null;
  return (
    <Callout
      tone="info"
      actions={
        <Link
          href={`/projects/${p.id}/discovery/changes/${b.key}`}
          className="inline-flex h-10 items-center rounded-md bg-surface px-4 text-body font-medium text-fg-strong ring-1 ring-inset ring-line-input hover:bg-overlay"
        >
          Open {b.key}
        </Link>
      }
    >
      <p className="[overflow-wrap:anywhere]">{b.text}</p>
      {b.rebaseline && <p className="mt-1">{b.rebaseline}</p>}
    </Callout>
  );
}
