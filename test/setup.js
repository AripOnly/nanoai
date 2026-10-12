// test/setup.js
//
// Preloaded before every suite file (see the `test` script in package.json).
// Points all runtime data at a throwaway directory so suites never touch the
// developer's real ~/.nanoai — every test file runs in its own process, so
// each suite gets its own sandbox.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.NANO_DATA_DIR) {
  process.env.NANO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nanoai-suite-"));
}
// Test processes must never adopt or move real user data: migration stays off.
process.env.NANOAI_SKIP_MIGRATION = "1";
