// MarkdownContent.tsx — Renderer de markdown basado en marked + shiki + katex
// Reemplaza a react-markdown. Usa:
//   - marked                       (parser core)
//   - marked-shiki                 (syntax highlighting async via Shiki)
//   - marked-katex-extension       (math inline + display)
//   - DOMPurify                    (sanitización del HTML resultante)
//   - morphdom                     (diff eficiente del DOM para streaming)
//
// Mantiene un LRU cache módulo-level de 200 entradas keyed por hash de contenido,
// con fast path para texto plano sin caracteres de markdown.

import { useEffect, useRef } from "react";
import { marked } from "marked";
import markedShiki from "marked-shiki";
import markedKatex from "marked-katex-extension";
import DOMPurify from "dompurify";
import morphdom from "morphdom";

type CodeToHtmlFn = typeof import("shiki")["codeToHtml"];
let codeToHtmlLoader: Promise<CodeToHtmlFn> | null = null;

async function getCodeToHtml(): Promise<CodeToHtmlFn> {
  if (!codeToHtmlLoader) {
    codeToHtmlLoader = import("shiki").then((mod) => mod.codeToHtml);
  }
  return codeToHtmlLoader;
}

// ─── LRU Cache ──────────────────────────────────────────────────────────────
const CACHE_MAX = 200;
const markdownCache = new Map<string, string>();

/** FNV-1a hash (fast, no crypto). Returns base36 string. */
function cacheHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function cacheInsert(hash: string, html: string) {
  if (markdownCache.size >= CACHE_MAX) {
    const firstKey = markdownCache.keys().next().value;
    if (firstKey !== undefined) markdownCache.delete(firstKey);
  }
  markdownCache.set(hash, html);
}

// ─── Escape HTML ────────────────────────────────────────────────────────────
const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]!);
}

// ─── Setup de marked (una sola vez) ─────────────────────────────────────────
let markedInitialized = false;
function initMarked() {
  if (markedInitialized) return;

  // Shiki syntax highlighting (async)
  marked.use(
    markedShiki({
      async highlight(code, lang) {
        try {
          const codeToHtml = await getCodeToHtml();
          return await codeToHtml(code, {
            lang: lang || "text",
            theme: "github-dark",
          });
        } catch {
          // Si el lenguaje no existe en Shiki, fallback a <pre><code>
          return `<pre class="markdown-code-block"><code>${escapeHtml(code)}</code></pre>`;
        }
      },
    })
  );

  // KaTeX math ($...$ y $$...$$)
  marked.use(
    markedKatex({
      throwOnError: false,
      output: "html",
    })
  );

  marked.setOptions({
    gfm: true,
    breaks: false,
  });

  markedInitialized = true;
}

// ─── Fast path para texto plano ─────────────────────────────────────────────
// Si el contenido no tiene ningún carácter típico de markdown en sus primeros
// 500 chars, saltamos el parser entero y escapamos + <br>.
const MD_CHARS_REGEX = /[#*_`[\]|>~$\\]/;

// ─── DOMPurify config ───────────────────────────────────────────────────────
// Whitelist mínima para MathML que emite KaTeX, sin permitir nada peligroso.
const PURIFY_CONFIG = {
  ADD_TAGS: [
    "math",
    "semantics",
    "annotation",
    "mrow",
    "mi",
    "mo",
    "mn",
    "ms",
    "mtext",
    "mspace",
    "msup",
    "msub",
    "msubsup",
    "mfrac",
    "mroot",
    "msqrt",
    "mtable",
    "mtr",
    "mtd",
    "munder",
    "mover",
    "munderover",
    "mpadded",
    "mphantom",
    "mstyle",
  ],
  ADD_ATTR: [
    "class",
    "style",
    "xmlns",
    "display",
    "encoding",
    "mathvariant",
    "fence",
    "stretchy",
    "separator",
    "accent",
    "largeop",
    "lspace",
    "rspace",
    "linethickness",
    "columnalign",
    "rowspacing",
    "columnspacing",
    "aria-hidden",
  ],
};

// ─── Render principal ───────────────────────────────────────────────────────
async function renderMarkdown(content: string): Promise<string> {
  const hash = cacheHash(content);
  const cached = markdownCache.get(hash);
  if (cached !== undefined) {
    // MRU promotion
    markdownCache.delete(hash);
    markdownCache.set(hash, cached);
    return cached;
  }

  initMarked();

  // Fast path: texto plano sin caracteres de markdown
  if (!MD_CHARS_REGEX.test(content.slice(0, 500))) {
    const html = `<p>${escapeHtml(content).replace(/\n/g, "<br>")}</p>`;
    cacheInsert(hash, html);
    return html;
  }

  const rawHtml = await marked.parse(content, { async: true });
  const clean = DOMPurify.sanitize(rawHtml, PURIFY_CONFIG) as unknown as string;

  cacheInsert(hash, clean);
  return clean;
}

// ─── Componente React ───────────────────────────────────────────────────────
interface MarkdownContentProps {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className }: MarkdownContentProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    renderMarkdown(content)
      .then((html) => {
        if (cancelled || !ref.current) return;

        // Morphdom diff — eficiente para streaming
        const temp = document.createElement("div");
        temp.innerHTML = html;
        morphdom(ref.current, temp, {
          childrenOnly: true,
        });
      })
      .catch((err) => {
        console.error("[markdown] render error:", err);
        if (ref.current && !cancelled) {
          ref.current.textContent = content;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [content]);

  return <div ref={ref} className={className} />;
}

export default MarkdownContent;
