// Overlay scrollbars, Windows 11 style. Native bars are hidden in base.css
// because Chromium's classic ones take 10–15 px out of every panel. One thin
// thumb per scrolling element is drawn over its right edge: it shows while you
// scroll or move the pointer over the element, widens near the edge, can be
// dragged, and fades a second after you stop.

const HIDE_AFTER_MS = 1000;
const EDGE_PX = 16; // how close to the right edge the pointer widens the thumb
const INSET = 2;
const MIN_THUMB = 32;

interface Bar {
  el: HTMLElement;
  thumb: HTMLDivElement;
  timer: number;
  wide: boolean;
  dragging: boolean;
}

const bars = new Map<HTMLElement, Bar>();
const overflowCache = new WeakMap<Element, boolean>();

function canScroll(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 1) return false;
  let ok = overflowCache.get(el);
  if (ok === undefined) {
    const oy = getComputedStyle(el).overflowY;
    ok = oy === "auto" || oy === "scroll";
    overflowCache.set(el, ok);
  }
  return ok;
}

function scrollerAt(target: EventTarget | null): HTMLElement | null {
  for (let n = target as Element | null; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    if (canScroll(n)) return n;
  }
  return null;
}

function remove(b: Bar) {
  window.clearTimeout(b.timer);
  b.thumb.remove();
  bars.delete(b.el);
}

function barFor(el: HTMLElement): Bar {
  let b = bars.get(el);
  if (b) return b;
  const thumb = document.createElement("div");
  thumb.className = "overlay-thumb";
  thumb.setAttribute("aria-hidden", "true");
  document.body.appendChild(thumb);
  b = { el, thumb, timer: 0, wide: false, dragging: false };
  bars.set(el, b);
  attachDrag(b);
  return b;
}

function geometry(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const track = r.height - INSET * 2;
  const h = Math.max(MIN_THUMB, Math.round((track * el.clientHeight) / el.scrollHeight));
  return { r, track, h };
}

function place(b: Bar): boolean {
  const { el, thumb } = b;
  if (!el.isConnected) {
    remove(b);
    return false;
  }
  if (el.scrollHeight <= el.clientHeight + 1 || el.clientHeight < MIN_THUMB * 1.5) {
    thumb.classList.remove("on");
    return false;
  }
  const { r, track, h } = geometry(el);
  const max = el.scrollHeight - el.clientHeight;
  const top = r.top + INSET + Math.round((track - h) * (max > 0 ? el.scrollTop / max : 0));
  const width = b.wide || b.dragging ? 8 : 6;
  thumb.style.height = `${h}px`;
  thumb.style.transform = `translate(${Math.round(r.right - INSET - width)}px, ${top}px)`;
  thumb.classList.toggle("wide", b.wide || b.dragging);
  return true;
}

function show(b: Bar) {
  if (!place(b)) return;
  b.thumb.classList.add("on");
  window.clearTimeout(b.timer);
  b.timer = window.setTimeout(() => {
    if (!b.wide && !b.dragging) b.thumb.classList.remove("on");
  }, HIDE_AFTER_MS);
}

function attachDrag(b: Bar) {
  b.thumb.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    b.thumb.setPointerCapture(e.pointerId);
    b.dragging = true;
    const startY = e.clientY;
    const startTop = b.el.scrollTop;
    const { track, h } = geometry(b.el);
    const ratio = (b.el.scrollHeight - b.el.clientHeight) / Math.max(1, track - h);
    const move = (ev: PointerEvent) => {
      b.el.scrollTop = startTop + (ev.clientY - startY) * ratio;
    };
    const up = () => {
      b.dragging = false;
      b.thumb.removeEventListener("pointermove", move);
      b.thumb.removeEventListener("pointerup", up);
      b.thumb.removeEventListener("lostpointercapture", up);
      show(b);
    };
    b.thumb.addEventListener("pointermove", move);
    b.thumb.addEventListener("pointerup", up);
    b.thumb.addEventListener("lostpointercapture", up);
    show(b);
  });
  b.thumb.addEventListener("pointerenter", () => {
    b.wide = true;
    show(b);
  });
  b.thumb.addEventListener("pointerleave", () => {
    b.wide = false;
    show(b);
  });
}

let pending: PointerEvent | null = null;
function onPointer() {
  const e = pending;
  pending = null;
  if (!e || e.target === null) return;
  if ((e.target as Element).classList?.contains("overlay-thumb")) return;
  const el = scrollerAt(e.target);
  for (const b of bars.values()) {
    if (b.el !== el && b.wide) {
      b.wide = false;
      show(b);
    }
  }
  if (!el) return;
  const b = barFor(el);
  const r = el.getBoundingClientRect();
  b.wide = r.right - e.clientX <= EDGE_PX;
  show(b);
}

export function installOverlayScrollbars() {
  document.addEventListener(
    "scroll",
    (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && canScroll(t)) show(barFor(t));
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse") return;
      if (!pending) requestAnimationFrame(onPointer);
      pending = e;
    },
    { passive: true },
  );
  document.addEventListener("pointerleave", () => {
    for (const b of bars.values()) {
      b.wide = false;
      if (!b.dragging) b.thumb.classList.remove("on");
    }
  });
  window.addEventListener("resize", () => {
    for (const b of [...bars.values()]) if (b.thumb.classList.contains("on")) place(b);
  });
  // Elements that leave the page take their thumbs with them.
  window.setInterval(() => {
    for (const b of [...bars.values()]) if (!b.el.isConnected) remove(b);
  }, 5000);
}
