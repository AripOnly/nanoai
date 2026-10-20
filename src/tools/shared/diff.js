// src/tools/shared/diff.js
//
// Shared diff presentation. Moved out of edit.js so the write tool (and any
// future tool) can render diffs without depending on the edit tool —
// sibling tool families must stay level with each other, never hierarchical.

/**
 * Dedent unified diffs so deeply indented files stay readable for the model.
 */
export function trimDiff(diff) {
  const lines = diff.split("\n");
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  );
  if (contentLines.length === 0) return diff;
  let min = Infinity;
  for (const line of contentLines) {
    const content = line.slice(1);
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/);
      if (match) min = Math.min(min, match[1].length);
    }
  }
  if (min === Infinity || min === 0) return diff;
  return lines
    .map((line) => {
      if (
        (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
        !line.startsWith("---") &&
        !line.startsWith("+++")
      ) {
        return line[0] + line.slice(1).slice(min);
      }
      return line;
    })
    .join("\n");
}
