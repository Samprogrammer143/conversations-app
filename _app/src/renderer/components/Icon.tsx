import { memo } from "react";
import { ICONS } from "../icons/icons";

export type IconProps = { name: string; size?: number; className?: string; label?: string; strokeWidth?: number };

/** Lucide at 1.75 stroke on a 24 grid, drawn at 16 px by default (Figma: Components > Icons). */
export const Icon = memo(function Icon({ name, size = 16, className, label, strokeWidth = 1.75 }: IconProps) {
  const src = ICONS[name] ?? ICONS["circle-dashed"];
  const filled = src.startsWith("FILL:");
  const custom = src.startsWith("F:");
  const inner = filled ? src.slice(5) : custom ? src.slice(2) : src;
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={custom ? undefined : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
});

export const ToolIcon = ({ kind, size = 14 }: { kind: string; size?: number }) => {
  const name =
    {
      read: "file-text",
      search: "search",
      edit: "pencil",
      write: "file-code",
      command: "terminal",
      web: "globe",
      mcp: "zap",
      agent: "bot",
      plan: "list-filter",
      skill: "sparkles",
      question: "message-square",
      other: "wrench",
    }[kind] ?? "wrench";
  return <Icon name={name} size={size} />;
};
