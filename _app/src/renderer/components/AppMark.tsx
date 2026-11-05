// The app's icon in the window itself (the tray popup, the workspace button, the welcome): the
// same drawing as the computer's own icon (scripts/icon-art.mjs). On a Mac the chat on its tile,
// the small one at 32 px and under; on Windows the chat alone, as its taskbar shows it.
import { useId, useMemo } from "react";
import { iconSvg, markSvg } from "../../../scripts/icon-art.mjs";
import { isMac } from "../lib/platform";

export function AppMark({ size, className }: { size: number; className?: string }) {
  // Each copy needs its own gradient ids, or a second one on the page would borrow the first's.
  const ids = `am${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // (By the pixels it is drawn in: a 24 px mark on a sharp screen is 48 of them, so the full drawing.)
  const small = size * (window.devicePixelRatio || 1) <= 32;
  const mac = isMac();
  const svg = useMemo(() => (mac ? iconSvg({ size, grid: "full", inset: 0, small, ids }) : markSvg({ size, small, ids })), [mac, size, small, ids]);
  return <span className={`app-mark${className ? ` ${className}` : ""}`} aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />;
}
