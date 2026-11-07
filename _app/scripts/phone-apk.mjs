// Builds the Android app: the phone build (dist-phone), copied into android/ by Capacitor,
// then Gradle's assembleDebug (or --release). Needs JDK 21 and the Android SDK:
// JAVA_HOME and ANDROID_HOME, else %LOCALAPPDATA%\Programs\jdk-21* and %LOCALAPPDATA%\Android\Sdk.
// The APK ends up in release/phone/.
//   node scripts/phone-apk.mjs [--release]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const local = process.env.LOCALAPPDATA ?? "";
const release = process.argv.includes("--release");

/** Windows' short form of a path (no spaces): Java's and the SDK's .bat scripts break on spaces. */
function short(p) {
  if (!win || !p.includes(" ")) return p;
  const r = spawnSync("cmd", ["/d", "/s", "/c", `"for %I in ("${p}") do @echo %~sI"`], { encoding: "utf8", windowsVerbatimArguments: true });
  return r.stdout.trim().split(/\r?\n/).pop() || p;
}

const jdk =
  process.env.JAVA_HOME ||
  (() => {
    const base = path.join(local, "Programs");
    const d = fs.existsSync(base) ? fs.readdirSync(base).find((n) => /^jdk-21/i.test(n)) : null;
    return d ? path.join(base, d) : "";
  })();
const sdk = process.env.ANDROID_HOME || path.join(local, "Android", "Sdk");
if (!jdk || !fs.existsSync(jdk)) throw new Error("No JDK 21: set JAVA_HOME");
if (!fs.existsSync(sdk)) throw new Error("No Android SDK: set ANDROID_HOME");

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: win, cwd: root, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
};

run("npx", ["vite", "build", "-c", "vite.phone.config.ts"]);
run("npx", ["cap", "sync", "android"]);

const android = path.join(root, "android");
// The app's own version: 0.5.36 is versionName "0.5.36", versionCode 536 (each release a higher one, so Android updates in place).
{
  const v = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const [a, b, c] = v.split(".").map(Number);
  const gradle = path.join(android, "app", "build.gradle");
  const text = fs.readFileSync(gradle, "utf8").replace(/versionCode \d+/, `versionCode ${a * 100000 + b * 1000 + c}`).replace(/versionName "[^"]*"/, `versionName "${v}"`);
  fs.writeFileSync(gradle, text);
}
fs.writeFileSync(path.join(android, "local.properties"), `sdk.dir=${sdk.replace(/\\/g, "\\\\")}\n`);
const env = { ...process.env, JAVA_HOME: short(jdk), ANDROID_HOME: sdk };
run(win ? path.join(short(android), "gradlew.bat") : "./gradlew", [release ? "assembleRelease" : "assembleDebug", "--no-daemon", "-q"], { cwd: android, env });

const kind = release ? "release" : "debug";
const outDir = path.join(android, "app", "build", "outputs", "apk", kind);
const apk = fs.readdirSync(outDir).find((f) => f.endsWith(".apk"));
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const dest = path.join(root, "release", "phone", `Conversations-${version}-${kind}.apk`);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(path.join(outDir, apk), dest);
console.log(`${dest} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
