// Dates and sizes the way the design writes them: 24-hour times, weekday names
// for this week, short dates beyond, British style.

const LOCALE = "en-GB";

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const DAY = 86_400_000;

export function time24(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "14:52" today and yesterday, "Thu" within the week, "3 Oct" this year, "3 Oct 2025" before. */
export function rowTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
  if (days <= 1) return time24(iso);
  if (days < 7) return d.toLocaleDateString(LOCALE, { weekday: "short" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
  return d.toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" });
}

/** List section headers: Today, Yesterday, Earlier this week, then months. */
export function groupLabel(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "Earlier";
  const d = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Earlier this week";
  if (days < 14) return "Last week";
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(LOCALE, { month: "long" });
  return d.toLocaleDateString(LOCALE, { month: "long", year: "numeric" });
}

/** Day separator in a transcript: "Today", "Yesterday", "Thursday 8 October". */
export function dayLabel(date: string, now = new Date()): string {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  const days = Math.round((startOfDay(now) - day.getTime()) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return day.toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long", ...(day.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/** "just now", "2 min ago", "17 h ago", "11 d ago". */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = (now - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Long form for sentences: "17 h ago" -> "Seen 17 h ago" uses this; "11 days ago". */
export function agoLong(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = (now - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "claude-opus-5-5" -> "Opus 5.5". */
export function modelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  if (/^(opus|sonnet|haiku|fable)(\[.*\])?$/i.test(model)) return model.charAt(0).toUpperCase() + model.slice(1).replace(/\[.*\]$/, "");
  const m = model.match(/claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
  if (!m) return model;
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const ver = m[3] && m[3].length <= 2 ? `${m[2]}.${m[3]}` : m[2];
  return `${name} ${ver}`;
}

/** The separator between parts of a line ("Opus 5.5 · 14:41 · Home PC"), spaced as in the design. */
export const SEP = "\u2002·\u2002";

/** "Resets in 3 hr 48 min (21:39)" within a day, "Resets Sat 17 Oct, 19:59" beyond. */
export function resetText(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const mins = Math.round((at - now) / 60_000);
  if (mins <= 0) return "Resets any moment";
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const span = h ? `${h} hr${m ? ` ${m} min` : ""}` : `${m} min`;
    return `Resets in ${span} (${time24(iso)})`;
  }
  const d = new Date(at);
  return `Resets ${d.toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short" })}, ${time24(iso)}`;
}
