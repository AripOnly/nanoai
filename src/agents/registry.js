// src/agents/registry.js
//
// Agent definitions are data, not behavior. `mode` separates the two public
// primaries from internal helpers such as compaction. `policy` is the safety
// envelope the loop and tool executor enforce even if the model asks for a
// tool that is not in the advertised list.

import { schema } from "#src/tools/tools.js";

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

const nano = {
  mode: "primary",
  instruction: "default",
  tools: [
    schema.readTool,
    schema.writeTool,
    schema.wordTool,
    schema.excelTool,
    schema.editTool,
    schema.shellTool,
    schema.globTool,
    schema.grepTool,
    schema.webSearchTool,
    schema.webFetchTool,
  ],
  policy: FULL_POLICY,
};

const plan = {
  mode: "primary",
  instruction: "plan",
  tools: [schema.readTool, schema.globTool, schema.grepTool, schema.webSearchTool, schema.webFetchTool],
  policy: READ_ONLY_POLICY,
};

const compaction = {
  mode: "subagent",
  instruction: "compaction",
  tools: [],
  policy: COMPACTION_POLICY,
};

export const agents = {
  nano,
  plan,
  compaction,
};

/** Tool name for either a schema object (today) or a plain name (Fase 2). */
function toolName(tool) {
  return typeof tool === "string" ? tool : tool?.name;
}

/** Names advertised by an agent definition, in registry order. */
export function toolNamesFor(definition) {
  if (!definition || !Array.isArray(definition.tools)) return [];
  return definition.tools.map(toolName).filter((name) => typeof name === "string" && name.length > 0);
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
