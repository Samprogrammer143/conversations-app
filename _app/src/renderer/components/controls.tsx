import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon } from "./Icon";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({ kind = "secondary", icon, children, className, ...rest }: BtnProps & { kind?: "primary" | "secondary" | "plain" | "danger"; icon?: string }) {
  const cls = { primary: "btn-primary", secondary: "btn-secondary", plain: "btn-plain", danger: "btn-danger-plain" }[kind];
  return (
    <button type="button" className={`btn ${cls}${className ? ` ${className}` : ""}`} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

/** Icon-only button. Every one gets an accessible name and a tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, BtnProps & { icon: string; label: string; size?: number; pressed?: boolean }>(function IconButton({ icon, label, size = 16, pressed, className, ...rest }, ref) {
  return (
    <button ref={ref} type="button" className={`icon-btn${className ? ` ${className}` : ""}`} aria-label={label} title={label} aria-pressed={pressed} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
});

export function GlassCircle({ icon, label, ...rest }: BtnProps & { icon: string; label: string }) {
  return (
    <button type="button" className="glass glass-circle" aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

export function ToolbarButton({ icon, children, ...rest }: BtnProps & { icon: string; children: ReactNode }) {
  return (
    <button type="button" className="glass toolbar-btn" {...rest}>
      <Icon name={icon} />
      <span>{children}</span>
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" onClick={() => onChange(!checked)} />;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; count?: number }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className="segment"
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            const i = options.findIndex((x) => x.value === value);
            if (e.key === "ArrowRight") onChange(options[Math.min(options.length - 1, i + 1)].value);
            if (e.key === "ArrowLeft") onChange(options[Math.max(0, i - 1)].value);
          }}
        >
          {o.label}
          {o.count != null && o.count > 0 && <span className="count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Graphite tile. The sidebar uses the 20 px tile at 16 px with its 13 px glyph (Figma), hence glyphSize. */
export function Tile({ glyph, size = 20, glyphSize }: { glyph: string; size?: 16 | 20; glyphSize?: number }) {
  return (
    <span className={`tile${size === 16 ? " s16" : ""}`} aria-hidden>
      <Icon name={glyph} size={glyphSize ?? (size === 16 ? 11 : 13)} strokeWidth={2} />
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg className="icon spinner" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
