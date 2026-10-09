import { render } from "preact";
import { createApi } from "./api";
import { readConfig } from "./config";
import { installHostApi } from "./host";
import { createStorage } from "./storage";
import { STYLES } from "./styles";
import { App, type HostControls } from "./ui/App";

// Must be read while the script runs; it is null inside callbacks.
const ownScript = document.currentScript as HTMLScriptElement | null;

function start(): void {
  const config = readConfig(ownScript);
  if (!config) {
    console.warn("[shopping assistant] the widget script needs a valid data-key (pk_…)");
    return;
  }
  let rawStorage: Storage | null = null;
  try {
    rawStorage = window.localStorage;
  } catch {
    // blocked storage: the widget keeps state in memory
  }
  const storage = createStorage(rawStorage);
  const api = createApi({ api: config.api, key: config.key, visitorId: storage.visitorId() });

  // Shadow DOM isolates styles both ways (open so tests and assistive tech can reach it).
  const host = document.createElement("div");
  host.setAttribute("data-shopping-assistant", "");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLES;
  const mount = document.createElement("div");
  mount.className = "root";
  shadow.append(style, mount);

  let controls: HostControls | null = null;
  let initialCartId: string | null = null;
  const pending: ((c: HostControls) => void)[] = [];
  const whenReady = (fn: (c: HostControls) => void) => (controls ? fn(controls) : pending.push(fn));
  installHostApi(window, {
    open: () => whenReady((c) => c.open()),
    close: () => whenReady((c) => c.close()),
    setCart: (cartId) => {
      initialCartId = cartId;
      whenReady((c) => c.setCart(cartId));
    },
  });

  render(
    <App
      widgetKey={config.key}
      api={api}
      storage={storage}
      win={window}
      initialCartId={initialCartId}
      bindHost={(c) => {
        controls = c;
        for (const fn of pending.splice(0)) fn(c);
      }}
    />,
    mount,
  );
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
