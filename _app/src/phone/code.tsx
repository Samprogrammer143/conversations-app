// The GitHub sign-in code with a Copy button (setup and the workspace switcher). Kept apart from
// screens.tsx, which loads the window's store: setup runs before window.conversations exists.
import { useState } from "react";
import { Icon } from "../renderer/components/Icon";
import { copyText } from "./state";

/** The GitHub sign-in code, big, with a Copy button (and it can be selected by hand). */
export function CodeToCopy({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-to-copy">
      <span className="device-code" aria-label={`Code ${code}`}>
        {code}
      </span>
      <button
        className="copy-button"
        onClick={async () => {
          setCopied(await copyText(code));
          setTimeout(() => setCopied(false), 2500);
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={18} />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

