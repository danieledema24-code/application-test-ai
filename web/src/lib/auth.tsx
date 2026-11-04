"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, getToken, setToken } from "./api";
import type { AuthResponse, Organisation, User } from "./types";

type AuthState = {
  user: User | null;
  organisation: Organisation | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: { fullName: string; email: string; password: string; organisationName: string }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [organisation, setOrganisation] = useState<Organisation | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setOrganisation(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api<{ user: User; organisation: Organisation }>("/auth/me");
      setUser(me.user);
      setOrganisation(me.organisation);
    } catch {
      setUser(null);
      setOrganisation(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api<AuthResponse>("/auth/login", { body: { email, password }, noAuthRedirect: true });
    setToken(res.token);
    setUser(res.user);
    setOrganisation(res.organisation);
  }, []);

  const register = useCallback(
    async (data: { fullName: string; email: string; password: string; organisationName: string }) => {
      const res = await api<AuthResponse>("/auth/register", { body: data, noAuthRedirect: true });
      setToken(res.token);
      setUser(res.user);
      setOrganisation(res.organisation);
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST", noAuthRedirect: true });
    } catch {
      /* token may already be invalid */
    }
    setToken(null);
    setUser(null);
    setOrganisation(null);
    window.location.href = "/login";
  }, []);

  const value = useMemo(
    () => ({ user, organisation, loading, login, register, logout, refresh }),
    [user, organisation, loading, login, register, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
