// src/agents/agent-loop.js
//
// The provider/tool loop. It is deliberately bounded: every model step and
// every parallel tool batch has a hard limit, and a client abort stops both
// provider streaming and tool execution.
//
// This file is pure agent core: it receives a resolved provider adapter, tool
// schemas, an executor function, and an optional compaction callback from the
// runtime. It must not import settings, sessions, provider registries, or tool
// implementations.

import { EVENT } from "#src/shared/event-type.js";
import { getCallId } from "#src/shared/call-id.js";

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_MAX_TOOL_CALLS = 8;
const DEFAULT_MAX_CONCURRENCY = 4;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function isAborted(signal) {
  return signal?.aborted === true;
}

function failure(name, message) {
  return { success: false, error: `Tool "${name}" was not executed: ${message}` };
}

function continuation(provider, context) {
  if (typeof provider?.continue === "function") {
    return provider.continue(context);
  }
  if (typeof provider?.feed === "function") {
    return provider.feed(context);
  }
  return [];
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Results keep the
 * input order, so tool results stay aligned with the tool calls in history.
 */
async function runWithConcurrency(items, limit, worker) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

export async function* agentLoop(request) {
  const provider = request?.provider;
  if (!provider || typeof provider.request !== "function") {
    throw new Error(
      "agentLoop requires a resolved provider adapter with request().",
    );
  }

  const executeTool = request.executeTool;
  if (isAborted(request.signal)) return;
  if (typeof executeTool !== "function") {
    throw new Error("agentLoop requires an executeTool() function.");
  }

  const policy = request.policy ?? {};
  const maxSteps = positiveInteger(policy.maxSteps, DEFAULT_MAX_STEPS);
  const maxToolCalls = nonNegativeInteger(
    policy.maxToolCallsPerStep,
    DEFAULT_MAX_TOOL_CALLS,
  );
  const maxConcurrency = positiveInteger(
    policy.maxToolConcurrency,
    DEFAULT_MAX_CONCURRENCY,
  );

  for (let step = 1; step <= maxSteps; step++) {
    if (isAborted(request.signal)) return;

    let toolCall = [];
    const reasoningSignatures = [];
    let reasoningSignature = "";
    let assistantText = "";
    let token = 0;

    for await (const event of provider.request(request)) {
      if (isAborted(request.signal)) return;

      switch (event.role) {
        case EVENT.ASSISTANT:
          assistantText += event.content.text;
          break;

        case EVENT.REASONING_SIGNATURE:
          if (
            typeof event.content?.signature === "string" &&
            event.content.signature !== ""
          ) {
            reasoningSignatures.push({
              role: EVENT.REASONING_SIGNATURE,
              content: { ...event.content },
            });
            reasoningSignature = event.content.signature;
          }
          break;

        case EVENT.TOOL_CALL:
          toolCall.push({ ...event.content });
          break;

        case EVENT.TOKEN:
          token = event.content.total_tokens;
          break;
      }

      yield event;
    }

    if (isAborted(request.signal)) return;

    // Thought/reasoning items always precede the assistant output they belong
    // to. They are recorded even on a final text-only response so the provider
    // can verify the reasoning state on a later user turn.
    if (reasoningSignatures.length > 0) {
      request.input.push(...reasoningSignatures);
    }

    if (assistantText) {
      request.input.push({
        role: EVENT.ASSISTANT,
        content: { text: assistantText },
      });
    }

    if (toolCall.length === 0) return;

    // Execute only the first N calls; the rest get an explicit failure result
    // so the model sees every call answered and cannot smuggle extra work in.
    const accepted = toolCall.slice(0, maxToolCalls);
    const rejected = toolCall.slice(maxToolCalls);
    const pendingUpdates = [];

    const executeOne = async (tc) => {
      try {
        return await executeTool(tc, {
          signal: request.signal,
          sessionID: request.session_id,
          allowedTools: request.allowedTools,
          policy,
          onUpdate: (update = {}) => {
            pendingUpdates.push({
              role: EVENT.TOOL_UPDATE,
              content: {
                call_id: getCallId(update) ?? tc.call_id,
                name: tc.name,
                preview: update.preview ?? "",
              },
            });
          },
          onOutput: (chunk) => {
            const text = chunk?.text ?? "";
            if (!text) return;
            pendingUpdates.push({
              role: EVENT.TOOL_UPDATE,
              content: {
                call_id: tc.call_id,
                name: tc.name,
                preview: text.slice(-4000),
              },
            });
          },
        });
      } catch (error) {
        return failure(
          tc.name,
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    let toolsDone = false;
    const all = runWithConcurrency(accepted, maxConcurrency, executeOne).then(
      (results) => {
        toolsDone = true;
        return [
          ...results,
          ...rejected.map((tc) =>
            failure(
              tc.name,
              `this step requested ${toolCall.length} tool calls, the limit is ${maxToolCalls}.`,
            ),
          ),
        ];
      },
    );

    const settled = all.catch((error) => {
      toolsDone = true;
      throw error;
    });

    while (!toolsDone) {
      await Promise.race([
        settled,
        new Promise((resolve) => setTimeout(resolve, 50)),
      ]);
      while (pendingUpdates.length > 0) {
        yield pendingUpdates.shift();
      }
    }
    const results = await all;
    while (pendingUpdates.length > 0) {
      yield pendingUpdates.shift();
    }

    if (isAborted(request.signal)) return;

    for (let i = 0; i < toolCall.length; i++) {
      const callId = getCallId(toolCall[i]) ?? toolCall[i].call_id;
      yield {
        role: EVENT.TOOL_RESULT,
        content: {
          call_id: callId,
          name: toolCall[i].name,
          result: results[i],
        },
      };
    }

    const continuationParts = continuation(provider, {
      reasoningSignature,
      reasoningSignatures,
      toolCall,
      toolResult: results,
    });
    if (Array.isArray(continuationParts)) {
      request.input.push(...continuationParts);
    }

    if (isAborted(request.signal)) return;

    // Mid-turn compaction is a runtime use-case. The loop only asks; the
    // runtime decides, persists the summary, and returns the pruned input.
    if (typeof request.requestCompaction === "function") {
      const compacted = await request.requestCompaction({
        conversation: request.input,
        token,
      });

      if (isAborted(request.signal)) return;

      if (compacted?.summary) {
        request.instruction =
          `${request.instruction}\n\n${compacted.summary}`.trim();
        if (Array.isArray(compacted.input)) {
          request.input = compacted.input;
        }
        yield {
          role: EVENT.COMPACTION,
          content: { text: compacted.summary },
        };
      }
    }
  }

  if (!isAborted(request.signal)) {
    yield {
      role: EVENT.ERROR,
      content: {
        message: `Agent stopped after reaching the maximum of ${maxSteps} steps.`,
      },
    };
  }
}
