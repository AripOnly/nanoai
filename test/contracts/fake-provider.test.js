// test/contracts/fake-provider.test.js
// Locks the shared fake provider used by later contract/integration tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EVENT } from "#src/shared/event-type.js";
import {
  createFakeProvider,
  textTurn,
  toolTurn,
} from "../helpers/fake-provider.js";

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("fake provider helper", () => {
  it("scripts text turns and records every request", async () => {
    const provider = createFakeProvider({
      turns: [textTurn("hello", { input_tokens: 3, output_tokens: 4 })],
    });

    const first = await collect(provider.request({ model: "fake-model", input: [] }));
    assert.deepEqual(
      first.map((event) => event.role),
      [EVENT.ASSISTANT, EVENT.TOKEN],
    );
    assert.equal(first[0].content.text, "hello");
    assert.equal(first[1].content.total_tokens, 7);

    // An exhausted script repeats its last turn instead of hanging the loop.
    const second = await collect(provider.request({ model: "fake-model", input: [] }));
    assert.equal(second[0].content.text, "hello");
    assert.equal(provider.calls.request.length, 2);
  });

  it("supports tool calls, lifecycle hooks, and abort", async () => {
    const provider = createFakeProvider({
      turns: [
        toolTurn({
          call_id: "call_9",
          name: "read",
          arguments: { path: "a.txt" },
          signature: "opaque-sig",
        }),
      ],
    });

    provider.configure({ endpoint: "http://localhost:1234" });
    assert.equal(provider.config.endpoint, "http://localhost:1234");
    assert.equal(provider.calls.configure.length, 1);

    const events = await collect(provider.request({ model: "fake-model", input: [] }));
    assert.equal(events[0].role, EVENT.TOOL_CALL);
    assert.equal(events[0].content.call_id, "call_9");
    assert.equal(events[0].content.signature, "opaque-sig");

    assert.deepEqual(provider.feed({ toolCall: [] }), []);
    assert.deepEqual(provider.continue({ toolCall: [] }), []);
    assert.equal(provider.calls.feed.length, 1);
    assert.equal(provider.calls.continue.length, 1);

    provider.dispose();
    assert.equal(provider.calls.dispose, 1);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      collect(provider.request({ input: [], signal: controller.signal })),
      (error) => error.name === "AbortError",
    );
  });
});
