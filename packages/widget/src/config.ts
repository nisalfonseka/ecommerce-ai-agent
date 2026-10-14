export interface WidgetConfig {
  /** Publishable widget key (pk_…). Never a secret key. */
  key: string;
  /** Engine origin, without a trailing slash. */
  api: string;
  privacyNoticeUrl?: string;
}

/** Reads `data-key` and `data-api` from the widget's own script tag. Returns null when misconfigured. */
export function readConfig(script: HTMLScriptElement | null): WidgetConfig | null {
  const key = script?.getAttribute("data-key") ?? "";
  if (!script || !/^pk_[A-Za-z0-9_-]+$/.test(key)) return null;
  try {
    const api = new URL(script.getAttribute("data-api") ?? new URL(script.src).origin);
    if (api.protocol !== "https:" && api.protocol !== "http:") return null;
    const privacyValue = script.getAttribute("data-privacy-notice");
    let privacyNoticeUrl: string | undefined;
    if (privacyValue) {
      const privacy = new URL(privacyValue);
      if (privacy.protocol !== "https:" && privacy.protocol !== "http:") return null;
      privacyNoticeUrl = privacy.toString();
    }
    return {
      key,
      api: api.origin + api.pathname.replace(/\/+$/, ""),
      ...(privacyNoticeUrl ? { privacyNoticeUrl } : {}),
    };
  } catch {
    return null;
  }
}
