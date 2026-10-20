// src/agents/index.js
//
// The module door. Outer layers (gateway, future channels) reach agents ONLY
// through this file: run a turn with agent(), or inspect the roster with
// hasAgent()/listAgentNames(). Internal files (agent-loop, tool-execute,
// registry, compaction) stay private to the module.

import { agent } from "./agent.js";
import { agents } from "./registry.js";

export { agent };

/** Is this a known agent name? Used by doors to reject bad input early. */
export function hasAgent(name) {
  return typeof name === "string" && name in agents;
}

/** Every agent name, in registry order (for "Available agents: …" messages). */
export function listAgentNames() {
  return Object.keys(agents);
}
