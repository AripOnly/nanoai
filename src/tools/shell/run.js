// src/tools/shell/run.js
// Streaming execution engine with timeout and incremental output.
// Dual-channel streaming:
// - to user (live): onUpdate({ preview }) called per chunk, capped at 30k tail.
// - to LLM (final): truncated tail + outputPath + exit/timedOut/aborted metadata.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isPS } from "./select.js";
import { limits, preview, tail } from "#src/tools/shared/truncate.js";

const SIGKILL_TIMEOUT_MS = 200;

async function killTree(child) {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, SIGKILL_TIMEOUT_MS));
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, SIGKILL_TIMEOUT_MS));
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    } catch {
      // already exited
    }
  }
}

function buildSpawn(shell, command, cwd, env) {
  if (process.platform === "win32" && isPS(shell)) {
    return spawn(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    });
  }
  return spawn(command, [], {
    shell,
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
}

export async function runShell({ shell, command, cwd, env, timeout, signal, onUpdate }) {
  const { maxLines, maxBytes } = limits();
  const keep = maxBytes * 2;

  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("Command must be a non-empty string.");
  }
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new Error("Timeout must be a non-negative number.");
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = buildSpawn(shell, command, cwd, env ?? process.env);
    } catch (err) {
      reject(err);
      return;
    }

    const list = [];
    let used = 0;
    let cut = false;
    let last = "";
    let full = "";
    let file = "";
    let sink;
    let timedOut = false;
    let aborted = false;
    let finished = false;

    const emit = () => {
      try {
        onUpdate?.({ preview: last });
      } catch {
        // UI callback must never break execution.
      }
    };

    const spillToFile = async () => {
      const dir = path.join(os.tmpdir(), "nano-shell");
      await mkdir(dir, { recursive: true });
      // Capture first, then reset: chunks arriving while writeFile is in
      // flight keep appending to `full` and are flushed to the sink below.
      // (Resetting after the write would silently drop them.)
      const pending = full;
      full = "";
      const name = `shell-${Date.now()}-${Math.random().toString(36).slice(2)}.log`;
      const filePath = path.join(dir, name);
      await writeFile(filePath, pending, "utf8");
      file = filePath;
      cut = true;
      sink = createWriteStream(filePath, { flags: "a" });
      if (full) {
        try {
          sink.write(full);
        } catch {
          // ignore sink errors, memory buffer still has the tail
        }
        full = "";
      }
    };
    let spillPromise = Promise.resolve();
    let spillScheduled = false;

    const onChunk = (chunk) => {
      const text = chunk.toString();
      const size = Buffer.byteLength(text, "utf-8");
      list.push({ text, size });
      used += size;
      while (used > keep && list.length > 1) {
        const item = list.shift();
        if (!item) break;
        used -= item.size;
        cut = true;
      }
      last = preview(last + text);
      if (file) {
        try {
          sink?.write(text);
        } catch {
          // ignore sink errors, memory buffer still has tail
        }
      } else {
        full += text;
        if (Buffer.byteLength(full, "utf-8") > maxBytes && !spillScheduled) {
          spillScheduled = true;
          spillPromise = spillPromise.then(spillToFile).catch(() => {});
        }
      }
      emit();
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(err);
    });

    const abortHandler = () => {
      if (finished) return;
      aborted = true;
      killTree(child).catch(() => {});
    };
    if (signal) {
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }

    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      killTree(child).catch(() => {});
    }, timeout);

    const cleanup = () => {
      clearTimeout(timer);
      try {
        signal?.removeEventListener("abort", abortHandler);
      } catch {
        // ignore
      }
    };

    child.on("close", async (code) => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        await spillPromise;
      } catch {
        // ignore
      }
      try {
        if (sink) {
          await new Promise((res) => {
            if (sink.destroyed || sink.closed) return res();
            sink.once("close", () => res());
            sink.once("error", () => res());
            sink.once("finish", () => res());
            sink.end(() => res());
          });
        }
      } catch {
        // ignore
      }

      await spillPromise.catch(() => {});
      const raw = list.map((i) => i.text).join("");
      const end = tail(raw, maxLines, maxBytes);
      if (end.truncated) cut = true;
      let outFile = file;
      if (!outFile && end.truncated) {
        try {
          const dir = path.join(os.tmpdir(), "nano-shell");
          await mkdir(dir, { recursive: true });
          const name = `shell-${Date.now()}-${Math.random().toString(36).slice(2)}.log`;
          outFile = path.join(dir, name);
          await writeFile(outFile, raw, "utf8");
        } catch {
          outFile = file;
        }
      }

      let output = end.text;
      if (!output) output = "(no output)";
      if (cut && outFile) {
        output = `...output truncated...\n\nFull output saved to: ${outFile}\n\n` + output;
      }
      const meta = [];
      if (timedOut) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        );
      }
      if (aborted) meta.push("User aborted the command");
      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>";
      }

      resolve({
        code,
        output,
        rawPreview: last || preview(output),
        truncated: cut,
        outputPath: cut && outFile ? outFile : null,
        timedOut,
        aborted,
      });
    });
  });
}
