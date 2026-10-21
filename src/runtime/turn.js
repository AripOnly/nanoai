// src/runtime/turn.js
//
// One turn of an agent: resolve the model through the registry, compact when
// needed, build the provider request, then stream the pure agent loop. This is
// the application/use-case layer: the gateway stays transport-only, the agent
// loop stays free of settings/session/tool implementations, and every
// dependency (session door, model resolver, config snapshot, tool registry)
// arrives through `deps`.
//
// The settings snapshot and model catalog snapshot are captured once at the
// start of the turn, so a hot-reload cannot change the model, credentials, or
// limits halfway through a stream.

import { agentLoop } from "#src/agents/agent-loop.js";
import { getAgent, listAgentNames, toolNamesFor } from "#src/agents/index.js";
import { executeTool } from "#src/tools/executor.js";
import { toolRegistry } from "#src/tools/registry.js";
import { createInstruction } from "#src/prompts/createInstruction.js";
import { collectAttachmentIds } from "#src/llm/attachment-expansion.js";
import { EVENT } from "#src/shared/event-type.js";
import { SessionBusyError } from "#src/session/index.js";
import {
  compactConversation,
  prunedInputAfterCompaction,
  shouldCompact,
} from "./compaction.js";

const INTERNAL_AGENTS = Object.freeze(["compaction"]);

function unknownAgentMessage(name) {
  if (INTERNAL_AGENTS.includes(name)) {
    return `Agent "${name}" is a subagent and cannot be run directly. Available agents: ${listAgentNames().join(", ")}.`;
  }
  return `Unknown agent "${name}". Available agents: ${listAgentNames().join(", ")}.`;
}

function abortRequested(signal) {
  return signal?.aborted === true;
}

function errorEvent(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { role: EVENT.ERROR, content: { message } };
}

function visibleInput(conversation) {
  return conversation.filter(
    (event) =>
      event?.role !== EVENT.ERROR &&
      event?.role !== EVENT.COMPACTION &&
      event?.role !== EVENT.TOOL_UPDATE,
  );
}

function mergePolicy(definitionPolicy, callerPolicy) {
  const policy = callerPolicy ?? {};
  const positive = (a, b, fallback) => {
    const values = [a, b].filter(
      (value) => Number.isInteger(value) && value > 0,
    );
    return values.length > 0 ? Math.min(...values) : fallback;
  };
  const nonNegative = (a, b, fallback) => {
    const values = [a, b].filter(
      (value) => Number.isInteger(value) && value >= 0,
    );
    return values.length > 0 ? Math.min(...values) : fallback;
  };

  return {
    ...definitionPolicy,
    ...policy,
    allowShell:
      definitionPolicy.allowShell === true && policy.allowShell !== false,
    allowWrite:
      definitionPolicy.allowWrite === true && policy.allowWrite !== false,
    allowOutsideRoot:
      definitionPolicy.allowOutsideRoot === true &&
      policy.allowOutsideRoot !== false,
    maxSteps: positive(definitionPolicy.maxSteps, policy.maxSteps, 24),
    maxToolCallsPerStep: nonNegative(
      definitionPolicy.maxToolCallsPerStep,
      policy.maxToolCallsPerStep,
      8,
    ),
    maxToolConcurrency: positive(
      definitionPolicy.maxToolConcurrency,
      policy.maxToolConcurrency,
      4,
    ),
  };
}

function logFailure(logger, label, error) {
  // Never log the raw error object: provider/SDK errors can carry request
  // context. A message is enough to diagnose, and credentials stay out.
  const message = error instanceof Error ? error.message : String(error);
  logger?.error?.(`[runtime] ${label}:`, message);
}

export async function* runTurn({
  name,
  prompt,
  session_id,
  signal,
  allowedTools,
  policy,
  deps,
} = {}) {
  if (!deps || typeof deps !== "object") {
    throw new TypeError("runTurn requires a deps object.");
  }

  const { session, resolveModel, getConfig, getCatalog } = deps;
  if (!session) throw new TypeError("runTurn deps.session is required.");
  if (typeof resolveModel !== "function") {
    throw new TypeError("runTurn deps.resolveModel is required.");
  }
  if (typeof getConfig !== "function") {
    throw new TypeError("runTurn deps.getConfig is required.");
  }

  const tools = deps.tools ?? toolRegistry;
  const logger = deps.logger ?? console;
  let token = 0;
  let began = false;

  try {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error("prompt must be a non-empty string.");
    }
    if (typeof session_id !== "string" || session_id.trim() === "") {
      throw new Error("session_id must be a non-empty string.");
    }

    const definition = getAgent(name);
    if (!definition) {
      throw new Error(unknownAgentMessage(name));
    }

    if (abortRequested(signal)) return;

    if (!session.getSession(session_id)) {
      throw new Error(`Session ${session_id} not found`);
    }

    if (session.isSessionBusy(session_id)) {
      throw new SessionBusyError(session_id);
    }

    // A previous process may have died mid-stream. Mark that partial turn as
    // aborted before reserving the session for this one.
    session.recoverInterruptedTurn(session_id);

    const before = session.getSession(session_id) ?? {};
    let summary = before.summary ?? null;
    let conversation = session.getConversation(session_id) ?? [];
    token = before.token ?? 0;

    // Reserve the session first: the prompt is durable from here on and a
    // concurrent turn fails before doing model work.
    session.beginTurn(session_id, prompt);
    began = true;
    session.autoNameSession(session_id, prompt);

    if (abortRequested(signal)) return;

    const config = getConfig() ?? {};
    const catalog = typeof getCatalog === "function" ? getCatalog() : null;
    const modelRef = config.model;
    const modelHandle = await resolveModel({
      config,
      catalog,
      modelRef,
      requiredCapabilities: ["streaming", "toolCalling"],
    });
    if (!modelHandle?.adapter || !modelHandle?.model) {
      throw new Error("Model resolver returned an incomplete handle.");
    }

    const contextWindow =
      modelHandle.limits?.contextWindow ??
      modelHandle.model.contextWindow;
    const ratio = config.compaction?.ratio ?? 85;
    const keepTurn = config.compaction?.keep_turn ?? 2;
    const getSummary = () =>
      typeof session.getSummary === "function"
        ? session.getSummary(session_id)
        : null;
    const persistSummary = (nextSummary) =>
      session.compactSession(session_id, nextSummary);
    const pruneConversation = (inputConversation, turns) =>
      session.pruneConversation(inputConversation, turns);

    // Compact before sending the current prompt when history is already over
    // the threshold. The current prompt is not part of the summary.
    if (
      shouldCompact({ token, contextWindow, ratio }) &&
      !abortRequested(signal)
    ) {
      let compacted = "";
      for await (const event of compactConversation({
        conversation: conversation.filter(
          (item) => item?.role !== EVENT.ERROR,
        ),
        getSummary,
        persistSummary,
        provider: modelHandle.adapter,
        model: modelHandle.model,
        signal,
        username: config.username,
        keepTurn,
      })) {
        if (abortRequested(signal)) return;

        if (event.role === EVENT.ASSISTANT) {
          compacted += event.content?.text ?? "";
          yield {
            role: EVENT.COMPACTION,
            content: { text: event.content?.text ?? "" },
          };
        }

        if (event.role === EVENT.ERROR) {
          // The compaction request failed. Do not send the oversized history
          // anyway; persist the provider error, surface it, and close the turn.
          session.recordEvent(session_id, event);
          yield event;
          return;
        }
      }

      compacted = compacted.trim();
      if (compacted) {
        summary = compacted;
        token = 0;
        conversation.push({
          role: EVENT.COMPACTION,
          content: { text: compacted },
        });
      }
    }

    conversation.push({ role: EVENT.USER, content: { text: prompt } });

    const instruction = await createInstruction(definition.instruction, {
      summary,
      username: config.username,
    });

    // Prune with the compaction marker still present, then strip UI-only
    // events before handing history to the provider. Filtering first would
    // hide the marker and silently defeat compaction.
    const input = visibleInput(
      pruneConversation(conversation, keepTurn),
    );

    const definitionTools = toolNamesFor(definition);
    const effectivePolicy = mergePolicy(definition.policy, policy);
    const effectiveAllowedTools = Array.isArray(allowedTools)
      ? definitionTools.filter((tool) => allowedTools.includes(tool))
      : definitionTools;

    const requestCompaction = async ({ conversation: inputConversation, token: stepToken }) => {
      if (
        !shouldCompact({
          token: stepToken,
          contextWindow,
          ratio,
        })
      ) {
        return null;
      }

      let compacted = "";
      try {
        for await (const event of compactConversation({
          conversation: inputConversation,
          getSummary,
          persistSummary,
          provider: modelHandle.adapter,
          model: modelHandle.model,
          signal,
          username: config.username,
          keepTurn,
        })) {
          if (event.role === EVENT.ASSISTANT) {
            compacted += event.content?.text ?? "";
          }
        }
      } catch (error) {
        logger.warn?.(
          `[runtime] mid-turn compaction failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      }

      compacted = compacted.trim();
      if (!compacted) return null;

      return {
        summary: compacted,
        input: prunedInputAfterCompaction({
          pruneConversation,
          conversation: inputConversation,
          summary: compacted,
          keepTurn,
        }),
      };
    };

    if (abortRequested(signal)) return;

    const request = {
      provider: modelHandle.adapter,
      model: modelHandle.model,
      instruction,
      input,
      tools: tools.schemasFor(effectiveAllowedTools),
      policy: effectivePolicy,
      allowedTools: effectiveAllowedTools,
      signal,
      session_id,
      sentAttachments: collectAttachmentIds(input),
      executeTool,
      requestCompaction,
    };

    for await (const event of agentLoop(request)) {
      session.recordEvent(session_id, event);

      if (event.role === EVENT.TOKEN) {
        token = event.content.total_tokens;
      }

      yield event;
    }
  } catch (error) {
    // Busy sessions are transport-level: the gateway maps this to 409 without
    // turning it into an in-stream error event.
    if (error instanceof SessionBusyError) throw error;
    if (abortRequested(signal)) return;

    logFailure(logger, "turn failed", error);
    const event = errorEvent(error);
    if (began) {
      try {
        session.recordEvent(session_id, event);
      } catch {
        // Persisting the error failed too; the live stream still shows it.
      }
    }
    yield event;
  } finally {
    if (began) {
      try {
        session.commitTurn(session_id, token);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logFailure(logger, "commit failed", error);
        yield {
          role: EVENT.ERROR,
          content: { message: `Failed to save this turn: ${message}` },
        };
      }
    }
  }
}
