export interface WidgetConfig {
  /** Publishable widget key (pk_…). Never a secret key. */
  key: string;
  /** Engine origin, without a trailing slash. */
  api: string;
}

/** Reads `data-key` and `data-api` from the widget's own script tag. Returns null when misconfigured. */
export function readConfig(script: HTMLScriptElement | null): WidgetConfig | null {
  const key = script?.getAttribute("data-key") ?? "";
  if (!script || !/^pk_[A-Za-z0-9_-]+$/.test(key)) return null;
  try {
    const api = new URL(script.getAttribute("data-api") ?? new URL(script.src).origin);
    if (api.protocol !== "https:" && api.protocol !== "http:") return null;
    return { key, api: api.origin + api.pathname.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}
