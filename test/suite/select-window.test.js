// test/suite/select-window.test.js
// Covers the fixed-height (10 rows) scrolling window shared by every
// picker (CommandBox, SessionList, ModelList, provider list).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_VISIBLE_ITEMS,
  adjustWindow,
  nextCursor,
  visibleSlice,
} from "../../apps/cli/lib/select-window.js";

describe("select window", () => {
  it("fixes the visible height to 10", () => {
    assert.equal(MAX_VISIBLE_ITEMS, 10);
  });

  it("wraps the cursor at both ends", () => {
    assert.equal(nextCursor(0, -1, 25), 24);
    assert.equal(nextCursor(24, 1, 25), 0);
    assert.equal(nextCursor(4, 1, 25), 5);
    assert.equal(nextCursor(0, 1, 0), 0);
  });

  it("never offsets short lists", () => {
    assert.equal(adjustWindow(0, 0, 5), 0);
    assert.equal(adjustWindow(9, 0, 10), 0);
    assert.equal(adjustWindow(9, 5, 10), 0);
  });

  it("scrolls the window only when the cursor leaves it", () => {
    // Walk down a 25-row list: first 10 stay pinned, then follow one-by-one.
    let start = 0;
    for (let cursor = 0; cursor < 10; cursor++) {
      start = adjustWindow(cursor, start, 25);
      assert.equal(start, 0);
    }
    start = adjustWindow(10, start, 25);
    assert.equal(start, 1);
    start = adjustWindow(24, 1, 25);
    assert.equal(start, 15);
    // Wrap back to top resets the window.
    assert.equal(adjustWindow(0, 15, 25), 0);
    // Step up from the bottom edge pulls the window back.
    assert.equal(adjustWindow(14, 15, 25), 14);
  });

  it("slices exactly the visible rows", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ value: i, label: `i${i}` }));
    assert.equal(visibleSlice(items, 0).length, 10);
    assert.deepEqual(
      visibleSlice(items, 15).map((it) => it.value),
      [15, 16, 17, 18, 19, 20, 21, 22, 23, 24],
    );
    assert.deepEqual(visibleSlice([{ value: 1 }], 0).length, 1);
    assert.deepEqual(visibleSlice([], 0), []);
  });

  it("clamps after filtering shrinks the list", () => {
    // 25 -> 3 rows (e.g. typing a CommandBox filter): window resets.
    assert.equal(adjustWindow(2, 15, 3), 0);
  });
});
