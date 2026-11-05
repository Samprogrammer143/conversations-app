// The app icon, drawn once (designed in Figma: "Conversations · Showcase", page "App icon",
// concept C · Prompt): a blue chat with a prompt in it, on a graphite tile. Everything that shows
// the icon is made from these: the Windows and Mac icons and the tray icons
// (scripts/make-icons.cjs, scripts/make-mac-icons.mjs), the window's own badge
// (src/renderer/components/AppMark.tsx) and the website.
//
// Drawn on a 1024 canvas. The tile's corners are continuous, as Apple's are (Figma's corner
// smoothing at 60%), not plain rounded.

/** A rounded square with continuous corners (the figma-squircle construction). */
export function squirclePath(x, y, size, radius, smoothing = 0.6) {
  const r = radius;
  const p = Math.min((1 + smoothing) * r, size / 2);
  const rad = (deg) => (deg * Math.PI) / 180;
  const arcMeasure = 90 * (1 - smoothing);
  const arc = Math.sin(rad(arcMeasure / 2)) * r * Math.sqrt(2);
  const alpha = (90 - arcMeasure) / 2;
  const p3p4 = r * Math.tan(rad(alpha / 2));
  const beta = 45 * smoothing;
  const c = p3p4 * Math.cos(rad(beta));
  const d = c * Math.tan(rad(beta));
  const b = (p - arc - c - d) / 3;
  const a = 2 * b;
  const n = (v) => +v.toFixed(3);
  const w = size;
  return [
    `M ${n(x + w - p)} ${n(y)}`,
    `c ${n(a)} 0 ${n(a + b)} 0 ${n(a + b + c)} ${n(d)}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(arc)} ${n(arc)}`,
    `c ${n(d)} ${n(c)} ${n(d)} ${n(b + c)} ${n(d)} ${n(a + b + c)}`,
    `L ${n(x + w)} ${n(y + w - p)}`,
    `c 0 ${n(a)} 0 ${n(a + b)} ${n(-d)} ${n(a + b + c)}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(-arc)} ${n(arc)}`,
    `c ${n(-c)} ${n(d)} ${n(-(b + c))} ${n(d)} ${n(-(a + b + c))} ${n(d)}`,
    `L ${n(x + p)} ${n(y + w)}`,
    `c ${n(-a)} 0 ${n(-(a + b))} 0 ${n(-(a + b + c))} ${n(-d)}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(-arc)} ${n(-arc)}`,
    `c ${n(-d)} ${n(-c)} ${n(-d)} ${n(-(b + c))} ${n(-d)} ${n(-(a + b + c))}`,
    `L ${n(x)} ${n(y + p)}`,
    `c 0 ${n(-a)} 0 ${n(-(a + b))} ${n(d)} ${n(-(a + b + c))}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(arc)} ${n(-arc)}`,
    `c ${n(c)} ${n(-d)} ${n(b + c)} ${n(-d)} ${n(a + b + c)} ${n(-d)}`,
    "Z",
  ].join(" ");
}

// The chat, the prompt and the cursor, as drawn on Apple's grid (824 tile, 100 in).
const CHAT = "M 372 320 H 652 A 120 120 0 0 1 772 440 V 580 A 120 120 0 0 1 652 700 H 440 C 400 744 336 780 266 792 C 290 762 300 732 300 692 C 270 670 252 630 252 580 V 440 A 120 120 0 0 1 372 320 Z";
const PROMPT = "M 392 452 L 472 512 L 392 572";
// Alone (the small drawing and the menu bar), the prompt sits in the middle of the chat.
const PROMPT_ALONE = "M 466 452 L 546 512 L 466 572";
const CURSOR = "M 522 572 H 632";
export const COLORS = { tileTop: "#3A3A3E", tileBottom: "#141416", chatTop: "#3B8BFF", chatBottom: "#4B52EC", glow: "#3B6BFF" };

/**
 * The icon as SVG markup.
 *   grid "mac": Apple's grid, the tile 824 of 1024 with its soft shadow (the .icns).
 *   grid "full": the tile almost to the edges (Windows, the web); inset is a share of the size.
 *   small: for 32 px and under: no glow or shadows, the chat larger, the prompt only, bolder.
 * ids: a prefix for the gradient and filter ids, so several icons can share one page.
 */
export function iconSvg({ size = 1024, grid = "full", inset = 0.06, small = false, ids = "ci" } = {}) {
  const tileSize = grid === "mac" ? 824 : 1024 * (1 - inset * 2);
  const tileX = (1024 - tileSize) / 2;
  const radius = tileSize * (185 / 824);
  const tile = squirclePath(tileX, tileX, tileSize, radius);
  // The art inside is drawn for the 824 grid; it scales with the tile, about the centre.
  const k = (tileSize / 824) * (small ? 1.3 : 1);
  const art = `translate(512 ${small ? 480 : 512}) scale(${k.toFixed(4)}) translate(-512 -512)`;
  const sw = small ? 76 : 48;
  const shadow = grid === "mac" && !small;
  const defs = `
    <linearGradient id="${ids}-tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${COLORS.tileTop}"/><stop offset="1" stop-color="${COLORS.tileBottom}"/></linearGradient>
    <linearGradient id="${ids}-chat" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${COLORS.chatTop}"/><stop offset="1" stop-color="${COLORS.chatBottom}"/></linearGradient>
    <radialGradient id="${ids}-glow" cx="512" cy="490" r="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${COLORS.glow}" stop-opacity="0.3"/><stop offset="1" stop-color="${COLORS.glow}" stop-opacity="0"/></radialGradient>
    <clipPath id="${ids}-clip"><path d="${tile}"/></clipPath>
    ${shadow ? `<filter id="${ids}-tshadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#000" flood-opacity="0.22"/><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.18"/></filter>` : ""}
    ${small ? "" : `<filter id="${ids}-cshadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#000" flood-opacity="0.45"/></filter>`}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <defs>${defs}</defs>
  <path d="${tile}" fill="url(#${ids}-tile)"${shadow ? ` filter="url(#${ids}-tshadow)"` : ""}/>
  <g clip-path="url(#${ids}-clip)">
    ${small ? "" : `<rect x="0" y="0" width="1024" height="1024" fill="url(#${ids}-glow)"/>`}
    <g transform="${art}">
      <path d="${CHAT}" fill="url(#${ids}-chat)"${small ? "" : ` filter="url(#${ids}-cshadow)"`}/>
      <path d="${small ? PROMPT_ALONE : PROMPT}" fill="none" stroke="#fff" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>
      ${small ? "" : `<path d="${CURSOR}" fill="none" stroke="#fff" stroke-width="${sw}" stroke-linecap="round"/>`}
    </g>
  </g>
  <path d="${tile}" fill="none" stroke="#fff" stroke-opacity="${small ? 0.14 : 0.1}" stroke-width="${small ? 24 : 8}" clip-path="url(#${ids}-clip)"/>
</svg>`;
}

/**
 * The Mac menu bar icon: a template image (black on clear; macOS draws it light or dark). The
 * chat in black with the prompt cut out of it; with a dot at the top right, cut clear of the
 * chat, when Claude is waiting for you (a template can't be orange: the dot says it by shape).
 */
export function trayTemplateSvg(px, badge = false) {
  // The chat's own box is x 252..772, y 320..792 on the grid; fitted into 24 units with a margin.
  const s = 21 / 520;
  const place = `translate(1.5 ${(24 - 472 * s) / 2 + 0.6}) scale(${s.toFixed(5)}) translate(-252 -320)`;
  const sw = px <= 18 ? 92 : 84;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24">
  <defs>
    <mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
      <rect width="24" height="24" fill="#fff"/>
      <g transform="${place}"><path d="${PROMPT_ALONE}" fill="none" stroke="#000" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/></g>
      ${badge ? `<circle cx="19.6" cy="4.4" r="6" fill="#000"/>` : ""}
    </mask>
  </defs>
  <g mask="url(#m)"><g transform="${place}"><path d="${CHAT}" fill="#000"/></g></g>
  ${badge ? `<circle cx="19.6" cy="4.4" r="4.1" fill="#000"/>` : ""}
</svg>`;
}

/** The Windows tray icon: the small icon, with an orange dot when Claude is waiting for you. */
export function trayIconSvg(size, badge = false) {
  const base = iconSvg({ size, grid: "full", inset: 0.04, small: true, ids: badge ? "tb" : "t" });
  if (!badge) return base;
  return base.replace("</svg>", `<circle cx="${1024 - 190}" cy="190" r="168" fill="#ff9500" stroke="#fff" stroke-width="56"/></svg>`);
}
