import { loadSettings } from "./settings";

/** Fetch from the API proxy, attaching the bearer token when one is configured. */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { token } = loadSettings();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(`/api${path}`, { ...init, headers });
}
