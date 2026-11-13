"use client";

import Link from "next/link";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import type { ArtefactRef, Chain } from "@/lib/contract";
import { useApi } from "@/lib/hooks";
import { CHAIN_KEY, PHASE4_SR, chainLevels, keyHref, levelName, type ChainLevel as Level } from "@/lib/traceability";
import { Button, EmptyState, ErrorState, LinkButton, Skeleton } from "@/components/ui";
import { useProject } from "@/components/workspace/ProjectContext";
import { isNotFound } from "@/components/testcases/hooks";

const SHOW = 5;
const LATER: Record<string, string> = { automation_script: "Script", execution_result: "Result", defect: "Defect" };

function ItemLink({ item, projectId, here }: { item: ArtefactRef; projectId: string; here?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <Link href={keyHref(projectId, item.key)} className="font-mono text-navy-700 underline underline-offset-2">
        {item.key}
      </Link>
      {item.label && <span className="break-words">{item.label}</span>}
      {here && <span className="font-semibold text-fg-strong">(you are here)</span>}
    </span>
  );
}

function LevelItems({ level, projectId }: { level: Level; projectId: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? level.items : level.items.slice(0, SHOW);
  const rest = level.items.length - shown.length;
  return (
    <span className="inline-flex flex-col gap-1">
      {shown.map((it) => (
        <ItemLink key={it.key} item={it} projectId={projectId} here={level.root} />
      ))}
      {rest > 0 && (
        <Button variant="ghost" className="self-start" onClick={() => setAll(true)}>
          Show {rest} more {levelName(level.type, rest).toLowerCase()}
        </Button>
      )}
    </span>
  );
}

/** One level per nested `ul`, with the level name in text so the structure doesn't rely on indentation. */
function Nested({ levels, projectId, tail }: { levels: Level[]; projectId: string; tail: ReactNode }) {
  if (levels.length === 0) return <ul className="ml-4 border-l border-line pl-4">{tail}</ul>;
  const [first, ...rest] = levels;
  return (
    <ul className="ml-4 border-l border-line pl-4 first:ml-0">
      <li className="space-y-2 py-1">
        <p className="flex flex-wrap gap-x-2">
          <span className="font-medium text-fg-muted">{levelName(first.type, first.items.length)}</span>
          <LevelItems level={first} projectId={projectId} />
        </p>
        <Nested levels={rest} projectId={projectId} tail={tail} />
      </li>
    </ul>
  );
}

function ChainView() {
  const p = useProject();
  const { key: raw } = useParams<{ key: string }>();
  const key = decodeURIComponent(raw);
  const valid = CHAIN_KEY.test(key);
  const chain = useApi<Chain>(valid ? `/projects/${p.id}/traceability/chain` : null, { key }, { shouldRetryOnError: false });

  useEffect(() => {
    document.title = `Trace ${key} · Traceability · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [key, p.project?.name]);

  const back = <LinkButton href={`/projects/${p.id}/traceability`}>Back to traceability</LinkButton>;
  if (!valid || isNotFound(chain.error)) return <EmptyState title={`We couldn’t find ${key} in this project.`} action={back} />;
  if (chain.error && !chain.data) return <ErrorState error={chain.error} title="Couldn’t load traceability." message="Try again." onRetry={() => void chain.mutate()} />;
  if (!chain.data)
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-9 w-80" />
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );

  const c = chain.data;
  const { chain: levels, side } = chainLevels(c);
  const later = (c.later_phase ?? []).map((l) => LATER[l.type] ?? l.type).join(" · ");
  const tail = later ? (
    <li className="py-1 text-fg-muted">
      {later}: {PHASE4_SR}
    </li>
  ) : null;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-small">
          <Link href={`/projects/${p.id}/traceability`} className="text-navy-700 underline underline-offset-2">
            Traceability
          </Link>
        </p>
        <h1 tabIndex={-1} className="break-words text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
          Trace {c.root.key}
          {c.root.label ? ` · ${c.root.label}` : ""}
        </h1>
      </div>
      <section aria-labelledby="chain-h" className="space-y-2">
        <h2 id="chain-h" className="text-h3 font-semibold text-fg-strong">
          Chain
        </h2>
        <div className="-ml-4">
          <Nested levels={levels} projectId={p.id} tail={tail} />
        </div>
      </section>
      {side.length > 0 && (
        <section aria-labelledby="related-h" className="space-y-2">
          <h2 id="related-h" className="text-h3 font-semibold text-fg-strong">
            Related
          </h2>
          <ul className="space-y-2">
            {side.map((l) => (
              <li key={l.type} className="flex flex-wrap gap-x-2">
                <span className="font-medium text-fg-muted">{levelName(l.type, l.items.length)}</span>
                <LevelItems level={l} projectId={p.id} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default function ChainPage() {
  return (
    <Suspense>
      <ChainView />
    </Suspense>
  );
}
