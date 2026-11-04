// Words that differ on a Mac. Read at call time: modules load before main.tsx marks the platform.

import { api } from "./api";

export function isMac(): boolean {
  return api.app.platform() === "darwin";
}

/** "Mac" on a Mac, "PC" on Windows: for "this PC", the computer the app runs on. */
export function pcWord(): string {
  return isMac() ? "Mac" : "PC";
}
