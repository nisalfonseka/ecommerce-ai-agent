// Serves the demo store page and the built widget. Usage:
//   ACE_DEMO_KEY=pk_live_… ACE_DEMO_API=http://localhost:8080 node demo/server.mjs   (port 5173 by default)
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const port = Number(process.env.ACE_DEMO_PORT ?? 5173);
const key = process.env.ACE_DEMO_KEY ?? "";
const api = process.env.ACE_DEMO_API ?? "http://localhost:8080";
if (!/^pk_[A-Za-z0-9_-]+$/.test(key)) {
  console.error("Set ACE_DEMO_KEY to a widget key (pnpm seed prints one).");
  process.exit(1);
}

const escapeAttr = (value) => value.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
const files = {
  "/ace.js": ["../dist/ace.js", "text/javascript; charset=utf-8"],
  "/ace.js.map": ["../dist/ace.js.map", "application/json"],
};

createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/" || path === "/index.html") {
      const html = (await readFile(new URL("./index.html", import.meta.url), "utf8"))
        .replace("__ACE_KEY__", escapeAttr(key))
        .replace("__ACE_API__", escapeAttr(api));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      return;
    }
    const file = files[path];
    if (!file) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": file[1] }).end(await readFile(new URL(file[0], import.meta.url)));
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
}).listen(port, () => console.log(`demo store: http://localhost:${port}`));
