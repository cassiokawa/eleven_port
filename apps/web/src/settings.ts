export interface Settings {
  voiceId: string;
  token: string;
  stability: number;
  similarity: number;
}

const KEY = "eleven-port-settings";
export const DEFAULTS: Settings = { voiceId: "21m00Tcm4TlvDq8ikWAM", token: "", stability: 0.5, similarity: 0.75 };

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable (private mode): settings last for this session only */
  }
}
