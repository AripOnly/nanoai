// test/contracts/agent-loop.test.js
//
// Loop-level safety: bounded steps, bounded tool batches/concurrency, signal
// propagation, and abort checks. No network: every provider is the scripted
// fake from test/helpers.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentLoop } from "../../src/agents/agent-loop.js";
import { EVENT } from "../../src/shared/event-type.js";
import {
  assistant,
  createFakeProvider,
  textTurn,
  toolCall,
  toolTurn,
  usage,
} from "../helpers/fake-provider.js";

const PROVIDER = "fake-loop";

function request(overrides = {}) {
  return {
    provider: PROVIDER,
    model: "fake-model",
    instruction: "test",
    input: [],
    tools: [],
    policy: {
      maxSteps: 2,
      maxToolCallsPerStep: 8,
      maxToolConcurrency: 2,
    },
    executeTool: async () => ({ success: true, output: "ok" }),
    ...overrides,
  };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("agent loop bounds", () => {
  it("does not call the provider when the signal is already aborted", async () => {
    const provider = createFakeProvider({
      id: PROVIDER,
      turns: [textTurn("must not run")],
    });
    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      agentLoop(request({ provider, signal: controller.signal })),
    );

    assert.deepEqual(events, []);
    assert.equal(provider.calls.request.length, 0);
  });

  it("passes the signal through and stops after a mid-stream abort", async () => {
    const controller = new AbortController();
    const provider = createFakeProvider({
      id: PROVIDER,
      turns: [
        [
          assistant("partial"),
          () => {
            controller.abort();
            return usage({ input_tokens: 1, output_tokens: 1 });
          },
        ],
      ],
    });

    const events = await collect(
      agentLoop(request({ provider, signal: controller.signal })),
    );

    assert.equal(provider.calls.request[0].signal, controller.signal);
    assert.deepEqual(
      events.map((event) => event.role),
      [EVENT.ASSISTANT],
      "the event produced while aborting is not forwarded",
    );
  });

  it("executes a tool batch with bounded concurrency", async () => {
    const calls = Array.from({ length: 6 }, (_, index) =>
      toolCall({
        call_id: `c${index}`,
        name: "read",
        arguments: { path: "unused" },
      }),
    );
    const provider = createFakeProvider({
      id: PROVIDER,
      turns: [
        [...calls, usage({ input_tokens: 10, output_tokens: 2 })],
        textTurn("done"),
      ],
    });

    let active = 0;
    let maxActive = 0;
    let executed = 0;
    const events = await collect(
      agentLoop(
        request({
          provider,
          executeTool: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            executed += 1;
            await new Promise((resolve) => setTimeout(resolve, 15));
            active -= 1;
            return { success: true, output: "ok" };
          },
        }),
      ),
    );

    assert.equal(executed, calls.length);
    assert.equal(maxActive, 2, "never more than maxToolConcurrency in flight");
    assert.equal(
      events.filter((event) => event.role === EVENT.TOOL_RESULT).length,
      calls.length,
    );
  });

  it("rejects tool calls beyond maxToolCallsPerStep without running them", async () => {
    const calls = ["a", "b", "c"].map((id) =>
      toolCall({ call_id: id, name: "read", arguments: { path: "unused" } }),
    );
    const provider = createFakeProvider({
      id: PROVIDER,
      turns: [
        [...calls, usage({ input_tokens: 10, output_tokens: 2 })],
        textTurn("done"),
      ],
    });

    const executed = [];
    const events = await collect(
      agentLoop(
        request({
          provider,
          policy: {
            maxSteps: 2,
            maxToolCallsPerStep: 2,
            maxToolConcurrency: 2,
          },
          executeTool: async (call) => {
            executed.push(call.call_id);
            return { success: true, output: "ok" };
          },
        }),
      ),
    );

    assert.deepEqual(executed, ["a", "b"]);
    const results = events.filter(
      (event) => event.role === EVENT.TOOL_RESULT,
    );
    assert.equal(results.length, 3);
    assert.match(results[2].content.result.error, /limit is 2/);
  });

  it("stops a runaway loop after maxSteps", async () => {
    const provider = createFakeProvider({
      id: PROVIDER,
      turns: [toolTurn({ name: "read", arguments: { path: "unused" } })],
    });

    let executed = 0;
    const events = await collect(
      agentLoop(
        request({
          provider,
          policy: {
            maxSteps: 2,
            maxToolCallsPerStep: 4,
            maxToolConcurrency: 1,
          },
          executeTool: async () => {
            executed += 1;
            return { success: true, output: "ok" };
          },
        }),
      ),
    );

    assert.equal(executed, 2);
    assert.equal(provider.calls.request.length, 2);
    const error = events.find((event) => event.role === EVENT.ERROR);
    assert.ok(error, "max steps must surface a terminal error event");
    assert.match(error.content.message, /maximum of 2 steps/);
  });
});
