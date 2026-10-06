import { lazy, Suspense, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { toText } from "hast-util-to-text";
import { createLowlight } from "lowlight";
import { visit } from "unist-util-visit";
import { Check, Copy, TriangleAlert } from "lucide-react";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";

const MermaidDiagram = lazy(() => import("./MermaidDiagram.jsx"));

const languages = {
  bash,
  css,
  diff,
  javascript,
  json,
  markdown,
  python,
  sql,
  typescript,
  xml,
  yaml,
};

const highlighter = createLowlight(languages);
highlighter.registerAlias({
  html: "xml",
  js: "javascript",
  py: "python",
  sh: "bash",
  ts: "typescript",
  jsx: "javascript",
  tsx: "typescript",
  yml: "yaml",
});

function rehypeHighlightCommon() {
  return (tree) => {
    visit(tree, "element", (node, _, parent) => {
      if (node.tagName !== "code" || parent?.tagName !== "pre") return;

      const classes = Array.isArray(node.properties.className)
        ? node.properties.className.map(String)
        : [];
      if (classes.includes("no-highlight") || classes.includes("nohighlight")) {
        return;
      }

      const languageClass = classes.find(
        (name) => name.startsWith("language-") || name.startsWith("lang-"),
      );
      const language = languageClass?.replace(/^(language-|lang-)/, "");
      if (!language) return;

      try {
        const highlighted = highlighter.highlight(
          language,
          toText(node, { whitespace: "pre" }),
        );
        node.properties.className = classes.includes("hljs")
          ? classes
          : ["hljs", ...classes];
        node.children = highlighted.children;
      } catch {
        return;
      }
    });
  };
}

function textFromNode(node) {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(textFromNode).join("");
  }

  if (node && typeof node === "object" && "props" in node) {
    return textFromNode(node.props.children);
  }

  return "";
}

const LANGUAGE_NAMES = {
  js: "JavaScript",
  jsx: "JSX",
  ts: "TypeScript",
  tsx: "TSX",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  md: "Markdown",
  py: "Python",
  sh: "Shell",
  yml: "YAML",
  mermaid: "Mermaid",
};

function CodeBlock({ children, isStreaming }) {
  const [status, setStatus] = useState("idle");
  const code = textFromNode(children).replace(/\n$/, "");
  const className = children?.props?.className ?? "";
  const language = className.match(/language-([\w+-]+)/)?.[1];
  const languageLabel = language
    ? (LANGUAGE_NAMES[language.toLowerCase()] ?? language)
    : "Code";
  const isMermaid = !isStreaming && language?.toLowerCase() === "mermaid";
  useEffect(() => {
    if (status === "idle" || status === "copying") return undefined;
    const timeout = window.setTimeout(() => setStatus("idle"), 1800);
    return () => window.clearTimeout(timeout);
  }, [status]);

  async function copyCode() {
    setStatus("copying");

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API is unavailable");
      }
      await navigator.clipboard.writeText(code);
      setStatus("success");
    } catch {
      setStatus("error");
    }
  }

  const copyLabel = {
    idle: "Salin kode",
    copying: "Menyalin kode",
    success: "Kode tersalin",
    error: "Gagal menyalin kode",
  }[status];

  return (
    <div className="markdown-code-block relative mb-4 max-w-full overflow-hidden rounded-md border border-[#d9dee5] bg-[#f6f8fa]">
      <div className="markdown-code-toolbar flex min-h-10 items-center justify-between gap-3 border-b border-[#d9dee5] px-3.5 py-1.5 text-xs leading-tight text-[#57606a]">
        <span className="markdown-code-language overflow-hidden text-ellipsis whitespace-nowrap">
          {languageLabel}
        </span>
        <button
          type="button"
          className="markdown-copy-button inline-flex min-h-8 min-w-8 items-center justify-center gap-1.5 rounded-sm border-0 bg-transparent px-2 py-1.5 font-[inherit] text-[#444b53] hover:bg-[#e9edf1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 disabled:cursor-wait disabled:opacity-70"
          aria-label={copyLabel}
          title={copyLabel}
          onClick={copyCode}
          disabled={status === "copying"}
        >
          {status === "success" ? (
            <Check aria-hidden="true" size={15} />
          ) : status === "error" ? (
            <TriangleAlert aria-hidden="true" size={15} />
          ) : (
            <Copy aria-hidden="true" size={15} />
          )}
          <span>{status === "success" ? "Tersalin" : "Salin kode"}</span>
        </button>
      </div>
      {isMermaid ? (
        <Suspense fallback={<div className="min-h-32" aria-hidden="true" />}>
          <MermaidDiagram chart={code} />
        </Suspense>
      ) : (
        <pre className="m-0 max-w-full overflow-x-auto bg-[#f6f8fa] px-4 py-3.5 text-[0.84rem] leading-[1.6] text-[#24292f] tab-2 [&_code]:bg-transparent [&_code]:p-0 [&_code]:font-[inherit] [&_code]:text-inherit">
          {children}
        </pre>
      )}
      <span
        className="markdown-copy-status sr-only"
        role="status"
        aria-live="polite"
      >
        {status === "success" ? "Kode berhasil disalin" : ""}
        {status === "error"
          ? "Clipboard tidak tersedia atau menolak akses"
          : ""}
      </span>
    </div>
  );
}

function MarkdownRenderer({ content = "", isStreaming = false }) {
  return (
    <div className="markdown-body min-w-0 wrap-break-word text-[0.95rem] leading-5 text-current [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_.katex-display]:my-1 [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlightCommon]}
        components={{
          h1: ({ children, ...props }) => (
            <h1
              className="mb-2 mt-6 text-[1.65rem] leading-[1.35] font-semibold text-[#202124]"
              {...props}
            >
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2
              className="mb-2 mt-6 text-[1.35rem] leading-[1.35] font-semibold text-[#202124]"
              {...props}
            >
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3
              className="mb-2 mt-6 text-[1.12rem] leading-[1.35] font-semibold text-[#202124]"
              {...props}
            >
              {children}
            </h3>
          ),
          h4: ({ children, ...props }) => (
            <h4
              className="mb-2 mt-6 text-base leading-[1.35] font-semibold text-[#202124]"
              {...props}
            >
              {children}
            </h4>
          ),
          h5: ({ children, ...props }) => (
            <h5
              className="mb-2 mt-6 text-base leading-[1.35] font-semibold text-[#202124]"
              {...props}
            >
              {children}
            </h5>
          ),
          h6: ({ children, ...props }) => (
            <h6
              className="mb-2 mt-6 text-base leading-[1.35] font-semibold text-[#202124]"
              {...props}
            >
              {children}
            </h6>
          ),
          p: ({ children, ...props }) => (
            <p className="mb-4" {...props}>
              {children}
            </p>
          ),
          ul: ({ children, ...props }) => (
            <ul
              className="mb-4 list-disc pl-6 [&>li+li]:mt-1 [&_p]:mb-1"
              {...props}
            >
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol
              className="mb-4 list-decimal pl-6 [&>li+li]:mt-1 [&_p]:mb-1"
              {...props}
            >
              {children}
            </ol>
          ),
          blockquote: ({ children, ...props }) => (
            <blockquote
              className="mb-4 border-l-[3px] border-gray-300 pl-4 text-gray-600"
              {...props}
            >
              {children}
            </blockquote>
          ),
          a: ({ href, children, ...props }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-800 underline decoration-1 underline-offset-2 hover:text-sky-950"
              {...props}
            >
              {children}
            </a>
          ),
          code: ({ className, children, ...props }) => {
            delete props.node;
            return (
              <code
                className={
                  className ??
                  "markdown-inline-code rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.88em] wrap-break-word text-gray-800"
                }
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <CodeBlock isStreaming={isStreaming}>{children}</CodeBlock>
          ),
          hr: (props) => (
            <hr className="my-6 h-px border-0 bg-[#d9dee5]" {...props} />
          ),
          img: ({ alt, ...props }) => (
            <img className="h-auto max-w-full" alt={alt ?? ""} {...props} />
          ),
          table: ({ children, ...props }) => (
            <div className="markdown-table-wrap mb-4 max-w-full overflow-x-auto rounded border border-[#d9dee5]">
              <table
                className="mb-4 w-max min-w-full border-collapse text-left [&_td]:border-b [&_td]:border-[#e1e4e8] [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_th]:border-b [&_th]:border-[#e1e4e8] [&_th]:bg-[#f6f8fa] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:align-top [&_tr:last-child_td]:border-b-0"
                {...props}
              >
                {children}
              </table>
            </div>
          ),
        }}
      >
        {typeof content === "string" ? content : ""}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownRenderer;
