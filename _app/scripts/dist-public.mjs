// The installer to publish, and the download that goes with it.
//   node scripts/dist-public.mjs          Windows: Conversations-Setup.zip
//   node scripts/dist-public.mjs --mac    macOS (on a Mac): Conversations-mac-arm64.zip and -x64.zip
// The same app as `npm run dist`, without Claude's Agent SDK inside: its licence doesn't let
// anyone pass it on, so the set-up installs it from npm on each PC instead (the engine's
// ensureRuntime). The Windows download is a zip of the installer, the set-up files and the
// licence: unzip it and double-click "Set up Conversations.cmd". The Mac downloads are the
// app alone, zipped: setup/install.sh fetches the one for the Mac it runs on.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const out = path.join(root, "release-public");

const built = spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { cwd: root, stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);

const builder = require("electron-builder");
if (process.argv.includes("--mac")) {
  await mac();
  process.exit(0);
}
const config = {
  ...pkg.build,
  directories: { ...pkg.build.directories, output: out },
  // Electron from node_modules, the version the app is developed and tested on.
  electronDist: path.join(root, "node_modules", "electron", "dist"),
  extraResources: pkg.build.extraResources.filter((r) => !String(r.from).includes("claude-agent-sdk")),
  // electron-builder merges package.json's build settings back in, SDK copy and all: it goes
  // from the packed app here, before the installer is made from it.
  // Electron's own demo app and version file come with electronDist too: not needed either.
  afterPack: async (ctx) => {
    for (const p of [path.join("resources", "sdk"), path.join("resources", "default_app.asar"), "version"]) fs.rmSync(path.join(ctx.appOutDir, p), { recursive: true, force: true });
  },
};
fs.rmSync(out, { recursive: true, force: true });
await builder.build({ projectDir: root, targets: builder.Platform.WINDOWS.createTarget("nsis", builder.Arch.x64), config, publish: "never" });

const exe = `${pkg.build.productName} Setup ${pkg.version}.exe`;
if (!fs.existsSync(path.join(out, exe))) throw new Error(`no ${exe} in ${out}`);
// The point of this build: nothing of the SDK inside.
const resources = path.join(out, "win-unpacked", "resources");
const sdk = fs.existsSync(resources) && fs.readdirSync(resources, { recursive: true }).some((f) => String(f).includes("claude-agent-sdk"));
if (sdk) throw new Error("Claude's Agent SDK is inside the public installer");

const stage = path.join(out, "download");
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(path.join(out, exe), path.join(stage, exe));
for (const f of ["Set up Conversations.cmd", "setup.ps1"]) fs.copyFileSync(path.join(repo, "setup", f), path.join(stage, f));
fs.copyFileSync(path.join(repo, "LICENSE"), path.join(stage, "LICENSE.txt"));
// One name for every version, so the website's link to the latest release's download
// (github.com/<owner>/<repo>/releases/latest/download/Conversations-Setup.zip) never changes.
const zip = path.join(out, "Conversations-Setup.zip");
const ps = (s) => `'${s.replace(/'/g, "''")}'`; // a PowerShell string: ' doubled
const z = spawnSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path (Join-Path ${ps(stage)} '*') -DestinationPath ${ps(zip)} -Force`], { stdio: "inherit" });
if (z.status !== 0) process.exit(z.status ?? 1);
console.log(`\n${zip} (${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)`);

// The Mac app, for Apple silicon and for Intel. Unsigned (no paid Apple account): the
// install script gives it a local signature on the Mac it lands on, and since it comes
// through Terminal rather than a browser, macOS doesn't hold it back. electron-builder
// fetches Electron for each architecture itself (node_modules has only this Mac's).
async function mac() {
  if (process.platform !== "darwin") throw new Error("the Mac app can only be built on a Mac (CI does it: .github/workflows/mac.yml)");
  const config = {
    ...pkg.build,
    directories: { ...pkg.build.directories, output: out },
    extraResources: pkg.build.extraResources.filter((r) => !String(r.from).includes("claude-agent-sdk")),
    afterPack: async (ctx) => {
      const res = path.join(ctx.appOutDir, `${pkg.build.productName}.app`, "Contents", "Resources");
      for (const p of ["sdk", "default_app.asar"]) fs.rmSync(path.join(res, p), { recursive: true, force: true });
    },
  };
  fs.rmSync(out, { recursive: true, force: true });
  await builder.build({ projectDir: root, targets: builder.Platform.MAC.createTarget("zip", builder.Arch.arm64, builder.Arch.x64), config, publish: "never" });
  for (const arch of ["arm64", "x64"]) {
    const zip = path.join(out, `${pkg.build.productName}-mac-${arch}.zip`);
    if (!fs.existsSync(zip)) throw new Error(`no ${zip}`);
    const res = path.join(out, arch === "x64" ? "mac" : `mac-${arch}`, `${pkg.build.productName}.app`, "Contents", "Resources");
    if (!fs.existsSync(res)) throw new Error(`no app at ${res}`);
    const sdk = fs.readdirSync(res, { recursive: true }).some((f) => String(f).includes("claude-agent-sdk"));
    if (sdk) throw new Error(`Claude's Agent SDK is inside the ${arch} Mac app`);
    console.log(`${zip} (${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)`);
  }
}
