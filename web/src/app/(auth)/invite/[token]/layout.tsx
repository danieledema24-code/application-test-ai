import type { Metadata } from "next";

// The token is in the URL: never send it on as a referrer (design P3 §17.3).
export const metadata: Metadata = { title: "Join a workspace", referrer: "no-referrer" };

export default function InviteLayout({ children }: { children: React.ReactNode }) {
  return children;
}
