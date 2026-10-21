// src/infra/watch-file.js
//
// Generic polling file watcher shared by every hot-reloadable artifact
// (settings snapshot, model catalog, future job specs). fs.watchFile is
// deliberately used instead of fs.watch: it polls, survives atomic editor
// saves, and behaves consistently on Windows and Linux. Events are debounced
// because one save can produce several stat changes. The watcher is
// non-persistent so a test process can exit cleanly; the gateway keeps the
// event loop alive on its own.

import fs from "node:fs";

export function watchFile(
  filePath,
  onChange,
  { interval = 1000, debounceMs = 150 } = {},
) {
  if (typeof onChange !== "function") {
    throw new TypeError("watchFile requires an onChange callback.");
  }

  let stopped = false;
  let timer = null;

  const listener = (current, previous) => {
    if (stopped) return;
    if (
      current.mtimeMs === previous.mtimeMs &&
      current.ctimeMs === previous.ctimeMs &&
      current.size === previous.size &&
      current.ino === previous.ino
    ) {
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) onChange({ current, previous });
    }, debounceMs);
    timer.unref?.();
  };

  fs.watchFile(filePath, { interval, persistent: false }, listener);

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      fs.unwatchFile(filePath, listener);
    },
  };
}
