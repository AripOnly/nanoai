// src/infra/secure-file.js
//
// Atomic file replacement for small, sensitive JSON documents. Write to a
// sibling temp file, fsync it, then rename over the target. A crash leaves
// either the old complete file or the new complete file, never a half-written
// settings file. POSIX permissions are tightened to owner-only; Windows has
// no equivalent mode, so chmod is skipped there.

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isWindows, setPrivateMode } from "./platform.js";

export async function writeFileAtomic(
  filePath,
  content,
  { mode = 0o600 } = {},
) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });

  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );

  let handle = null;
  try {
    handle = await fs.open(tempPath, "w", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    await fs.rename(tempPath, filePath);
    const modeApplied = await setPrivateMode(filePath, mode);
    if (!modeApplied && !isWindows()) {
      throw new Error(`Failed to set owner-only permissions on ${filePath}.`);
    }
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The original error is the useful one.
      }
    }
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      // Best effort; a leftover temp file is harmless and contains no more
      // than the settings document itself.
    }
    throw error;
  }
}
