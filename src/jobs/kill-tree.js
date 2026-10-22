// src/jobs/kill-tree.js
//
// Compatibility window for callers that historically imported process-tree
// helpers from the jobs module. The implementation lives in
// src/infra/platform.js so the shell tool, job runner, and daemon share one
// cross-platform contract.

export { isProcessAlive, killProcessTree } from "#src/infra/platform.js";
