// agent.js

import { settings } from "#src/config/config.js";
import { agentLoop } from "./agent-loop.js";
import { sessionStore } from "#src/session/session-store.js";
import { EVENT } from "#src/shared/event-type.js";
import { agents } from "./registry.js";
import { createInstruction } from "#src/prompts/createInstruction.js";
import { compaction, checkCompaction } from "./compaction.js";
import { collectAttachmentIds } from "#src/llm/providers/google/google.js";

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
    yield {
      role: EVENT.ERROR,
      content: { message: error.stack },
    };
  } finally {
    sessionStore.commit(session_id, token);
  }
}
