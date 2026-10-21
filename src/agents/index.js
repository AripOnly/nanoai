// src/agents/index.js
//
// The module door. Outer layers (gateway, future channels) reach agent
// definitions ONLY through this file: inspect the public roster with
// getAgent()/hasAgent()/listAgentNames(). Running a turn belongs to
// src/runtime/, which imports this door plus the contracts in
// src/llm/provider-contract.js and src/tools/.
//
// Only mode "primary" agents are public. Internal subagents such as
// "compaction" stay reachable inside the module but cannot be invoked through
// the gateway or any other outer door.

import {
  getPrimaryAgent,
  listPrimaryAgentNames,
} from "./registry.js";

export { skillNamesFor, toolNamesFor } from "./registry.js";

/** Public agent definition + policy, or undefined for unknown/subagents. */
export function getAgent(name) {
  return getPrimaryAgent(name);
}

/** Is this a public primary agent? Used by doors to reject bad input early. */
export function hasAgent(name) {
  return getPrimaryAgent(name) !== undefined;
}

/** Every public agent name, in registry order (for "Available agents: …"). */
export function listAgentNames() {
  return listPrimaryAgentNames();
}
