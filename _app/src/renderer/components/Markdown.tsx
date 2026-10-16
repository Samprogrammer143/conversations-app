// Claude's replies as Markdown: prose at a 560 px measure, code blocks and
// tables the full 720 px column. Raw HTML in a transcript is shown as text.
import { memo, useMemo } from "react";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import diff from "highlight.js/lib/languages/diff";
import markdownLang from "highlight.js/lib/languages/markdown";
import { ICONS } from "../icons/icons";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("python", python);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("markdown", markdownLang);
const ALIASES: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", sh: "bash", shell: "bash", zsh: "bash", ps1: "powershell", pwsh: "powershell", py: "python", html: "xml", svg: "xml", yml: "yaml", md: "markdown" };

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const copyIcon = `<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS.copy}</svg>`;

export function highlight(code: string, lang?: string | null): string {
  const l = lang ? ALIASES[lang.toLowerCase()] ?? lang.toLowerCase() : null;
  try {
    if (l && hljs.getLanguage(l)) return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
  } catch {}
  return escapeHtml(code);
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const info = (t.info || "").trim();
  const lang = info.split(/\s+/)[0] || "";
  const name = info.includes(":") ? info.split(":").slice(1).join(":") : lang;
  const code = t.content.replace(/\n$/, "");
  return `<div class="code-block"><div class="code-head"><span class="name">${escapeHtml(name || "code")}</span><button type="button" class="icon-btn" data-copy aria-label="Copy code" title="Copy code">${copyIcon}</button></div><pre class="code-body"><code>${highlight(code, lang)}</code></pre></div>`;
};
md.renderer.rules.code_block = md.renderer.rules.fence;
md.renderer.rules.table_open = () => '<div class="table-wrap"><table>';
md.renderer.rules.table_close = () => "</table></div>";
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noreferrer");
  return defaultLink(tokens, idx, options, env, self);
};

const cache = new Map<string, string>();
export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit) return hit;
  const html = md.render(text);
  if (cache.size > 2000) cache.clear();
  cache.set(text, html);
  return html;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="prose selectable" dangerouslySetInnerHTML={{ __html: html }} />;
});
