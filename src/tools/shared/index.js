// src/tools/shared/index.js
//
// Public contract of the shared tool helpers. Cross-folder imports must go
// through this barrel (or the #tools alias), never via deep sibling paths
// like ../read/media.js — that hid coupling and broke unrelated tools.

export { fail } from "./fail.js";
export { trimDiff } from "./diff.js";
export {
  ATTACH_DIR,
  IMAGE_MIMES,
  MAX_ATTACHMENT_BYTES,
  formatBytes,
  loadAttachment,
  saveAttachment,
} from "./attachments.js";
export { limits, preview, tail, truncateOutput, writeTruncation } from "./truncate.js";
export { rgGlob, rgGrep, resolveRgBinary, runRg } from "./rg.js";
export { resolveWorkspacePath, resolveWorkspaceRoot, resolveHomeDir, suggestSimilarPaths } from "./workspace.js";
