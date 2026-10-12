// test/suite/write.test.js
// Covers the rebuilt write tool plus the Word/Excel writers: overwrite and
// create semantics, mkdir mode, diffs, jail policy, validation, and binary
// round-trips back through the readers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { write } from "../../src/tools/write/write.js";
import { writeWord } from "../../src/tools/write/word.js";
import { writeExcel } from "../../src/tools/write/excel.js";
import { read } from "../../src/tools/read/read.js";
import { readSpreadsheet } from "../../src/tools/read/excel.js";
import { toolExecute } from "../../src/agents/tool-execute.js";

function scratchDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nano-write-"));
  process.env.NANO_WORKSPACE = dir;
  return dir;
}

describe("write tool: files", () => {
  it("creates missing parents and reports a diff", async () => {
    scratchDir();
    const result = await write({ filePath: "deep/nested/file.txt", content: "hi\n" });
    assert.equal(result.success, true);
    assert.equal(result.created, true);
    assert.ok(result.diff.includes("+hi"), result.diff.slice(0, 200));
    const second = await write({ filePath: "deep/nested/file.txt", content: "ho\n" });
    assert.equal(second.success, true);
    assert.equal(second.created, false);
    assert.ok(second.diff.includes("-hi") && second.diff.includes("+ho"));
  });

  it("writes empty content as a valid empty file", async () => {
    scratchDir();
    const result = await write({ filePath: "empty.txt", content: "" });
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(process.env.NANO_WORKSPACE + "/empty.txt", "utf8"), "");
  });

  it("validates every parameter", async () => {
    scratchDir();
    assert.equal((await write()).success, false);
    assert.equal((await write({})).success, false);
    assert.equal((await write({ filePath: "  ", content: "x" })).success, false);
    assert.equal((await write({ filePath: "x.txt" })).success, false);
    assert.equal((await write({ filePath: "x.txt", content: 7 })).success, false);
    assert.equal((await write({ filePath: "x.txt", content: "x", mkdir: "yes" })).success, false);
    assert.equal((await write("x.txt")).success, false);
  });

  it("jails writes to the workspace", async () => {
    scratchDir();
    const result = await write({ filePath: "C:\\Windows\\Temp\\nano-evil.txt", content: "x" });
    assert.equal(result.success, false);
    assert.match(result.error, /workspace/);
  });
});

describe("write tool: directories", () => {
  it("creates directories with mkdir mode", async () => {
    scratchDir();
    const result = await write({ filePath: "a/b/c", mkdir: true });
    assert.equal(result.success, true);
    assert.ok(fs.statSync(process.env.NANO_WORKSPACE + "/a/b/c").isDirectory());
  });

  it("refuses file paths that collide with directories", async () => {
    const dir = scratchDir();
    fs.mkdirSync(path.join(dir, "taken"));
    const result = await write({ filePath: "taken", content: "x" });
    assert.equal(result.success, false);
    assert.match(result.error, /directory/);
  });
});

describe("writeWord tool", () => {
  it("builds headings, bullets, tables and reads back", async () => {
    scratchDir();
    const result = await writeWord({
      filePath: "doc/report.docx",
      title: "Monthly",
      blocks: [
        { type: "paragraph", text: "Intro with **bold**." },
        { type: "bullet", text: "First item" },
        {
          type: "table",
          rows: [
            ["item", "qty"],
            ["apple", "3"],
          ],
        },
      ],
    });
    assert.equal(result.success, true);
    assert.equal(result.blocks, 3);
    const back = await read({ path: "doc/report.docx" });
    assert.equal(back.success, true);
    assert.ok(back.output.includes("Monthly"), back.output.slice(0, 400));
    assert.ok(back.output.includes("apple"));
  });

  it("validates blocks strictly", async () => {
    scratchDir();
    assert.equal((await writeWord({ filePath: "x.docx", blocks: [] })).success, false);
    assert.equal((await writeWord({ filePath: "x.txt", blocks: [{ type: "paragraph", text: "t" }] })).success, false);
    const badLevel = await writeWord({ filePath: "x.docx", blocks: [{ type: "heading", level: 9, text: "t" }] });
    assert.equal(badLevel.success, false);
    const ragged = await writeWord({
      filePath: "x.docx",
      blocks: [{ type: "table", rows: [["a", "b"], ["c"]] }],
    });
    assert.equal(ragged.success, false);
    assert.match(ragged.error, /exactly 2/);
    const unknown = await writeWord({ filePath: "x.docx", blocks: [{ type: "poem", text: "t" }] });
    assert.equal(unknown.success, false);
    const jailed = await writeWord({ filePath: "C:\\Windows\\Temp\\x.docx", blocks: [{ type: "paragraph", text: "t" }] });
    assert.equal(jailed.success, false);
    assert.match(jailed.error, /workspace/);
  });
});

describe("writeExcel tool", () => {
  it("builds sheets and reads values back", async () => {
    scratchDir();
    const created = await writeExcel({
      filePath: "data/stock.xlsx",
      sheets: [
        { name: "Stock", rows: [["name", "qty"], ["apple", 3], ["pear", null]] },
        { rows: [[true]] },
      ],
    });
    assert.equal(created.success, true);
    assert.equal(created.sheets, 2);
    const buffer = fs.readFileSync(process.env.NANO_WORKSPACE + "/data/stock.xlsx");
    const parsed = readSpreadsheet(buffer);
    assert.equal(parsed.sheets, 2);
    assert.ok(parsed.text.includes("apple | 3"));
  });

  it("validates sheets strictly", async () => {
    scratchDir();
    assert.equal((await writeExcel({ filePath: "x.xlsx", sheets: [] })).success, false);
    assert.equal((await writeExcel({ filePath: "x.csv", sheets: [{ rows: [[1]] }] })).success, false);
    const dupes = await writeExcel({
      filePath: "x.xlsx",
      sheets: [{ name: "S", rows: [[1]] }, { name: "s", rows: [[2]] }],
    });
    assert.equal(dupes.success, false);
    assert.match(dupes.error, /duplicate/i);
    const badCell = await writeExcel({ filePath: "x.xlsx", sheets: [{ rows: [[{}]] }] });
    assert.equal(badCell.success, false);
    const longName = await writeExcel({ filePath: "x.xlsx", sheets: [{ name: "n".repeat(32), rows: [[1]] }] });
    assert.equal(longName.success, false);
    const jailed = await writeExcel({ filePath: "C:\\Windows\\Temp\\x.xlsx", sheets: [{ rows: [[1]] }] });
    assert.equal(jailed.success, false);
    assert.match(jailed.error, /workspace/);
  });

  it("dispatches writers by name through toolExecute", async () => {
    scratchDir();
    const w = await toolExecute({
      name: "writeExcel",
      arguments: JSON.stringify({ filePath: "d/out.xlsx", sheets: [{ rows: [["ok"]] }] }),
    });
    assert.equal(w.success, true);
    const d = await toolExecute({
      name: "writeWord",
      arguments: JSON.stringify({ filePath: "d/out.docx", blocks: [{ type: "paragraph", text: "hi" }] }),
    });
    assert.equal(d.success, true);
  });
});
