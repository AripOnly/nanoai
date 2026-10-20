// test/suite/agent-policy-e2e.test.js
//
// End-to-end proof for the Fase 1 exit criterion: a read-only primary (plan)
// still advertises only its own tools, and a model's invented shell call is
// refused by the loop/tool dispatcher without executing anything.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { agent } from "../../src/agents/agent.js";
import { sessionStore } from "../../src/session/session-store.js";
import { registerProvider } from "../../src/llm/registry.js";
import { settings } from "../../src/config/config.js";
import { EVENT } from "../../src/shared/event-type.js";
import {
  createFakeProvider,
  textTurn,
  toolTurn,
} from "../helpers/fake-provider.js";

const IDS = [];

after(() => {
  for (const id of IDS) {
    try {
      sessionStore.deleteSession(id);
    } catch {
      // Cleanup must never fail the suite.
    }
  }
});

describe("read-only agent end-to-end", () => {
  it("refuses a model-requested shell call before execution", async () => {
    const provider = createFakeProvider({
      id: "fake-policy",
      turns: [
        toolTurn({
          name: "shell",
          arguments: { command: "echo must-not-run" },
        }),
        textTurn("done"),
      ],
    });
    registerProvider("fake-policy", provider);
    await settings.set("model", "fake-policy/fake-model");

    const row = sessionStore.createSession("policy-e2e", "policy");
    IDS.push(row.id);

    const events = [];
    for await (const event of agent({
      name: "plan",
      prompt: "please run a shell command",
      session_id: row.id,
    })) {
      events.push(event);
    }

    const toolResult = events.find(
      (event) => event.role === EVENT.TOOL_RESULT,
    );
    assert.ok(toolResult, "the loop must answer the invented tool call");
    assert.equal(toolResult.content.result.success, false);
    assert.match(toolResult.content.result.error, /not allowed for this agent/);

    // The provider receives the plan tool schemas, never shell.
    const advertised = provider.calls.request[0].tools.map((tool) => tool.name);
    assert.ok(advertised.includes("read"));
    assert.ok(!advertised.includes("shell"));

    assert.equal(sessionStore.isActive(row.id), false, "turn must commit");
  });
});
