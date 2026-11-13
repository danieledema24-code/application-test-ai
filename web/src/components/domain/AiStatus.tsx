import { Badge } from "@/components/ui";

export type AiMode = "on" | "off" | "unavailable" | "limited";

/** Header chip for the assistant's AI mode (design P2 §11.5). Text carries the state, the dot is decoration. */
export function AiStatus({ mode, provider }: { mode: AiMode; provider?: string | null }) {
  if (mode === "on")
    return (
      <Badge tone="green">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success-solid" />
        AI on{provider ? ` · ${provider}` : ""}
      </Badge>
    );
  if (mode === "unavailable") return <Badge tone="amber">AI unavailable</Badge>;
  if (mode === "limited") return <Badge tone="amber">AI limit reached</Badge>;
  return <Badge tone="grey">AI off</Badge>;
}
