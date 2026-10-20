// agent.js
//
// One turn of an agent: validate, reserve the session, compact if needed,
// build the provider request, then stream the loop. This file is still the
// use-case layer in Fase 1; Fase 2 moves orchestration into src/runtime.

import { settings } from "#src/config/config.js";
import { agentLoop } from "./agent-loop.js";
import { sessionStore, SessionBusyError } from "#src/session/session-store.js";
import { EVENT } from "#src/shared/event-type.js";
import {
  getAgentDefinition,
  getPrimaryAgent,
  listPrimaryAgentNames,
  toolNamesFor,
} from "./registry.js";
import { createInstruction } from "#src/prompts/createInstruction.js";
import { compaction, checkCompaction } from "./compaction.js";
import { collectAttachmentIds } from "#src/llm/attachment-expansion.js";

function unknownAgentMessage(name) {
  const internal = getAgentDefinition(name);
  if (internal) {
    return `Agent "${name}" is a subagent and cannot be run directly. Available agents: ${listPrimaryAgentNames().join(", ")}.`;
  }
  return `Unknown agent "${name}". Available agents: ${listPrimaryAgentNames().join(", ")}.`;
}

export async function* agent({
  name,
  prompt,
  session_id,
  signal,
  allowedTools,
  policy,
} = {}) {
  let token = 0;
  try {
    const definition = getPrimaryAgent(name);
    if (!definition) {
      throw new Error(unknownAgentMessage(name));
    }

    if (signal?.aborted) return;

    const session = sessionStore.getSessionById(session_id);
    if (!session) {
      throw new Error(`Session ${session_id} not found`);
    }

    // A previous turn may have died mid-stream (restart/crash). Mark it
    // aborted with its partial state first, so this run continues from
    // exactly where the last one stopped. Never touch a live turn.
    if (sessionStore.isActive(session_id)) {
      throw new SessionBusyError(session_id);
    }
    sessionStore.recoverInterruptedTurns(session_id);

    // Capture history before start() inserts the current prompt, otherwise
    // the prompt would appear twice in the model input.
    let { summary } = sessionStore.getSessionById(session_id) ?? {};
    let conversation = sessionStore.getConversation(session_id);
    token = session.token ?? 0;

    // Reserve the session first: this both persists the prompt immediately
    // and makes a concurrent second turn fail before doing model work.
    sessionStore.start(session_id, EVENT.USER, prompt);

    // Still carrying the auto-generated name ("session-xxxxxxxx")? The first
    // real prompt gives it a permanent one — backend-side, so every client
    // (CLI, web, API) sees the same name without client-side renaming.
    sessionStore.autoNameSession(session_id, prompt);

    // Model references are "provider/model"; Fase 2 replaces this with the
    // registry-backed resolver. Keep the existing behavior for now.
    const [provider, model] = (await settings.get("model")).split("/");

    let resultCompaction = "";

    if (signal?.aborted) return;

    if (await checkCompaction({ provider, model, token })) {
      for await (const event of compaction({
        // Errors are persisted for the user but must never reach any LLM.
        conversation: conversation.filter(
          (event) => event?.role !== EVENT.ERROR,
        ),
        session_id,
        provider,
        model,
        signal,
      })) {
        if (signal?.aborted) return;

        if (event.role === EVENT.ASSISTANT) {
          resultCompaction += event.content.text;
          yield {
            role: EVENT.COMPACTION,
            content: { text: event.content.text },
          };
        }

        if (event.role === EVENT.ERROR) {
          yield event;
        }
      }
    }

    conversation.push({ role: EVENT.USER, content: { text: prompt } });

    if (resultCompaction) {
      summary = resultCompaction.trim();
      conversation.push({ role: EVENT.COMPACTION, content: resultCompaction });
    }

    const instruction = await createInstruction(definition.instruction, {
      summary,
    });
    // Error, compaction, and transient tool previews are persisted for bookkeeping
    // (or not at all for previews), but must never reach the LLM.
    const { keep_turn } = await settings.get("compaction");
    const input = sessionStore.pruneConversation(
      conversation.filter(
        (event) =>
          event?.role !== EVENT.ERROR &&
          event?.role !== EVENT.COMPACTION &&
          event?.role !== EVENT.TOOL_UPDATE,
      ),
      keep_turn,
    );

    const definitionTools = toolNamesFor(definition);
    // A caller may narrow the policy, never widen it. The definition is the
    // floor: plan stays read-only even if a future channel passes its own
    // policy object.
    const effectivePolicy = {
      ...definition.policy,
      ...(policy ?? {}),
      allowShell:
        definition.policy.allowShell === true && policy?.allowShell !== false,
      allowWrite:
        definition.policy.allowWrite === true && policy?.allowWrite !== false,
      allowOutsideRoot:
        definition.policy.allowOutsideRoot === true &&
        policy?.allowOutsideRoot !== false,
    };
    const effectiveAllowedTools = Array.isArray(allowedTools)
      ? definitionTools.filter((tool) => allowedTools.includes(tool))
      : definitionTools;

    const request = {
      provider,
      model,
      instruction,
      input,
      tools: definition.tools,
      // Policy is enforced by the loop and every tool dispatcher; the
      // provider only receives the advertised schemas.
      policy: effectivePolicy,
      allowedTools: effectiveAllowedTools,
      signal,
      session_id,
      // Attachments referenced by history are marked sent upfront so the
      // provider never re-sends (and re-charges) bytes from earlier turns.
      sentAttachments: collectAttachmentIds(input),
    };

    if (signal?.aborted) return;

    for await (const event of agentLoop(request)) {
      sessionStore.record(session_id, event);

      if (event.role === EVENT.TOKEN) {
        token = event.content.total_tokens;
      }

      yield event;
    }
  } catch (error) {
    // A busy session is a transport-level condition: let the HTTP door map it
    // to 409 instead of turning it into an in-stream error event.
    if (error instanceof SessionBusyError) throw error;
    if (signal?.aborted) return;

    // Fatal failures (bad provider, DB hiccup, …) must reach the user through
    // the same EVENT.ERROR envelope and survive a reload, so record before
    // yielding. record() is a no-op when the turn never started.
    const message = error instanceof Error ? error.message : String(error);
    console.error("[agent] turn failed:", error);
    const event = { role: EVENT.ERROR, content: { message } };
    try {
      sessionStore.record(session_id, event);
    } catch {
      // Persisting the error failed too; the live stream still shows it.
    }
    yield event;
  } finally {
    try {
      sessionStore.commit(session_id, token);
    } catch (error) {
      // The stream is nearly over, but the user still deserves to know the
      // turn was not saved (e.g. the session was deleted mid-turn).
      const message = error instanceof Error ? error.message : String(error);
      console.error("[agent] commit failed:", error);
      yield {
        role: EVENT.ERROR,
        content: { message: `Failed to save this turn: ${message}` },
      };
    }
  }
}
