import io, re
def patch(p, pairs):
    b = io.open(p, "rb").read().decode("utf-8")
    crlf = "\r\n" in b
    s = b.replace("\r\n", "\n")
    for old, new in pairs:
        c = s.count(old)
        if c != 1: raise SystemExit(f"{p}: {c}x {old[:100]!r}")
        s = s.replace(old, new)
    io.open(p, "wb").write((s.replace("\n", "\r\n") if crlf else s).encode("utf-8"))
    print("patched", p)

patch("src/renderer/features/Detail.tsx", [
('''function readImage(file: File): Promise<Pending | null> {
  return new Promise((resolve) => {
    if (!IMAGE_MEDIA.has(file.type) || file.size > 5 * 1024 * 1024) return resolve(null);
    const r = new FileReader();''', '''async function readImage(file: File): Promise<Pending | null> {
  if (!IMAGE_MEDIA.has(file.type)) return null;
  const fit = await fitImage(file, file.type);
  return fit && { key: `${Date.now()}-${Math.random()}`, name: file.name || "Pasted image", mediaType: fit.mediaType as Attachment["mediaType"], data: fit.data };
}
'''),
('''    if (skipped) toast({ text: skipped === list.length ? "Only PNG, JPEG, GIF or WebP images up to 5 MB can be attached" : `${skipped} of them couldn't be attached (images up to 5 MB only)`, icon: "alert" });''',
 '''    if (skipped) toast({ text: skipped === list.length ? "Only PNG, JPEG, GIF or WebP images can be attached" : `${skipped} of them couldn't be attached (images only)`, icon: "alert" });'''),
('''    const r = await api.app.pickFiles();
    if (r.images.length) setPending((prev) => [...prev, ...r.images.map((a) => ({ ...a, key: `${Date.now()}-${Math.random()}` }))].slice(0, 10));''',
 '''    const r = await api.app.pickFiles();
    // A big one is made to fit, as a paste or a drop is.
    const fitted = await Promise.all(r.images.map(async (a) => (a.data.length <= MAX_BASE64 ? a : { ...a, ...(await fitImage(fromBase64(a.data, a.mediaType), a.mediaType)) })));
    const usable = fitted.filter((a) => a.data.length <= MAX_BASE64) as Attachment[];
    if (usable.length < fitted.length) toast({ text: "An image couldn't be made small enough to attach", icon: "alert" });
    if (usable.length) setPending((prev) => [...prev, ...usable.map((a) => ({ ...a, key: `${Date.now()}-${Math.random()}` }))].slice(0, 10));'''),
('''import { Transcript } from "./Transcript";''', '''import { fitImage, fromBase64, MAX_BASE64 } from "../lib/images";
import { Transcript } from "./Transcript";'''),
])
# what's left of the old promise body
p = "src/renderer/features/Detail.tsx"
s = io.open(p, encoding="utf-8", newline="").read()
s2, n = re.subn(r'(data: fit\.data \};\n\}\n)\n    r\.onload = .*?\n    r\.onerror = .*?\n    r\.readAsDataURL\(file\);\n  \}\);\n\}\n', r'\1', s, flags=re.S)
assert n == 1
io.open(p, "w", encoding="utf-8", newline="").write(s2)

patch("src/main/main.ts", [
('''// Images a message can carry: the types the API accepts, 5 MB each, ten at a time.''',
 '''// Images a message can carry: the types the API accepts, 5 MB each counted as base64 (the
// window makes bigger ones fit), ten at a time. From the picker, up to 100 MB to make fit.'''),
('''const MAX_IMAGE_BYTES = 5 * 1024 * 1024;''', '''const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;
const MAX_PICKED_IMAGE_BYTES = 100 * 1024 * 1024;'''),
('''    if (a.data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4 || !/^[A-Za-z0-9+/=]+$/.test(a.data)) return null;''',
 '''    if (a.data.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(a.data)) return null;'''),
('''      if (type && size <= MAX_IMAGE_BYTES) images.push(''', '''      if (type && size <= MAX_PICKED_IMAGE_BYTES) images.push('''),
('''"Only PNG, JPEG, GIF or WebP images up to 5 MB can be attached, at most 10 at a time"''', '''"Only PNG, JPEG, GIF or WebP images can be attached, at most 10 at a time"'''),
])

for f in ["package.json", "package-lock.json"]:
    t = io.open(f, encoding="utf-8", newline="").read()
    n, c = re.subn(r'"version": "0\.5\.19"', '"version": "0.5.20"', t, count=2)
    io.open(f, "w", encoding="utf-8", newline="").write(n)
    print(f, c)
