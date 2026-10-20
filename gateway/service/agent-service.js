// gateway/service/agent-service.js
//
// Validation lives here, not in the controller: the service owns the business
// rule of which agents exist and how a request must look. agentService()
// validates synchronously (so the controller can still answer with a plain
// HTTP error) and returns the event stream to consume.

import { agent, hasAgent, listAgentNames } from "../../src/agents/index.js";
import { ResponseError } from "../error/response-error.js";

export function agentService(request = {}) {
  const { name, prompt, session_id } = request;

  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new ResponseError(400, "prompt must be a non-empty string.");
  }

  if (!hasAgent(name)) {
    throw new ResponseError(
      400,
      `Unknown agent "${name}". Available agents: ${listAgentNames().join(", ")}.`,
    );
  }

  return runAgent({ name, prompt, session_id });
}

async function* runAgent({ name, prompt, session_id }) {
  yield* agent({ name, prompt, session_id });
}
