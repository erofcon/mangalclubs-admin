import type { JsonRecord, StoredSession, TokenPair } from "./admin-types";

const SESSION_KEY = "mangalclubs.admin.session";
const DEVICE_KEY = "mangalclubs.admin.device";
export const AUTH_EXPIRED_EVENT = "mangalclubs.admin.auth-expired";

export type ApiOptions = RequestInit & {
  auth?: boolean;
  retryOnUnauthorized?: boolean;
};

export function makeDeviceId() {
  if (typeof window === "undefined") return "mangal-admin-device";
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const id = `admin-${crypto.randomUUID()}`;
  localStorage.setItem(DEVICE_KEY, id);
  return id;
}

export function loadSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function saveSession(session: StoredSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  if (typeof window !== "undefined") localStorage.removeItem(SESSION_KEY);
}

export function notifyAuthExpired() {
  clearSession();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
  }
}

function extractError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const data = payload as JsonRecord;
  if (typeof data.detail === "string") return data.detail;
  if (Array.isArray(data.detail)) {
    return data.detail
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const row = item as JsonRecord;
        const loc = Array.isArray(row.loc) ? row.loc.join(".") : "";
        return `${loc}${loc ? ": " : ""}${String(row.msg || "")}`;
      })
      .filter(Boolean)
      .join("; ");
  }
  if (typeof data.message === "string") return data.message;
  return fallback;
}

export async function apiRequest<T>(
  session: StoredSession | null,
  path: string,
  options: ApiOptions = {},
): Promise<T> {
  if (options.auth !== false && !session?.access_token) {
    notifyAuthExpired();
    throw new Error("Session expired. Please log in again.");
  }

  const headers = new Headers(options.headers);
  const isFormData = options.body instanceof FormData;

  if (!isFormData && options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (options.auth !== false && session?.access_token) {
    headers.set("Authorization", `Bearer ${session.access_token}`);
  }

  const response = await fetch(`/api/proxy${path}`, {
    ...options,
    headers,
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text ? { message: text } : null;
  }

  if (!response.ok) {
    throw new Error(extractError(payload, `${response.status} ${response.statusText}`));
  }

  return payload as T;
}

export async function staffLogin(args: {
  email: string;
  password: string;
  deviceId: string;
}) {
  const deviceId = args.deviceId || makeDeviceId();
  const tokens = await apiRequest<TokenPair>(null, "/api/v1/auth/staff/login", {
    auth: false,
    method: "POST",
    body: JSON.stringify({
      device_id: deviceId,
      device_name: "MangalClubs Admin",
      email: args.email,
      password: args.password,
    }),
  });

  const session: StoredSession = {
    ...tokens,
    device_id: deviceId,
    saved_at: Date.now(),
  };
  saveSession(session);
  return session;
}

export async function refreshSession(session: StoredSession) {
  const tokens = await apiRequest<TokenPair>(session, "/api/v1/auth/refresh", {
    auth: false,
    method: "POST",
    body: JSON.stringify({
      device_id: session.device_id,
      device_name: "MangalClubs Admin",
      refresh_token: session.refresh_token,
    }),
  });

  const nextSession: StoredSession = {
    ...tokens,
    device_id: session.device_id,
    saved_at: Date.now(),
  };
  saveSession(nextSession);
  return nextSession;
}

function shouldRefresh(session: StoredSession) {
  const expiresAt = session.saved_at + session.expires_in * 1000;
  return Date.now() > expiresAt - 30_000;
}

export async function apiRequestWithRefresh<T>(
  session: StoredSession | null,
  setSession: (session: StoredSession | null) => void,
  path: string,
  options: ApiOptions = {},
): Promise<T> {
  let activeSession = session;

  if (options.auth !== false && activeSession && shouldRefresh(activeSession)) {
    try {
      activeSession = await refreshSession(activeSession);
      setSession(activeSession);
    } catch {
      notifyAuthExpired();
      setSession(null);
      throw new Error("Session expired. Please log in again.");
    }
  }

  try {
    return await apiRequest<T>(activeSession, path, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const canRetry =
      options.auth !== false &&
      options.retryOnUnauthorized !== false &&
      Boolean(activeSession) &&
      /\b(401|403|unauthorized|forbidden|not authenticated|expired|invalid token|credentials)\b/i.test(message);

    if (!canRetry) throw error;

    const retrySession = activeSession;
    if (!retrySession) throw error;

    try {
      const refreshed = await refreshSession(retrySession);
      setSession(refreshed);
      return await apiRequest<T>(refreshed, path, {
        ...options,
        retryOnUnauthorized: false,
      });
    } catch {
      notifyAuthExpired();
      setSession(null);
      throw new Error("Session expired. Please log in again.");
    }
  }
}
