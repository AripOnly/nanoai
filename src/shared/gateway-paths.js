// src/shared/gateway-paths.js
//
// One source of truth for runtime files that both the gateway process and the
// detached supervisor need: pidfiles, the stop marker, and the operational
// logs. Paths are resolved lazily so tests can point NANO_DATA_DIR at a
// throwaway directory before importing a caller.

import path from "node:path";
import { dataDir } from "./data-dir.js";

export function pidFileFor() {
  return path.join(dataDir(), "gateway.pid");
}

export function childPidFileFor() {
  return path.join(dataDir(), "gateway.child.pid");
}

export function stopFileFor() {
  return path.join(dataDir(), "gateway.stop");
}

export function logDirFor() {
  return path.join(dataDir(), "logs");
}

/**
 * Primary operational log: structured JSON from the daemon and the gateway
 * child, rotated by the daemon (never grows past its cap).
 */
export function logFileFor() {
  return path.join(logDirFor(), "gateway.log");
}

/**
 * Last-resort launch log. It is truncated on every supervised start and only
 * captures output written before the daemon can open the rotating log (for
 * example a Node syntax error in the child entry point).
 */
export function consoleLogFileFor() {
  return path.join(logDirFor(), "gateway.console.log");
}
