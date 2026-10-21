// src/agents/registry.js
//
// Agent definitions are data, not behavior. `mode` separates the two public
// primaries from internal helpers such as compaction. `policy` is the safety
// envelope the runtime and tool executor enforce even if the model asks for a
// tool that is not in the advertised list.
//
// Tool lists are plain names: the runtime turns them into provider schemas
// through src/tools/registry.js, so agents never import a tool implementation.

const FULL_POLICY = Object.freeze({
  allowShell: true,
  allowWrite: true,
  allowOutsideRoot: true,
  maxSteps: 40,
  maxToolCallsPerStep: 12,
  maxToolConcurrency: 4,
});

const READ_ONLY_POLICY = Object.freeze({
  allowShell: false,
  allowWrite: false,
  allowOutsideRoot: true,
  maxSteps: 20,
  maxToolCallsPerStep: 8,
  maxToolConcurrency: 4,
});

const COMPACTION_POLICY = Object.freeze({
  allowShell: false,
  allowWrite: false,
  allowOutsideRoot: false,
  maxSteps: 1,
  maxToolCallsPerStep: 0,
  maxToolConcurrency: 1,
});

const nano = Object.freeze({
  mode: "primary",
  instruction: "default",
  tools: Object.freeze([
    "read",
    "write",
    "writeWord",
    "writeExcel",
    "edit",
    "shell",
    "glob",
    "grep",
    "webSearch",
    "webFetch",
  ]),
  policy: FULL_POLICY,
});

const plan = Object.freeze({
  mode: "primary",
  instruction: "plan",
  tools: Object.freeze(["read", "glob", "grep", "webSearch", "webFetch"]),
  policy: READ_ONLY_POLICY,
});

const compaction = Object.freeze({
  mode: "subagent",
  instruction: "compaction",
  tools: Object.freeze([]),
  policy: COMPACTION_POLICY,
});

export const agents = Object.freeze({
  nano,
  plan,
  compaction,
});

/** Tool name for either a plain name or a legacy schema object. */
function toolName(tool) {
  return typeof tool === "string" ? tool : tool?.name;
}

/** Names advertised by an agent definition, in registry order. */
export function toolNamesFor(definition) {
  if (!definition || !Array.isArray(definition.tools)) return [];
  return definition.tools
    .map(toolName)
    .filter((name) => typeof name === "string" && name.length > 0);
}

/** Any agent definition, including internal subagents. */
export function getAgentDefinition(name) {
  return typeof name === "string" ? agents[name] : undefined;
}

/** Public definition (mode "primary") with its policy envelope. */
export function getPrimaryAgent(name) {
  const definition = getAgentDefinition(name);
  if (!definition || definition.mode !== "primary") return undefined;
  return { name, ...definition };
}

/** Public agent names only; internal subagents are not addressable by doors. */
export function listPrimaryAgentNames() {
  return Object.keys(agents).filter((name) => agents[name].mode === "primary");
}
