// src/config/watcher.js
//
// Compatibility facade: the generic polling watcher now lives in
// src/infra/watch-file.js so models and settings share one implementation.
// Existing callers keep importing "./watcher.js".

export { watchFile } from "#src/infra/watch-file.js";
