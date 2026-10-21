// src/skills/index.js
//
// The skills module door. Runtime and gateway reach the registry through this
// file; the installer is imported only by the explicit `nanoai skills` entry
// point and tests, never by the model/tool path.

export {
  SkillError,
  SKILL_NAME_RE,
  parseSkillMarkdown,
  parseSkillManifest,
  readSkillDocument,
} from "./loader.js";

export {
  createSkillRegistry,
} from "./registry.js";

export {
  buildCatalog,
  formatCatalogEntry,
  DEFAULT_MAX_CATALOG_BYTES,
  DEFAULT_MAX_CATALOG_ENTRIES,
} from "./catalog.js";

export {
  normalizeSearchText,
  scoreSkill,
  searchSkills,
  tokenize,
  MAX_SEARCH_RESULTS,
} from "./search.js";

export {
  emptyLockfile,
  lockEntryFromManifest,
  readLockfile,
  readLockfileSafe,
  shortHash,
  withLockEntry,
  withoutLockEntry,
  writeLockfile,
} from "./lockfile.js";

export {
  DEFAULT_MAX_SKILL_BYTES,
  findSkillRoots,
  hashSkillTree,
  readSupportingFile,
  validateSkillTree,
  walkSkillTree,
} from "./validate.js";

export {
  SKILLS_CLI_VERSION,
  buildInstallerEnv,
  defaultRunSkillsCli,
  installSkill,
  parseSkillSource,
  removeSkill,
  updateSkill,
} from "./installer.js";

export { createSkillWatcher } from "./watcher.js";
