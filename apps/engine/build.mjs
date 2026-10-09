// Bundles the engine for production. Workspace packages (@ace/*) ship TypeScript source, so they are bundled;
// npm packages stay external and are installed in the image. Because pnpm is strict, every external package
// that bundled code imports must be a dependency of the engine itself; the build fails otherwise.
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));
const builtins = new Set(builtinModules);
const missing = new Set();

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

await build({
  entryPoints: { main: "src/main.ts", migrate: "src/migrate-cli.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  plugins: [
    {
      name: "externalize-npm",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith("@ace/")) return undefined;
          const name = packageName(args.path.replace(/^node:/, ""));
          if (!args.path.startsWith("node:") && !builtins.has(name) && !declared.has(name)) missing.add(name);
          return { path: args.path, external: true };
        });
      },
    },
  ],
});
if (missing.size > 0) {
  console.error(
    `Add these to apps/engine dependencies (imported by bundled code): ${[...missing].sort().join(", ")}`,
  );
  process.exit(1);
}
console.log("built dist/main.js and dist/migrate.js");
