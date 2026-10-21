// src/skills/watcher.js
//
// Reload triggers for installed skills. The lockfile is watched with a small
// polling watcher (it lives next to the database and other noisy files), while
// the skills directory is watched recursively when the platform supports it.
// Every event is debounced so one atomic install produces one rebuild.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_DEBOUNCE_MS = 500;

function safeMkdir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // A missing root is a normal empty state; the next reload will retry.
  }
}

export function createSkillWatcher({
  roots = [],
  files = [],
  onChange,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  logger = console,
} = {}) {
  let dirWatchers = [];
  let fileWatchers = [];
  let timer = null;
  let stopped = false;
  let started = false;

  function schedule(reason) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      Promise.resolve()
        .then(() => onChange?.(reason))
        .catch((error) => {
          logger?.warn?.(
            `[skills] reload failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }, debounceMs);
    timer.unref?.();
  }

  function watchDirectory(dir, recursive) {
    try {
      const watcher = fs.watch(
        dir,
        { persistent: false, recursive },
        (_eventType, filename) => schedule(filename ? String(filename) : "skills"),
      );
      watcher.on("error", (error) => {
        logger?.warn?.(`[skills] watcher error: ${error.message}`);
      });
      dirWatchers.push(watcher);
      return true;
    } catch (error) {
      if (recursive) return false;
      logger?.warn?.(
        `[skills] cannot watch ${dir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return true;
    }
  }

  function attachRoots() {
    for (const dir of roots) {
      if (typeof dir !== "string" || dir === "") continue;
      safeMkdir(dir);
      if (watchDirectory(dir, true)) continue;
      // Node on some filesystems (notably older Linux builds) rejects
      // recursive watching. Watch the root and each current child instead.
      watchDirectory(dir, false);
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          watchDirectory(path.join(dir, entry.name), false);
        }
      }
    }
  }

  function attachFiles() {
    for (const file of files) {
      if (typeof file !== "string" || file === "") continue;
      try {
        fs.watchFile(
          file,
          { persistent: false, interval: 1000 },
          (current, previous) => {
            if (
              current.mtimeMs !== previous.mtimeMs ||
              current.size !== previous.size
            ) {
              schedule("lockfile");
            }
          },
        );
        fileWatchers.push(file);
      } catch (error) {
        logger?.warn?.(
          `[skills] cannot watch ${file}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  function closeDirectories() {
    for (const watcher of dirWatchers) {
      try {
        watcher.close();
      } catch {
        // Best effort; shutdown and refresh must not fail.
      }
    }
    dirWatchers = [];
  }

  return Object.freeze({
    start() {
      if (started || stopped) return;
      started = true;
      attachRoots();
      attachFiles();
    },

    /** Rebuild directory watchers after a reload added/removed a skill dir. */
    refresh() {
      if (!started || stopped) return;
      closeDirectories();
      attachRoots();
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      closeDirectories();
      for (const file of fileWatchers) {
        try {
          fs.unwatchFile(file);
        } catch {
          // Best effort.
        }
      }
      fileWatchers = [];
    },
  });
}
