// The GitHub sign-in code, big: hold it to copy (it's also copied when GitHub opens). Kept apart
// from screens.tsx, which loads the window's store: setup runs before window.conversations exists.
import { useRef, useState } from "react";
import { copyText } from "./state";

export function CodeToCopy({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = async () => {
    if (await copyText(code)) {
      setCopied(true);
      navigator.vibrate?.(20);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return (
    <div className="code-hold">
      <span
        className={`device-code${copied ? " copied" : ""}`}
        aria-label={`Code ${code}. Hold to copy.`}
        onPointerDown={() => {
          cancel();
          timer.current = setTimeout(() => void copy(), 450);
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onContextMenu={(e) => {
          e.preventDefault();
          void copy();
        }}
      >
        {code}
      </span>
      <span className="code-hint">{copied ? "Copied" : "Hold to copy · copied when GitHub opens"}</span>
    </div>
  );
}
