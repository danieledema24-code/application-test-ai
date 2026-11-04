"use client";

import { SWRConfig } from "swr";
import { AuthProvider } from "@/lib/auth";
import { ToastProvider } from "@/components/ui/Toast";
import { ApiError } from "@/lib/api";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        shouldRetryOnError: (err: unknown) => !(err instanceof ApiError && err.status >= 400 && err.status < 500),
        errorRetryCount: 2,
      }}
    >
      <AuthProvider>
        <ToastProvider>{children}</ToastProvider>
      </AuthProvider>
    </SWRConfig>
  );
}
