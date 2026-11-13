"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, getToken, setToken } from "./api";
import type { AuthResponse, Me, Organisation, Role, User } from "./contract";

export type RegisterInput = { full_name: string; email: string; password: string; organisation_name: string };

type AuthState = {
  user: User | null;
  organisation: Organisation | null;
  role: Role | null;
  canApprove: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      setMe(await api<Me>("/auth/me"));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const accept = useCallback((res: AuthResponse) => {
    setToken(res.token);
    // Owners and admins can approve gates by default (contract: Roles); /auth/me refines it.
    setMe({ user: res.user, organisation: res.organisation, role: res.role, can_approve: res.role === "owner" || res.role === "admin" });
    void api<Me>("/auth/me")
      .then(setMe)
      .catch(() => undefined);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      accept(await api<AuthResponse>("/auth/login", { body: { email, password }, noAuthRedirect: true }));
    },
    [accept],
  );

  const register = useCallback(
    async (data: RegisterInput) => {
      accept(await api<AuthResponse>("/auth/register", { body: data, noAuthRedirect: true }));
    },
    [accept],
  );

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST", noAuthRedirect: true });
    } catch {
      /* the token may already be invalid; sign out locally regardless */
    }
    setToken(null);
    setMe(null);
    // replace(): Back must not return to an app page that still shows data.
    window.location.replace("/login?signed_out=1");
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user: me?.user ?? null,
      organisation: me?.organisation ?? null,
      role: me?.role ?? null,
      canApprove: me?.can_approve ?? false,
      loading,
      login,
      register,
      logout,
      refresh,
    }),
    [me, loading, login, register, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export function firstName(user: { full_name?: string } | null | undefined): string {
  return (user?.full_name || "").trim().split(/\s+/)[0] || "";
}
