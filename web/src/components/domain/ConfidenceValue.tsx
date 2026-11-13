import { AlertCircle } from "lucide-react";
import { confidenceBand, confidenceText } from "@/lib/requirements";
import { Tooltip } from "@/components/ui";

const TIP = "The agent’s confidence in this requirement, based on how much evidence supports it. It isn’t a test result.";

/** "68% · Medium" with a tooltip; Low adds a muted icon. No colour bar (design P2 §5.4). */
export function ConfidenceValue({ confidence, className = "" }: { confidence: number | null | undefined; className?: string }) {
  if (typeof confidence !== "number") return <span className="text-fg-muted">—</span>;
  const low = confidenceBand(confidence) === "low";
  return (
    <Tooltip content={TIP}>
      <span tabIndex={0} className={`inline-flex items-center gap-1 whitespace-nowrap tabular-nums text-fg ${className}`}>
        {low && <AlertCircle className="h-3.5 w-3.5 text-fg-muted" aria-hidden />}
        {confidenceText(confidence)}
        <span className="sr-only">. Confidence: {TIP}</span>
      </span>
    </Tooltip>
  );
}
