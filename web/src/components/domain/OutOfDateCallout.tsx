import { Callout } from "@/components/ui";

/** Upstream-changed banner (design P2 §5.8, §8.5, §9). The workspace stays fully usable. */
export function OutOfDateCallout({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <Callout tone="warning" title={title} actions={actions}>
      {children}
    </Callout>
  );
}
