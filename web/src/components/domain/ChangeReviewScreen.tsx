"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { ChangeReview as ChangeReviewT, ChangeReviewApply, ReviewAction } from "@/lib/contract";
import { EmptyState, ErrorState, LinkButton, Skeleton, useToast } from "@/components/ui";
import { ChangeReview, isChange } from "./ChangeReview";

/**
 * Review regenerated output (design P2 §5.7; also the strategy and plan): the candidate run's grouped diff.
 * Nothing is applied until [Apply n changes]; [Discard] keeps the run in history as "Discarded".
 */
export function ChangeReviewScreen({
  run,
  apiBase,
  title,
  backHref,
  backLabel,
  afterApplyHref,
  onDone,
  versionNoun = "Version",
  reviewProps,
  banner,
}: {
  run: number | null;
  /** e.g. `/projects/{id}/stages/requirements/runs/5/review` or `/projects/{id}/test-plan/changes/3`. */
  apiBase: string | null;
  title: string;
  backHref: string;
  backLabel: string;
  afterApplyHref: string;
  onDone: () => void;
  /** "Design run" instead of "Version" in the header and toasts. */
  versionNoun?: string;
  reviewProps?: Pick<React.ComponentProps<typeof ChangeReview>, "viewer" | "applyNote" | "protectedSub" | "itemHref" | "discardBody">;
  banner?: React.ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const review = useApi<ChangeReviewT>(apiBase, { include_unchanged: true }, { shouldRetryOnError: false });
  const r = review.data;

  const header = (
    <div className="space-y-1">
      <nav aria-label="Breadcrumb" className="text-small text-fg-muted">
        <Link href={backHref} className="text-navy-700 underline underline-offset-2">
          {backLabel}
        </Link>{" "}
        / Review changes
      </nav>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
          {title}
        </h1>
        {r && (
          <p className="text-body text-fg-muted">
            {r.current_version ? `${versionNoun} ${r.current_version} (current) → ` : ""}proposed {versionNoun.toLowerCase()} {r.candidate_version}
          </p>
        )}
      </div>
      {r?.guidance && <p className="text-small text-fg">Guidance used: “{r.guidance}”</p>}
    </div>
  );

  if (!apiBase || !run) return <div className="space-y-6">{header}<EmptyState title="No regenerated version to review." action={<LinkButton href={backHref}>{`Back to ${backLabel}`}</LinkButton>} /></div>;
  if (review.error && !r)
    return (
      <div className="space-y-6">
        {header}
        {review.error instanceof ApiError && review.error.status === 404 ? (
          <EmptyState title="This regenerated version doesn’t exist." action={<LinkButton href={backHref}>{`Back to ${backLabel}`}</LinkButton>} />
        ) : (
          <ErrorState error={review.error} title="Couldn’t load the changes." message="Try again." onRetry={() => void review.mutate()} />
        )}
      </div>
    );
  if (!r)
    return (
      <div className="space-y-6" aria-busy="true">
        {header}
        <Skeleton className="h-10" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
        <span className="sr-only" role="status">
          Loading the changes…
        </span>
      </div>
    );
  const done = r.review_status !== "pending_review";
  return (
    <div className="space-y-6">
      {header}
      {done && (
        <EmptyState
          title={r.review_status === "applied" ? `Version ${r.candidate_version} was already applied.` : `Version ${r.candidate_version} was discarded.`}
          action={<LinkButton href={backHref}>{`Back to ${backLabel}`}</LinkButton>}
        />
      )}
      {banner}
      <ChangeReview
        {...reviewProps}
        review={r}
        readOnly={done}
        onApply={async (decisions: Record<string, ReviewAction>) => {
          const body: ChangeReviewApply = { decisions };
          const n = r.items.filter((i) => isChange(i, decisions[i.lineage_id] ?? i.default_action)).length;
          try {
            await api(`${apiBase}/apply`, { body });
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) throw new Error("These results can’t be applied: they were already handled or a newer version exists. Reload the page.");
            throw new Error(`Couldn’t apply the changes. Nothing was changed. ${err instanceof Error ? err.message : ""}`.trim());
          }
          toast(`${versionNoun} ${r.candidate_version} applied: ${n} change${n === 1 ? "" : "s"}.`);
          onDone();
          router.push(afterApplyHref);
        }}
        onDiscard={async () => {
          try {
            await api(`${apiBase}/discard`, { body: {} });
            toast(`Regeneration discarded. ${r.current_version ? `Version ${r.current_version} stays current.` : ""}`.trim(), "info");
            onDone();
            router.push(backHref);
          } catch (err) {
            toast(`Couldn’t discard. ${err instanceof Error ? err.message : ""}`.trim(), "error");
          }
        }}
      />
    </div>
  );
}

