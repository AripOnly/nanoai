// apps/cli/lib/select-window.js
// Windowing helpers for SelectInput: keep every picker to a fixed visible
// height (10 rows) with a scrolling window. Pure JS so node:test can cover it.

export const MAX_VISIBLE_ITEMS = 10;

export function nextCursor(cursor, dir, total) {
  if (!Number.isInteger(total) || total <= 0) return 0;
  if (dir >= 0) return (cursor + 1) % total;
  return (cursor - 1 + total) % total;
}

export function adjustWindow(cursor, start, total, maxVisible = MAX_VISIBLE_ITEMS) {
  if (!Number.isInteger(total) || total <= 0) return 0;
  if (!Number.isInteger(maxVisible) || maxVisible <= 0) return 0;
  if (total <= maxVisible) return 0;
  const s = Number.isInteger(start) && start >= 0 ? start : 0;
  if (cursor < s) return cursor;
  if (cursor >= s + maxVisible) return cursor - maxVisible + 1;
  return s;
}

export function visibleSlice(items = [], start, maxVisible = MAX_VISIBLE_ITEMS) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (!Number.isInteger(maxVisible) || maxVisible <= 0) return [];
  const s = Number.isInteger(start) && start >= 0 ? start : 0;
  return items.slice(s, s + maxVisible);
}
