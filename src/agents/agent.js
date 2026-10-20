// agent.js

import { settings } from "#src/config/config.js";
import { agentLoop } from "./agent-loop.js";
import { sessionStore } from "#src/session/session-store.js";
import { EVENT } from "#src/shared/event-type.js";
import { agents } from "./registry.js";
import { createInstruction } from "#src/prompts/createInstruction.js";
import { compaction, checkCompaction } from "./compaction.js";
import { collectAttachmentIds } from "#src/llm/attachment-expansion.js";

export async function* agent({ name, prompt, session_id }) {
  let token = 0;
  try {
    const [provider, model] = (await settings.get("model")).split("/");
    const session = sessionStore.getSessionById(session_id);

    if (!session) {
      throw new Error(`Session ${session_id} not found`);
    }

    // A previous turn may have died mid-stream (restart/crash). Mark it
    // aborted with its partial state first, so this run continues from
    // exactly where the last one stopped.
    sessionStore.recoverInterruptedTurns(session_id);

    // Still carrying the auto-generated name ("session-xxxxxxxx")? The first
    // real prompt gives it a permanent one — backend-side, so every client
    // (CLI, web, API) sees the same name without client-side renaming.
    sessionStore.autoNameSession(session_id, prompt);

    if (!agents[name]) {
      throw new Error(
        `Unknown agent "${name}". Available agents: ${Object.keys(agents).join(", ")}.`,
      );
    }

    token = session.token ?? 0;
    let { summary } = sessionStore.getSessionById(session_id) ?? "";
    let conversation = sessionStore.getConversation(session_id);
    let resultCompaction = "";

    if (await checkCompaction({ provider, model, token })) {
      for await (const event of compaction({
        // Errors are persisted for the user but must never reach any LLM.
        conversation: conversation.filter(
          (event) => event?.role !== EVENT.ERROR,
        ),
        session_id,
        provider,
        model,
      })) {
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

    const instruction = await createInstruction(agents[name].instruction, {
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
    const request = {
      provider,
      model,
      instruction,
      input,
      tools: agents[name].tools,
      session_id,
      // Attachments referenced by history are marked sent upfront so the
      // provider never re-sends (and re-charges) bytes from earlier turns.
      sentAttachments: collectAttachmentIds(input),
    };

    sessionStore.start(session_id, EVENT.USER, prompt);
    for await (const event of agentLoop(request)) {
      sessionStore.record(session_id, event);

      if (event.role === EVENT.TOKEN) {
        token = event.content.total_tokens;
      }

      yield event;
    }
  } catch (error) {
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
