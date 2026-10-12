// test/suite/read.test.js
// Covers the rebuilt read tool: paged text with line numbers, directory
// listing, miss suggestions, binary refusal, images/PDFs as attachments,
// Word/Excel parsing, validation, and the open read-only path policy.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import XLSX from "xlsx";
import { read } from "../../src/tools/read/read.js";
import { loadAttachment } from "../../src/tools/shared/attachments.js";
import { toolExecute } from "../../src/agents/tool-execute.js";

// 1x1 transparent PNG (well-known minimal fixture).
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function scratchDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nano-read-"));
  process.env.NANO_WORKSPACE = dir;
  return dir;
}

describe("read tool: text files", () => {
  it("numbers lines and pages with offset/limit", async () => {
    const dir = scratchDir();
    const lines = Array.from({ length: 50 }, (_, i) => `content line ${i + 1}`);
    fs.writeFileSync(path.join(dir, "fifty.txt"), lines.join("\n") + "\n", "utf8");
    const first = await read({ path: "fifty.txt", offset: 1, limit: 10 });
    assert.equal(first.success, true);
    assert.ok(first.output.includes("1: content line 1"), first.output.slice(0, 200));
    assert.ok(first.output.includes("10: content line 10"));
    assert.ok(first.output.includes("Showing lines 1-10 of 50"));
    const second = await read({ path: "fifty.txt", offset: 41, limit: 20 });
    assert.equal(second.success, true);
    assert.ok(second.output.includes("41: content line 41"));
    assert.ok(second.output.includes("End of file - total 50 lines"));
  });

  it("rejects out-of-range offsets", async () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, "short.txt"), "a\nb\n", "utf8");
    const result = await read({ path: "short.txt", offset: 99 });
    assert.equal(result.success, false);
    assert.match(result.error, /out of range/);
  });

  it("suggests similar names on miss", async () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, "configuration.json"), "{}\n", "utf8");
    const result = await read({ path: "configuration.jso" });
    assert.equal(result.success, false);
    assert.match(result.error, /Did you mean/);
  });

  it("refuses binary files", async () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x41, 0x42]));
    const result = await read({ path: "blob.bin" });
    assert.equal(result.success, false);
    assert.match(result.error, /binary/);
  });

  it("validates every parameter", async () => {
    scratchDir();
    assert.equal((await read()).success, false);
    assert.equal((await read({})).success, false);
    assert.equal((await read({ path: "  " })).success, false);
    assert.equal((await read({ path: "x.txt", offset: 0 })).success, false);
    assert.equal((await read({ path: "x.txt", offset: 1.5 })).success, false);
    assert.equal((await read({ path: "x.txt", limit: -2 })).success, false);
    assert.equal((await read("x.txt")).success, false);
  });
});

describe("read tool: directories", () => {
  it("lists entries with trailing slashes for folders", async () => {
    const dir = scratchDir();
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n", "utf8");
    const result = await read({ path: "." });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("a.txt"), result.output);
    assert.ok(result.output.includes("sub/"), result.output);
    assert.ok(result.output.includes("(2 entries)"));
  });
});

describe("read tool: media attachments", () => {
  it("attaches images by reference, not by bytes", async () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, "dot.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
    const result = await read({ path: "dot.png" });
    assert.equal(result.success, true);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].mime, "image/png");
    assert.ok(!JSON.stringify(result).includes(TINY_PNG_BASE64.slice(0, 60)), "bytes must not leak into the result");
    const roundTrip = loadAttachment(result.attachments[0].id);
    assert.ok(roundTrip.equals(Buffer.from(TINY_PNG_BASE64, "base64")));
  });

  it("attaches PDFs for the model to read natively", async () => {
    const dir = scratchDir();
    const minimal = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF", "utf8");
    fs.writeFileSync(path.join(dir, "mini.pdf"), minimal);
    const result = await read({ path: "mini.pdf" });
    assert.equal(result.success, true);
    assert.equal(result.attachments[0].mime, "application/pdf");
  });

  it("rejects unknown attachment ids (no traversal)", () => {
    assert.throws(() => loadAttachment("../secret"), /Unknown attachment/);
    assert.throws(() => loadAttachment("x"), /Unknown attachment/);
  });
});

describe("read tool: office documents", () => {
  it("extracts Word text", async () => {
    const dir = scratchDir();
    const buffer = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Report")] }),
              new Paragraph({ children: [new TextRun("Hello word tool")] }),
            ],
          },
        ],
      }),
    );
    fs.writeFileSync(path.join(dir, "report.docx"), buffer);
    const result = await read({ path: "report.docx" });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("Hello word tool"), result.output.slice(0, 300));
  });

  it("extracts spreadsheet values per sheet", async () => {
    const dir = scratchDir();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["name", "qty"],
        ["apple", 3],
      ]),
      "Stock",
    );
    XLSX.writeFile(workbook, path.join(dir, "stock.xlsx"));
    const result = await read({ path: "stock.xlsx" });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("## Sheet: Stock"), result.output.slice(0, 300));
    assert.ok(result.output.includes("apple | 3"));
    assert.equal(result.sheets, 1);
  });

  it("refuses legacy binary .doc with guidance", async () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, "old.doc"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x01]));
    const result = await read({ path: "old.doc" });
    assert.equal(result.success, false);
    assert.match(result.error, /binary/);
  });
});

describe("read tool: path policy and dispatch", () => {
  it("reads absolute paths outside the workspace", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nano-read-outside-"));
    const file = path.join(dir, "free.txt");
    fs.writeFileSync(file, "outside\n", "utf8");
    try {
      const result = await read({ path: file });
      assert.equal(result.success, true);
      assert.ok(result.output.includes("1: outside"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatches by name through toolExecute", async () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, "via.txt"), "hello dispatch\n", "utf8");
    const result = await toolExecute({
      name: "read",
      arguments: JSON.stringify({ path: "via.txt" }),
    });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("1: hello dispatch"));
  });
});
