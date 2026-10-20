// src/session/session-store.js

import sql from "./sql.js";
import { randomUUID } from "node:crypto";
import { EVENT } from "#src/shared/event-type.js";
import { getCallId } from "#src/shared/call-id.js";
import { nameFromPrompt } from "#src/shared/naming.js";

export { nameFromPrompt };

// Atomic turn finalize: the turn row and the session bookkeeping land
// together or not at all.
const commitTurn = sql.transaction((rowId, parts, session_id, token) => {
  sql
    .prepare("UPDATE turn SET parts = ?, status = 'complete' WHERE id = ?")
    .run(parts, rowId);

  sql
    .prepare(
      "UPDATE session SET updated_at = datetime('now','localtime'), token = COALESCE(?, token) WHERE id = ?",
    )
    .run(token, session_id);
});

function assertSessionId(session_id) {
  if (typeof session_id !== "string" || session_id.trim() === "") {
    throw new Error("session_id must be a non-empty string.");
  }
}

class SessionStore {
  constructor() {
    this.turns = new Map();
  }

  persistTurn(state) {
    sql
      .prepare("UPDATE turn SET parts = ? WHERE id = ?")
      .run(JSON.stringify(state.turn), state.rowId);
  }

  flushResponse(state) {
    if (state.response.length > 0) {
      state.turn.push({
        role: EVENT.ASSISTANT,
        content: {
          text: state.response,
        },
      });
      state.response = "";
    }
  }

  // start record event
  // The turn row is INSERTed immediately (status 'streaming') so the user
  // prompt is durable from this point on — a crash can never lose it.
  start(session_id, event, input) {
    const turn = [
      {
        role: event,
        content: { text: input },
      },
    ];
    const row = sql
      .prepare(
        "INSERT INTO turn (parts, session_id, status) VALUES (?, ?, 'streaming')",
      )
      .run(JSON.stringify(turn), session_id);

    this.turns.set(session_id, {
      rowId: Number(row.lastInsertRowid),
      turn,
      response: "",
    });
  }

  // recort event
  // Assistant text chunks accumulate in memory and are flushed as one
  // consolidated message when the next non-assistant event arrives (or at
  // commit). Every other event is appended AND persisted immediately, so a
  // crash loses at most the current in-flight assistant message.
  record(session_id, event) {
    const state = this.turns.get(session_id);
    if (!state) return;

    // TOKEN events live in the session.token column, not in turns.
    // TOOL_UPDATE is transient live preview for the user: streamed over SSE
    // but never persisted and never sent to LLM.
    if (event.role === EVENT.TOKEN) return;
    if (event.role === EVENT.TOOL_UPDATE) return;

    if (event.role === EVENT.ASSISTANT) {
      state.response += event.content?.text ?? "";
      return;
    }

    this.flushResponse(state);
    state.turn.push(event);
    this.persistTurn(state);
  }

  // save event recording results to the database
  // Finalize only: the row already exists (see start), so this UPDATEs it to
  // 'complete' together with the session bookkeeping, atomically. Either
  // both land or neither does — a crash mid-commit never leaves half state.
  commit(session_id, token = null) {
    assertSessionId(session_id);
    const state = this.turns.get(session_id);
    if (!state || state.turn.length === 0) return;

    const exists = sql
      .prepare("SELECT 1 FROM session WHERE id = ?")
      .get(session_id);

    if (!exists) {
      this.turns.delete(session_id);
      throw new Error(`Cannot commit: session ${session_id} does not exist`);
    }

    this.flushResponse(state);

    commitTurn(state.rowId, JSON.stringify(state.turn), session_id, token);

    this.turns.delete(session_id);
  }

  // Mark interrupted ('streaming') turns as aborted and attach what the user
  // needs to continue: a synthetic result for an orphaned tool call (so the
  // provider never chokes on a call without a result) and an error marker
  // (shown in red, excluded from LLM input by the existing filters).
  // Returns how many turns were recovered. Never auto-resumes execution.
  recoverInterruptedTurns(session_id) {
    assertSessionId(session_id);
    const rows = sql
      .prepare(
        "SELECT id, parts FROM turn WHERE session_id = ? AND status = 'streaming' ORDER BY id ASC",
      )
      .all(session_id);

    for (const row of rows) {
      let parts;
      try {
        parts = JSON.parse(row.parts);
        if (!Array.isArray(parts)) {
          parts = [];
        }
      } catch {
        parts = [];
      }

      const lastCallIndex = parts.findLastIndex(
        (event) => event?.role === EVENT.TOOL_CALL,
      );
      if (lastCallIndex !== -1) {
        const orphan = parts[lastCallIndex].content ?? {};
        const orphanId = getCallId(orphan);
        const answered = parts
          .slice(lastCallIndex + 1)
          .some(
            (event) =>
              event?.role === EVENT.TOOL_RESULT &&
              getCallId(event?.content) !== undefined &&
              getCallId(event?.content) === orphanId,
          );
        if (!answered) {
          parts.push({
            role: EVENT.TOOL_RESULT,
            content: {
              call_id: orphanId,
              name: orphan.name,
              result:
                "Tool execution was interrupted by a restart before it " +
                "finished. Re-run it if the result is still needed.",
            },
          });
        }
      }

      parts.push({
        role: EVENT.ERROR,
        content: {
          message:
            "Turn interrupted (gateway restarted or crashed). Showing the " +
            "last saved state — reply to continue from here.",
        },
      });

      sql
        .prepare("UPDATE turn SET parts = ?, status = 'aborted' WHERE id = ?")
        .run(JSON.stringify(parts), row.id);
    }

    return rows.length;
  }

  recoverAllInterruptedTurns() {
    const rows = sql
      .prepare(
        "SELECT DISTINCT session_id FROM turn WHERE status = 'streaming'",
      )
      .all();

    let recovered = 0;
    for (const row of rows) {
      recovered += this.recoverInterruptedTurns(row.session_id);
    }
    return recovered;
  }

  // retrieve the summary based on session_id
  getSummary(session_id = "") {
    assertSessionId(session_id);
    const row = sql
      .prepare("SELECT summary FROM session WHERE id = ?")
      .get(session_id);
    return row?.summary ?? null;
  }

  // save the comparison results to the database
  compact(session_id = "", summary = "") {
    assertSessionId(session_id);
    sql
      .prepare("UPDATE session SET summary = ? WHERE id = ?")
      .run(summary, session_id);
  }

  getConversation(session_id = "") {
    assertSessionId(session_id);
    const rows = sql
      .prepare(
        "SELECT id, parts FROM turn WHERE session_id = ? ORDER BY id ASC",
      )
      .all(session_id);

    const conversation = [];

    for (const row of rows) {
      let parts;
      try {
        parts = JSON.parse(row.parts);
      } catch {
        // One corrupt row must never take down the whole session history.
        console.warn(
          `[session-store] Skipping corrupt turn row id=${row.id} for session ${session_id}.`,
        );
        continue;
      }
      conversation.push(...parts);
    }

    return conversation;
  }

  pruneConversation(conversation = [], keepTurn = null) {
    if (!Number.isInteger(keepTurn) || keepTurn < 1) {
      return conversation;
    }

    const userIndexes = [];

    const lastCompactionIndex = conversation.findLastIndex(
      (event) => event.role === EVENT.COMPACTION,
    );

    if (lastCompactionIndex === -1) {
      return conversation;
    }

    for (let i = 0; i < lastCompactionIndex; i++) {
      if (conversation[i]?.role === EVENT.USER) {
        userIndexes.push(i);
      }
    }

    const keepUserIndexes = userIndexes.slice(-keepTurn);

    if (keepUserIndexes.length < keepTurn) {
      return conversation;
    }

    return conversation.slice(keepUserIndexes[0]);
  }

  listSessions() {
    return sql
      .prepare("SELECT * FROM session ORDER BY updated_at DESC, id DESC")
      .all();
  }

  createSession(name = null, initialPrompt = null) {
    const id = randomUUID();
    const finalName = name ?? `session-${id.slice(0, 8)}`;

    sql
      .prepare(
        "INSERT INTO session (id, name, initial_prompt) VALUES (?, ?, ?)",
      )
      .run(id, finalName, initialPrompt);
    return sql.prepare("SELECT * FROM session WHERE id = ?").get(id);
  }

  getSessionById(id) {
    assertSessionId(id);
    return sql.prepare("SELECT * FROM session WHERE id = ?").get(id);
  }

  getSessionInfo(id) {
    assertSessionId(id);
    return sql
      .prepare(
        "SELECT id, name, initial_prompt, token, created_at, updated_at FROM session WHERE id = ?",
      )
      .get(id);
  }

  renameSession(id, name) {
    assertSessionId(id);
    sql
      .prepare(
        "UPDATE session SET name = ?, updated_at = datetime('now','localtime') WHERE id = ?",
      )
      .run(name, id);
  }

  // Give a session that still carries its auto-generated name
  // ("session-xxxxxxxx") a permanent one from its first real prompt. A name
  // the user chose is never touched, and an empty prompt is a no-op.
  autoNameSession(id, prompt) {
    assertSessionId(id);
    if (typeof prompt !== "string" || prompt.trim() === "") {
      return false;
    }
    const row = sql
      .prepare("SELECT id, name FROM session WHERE id = ?")
      .get(id);
    if (!row || row.name !== `session-${row.id.slice(0, 8)}`) {
      return false;
    }
    this.renameSession(id, nameFromPrompt(prompt));
    return true;
  }

  deleteSession(id) {
    assertSessionId(id);
    sql.prepare("DELETE FROM session WHERE id = ?").run(id);
  }
}

export const sessionStore = new SessionStore();
