// Types for icon-art.mjs (the app icon's one drawing), for the window's own badge.
export function squirclePath(x: number, y: number, size: number, radius: number, smoothing?: number): string;
export const COLORS: Record<"tileTop" | "tileBottom" | "chatTop" | "chatBottom" | "glow", string>;
export function iconSvg(opts?: { size?: number; grid?: "mac" | "full"; inset?: number; small?: boolean; ids?: string }): string;
export function trayTemplateSvg(px: number, badge?: boolean): string;
export function trayIconSvg(size: number, badge?: boolean): string;
