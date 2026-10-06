import { agent } from "../../src/agents/agent.js";

async function* agentService(request) {
  const { name, prompt, session_id } = request;

  // agent stream
  for await (const event of agent({ name, prompt, session_id })) {
    yield event;
  }
}

export { agentService };
