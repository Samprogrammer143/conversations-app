// The app's icon in the window itself (the tray popup, the workspace button, the welcome): the
// same drawing as the Windows and Mac icons (scripts/icon-art.mjs), the small one at 32 px and under.
import { useId, useMemo } from "react";
import { iconSvg } from "../../../scripts/icon-art.mjs";

export function AppMark({ size, className }: { size: number; className?: string }) {
  // Each copy needs its own gradient ids, or a second one on the page would borrow the first's.
  const ids = `am${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // (By the pixels it is drawn in: a 24 px mark on a sharp screen is 48 of them, so the full drawing.)
  const small = size * (window.devicePixelRatio || 1) <= 32;
  const svg = useMemo(() => iconSvg({ size, grid: "full", inset: 0, small, ids }), [size, small, ids]);
  return <span className={`app-mark${className ? ` ${className}` : ""}`} aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />;
}
