// Writes dist/THIRD-PARTY-NOTICES.txt: the licence of every open-source package and
// asset bundled into dist/ (the window's libraries and everything they depend on, the
// fonts and the icons), so the built app carries them wherever it is copied.
// Claude's Agent SDK is not among them: it is never bundled (see build.mjs).
import fs from "node:fs";
import path from "node:path";

/**
 * Everything package.json lists is bundled except these: build and test tools, types,
 * Electron itself (installed, not bundled) and Claude's Agent SDK (never bundled).
 */
const NOT_BUNDLED = /^(@playwright\/test|@types\/.*|@vitejs\/.*|electron|electron-builder|esbuild|typescript|vite|vitest|@anthropic-ai\/claude-agent-sdk)$/;
const ASSETS = [
  ["Inter (font)", "src/renderer/fonts/Inter-LICENSE.txt"],
  ["Geist Mono (font)", "src/renderer/fonts/GeistMono-LICENSE.txt"],
  ["Lucide (icons)", "src/renderer/icons/LUCIDE-LICENSE.txt"],
];

export function writeNotices(root, outFile) {
  const own = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const roots = Object.keys({ ...own.dependencies, ...own.devDependencies }).filter((n) => !NOT_BUNDLED.test(n));
  const seen = new Map();
  // Node's own lookup: the nearest node_modules up from the package that needs it.
  const resolve = (name, from) => {
    for (let d = from; ; d = path.dirname(d)) {
      const dir = path.join(d, "node_modules", ...name.split("/"));
      if (fs.existsSync(path.join(dir, "package.json"))) return dir;
      if (path.dirname(d) === d || path.relative(root, d).startsWith("..")) return null;
    }
  };
  const visit = (name, from) => {
    const dir = resolve(name, from);
    if (!dir) return;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const key = `${name}@${pkg.version}`;
    if (seen.has(key)) return;
    const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
    seen.set(key, { name, version: pkg.version, license: typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "see the package", text: file ? fs.readFileSync(path.join(dir, file), "utf8").trim() : null });
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir);
  };
  for (const r of roots) visit(r, root);
  const parts = ["Third-party software and assets included in Conversations", "=".repeat(58), ""];
  for (const { name, version, license, text } of [...seen.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
    parts.push(`${name} ${version} (${license})`, "-".repeat(40), text ?? `Licensed under ${license}.`, "");
  }
  for (const [name, file] of ASSETS) parts.push(name, "-".repeat(40), fs.readFileSync(path.join(root, file), "utf8").trim(), "");
  fs.writeFileSync(outFile, parts.join("\n"));
  return seen.size;
}
