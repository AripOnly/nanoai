// src/skills/registry.js
//
// Discovery, validation, and turn-scoped views for skills. The registry swaps
// immutable snapshots after a successful reload; a turn captures one snapshot
// and never sees a skill installed halfway through its stream.
//
// Trust rules are enforced here, not in prompt code:
//   - builtin and user-approved skills may auto-load;
//   - external skills are cataloged and hinted, but their bodies are only
//     loaded when the model explicitly calls loadSkill.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT, dataDir } from "#src/shared/data-dir.js";
import {
  buildCatalog,
  DEFAULT_MAX_CATALOG_BYTES,
  DEFAULT_MAX_CATALOG_ENTRIES,
} from "./catalog.js";
import { SkillError } from "./loader.js";
import { readLockfileSafe, shortHash } from "./lockfile.js";
import { searchSkills } from "./search.js";
import {
  DEFAULT_MAX_SKILL_BYTES,
  readSupportingFile,
  validateSkillTree,
} from "./validate.js";
import { createSkillWatcher } from "./watcher.js";

const DEFAULT_MAX_SUPPORTING_FILE_BYTES = 16384;
const MAX_VISIBLE_FILES = 50;
const MAX_ERROR_CHARS = 400;

function normalizeSettings(settings = {}) {
  return {
    enabled: settings.enabled !== false,
    autoLoadTrusted: settings.autoLoadTrusted !== false,
    allowUntrustedAutoLoad: settings.allowUntrustedAutoLoad === true,
    maxCatalogEntries:
      Number.isInteger(settings.maxCatalogEntries) && settings.maxCatalogEntries > 0
        ? settings.maxCatalogEntries
        : DEFAULT_MAX_CATALOG_ENTRIES,
    maxSkillBytes:
      Number.isInteger(settings.maxSkillBytes) && settings.maxSkillBytes > 0
        ? settings.maxSkillBytes
        : DEFAULT_MAX_SKILL_BYTES,
    maxSupportingFileBytes:
      Number.isInteger(settings.maxSupportingFileBytes) &&
      settings.maxSupportingFileBytes > 0
        ? settings.maxSupportingFileBytes
        : DEFAULT_MAX_SUPPORTING_FILE_BYTES,
  };
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_CHARS
    ? `${message.slice(0, MAX_ERROR_CHARS)}…`
    : message;
}

function normalizeOs(value) {
  const os = String(value).toLowerCase();
  if (os === "windows" || os === "win") return "win32";
  if (os === "macos" || os === "osx") return "darwin";
  return os;
}

function binaryExists(bin, env, platform) {
  const value = String(bin ?? "").trim();
  if (value === "") return false;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  if (pathValue === "" && !value.includes("/") && !value.includes("\\")) {
    return false;
  }
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  const candidates = [];
  if (pathValue) {
    for (const dir of pathValue.split(path.delimiter)) {
      if (dir === "") continue;
      for (const ext of extensions) {
        candidates.push(path.join(dir, value + ext));
      }
    }
  } else {
    for (const ext of extensions) candidates.push(value + ext);
  }
  return candidates.some((candidate) => {
    try {
      const stat = fsSync.statSync(candidate);
      return stat.isFile();
    } catch {
      return false;
    }
  });
}

function compatibility(entry, { env, platform }) {
  if (entry.os.length > 0) {
    const wanted = entry.os.map(normalizeOs);
    if (!wanted.includes(normalizeOs(platform))) {
      return { compatible: false, reason: `requires OS ${entry.os.join(", ")}` };
    }
  }
  for (const key of entry.requires.env) {
    const value = env[key];
    if (typeof value !== "string" || value.trim() === "") {
      return { compatible: false, reason: `requires environment variable ${key}` };
    }
  }
  for (const bin of entry.requires.bins) {
    if (!binaryExists(bin, env, platform)) {
      return { compatible: false, reason: `requires executable ${bin}` };
    }
  }
  return { compatible: true, reason: null };
}

function skillAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// A skill body is prompt content, not markup. Breaking out of the delimiter
// would let an external skill impersonate a second skill or close the block.
function neutralizeDelimiters(value) {
  return String(value ?? "")
    .replace(/<\/skill/gi, "<\\/skill")
    .replace(/<\/supporting_file/gi, "<\\/supporting_file");
}

function skillBlock(entry, body) {
  return [
    `<skill name="${skillAttr(entry.name)}" source="${skillAttr(
      entry.source ?? "unknown",
    )}" trust="${skillAttr(entry.trust)}">`,
    neutralizeDelimiters(body).trim(),
    "</skill>",
  ].join("\n");
}

function supportingBlock(file) {
  return [
    `<supporting_file path="${skillAttr(file.path)}">`,
    neutralizeDelimiters(file.content).trim(),
    "</supporting_file>",
  ].join("\n");
}

function normalizeMatchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function strongTriggerMatch(prompt, trigger) {
  const normalizedTrigger = normalizeMatchText(trigger);
  if (normalizedTrigger.length < 4) return false;
  const expression = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegex(normalizedTrigger)}([^\\p{L}\\p{N}]|$)`,
    "u",
  );
  return expression.test(prompt);
}

function matchingEntries(entries, prompt) {
  const normalizedPrompt = normalizeMatchText(prompt);
  if (normalizedPrompt === "") return [];
  return entries
    .map((entry) => {
      const triggers = Array.isArray(entry.triggers) ? entry.triggers : [];
      const matches = triggers.filter((trigger) =>
        strongTriggerMatch(normalizedPrompt, trigger),
      );
      return { entry, matches: matches.length };
    })
    .filter((item) => item.matches > 0)
    .sort((a, b) => {
      if (b.matches !== a.matches) return b.matches - a.matches;
      return String(a.entry.name).localeCompare(String(b.entry.name));
    })
    .map((item) => item.entry);
}

function agentAllows(entry, agentSkills) {
  if (!Array.isArray(agentSkills) || agentSkills.length === 0) return false;
  return agentSkills.includes("*") || agentSkills.includes(entry.name);
}

function publicEntry(entry, warnings = []) {
  return {
    name: entry.name,
    description: entry.description,
    version: entry.version,
    tags: [...entry.tags],
    triggers: [...entry.triggers],
    trust: entry.trust,
    source: entry.source,
    requested: entry.requested,
    resolvedRef: entry.resolvedRef,
    hash: shortHash(entry.contentHash),
    contentHash: entry.contentHash,
    status: !entry.compatible
      ? "incompatible"
      : entry.status ?? "ok",
    compatible: entry.compatible,
    unavailableReason: entry.unavailableReason,
    autoLoad: entry.autoLoad,
    allowedTools: [...entry.allowedTools],
    os: [...entry.os],
    requires: {
      env: [...entry.requires.env],
      bins: [...entry.requires.bins],
    },
    installedAt: entry.installedAt,
    skillsCliVersion: entry.skillsCliVersion,
    warnings: [...warnings],
  };
}

function freezeEntry(entry) {
  for (const value of [entry.tags, entry.triggers, entry.allowedTools, entry.os]) {
    Object.freeze(value);
  }
  Object.freeze(entry.requires.env);
  Object.freeze(entry.requires.bins);
  Object.freeze(entry.requires);
  Object.freeze(entry.files);
  return Object.freeze(entry);
}

function freezeSnapshot(snapshot) {
  for (const entry of snapshot.entries) freezeEntry(entry);
  Object.freeze(snapshot.entries);
  Object.freeze(snapshot.errors);
  return Object.freeze(snapshot);
}

function emptySnapshot() {
  return freezeSnapshot({
    revision: 0,
    entries: [],
    errors: [],
    lastError: null,
    loadedAt: null,
    lockError: null,
    stats: { total: 0, compatible: 0, trusted: 0, external: 0, invalid: 0 },
  });
}

function statsFor(entries, errors) {
  return {
    total: entries.length,
    compatible: entries.filter((entry) => entry.compatible).length,
    trusted: entries.filter((entry) => entry.trust !== "external").length,
    external: entries.filter((entry) => entry.trust === "external").length,
    invalid: errors.length,
  };
}

/**
 * Create a skill registry. Paths are injectable for tests; production callers
 * get the built-in folder from the package and user skills from NANO_DATA_DIR.
 */
export function createSkillRegistry({
  builtinRoot = path.join(PACKAGE_ROOT, "src", "skills", "builtin"),
  userRoot = path.join(dataDir(), "skills"),
  lockfilePath = path.join(dataDir(), "skills.lock.json"),
  config = () => null,
  knownTools = null,
  env = process.env,
  platform = process.platform,
  logger = console,
  debounceMs = 500,
} = {}) {
  let snapshot = emptySnapshot();
  let reloadChain = Promise.resolve();
  let disposed = false;
  let watcher = null;

  function settingsNow() {
    const current = config?.() ?? null;
    const value = current?.value ?? current ?? {};
    return normalizeSettings(value.skills ?? {});
  }

  async function scanRoot(root, kind, previousByPath, seenNames, errors) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      errors.push({
        name: path.basename(root),
        code: "SKILL_ROOT_UNREADABLE",
        message: `Cannot read ${root}: ${safeError(error)}`,
      });
      return [];
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    const found = [];
    const settings = settingsNow();
    const scanMaxSkillBytes = Math.max(DEFAULT_MAX_SKILL_BYTES, settings.maxSkillBytes);

    for (const dirent of entries) {
      if (dirent.name.startsWith(".") || dirent.name.includes(".tmp-")) continue;
      const skillPath = path.join(root, dirent.name);

      try {
        if (dirent.isSymbolicLink()) {
          throw new SkillError("Skill directory must not be a symlink.", "SKILL_SYMLINK");
        }
        if (!dirent.isDirectory()) continue;
        const stat = await fs.lstat(skillPath);
        if (stat.isSymbolicLink()) {
          throw new SkillError("Skill directory must not be a symlink.", "SKILL_SYMLINK");
        }
        if (!stat.isDirectory()) continue;

        const validated = await validateSkillTree(skillPath, {
          maxSkillBytes: scanMaxSkillBytes,
          knownTools,
        });
        const document = validated.document;
        if (seenNames.has(document.name)) {
          errors.push({
            name: document.name,
            code: "SKILL_DUPLICATE",
            message: `Duplicate skill name "${document.name}" in ${root}; keeping the first one.`,
          });
          continue;
        }

        const manifest = validated.manifest;
        let trust =
          kind === "builtin"
            ? "builtin"
            : manifest?.trust === "user-approved"
              ? "user-approved"
              : "external";
        let status = "ok";
        let warning = null;

        if (kind !== "builtin" && manifest?.trust === "builtin") {
          trust = "external";
          status = "modified";
          warning = "A user-installed skill cannot claim builtin trust; treated as external.";
        }

        if (
          manifest?.contentHash &&
          manifest.contentHash !== validated.contentHash
        ) {
          trust = "external";
          status = "modified";
          warning =
            "Skill content changed after installation; treated as external until reinstalled.";
        }

        const lockEntry = snapshotLockEntry(document.name);
        if (
          lockEntry?.contentHash &&
          lockEntry.contentHash !== validated.contentHash &&
          warning === null
        ) {
          warning = "skills.lock.json hash does not match the installed skill content.";
        }

        if (warning) {
          errors.push({
            name: document.name,
            code: "SKILL_INTEGRITY",
            message: warning,
          });
        }

        const requires = document.requires;
        const compatibilityResult = compatibility(
          {
            os: document.os,
            requires,
          },
          { env, platform },
        );

        found.push(
          freezeEntry({
            name: document.name,
            description: document.description,
            version:
              document.version ??
              manifest?.version ??
              lockEntry?.version ??
              shortHash(validated.contentHash),
            tags: [...document.tags],
            triggers: [...document.triggers],
            trust,
            source:
              manifest?.source ??
              lockEntry?.source ??
              (kind === "builtin" ? "builtin" : null),
            requested: manifest?.requested ?? lockEntry?.requested ?? null,
            resolvedRef: manifest?.resolvedRef ?? lockEntry?.resolvedRef ?? null,
            contentHash: validated.contentHash,
            autoLoad: document.autoLoad,
            allowedTools: [...document.allowedTools],
            os: [...document.os],
            requires: {
              env: [...requires.env],
              bins: [...requires.bins],
            },
            compatible: compatibilityResult.compatible,
            unavailableReason: compatibilityResult.reason,
            status:
              status === "ok" && !compatibilityResult.compatible
                ? "incompatible"
                : status,
            installedAt: manifest?.installedAt ?? lockEntry?.installedAt ?? null,
            skillsCliVersion:
              manifest?.skillsCliVersion ?? lockEntry?.skillsCliVersion ?? null,
            path: skillPath,
            body: document.body,
            files: validated.supportingFiles.slice(0, MAX_VISIBLE_FILES),
            totalBytes: validated.totalBytes,
            fileCount: validated.files.length,
          }),
        );
        seenNames.add(document.name);
      } catch (error) {
        const previous = previousByPath.get(skillPath);
        if (previous && !seenNames.has(previous.name)) {
          found.push(previous);
          seenNames.add(previous.name);
        }
        errors.push({
          name: previous?.name ?? dirent.name,
          code: error?.code ?? "SKILL_INVALID",
          message: safeError(error),
        });
      }
    }

    return found;
  }

  function snapshotLockEntry(name) {
    return snapshot.lock?.skills?.[name] ?? null;
  }

  async function doReload(reason) {
    const previousEntries = snapshot.entries;
    const previousByPath = new Map(
      previousEntries.map((entry) => [entry.path, entry]),
    );
    const errors = [];
    const seenNames = new Set();

    const { lock, error: lockError } = await readLockfileSafe(lockfilePath);
    if (lockError) {
      errors.push({
        name: "skills.lock.json",
        code: "SKILL_LOCK_INVALID",
        message: safeError(lockError),
      });
    }

    // The lock entry is read through a temporary snapshot so scanRoot can
    // attach provenance while still keeping the previous snapshot intact.
    const priorSnapshot = snapshot;
    const effectiveLock = lockError ? priorSnapshot.lock ?? { version: 1, skills: {} } : lock;
    const lockHolder = { lock: effectiveLock };
    const oldSnapshot = snapshot;
    snapshot = { ...oldSnapshot, lock: lockHolder.lock };

    let builtinEntries = [];
    let userEntries = [];
    try {
      builtinEntries = await scanRoot(
        builtinRoot,
        "builtin",
        previousByPath,
        seenNames,
        errors,
      );
      userEntries = await scanRoot(
        userRoot,
        "user",
        previousByPath,
        seenNames,
        errors,
      );
    } finally {
      snapshot = oldSnapshot;
    }

    const entries = [...builtinEntries, ...userEntries].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const nextRevision = snapshot.revision + 1;
    const lastError =
      errors.length > 0
        ? errors[0].message
        : lockError
          ? safeError(lockError)
          : null;

    const next = freezeSnapshot({
      revision: nextRevision,
      entries,
      errors,
      lastError,
      loadedAt: new Date().toISOString(),
      lock: effectiveLock,
      lockError: lockError ? safeError(lockError) : null,
      reason: reason ?? "reload",
      stats: statsFor(entries, errors),
    });
    snapshot = next;
    watcher?.refresh?.();
    return snapshot;
  }

  function reload({ reason = "manual" } = {}) {
    if (disposed) return Promise.resolve(snapshot);
    reloadChain = reloadChain.then(
      () => doReload(reason),
      () => doReload(reason),
    );
    return reloadChain;
  }

  function allowedEntries(agentSkills) {
    return snapshot.entries.filter(
      (entry) => entry.compatible && agentAllows(entry, agentSkills),
    );
  }

  function warningsFor(name) {
    return snapshot.errors
      .filter((error) => error.name === name)
      .map((error) => error.message);
  }

  function inspect(name) {
    const entry = snapshot.entries.find((item) => item.name === name);
    if (!entry) return null;
    return {
      ...publicEntry(entry, warningsFor(entry.name)),
      body: entry.body,
      files: entry.files.map((file) => ({ ...file })),
      path: entry.path,
    };
  }

  const registry = {
    get revision() {
      return snapshot.revision;
    },

    snapshot() {
      return snapshot;
    },

    async init() {
      await reload({ reason: "init" });
      return snapshot;
    },

    reload,

    startWatcher() {
      if (disposed || watcher) return;
      watcher = createSkillWatcher({
        roots: [userRoot],
        files: [lockfilePath],
        debounceMs,
        logger,
        onChange: async (reason) => {
          await reload({ reason: `watch:${reason}` });
        },
      });
      watcher.start();
    },

    stopWatcher() {
      watcher?.stop();
      watcher = null;
    },

    list({ agentSkills = null } = {}) {
      const source =
        agentSkills === null ? snapshot.entries : allowedEntries(agentSkills);
      return source.map((entry) => publicEntry(entry, warningsFor(entry.name)));
    },

    stats() {
      return { ...snapshot.stats, revision: snapshot.revision };
    },

    health() {
      return {
        revision: snapshot.revision,
        enabled: settingsNow().enabled,
        lastError: snapshot.lastError,
        loadedAt: snapshot.loadedAt,
        stats: { ...snapshot.stats },
      };
    },

    inspect,

    /**
     * Capture an immutable view for one turn. The view filters by the agent
     * allow-list and applies the settings snapshot captured by the runtime.
     */
    turnView({ agentSkills = [], allowedTools = null, settings = null } = {}) {
      const turnSnapshot = snapshot;
      const effectiveSettings = normalizeSettings(settings ?? settingsNow());
      const entries = effectiveSettings.enabled
        ? turnSnapshot.entries.filter(
            (entry) => entry.compatible && agentAllows(entry, agentSkills),
          )
        : [];
      const toolSet = Array.isArray(allowedTools)
        ? new Set(allowedTools)
        : new Set(knownTools ?? []);
      const catalog = buildCatalog(entries, {
        maxEntries: effectiveSettings.maxCatalogEntries,
        maxBytes: DEFAULT_MAX_CATALOG_BYTES,
      });

      // The tool executor supports async execute functions. Use an async load
      // so supporting-file reads never block the event loop.
      async function asyncLoad(name, file = null) {
        if (!effectiveSettings.enabled) {
          throw new SkillError("Skills are disabled.", "SKILL_DISABLED");
        }
        if (typeof name !== "string" || name.trim() === "") {
          throw new SkillError("Skill name must be a non-empty string.");
        }
        const entry = entries.find((item) => item.name === name.trim());
        if (!entry) {
          const known = turnSnapshot.entries.some((item) => item.name === name.trim());
          if (known) {
            throw new SkillError(
              `Skill "${name.trim()}" is not allowed for this agent or is unavailable on this platform.`,
              "SKILL_NOT_ALLOWED",
            );
          }
          throw new SkillError(`Skill "${name.trim()}" was not found.`, "SKILL_NOT_FOUND");
        }

        const bodyBytes = Buffer.byteLength(entry.body, "utf8");
        if (bodyBytes > effectiveSettings.maxSkillBytes) {
          throw new SkillError(
            `SKILL.md exceeds the current limit (${bodyBytes} bytes, limit ${effectiveSettings.maxSkillBytes}).`,
            "SKILL_TOO_LARGE",
          );
        }

        let supporting = null;
        if (file !== null && file !== undefined) {
          supporting = await readSupportingFile(entry.path, file, {
            maxBytes: effectiveSettings.maxSupportingFileBytes,
          });
        }

        const declared = entry.allowedTools;
        const narrowed =
          declared.length === 0
            ? [...toolSet]
            : declared.filter((tool) => toolSet.has(tool));

        const parts = [skillBlock(entry, entry.body)];
        if (supporting) parts.push(supportingBlock(supporting));
        return {
          name: entry.name,
          trust: entry.trust,
          source: entry.source,
          version: entry.version,
          contentHash: entry.contentHash,
          hash: shortHash(entry.contentHash),
          allowed_tools: narrowed,
          files: entry.files.map((item) => ({ ...item })),
          content: parts.join("\n\n"),
        };
      }

      function autoLoad(prompt) {
        if (!effectiveSettings.enabled) {
          return { skill: null, content: "", hints: [] };
        }
        const matches = matchingEntries(entries, prompt);
        const trustedMatches = matches.filter(
          (entry) =>
            entry.trust !== "external" &&
            entry.autoLoad === true &&
            effectiveSettings.autoLoadTrusted,
        );

        const auto = trustedMatches.length === 1 ? trustedMatches[0] : null;
        const hints = matches
          .filter((entry) => entry !== auto)
          .slice(0, 3)
          .map((entry) => entry.name);

        return {
          skill: auto
            ? {
                name: auto.name,
                trust: auto.trust,
                source: auto.source,
                version: auto.version,
                contentHash: auto.contentHash,
                hash: shortHash(auto.contentHash),
              }
            : null,
          content: auto ? skillBlock(auto, auto.body) : "",
          hints,
        };
      }

      function search(query, limit = 10) {
        if (!effectiveSettings.enabled) return [];
        return searchSkills(entries, query, limit).map((entry) => ({
          ...publicEntry(entry, warningsFor(entry.name)),
          score: entry.score,
        }));
      }

      return Object.freeze({
        enabled: effectiveSettings.enabled && entries.length > 0,
        revision: turnSnapshot.revision,
        available: entries.length,
        catalog: catalog.text,
        catalogOmitted: catalog.omitted,
        autoLoad,
        search,
        load: asyncLoad,
      });
    },

    dispose() {
      disposed = true;
      registry.stopWatcher();
    },
  };

  return Object.freeze(registry);
}
