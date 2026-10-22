// src/infra/logger.js
//
// Structured operational logging. Every entry is one JSON line so a human can
// still read it with `nanoai gateway log` while machines can parse it. The
// writer rotates files by size before appending, which keeps a 24/7 gateway
// from filling the disk. Secrets in field names are redacted; message text is
// left alone so explicit operator output (for example the first-boot token)
// stays useful.
//
// Logging is deliberately synchronous. Gateway logs are low-volume compared
// with request bodies and job output, and synchronous append/close makes
// rotation safe on Windows where renaming an open file is blocked.

import fs from "node:fs";
import path from "node:path";

export const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
});

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 3;
const SECRET_KEY = /(?:token|secret|password|passwd|authorization|api[_-]?key|private[_-]?key)/i;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function safeValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code ?? undefined,
      stack: typeof value.stack === "string" ? value.stack : undefined,
    };
  }
  if (depth >= 5) return "[depth-limit]";
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 100).map((item) => safeValue(item, depth + 1, seen));
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SECRET_KEY.test(key) ? "[redacted]" : safeValue(item, depth + 1, seen);
    }
    return result;
  }
  return String(value);
}

function normalizeFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
  const result = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = SECRET_KEY.test(key) ? "[redacted]" : safeValue(value);
  }
  return result;
}

/**
 * Rotate a log file once it is larger than maxBytes. Oldest files are dropped
 * first: app.log.1 is the previous file, app.log.2 the one before that.
 */
export function rotateLogFile(
  filePath,
  { maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP, force = false } = {},
) {
  const limit = positiveInteger(maxBytes, DEFAULT_MAX_BYTES);
  const copies = positiveInteger(keep, DEFAULT_KEEP);
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return { rotated: false, size: 0 };
  }
  if (!force && size <= limit) return { rotated: false, size };

  try {
    fs.rmSync(`${filePath}.${copies + 1}`, { force: true });
    for (let index = copies - 1; index >= 1; index--) {
      const older = `${filePath}.${index}`;
      if (fs.statSync(older, { throwIfNoEntry: false })) {
        fs.renameSync(older, `${filePath}.${index + 1}`);
      }
    }
    fs.renameSync(filePath, `${filePath}.1`);
    return { rotated: true, size: 0 };
  } catch {
    return { rotated: false, size };
  }
}

/**
 * Append-only rotating file sink. Exposed separately so the gateway daemon can
 * forward raw child stdout/stderr through the same rotation policy as
 * structured entries.
 */
export class RotatingLogWriter {
  constructor(
    filePath,
    { maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP, fsImpl = fs } = {},
  ) {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      throw new TypeError("RotatingLogWriter needs a file path.");
    }
    this.filePath = filePath;
    this.maxBytes = positiveInteger(maxBytes, DEFAULT_MAX_BYTES);
    this.keep = positiveInteger(keep, DEFAULT_KEEP);
    this.fs = fsImpl;
    this.size = null;
    this.privateModeChecked = false;
  }

  currentSize() {
    if (this.size === null) {
      try {
        this.size = this.fs.statSync(this.filePath).size;
      } catch {
        this.size = 0;
      }
    }
    return this.size;
  }

  rotate() {
    let rotated = false;
    try {
      this.fs.rmSync(`${this.filePath}.${this.keep + 1}`, { force: true });
      for (let index = this.keep - 1; index >= 1; index--) {
        const older = `${this.filePath}.${index}`;
        if (this.fs.statSync(older, { throwIfNoEntry: false })) {
          this.fs.renameSync(older, `${this.filePath}.${index + 1}`);
        }
      }
      this.fs.renameSync(this.filePath, `${this.filePath}.1`);
      rotated = true;
    } catch {
      // If rotation fails (transient lock, read-only volume), keep appending:
      // a log that grows is better than dropping the event entirely. Forget
      // the cached size so the next write re-checks the real file and retries.
    }
    this.size = rotated ? 0 : null;
  }

  write(chunk) {
    if (chunk === null || chunk === undefined) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (text === "") return;
    const bytes = Buffer.byteLength(text, "utf8");

    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Operational logs can contain the one-time boot token and request paths;
    // keep them owner-only on POSIX. The mode option only applies when the
    // file is created, so tighten an existing file once as well.
    if (!this.privateModeChecked) {
      this.privateModeChecked = true;
      if (process.platform !== "win32") {
        try {
          this.fs.chmodSync(this.filePath, 0o600);
        } catch {
          // The file may not exist yet; appendFileSync creates it as 0600.
        }
      }
    }
    if (this.currentSize() > 0 && this.size + bytes > this.maxBytes) {
      this.rotate();
    }
    try {
      this.fs.appendFileSync(this.filePath, text, { encoding: "utf8", mode: 0o600 });
      this.size += bytes;
    } catch {
      // Logging must never crash the gateway.
    }
  }

  writeLine(line) {
    this.write(`${String(line).replace(/\r?\n$/, "")}\n`);
  }

  close() {
    // Every write opens and closes its handle; nothing to release.
  }
}

/**
 * Create a logger. Sinks are tried in this order:
 * - `file`: rotating JSON-lines file
 * - `sink(entry, line)`: custom consumer (tests, daemon)
 * - `mirror`: stdout for debug/info, stderr for warn/error/fatal
 *
 * The default is a console-only logger, which keeps foreground `npm start`
 * useful while the daemon captures stdout into its rotating file.
 */
export function createLogger({
  name = "nanoai",
  level = "info",
  file = null,
  sink = null,
  mirror = true,
  maxBytes = DEFAULT_MAX_BYTES,
  keep = DEFAULT_KEEP,
  console: consoleImpl = console,
  clock = () => new Date(),
} = {}) {
  const threshold = LOG_LEVELS[String(level).toLowerCase()] ?? LOG_LEVELS.info;
  const writer = file ? new RotatingLogWriter(file, { maxBytes, keep }) : null;

  function emit(entryLevel, message, fields) {
    if ((LOG_LEVELS[entryLevel] ?? LOG_LEVELS.info) < threshold) return;
    let entry;
    try {
      entry = {
        ts: clock().toISOString(),
        level: entryLevel,
        name,
        msg: typeof message === "string" ? message : safeValue(message),
        ...normalizeFields(fields),
      };
    } catch {
      entry = {
        ts: new Date().toISOString(),
        level: entryLevel,
        name,
        msg: "log serialization failed",
      };
    }
    const line = JSON.stringify(entry);
    if (writer) writer.writeLine(line);
    if (typeof sink === "function") {
      try {
        sink(entry, line);
      } catch {
        // A broken sink must not take the process down.
      }
    }
    if (!sink && mirror) {
      const output =
        entryLevel === "warn" || entryLevel === "error" || entryLevel === "fatal"
          ? consoleImpl.error
          : consoleImpl.log;
      try {
        output.call(consoleImpl, line);
      } catch {
        // Console may be unavailable during early boot or tests.
      }
    }
  }

  const logger = {
    level,
    debug(message, fields) {
      emit("debug", message, fields);
    },
    info(message, fields) {
      emit("info", message, fields);
    },
    warn(message, fields) {
      emit("warn", message, fields);
    },
    error(message, fields) {
      emit("error", message, fields);
    },
    fatal(message, fields) {
      emit("fatal", message, fields);
    },
    child(bindings = {}) {
      const base = normalizeFields(bindings);
      return createLogger({
        name,
        level,
        file: null,
        sink: (entry, line) => {
          const bound = { ...entry, ...base };
          const boundLine = JSON.stringify(bound);
          if (writer) writer.writeLine(boundLine);
          if (typeof sink === "function") sink(bound, boundLine);
          if (!sink && mirror) {
            const output =
              bound.level === "warn" || bound.level === "error" || bound.level === "fatal"
                ? consoleImpl.error
                : consoleImpl.log;
            try {
              output.call(consoleImpl, boundLine);
            } catch {
              // Ignore console failures.
            }
          }
        },
        mirror: false,
        clock,
      });
    },
    /** Forward raw output (for example a child process's stdout). */
    writeRaw(chunk) {
      if (writer) writer.write(chunk);
      if (typeof sink === "function") {
        try {
          sink(null, String(chunk));
        } catch {
          // Ignore sink failures.
        }
      }
    },
    flush() {
      // Synchronous writes need no flush.
    },
    close() {
      writer?.close();
    },
  };

  return logger;
}

let defaultLogger = null;

/** Process-wide console logger for callers that do not need a file sink. */
export function getLogger() {
  defaultLogger ??= createLogger({ name: "nanoai" });
  return defaultLogger;
}
