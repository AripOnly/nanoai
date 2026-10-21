// src/skills/catalog.js
//
// A bounded prompt catalog. Skill descriptions are untrusted prompt text, so
// XML delimiters are escaped and every field is length-limited. When the
// catalog cannot fit, the prompt says so and points the model at
// searchSkills(); it never grows without limit.

export const DEFAULT_MAX_CATALOG_BYTES = 16 * 1024;
export const DEFAULT_MAX_CATALOG_ENTRIES = 200;
const MAX_DESCRIPTION = 220;
const MAX_TAGS = 6;
const MAX_TRIGGERS = 6;

function truncate(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

function escapeXmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function listPart(label, values, max) {
  const items = Array.isArray(values)
    ? values
        .filter((item) => typeof item === "string" && item.trim() !== "")
        .slice(0, max)
    : [];
  if (items.length === 0) return "";
  return ` [${label}: ${items.map((item) => escapeXmlText(truncate(item, 40))).join(", ")}]`;
}

export function formatCatalogEntry(entry) {
  const tags = listPart("tags", entry.tags, MAX_TAGS);
  const triggers = listPart("triggers", entry.triggers, MAX_TRIGGERS);
  const trust = ` [trust: ${escapeXmlText(entry.trust ?? "external")}]`;
  return `- ${entry.name}: ${escapeXmlText(
    truncate(entry.description, MAX_DESCRIPTION),
  )}${tags}${triggers}${trust}`;
}

/**
 * Build the catalog block. Returns "" when there is nothing to show.
 *
 * The returned object is useful to callers that need to know whether the list
 * was cut: `{ text, included, omitted }`.
 */
export function buildCatalog(
  entries,
  {
    maxEntries = DEFAULT_MAX_CATALOG_ENTRIES,
    maxBytes = DEFAULT_MAX_CATALOG_BYTES,
  } = {},
) {
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 0;
  const byteLimit = Number.isInteger(maxBytes) && maxBytes > 0
    ? maxBytes
    : DEFAULT_MAX_CATALOG_BYTES;
  const sorted = [...(entries ?? [])].sort((a, b) =>
    String(a.name).localeCompare(String(b.name)),
  );
  if (limit === 0 || sorted.length === 0) {
    return { text: "", included: 0, omitted: sorted.length };
  }

  const header = "<available_skills>\n";
  const footer = "</available_skills>";
  const reserve = 220;
  const lines = [];
  let bytes = Buffer.byteLength(header + footer, "utf8");
  let omitted = 0;

  for (let i = 0; i < sorted.length; i++) {
    if (i >= limit) {
      omitted = sorted.length - i;
      break;
    }
    const line = `${formatCatalogEntry(sorted[i])}\n`;
    const next = Buffer.byteLength(line, "utf8");
    if (bytes + next + reserve > byteLimit) {
      omitted = sorted.length - i;
      break;
    }
    lines.push(line);
    bytes += next;
  }

  if (lines.length === 0) {
    return { text: "", included: 0, omitted: sorted.length };
  }

  let note = "";
  if (omitted > 0) {
    note =
      `\n${omitted} more skill(s) omitted from this catalog. ` +
      "Use searchSkills to find them.";
    if (bytes + Buffer.byteLength(note, "utf8") + footer.length > byteLimit) {
      note = "";
    }
  }

  return {
    text: `${header}${lines.join("")}${note}${footer}`,
    included: lines.length,
    omitted,
  };
}
