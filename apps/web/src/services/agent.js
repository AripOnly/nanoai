// src/services/agent.js
import { gateway } from "./api.js";

/**
 * Stream one agent turn. Yields every SSE frame as a parsed event; transport
 * and HTTP failures throw so the caller can show them (silence is worse).
 */
async function* agent(request) {
  yield* gateway.streamAgent(request);
}

export { agent };
