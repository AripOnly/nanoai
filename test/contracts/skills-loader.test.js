// test/contracts/skills-loader.test.js
//
// Pure skill parsing contracts: frontmatter validation, tool narrowing, the
// bounded catalog, and deterministic lexical search. Filesystem security gates
// live in test/suite/skills.test.js.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCatalog,
  formatCatalogEntry,
  normalizeSearchText,
  parseSkillManifest,
  parseSkillMarkdown,
  readSkillDocument,
  scoreSkill,
  searchSkills,
  tokenize,
} from "../../src/skills/index.js";

function frontmatter(overrides = {}) {
  const values = {
    name: "pdf-report",
    description: "Create a PDF report from conversation data.",
    "allowed-tools": ["read", "write"],
    metadata: {
      version: "1.2.3",
      tags: ["pdf", "report"],
      triggers: ["buat laporan pdf", "create pdf report"],
      autoLoad: true,
    },
    ...overrides,
  };
  const lines = [
    "---",
    `name: ${values.name}`,
    `description: ${values.description}`,
  ];
  if (values["allowed-tools"] !== undefined) {
    if (Array.isArray(values["allowed-tools"])) {
      lines.push(
        `allowed-tools: [${values["allowed-tools"]
          .map((tool) => JSON.stringify(tool))
          .join(", ")}]`,
      );
    } else {
      lines.push(`allowed-tools: ${JSON.stringify(values["allowed-tools"])}`);
    }
  }
  if (values.metadata !== undefined) {
    lines.push("metadata:");
    if (values.metadata.version !== undefined) {
      lines.push(`  version: ${JSON.stringify(values.metadata.version)}`);
    }
    if (values.metadata.os) {
      lines.push(`  os: [${values.metadata.os.join(", ")}]`);
    }
    if (values.metadata.tags) {
      lines.push(`  tags: [${values.metadata.tags.join(", ")}]`);
    }
    if (values.metadata.triggers) {
      lines.push(`  triggers: [${values.metadata.triggers.join(", ")}]`);
    }
    if (values.metadata.autoLoad !== undefined) {
      lines.push(`  autoLoad: ${values.metadata.autoLoad}`);
    }
    if (values.metadata.auto_load !== undefined) {
      lines.push(`  auto_load: ${values.metadata.auto_load}`);
    }
    if (values.metadata.requires) {
      lines.push("  requires:");
      for (const [key, items] of Object.entries(values.metadata.requires)) {
        lines.push(`    ${key}: [${items.join(", ")}]`);
      }
    }
  }
  lines.push("---", "", "# Report", "", "Follow these instructions.");
  return lines.join("\n");
}

const KNOWN_TOOLS = ["read", "write", "edit", "shell", "glob", "grep", "webFetch", "webSearch"];

describe("parseSkillMarkdown", () => {
  it("normalizes frontmatter, aliases, metadata, and the body", () => {
    const document = parseSkillMarkdown(
      frontmatter({
        "allowed-tools": ["Bash(git:*)", "Read", "multiedit"],
      }),
      { knownTools: KNOWN_TOOLS },
    );

    assert.equal(document.name, "pdf-report");
    assert.equal(document.description, "Create a PDF report from conversation data.");
    assert.deepEqual(document.allowedTools, ["shell", "read", "edit"]);
    assert.equal(document.version, "1.2.3");
    assert.deepEqual(document.tags, ["pdf", "report"]);
    assert.deepEqual(document.triggers, ["buat laporan pdf", "create pdf report"]);
    assert.equal(document.autoLoad, true);
    assert.match(document.body, /^# Report/);
    assert.equal(document.attributes.name, "pdf-report");
    assert.ok(Object.isFrozen(document));
    assert.ok(Object.isFrozen(document.allowedTools));
  });

  it("accepts comma/space tool lists and snake_case auto_load", () => {
    const document = parseSkillMarkdown(
      frontmatter({
        "allowed-tools": "read write grep",
        metadata: {
          version: "",
          tags: [],
          triggers: [],
          autoLoad: undefined,
          auto_load: true,
        },
      }),
      { knownTools: KNOWN_TOOLS },
    );
    assert.deepEqual(document.allowedTools, ["read", "write", "grep"]);
    assert.equal(document.autoLoad, true);
    assert.equal(document.version, null);
  });

  it("parses minimal frontmatter with only name and description", () => {
    const document = parseSkillMarkdown(
      "---\nname: minimal-skill\ndescription: A minimal skill with no metadata.\n---\n# Minimal\nBody.",
      { knownTools: KNOWN_TOOLS },
    );
    assert.equal(document.name, "minimal-skill");
    assert.equal(document.description, "A minimal skill with no metadata.");
    assert.deepEqual(document.allowedTools, []);
    assert.equal(document.version, null);
    assert.deepEqual(document.os, []);
    assert.deepEqual(document.tags, []);
    assert.deepEqual(document.triggers, []);
    assert.equal(document.autoLoad, false);
    assert.deepEqual(document.requires.env, []);
    assert.deepEqual(document.requires.bins, []);
  });

  it("rejects missing, malformed, or unsafe frontmatter", () => {
    assert.throws(
      () => parseSkillMarkdown("# no frontmatter"),
      /must start with YAML frontmatter/,
    );
    assert.throws(
      () =>
        parseSkillMarkdown(
          "---\nname: [not closed\n---\nbody",
        ),
      /not valid YAML/,
    );
    for (const name of ["", "../escape", "UPPER", "a b", "-dash-start", "x".repeat(65)]) {
      assert.throws(
        () => parseSkillMarkdown(frontmatter({ name })),
        /name|unsafe/i,
        `name ${JSON.stringify(name)} must be rejected`,
      );
    }
    assert.throws(
      () => parseSkillMarkdown(frontmatter({ description: "" })),
      /description/,
    );
    assert.throws(
      () =>
        parseSkillMarkdown(
          frontmatter({ metadata: { autoLoad: "yes" } }),
        ),
      /autoLoad must be a boolean/,
    );
  });

  it("only keeps known tools and rejects unknown names", () => {
    assert.throws(
      () =>
        parseSkillMarkdown(
          frontmatter({ "allowed-tools": ["telepathy"] }),
          { knownTools: KNOWN_TOOLS },
        ),
      /not a known NanoAI tool/,
    );
    assert.deepEqual(
      parseSkillMarkdown(
        frontmatter({ "allowed-tools": ["TELEPATHY"] }),
      ).allowedTools,
      ["telepathy"],
      "without a known-tools list the loader is syntax-only",
    );
    assert.deepEqual(
      parseSkillMarkdown(
        frontmatter({ "allowed-tools": [] }),
        { knownTools: KNOWN_TOOLS },
      ).allowedTools,
      [],
    );
  });
});

describe("parseSkillManifest", () => {
  const valid = {
    source: "owner/repo/skill",
    requested: "owner/repo/skill",
    resolvedRef: null,
    contentHash: `sha256:${"a".repeat(64)}`,
    version: "1.0.0",
    installedAt: "2026-10-21T00:00:00.000Z",
    skillsCliVersion: "1.7.4",
    trust: "user-approved",
    scanner: "none",
    telemetryDisabled: true,
  };

  it("parses provenance and defaults unknown trust to external", () => {
    const manifest = parseSkillManifest(valid);
    assert.equal(manifest.trust, "user-approved");
    assert.equal(manifest.contentHash, valid.contentHash);
    assert.equal(manifest.telemetryDisabled, true);

    const external = parseSkillManifest({ ...valid, trust: undefined });
    assert.equal(external.trust, "external");
  });

  it("rejects non-object, malformed, and invalid hash manifests", () => {
    assert.throws(() => parseSkillManifest("not json"), /not valid JSON/);
    assert.throws(() => parseSkillManifest("[]"), /JSON object/);
    assert.throws(
      () => parseSkillManifest({ ...valid, trust: "root" }),
      /trust/,
    );
    assert.throws(
      () => parseSkillManifest({ ...valid, contentHash: "sha256:nope" }),
      /contentHash/,
    );
  });
});

describe("bounded catalog", () => {
  function entry(index, overrides = {}) {
    return {
      name: `skill-${index}`,
      description: `Description ${index} <unsafe> & text`,
      tags: ["pdf", `tag-${index}`],
      triggers: [`trigger ${index}`],
      trust: "external",
      ...overrides,
    };
  }

  it("escapes prompt markup, caps entries, and reports omissions", () => {
    const entries = Array.from({ length: 12 }, (_, index) => entry(index));
    const catalog = buildCatalog(entries, { maxEntries: 3 });
    assert.equal(catalog.included, 3);
    assert.equal(catalog.omitted, 9);
    assert.ok(catalog.text.startsWith("<available_skills>"));
    assert.ok(catalog.text.endsWith("</available_skills>"));
    assert.match(catalog.text, /9 more skill\(s\) omitted/);
    assert.match(catalog.text, /&lt;unsafe&gt; &amp; text/);
    assert.equal(catalog.text.includes("<unsafe>"), false);
  });

  it("returns an empty catalog for empty input or a tight byte budget", () => {
    assert.deepEqual(buildCatalog([]), { text: "", included: 0, omitted: 0 });
    const tight = buildCatalog([entry(1)], { maxBytes: 40 });
    assert.equal(tight.text, "");
    assert.equal(tight.included, 0);
    assert.equal(tight.omitted, 1);
  });

  it("formats only metadata, never a skill body", () => {
    const line = formatCatalogEntry({
      ...entry(1),
      name: "pdf-report",
      body: "SECRET BODY",
    });
    assert.match(line, /^\- pdf-report:/);
    assert.equal(line.includes("SECRET BODY"), false);
  });
});

describe("lexical skill search", () => {
  const entries = [
    {
      name: "pdf-report",
      description: "Create a PDF report from notes.",
      tags: ["pdf", "report"],
      triggers: ["buat laporan pdf"],
    },
    {
      name: "email-writer",
      description: "Draft concise email replies.",
      tags: ["email"],
      triggers: ["balas email"],
    },
    {
      name: "spreadsheet",
      description: "Build a spreadsheet model.",
      tags: ["excel"],
      triggers: ["buat excel"],
    },
  ];

  it("normalizes and tokenizes deterministically", () => {
    assert.equal(normalizeSearchText("  PDF   Report  "), "pdf report");
    assert.deepEqual(tokenize("buat laporan PDF"), ["buat", "laporan", "pdf"]);
    assert.ok(scoreSkill(entries[0], "pdf report") > scoreSkill(entries[1], "pdf report"));
  });

  it("ranks exact names and trigger matches, respecting limits", () => {
    const results = searchSkills(entries, "laporan pdf", 2);
    assert.equal(results.length, 1);
    assert.equal(results[0].name, "pdf-report");
    assert.ok(results[0].score > 0);
    assert.equal(searchSkills(entries, "email")[0].name, "email-writer");
    assert.deepEqual(searchSkills(entries, "", 5).map((item) => item.name), [
      "email-writer",
      "pdf-report",
      "spreadsheet",
    ]);
  });
});

describe("readSkillDocument size guard", () => {
  it("rejects oversized and symlinked SKILL.md files", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-skill-loader-"));
    try {
      const large = path.join(root, "large.md");
      await fs.writeFile(large, `---\nname: large\ndescription: x\n---\n${"a".repeat(2048)}`);
      await assert.rejects(
        readSkillDocument(large, { maxBytes: 512 }),
        /too large/,
      );

      const target = path.join(root, "target.md");
      const link = path.join(root, "link.md");
      await fs.writeFile(target, frontmatter());
      try {
        await fs.symlink(target, link, "file");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
          t.skip("symlink creation is not available on this host");
          return;
        }
        throw error;
      }
      await assert.rejects(readSkillDocument(link), /symlink/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
