// apps/cli/lib/tool-display.js
//
// One-line display value for a tool call, rendered after "name: " in the CLI
// (e.g. "read: package.json"). Plain JS on purpose: unit-tested with node:test
// (JSX components cannot run under plain node).

// First present key wins: every tool's most informative argument comes first.
// Note: `pattern` outranks `path` so grep/glob show the pattern; their
// search path is appended as context by the extras below.
const PRIMARY_KEYS = ["filePath", "command", "query", "url", "pattern", "path"];

const MAX_TARGET_CHARS = 60;

function parseArgs(argumentsValue) {
  if (typeof argumentsValue === "string") {
    const trimmed = argumentsValue.trim();
    if (trimmed === "") return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      // Raw string argument (e.g. echoed commands): display as-is.
      return { __raw: trimmed };
    }
  }
  if (argumentsValue && typeof argumentsValue === "object") return argumentsValue;
  return null;
}

function singleLine(text) {
  const flat = String(text).replace(/\n/g, "\\n");
  return flat.length > MAX_TARGET_CHARS ? flat.slice(0, MAX_TARGET_CHARS) + "..." : flat;
}

/**
 * Build the display value for a tool call's arguments.
 * Examples: read→"package.json", shell→"git status", grep→"foo in src".
 */
export function formatToolTarget(toolName, argumentsValue) {
  const args = parseArgs(argumentsValue);
  if (!args) return "";
  if (typeof args.__raw === "string") return singleLine(args.__raw);

  let target = "";
  for (const key of PRIMARY_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") {
      target = value.trim();
      break;
    }
  }
  if (target === "") {
    // No recognized key: fall back to a compact key=value dump.
    return singleLine(
      Object.entries(args)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" "),
    );
  }

  const extras = [];
  if (toolName === "shell" && typeof args.workdir === "string" && args.workdir.trim() !== "") {
    extras.push(`@ ${args.workdir.trim()}`);
  }
  if ((toolName === "glob" || toolName === "grep") && typeof args.path === "string" && args.path.trim() !== "") {
    extras.push(`in ${args.path.trim()}`);
  }
  const full = extras.length > 0 ? `${target} ${extras.join(" ")}` : target;
  return singleLine(full);
}

/**
 * Merge standalone tool_result entries into their tool_call by call_id so
 * history renders ONE entry per call (header + compact result), never a
 * doubled input/output pair. Unmatched results are kept as-is.
 */
export function attachToolResults(chat) {
  if (!Array.isArray(chat)) return chat;
  const merged = chat.map((item) =>
    item?.role === "tool_call" ? { ...item, content: { ...(item.content ?? {}) } } : item,
  );
  const callIndexById = new Map();
  merged.forEach((item, index) => {
    const id = item?.content?.call_id;
    if (item?.role === "tool_call" && id !== undefined && !callIndexById.has(id)) {
      callIndexById.set(id, index);
    }
  });
  const consumed = new Set();
  merged.forEach((item, index) => {
    if (item?.role !== "tool_result" || item?.content?.call_id === undefined) return;
    const target = callIndexById.get(item.content.call_id);
    // Only merge into an EARLIER call (results always follow their call).
    if (target === undefined || target > index) return;
    consumed.add(index);
    const call = merged[target];
    merged[target] = { ...call, content: { ...call.content, result: item.content?.result } };
  });
  return merged.filter((_, index) => !consumed.has(index));
}

/**
 * Trim a live output preview or final result for one-line-ish display:
 * last 8 lines, at most 600 chars with an ellipsis head.
 */
export function formatPreview(value) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const lines = text.split("\n").slice(-8);
  const joined = lines.join("\n");
  return joined.length > 600 ? "...\n" + joined.slice(-600) : joined;
}

