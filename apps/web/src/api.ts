import { fetchServerConfig, type ServerConfig } from "@eleven-port/core";
import { loadSettings } from "./settings";

/** Fetch from the API proxy, attaching the bearer token when one is configured. */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { token } = loadSettings();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(`/api${path}`, { ...init, headers });
}

let cached: Promise<ServerConfig | undefined> | undefined;

/** Active engines on the API; cached per page load and undefined if the API is unreachable. */
export function getServerConfig(refresh = false): Promise<ServerConfig | undefined> {
  if (refresh || !cached) cached = fetchServerConfig("/api", loadSettings().token || undefined);
  return cached;
}
