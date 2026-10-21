// test/suite/agent-policy-e2e.test.js
//
// End-to-end proof for the read-only agent boundary: `plan` advertises only
// its own tools, and a model's invented shell call is refused by the tool
// dispatcher without executing anything.
//
// The provider and model resolver are injected, so this test stays offline and
// does not touch the settings file or the global provider registry.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { runTurn } from "../../src/runtime/turn.js";
import * as sessionDoor from "../../src/session/index.js";
import { sessionStore } from "../../src/session/session-store.js";
import { EVENT } from "../../src/shared/event-type.js";
import {
  FAKE_MODEL,
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

    const row = sessionStore.createSession("policy-e2e", "policy");
    IDS.push(row.id);

    const config = {
      model: "fake-policy/fake-model",
      username: "tester",
      compaction: { ratio: 85, keep_turn: 2 },
    };

    const events = [];
    for await (const event of runTurn({
      name: "plan",
      prompt: "please run a shell command",
      session_id: row.id,
      deps: {
        session: sessionDoor,
        getConfig: () => config,
        getCatalog: () => null,
        resolveModel: async () => ({
          adapter: provider,
          model: FAKE_MODEL,
          limits: { contextWindow: FAKE_MODEL.contextWindow },
          capabilities: FAKE_MODEL.capabilities,
        }),
        logger: { warn() {}, error() {} },
      },
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
