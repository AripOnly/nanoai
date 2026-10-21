// gateway/service/skill-service.js
//
// Read-only HTTP view of installed skills. Installation, removal, and update
// are intentionally CLI-only: exposing them over the agent's HTTP surface would
// make skill installation reachable from the model loop.

import { ResponseError } from "../error/response-error.js";

function registryOrThrow(skills) {
  if (!skills || typeof skills.list !== "function") {
    throw new ResponseError(503, "Skills are not available.");
  }
  return skills;
}

export function createSkillService(skills) {
  const registry = registryOrThrow(skills);
  return {
    list() {
      return registry.list();
    },

    async reload() {
      const snapshot = await registry.reload({ reason: "api" });
      return {
        revision: snapshot.revision,
        skills: registry.list(),
        stats: registry.stats(),
      };
    },
  };
}
