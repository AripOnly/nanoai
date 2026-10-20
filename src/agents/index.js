// src/agents/index.js
//
// The module door. Outer layers (gateway, future channels) reach agents ONLY
// through this file: run a turn with agent(), or inspect the public roster
// with getAgent()/hasAgent()/listAgentNames(). Internal files (agent-loop,
// tool-execute, registry, compaction) stay private to the module.
//
// Only mode "primary" agents are public. Internal subagents such as
// "compaction" stay reachable inside the module but cannot be invoked through
// the gateway or any other outer door.

import { agent } from "./agent.js";
import {
  getPrimaryAgent,
  listPrimaryAgentNames,
} from "./registry.js";

export { agent };

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
