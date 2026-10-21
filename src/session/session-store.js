// src/session/session-store.js

import sql from "./sql.js";
import { randomUUID } from "node:crypto";
import { EVENT } from "#src/shared/event-type.js";
import { getCallId } from "#src/shared/call-id.js";
import { nameFromPrompt } from "#src/shared/naming.js";

export { nameFromPrompt };

/**
 * Raised when a second turn tries to start on a session that already has a
 * live turn in this process. The gateway maps it to HTTP 409; the store guard
 * is the last line of defence against two writers racing the same history.
 */
export class SessionBusyError extends Error {
  constructor(session_id) {
    super(`Session ${session_id} already has an active turn.`);
    this.name = "SessionBusyError";
    this.code = "SESSION_BUSY";
    this.session_id = session_id;
  }
}

const TURN_STATUSES = new Set(["complete", "aborted", "error"]);

// Atomic turn finalize: the turn row and the session bookkeeping land
// together or not at all.
const commitTurn = sql.transaction(
  (rowId, parts, session_id, token, usage, status) => {
    sql
      .prepare(
        "UPDATE turn SET parts = ?, status = ?, usage = ? WHERE id = ?",
      )
      .run(parts, status, usage, rowId);

    sql
      .prepare(
        "UPDATE session SET updated_at = datetime('now','localtime'), token = COALESCE(?, token) WHERE id = ?",
      )
      .run(token, session_id);
  },
);

function assertSessionId(session_id) {
  if (typeof session_id !== "string" || session_id.trim() === "") {
    throw new Error("session_id must be a non-empty string.");
  }
}

function optionalString(value, field, { max = 256 } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) {
    throw new Error(`${field} must be at most ${max} characters.`);
  }
  return trimmed;
}

function requiredString(value, field, { max = 256 } = {}) {
  const normalized = optionalString(value, field, { max });
  if (normalized === null) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return normalized;
}

function parseJson(value, fallback) {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function replayResult(row) {
  return {
    id: Number(row.id),
    status: row.status,
    replayed: true,
    parts: Array.isArray(row.parts) ? row.parts : parseJson(row.parts, []),
    usage:
      row.usage && typeof row.usage === "object"
        ? row.usage
        : parseJson(row.usage, null),
    provider: row.provider ?? null,
    model: row.model ?? null,
    client_message_id: row.client_message_id ?? null,
    kind: row.kind ?? "chat",
    trigger_ref: row.trigger_ref ?? null,
  };
}

class SessionStore {
  constructor() {
    this.turns = new Map();
  }

  /** Is a turn for this session currently being produced in this process? */
  isActive(session_id) {
    return typeof session_id === "string" && this.turns.has(session_id);
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
  //
  // A client_message_id is an idempotency key scoped to the session. When the
  // same key arrives again, the existing turn is returned instead of inserting
  // a second row. The partial unique index in migration v4 is the final guard
  // for two writers racing the same key.
  start(session_id, event, input, options = {}) {
    assertSessionId(session_id);
    if (this.turns.has(session_id)) {
      throw new SessionBusyError(session_id);
    }

    const clientMessageId = optionalString(
      options.clientMessageId ?? options.client_message_id,
      "client_message_id",
    );
    const provider = optionalString(options.provider, "provider", { max: 64 });
    const model = optionalString(options.model, "model", { max: 256 });
    const kind = optionalString(options.turnKind ?? options.kind, "kind", {
      max: 32,
    }) ?? "chat";
    const triggerRef = optionalString(
      options.triggerRef ?? options.trigger_ref,
      "trigger_ref",
      { max: 128 },
    );
    const eventRole =
      typeof options.eventRole === "string" && options.eventRole.trim() !== ""
        ? options.eventRole.trim()
        : event;
    const eventContent =
      options.eventContent &&
      typeof options.eventContent === "object" &&
      !Array.isArray(options.eventContent)
        ? { text: input, ...options.eventContent }
        : { text: input };

    if (clientMessageId !== null) {
      const existing = this.findTurnByClientMessageId(
        session_id,
        clientMessageId,
      );
      if (existing) return replayResult(existing);
    }

    const turn = [
      {
        role: eventRole,
        content: eventContent,
      },
    ];

    let row;
    try {
      row = sql
        .prepare(
          `INSERT INTO turn
             (parts, session_id, status, client_message_id, provider, model,
              kind, trigger_ref)
           VALUES (?, ?, 'streaming', ?, ?, ?, ?, ?)`,
        )
        .run(
          JSON.stringify(turn),
          session_id,
          clientMessageId,
          provider,
          model,
          kind,
          triggerRef,
        );
    } catch (error) {
      // Another process/request may have inserted the key between the lookup
      // above and this INSERT. Return the winner, never a duplicate turn.
      if (
        clientMessageId !== null &&
        String(error?.code ?? "").startsWith("SQLITE_CONSTRAINT")
      ) {
        const existing = this.findTurnByClientMessageId(
          session_id,
          clientMessageId,
        );
        if (existing) return replayResult(existing);
      }
      throw error;
    }

    const turnId = Number(row.lastInsertRowid);
    this.turns.set(session_id, {
      rowId: turnId,
      turn,
      response: "",
    });

    return {
      id: turnId,
      status: "streaming",
      replayed: false,
      parts: turn,
      usage: null,
      provider,
      model,
      client_message_id: clientMessageId,
      kind,
      trigger_ref: triggerRef,
    };
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
    if (event.role === EVENT.JOB_UPDATE) return;
    if (event.role === EVENT.TURN_START) return;

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
  commit(session_id, token = null, usage = null, status = "complete") {
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

    const finalStatus = TURN_STATUSES.has(status) ? status : "complete";
    commitTurn(
      state.rowId,
      JSON.stringify(state.turn),
      session_id,
      token,
      usage === null || usage === undefined ? null : JSON.stringify(usage),
      finalStatus,
    );

    this.turns.delete(session_id);
  }

  // Mark interrupted ('streaming') turns as aborted and attach what the user
  // needs to continue: a synthetic result for an orphaned tool call (so the
  // provider never chokes on a call without a result) and an error marker
  // (shown in red, excluded from LLM input by the existing filters).
  // Returns how many turns were recovered. Never auto-resumes execution.
  recoverInterruptedTurns(session_id, { includeActive = false } = {}) {
    assertSessionId(session_id);
    const rows = sql
      .prepare(
        "SELECT id, parts FROM turn WHERE session_id = ? AND status = 'streaming' ORDER BY id ASC",
      )
      .all(session_id);

    // A live turn in this process is not "interrupted": skip it so a stray
    // recovery sweep can never abort the request that is still streaming.
    // Tests (and explicit crash simulations) may pass includeActive: true.
    const activeRowId = includeActive
      ? undefined
      : this.turns.get(session_id)?.rowId;

    let recovered = 0;
    for (const row of rows) {
      if (row.id === activeRowId) continue;

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

      // Drop the stale in-memory writer for a recovered row so the next
      // start() is not blocked by a turn that no longer exists as streaming.
      if (this.turns.get(session_id)?.rowId === row.id) {
        this.turns.delete(session_id);
      }
      recovered += 1;
    }

    return recovered;
  }

  recoverAllInterruptedTurns({ includeActive = false } = {}) {
    const rows = sql
      .prepare(
        "SELECT DISTINCT session_id FROM turn WHERE status = 'streaming'",
      )
      .all();

    let recovered = 0;
    for (const row of rows) {
      recovered += this.recoverInterruptedTurns(row.session_id, {
        includeActive,
      });
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

  /**
   * One page of conversation history, oldest-to-newest within the page.
   * Cursors are turn ids and paginate backwards (`id < before`) so a UI can
   * load older messages without skipping rows appended during the read.
   */
  getConversationPage(
    session_id = "",
    { limit = 50, before = null } = {},
  ) {
    assertSessionId(session_id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("limit must be an integer between 1 and 500.");
    }

    const cursor =
      before === null || before === undefined || before === ""
        ? null
        : Number(before);
    if (cursor !== null && (!Number.isInteger(cursor) || cursor < 1)) {
      throw new Error("before must be a positive turn id.");
    }

    const rows =
      cursor === null
        ? sql
            .prepare(
              "SELECT id, parts FROM turn WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            )
            .all(session_id, limit + 1)
        : sql
            .prepare(
              "SELECT id, parts FROM turn WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
            )
            .all(session_id, cursor, limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const nextCursor =
      hasMore && page.length > 0 ? String(page[page.length - 1].id) : null;

    const events = [];
    for (const row of page.reverse()) {
      const parts = parseJson(row.parts, null);
      if (!Array.isArray(parts)) {
        console.warn(
          `[session-store] Skipping corrupt turn row id=${row.id} for session ${session_id}.`,
        );
        continue;
      }
      events.push(...parts);
    }

    return {
      events,
      next_cursor: nextCursor,
      has_more: hasMore,
    };
  }

  findTurnByClientMessageId(session_id, clientMessageId) {
    assertSessionId(session_id);
    const key = requiredString(clientMessageId, "client_message_id");
    const row = sql
      .prepare(
        `SELECT id, parts, status, usage, provider, model, client_message_id,
                kind, trigger_ref
           FROM turn
          WHERE session_id = ? AND client_message_id = ?`,
      )
      .get(session_id, key);
    if (!row) return undefined;
    return {
      ...row,
      parts: parseJson(row.parts, []),
      usage: parseJson(row.usage, null),
    };
  }

  getTurn(turnId) {
    const id = Number(turnId);
    if (!Number.isInteger(id) || id < 1) {
      throw new Error("turn_id must be a positive integer.");
    }
    const row = sql
      .prepare(
        `SELECT id, session_id, parts, status, usage, provider, model,
                client_message_id, kind, trigger_ref, created_at
           FROM turn WHERE id = ?`,
      )
      .get(id);
    if (!row) return undefined;
    return {
      ...row,
      parts: parseJson(row.parts, []),
      usage: parseJson(row.usage, null),
    };
  }

  listTurns(session_id, { limit = 100, before = null } = {}) {
    assertSessionId(session_id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("limit must be an integer between 1 and 500.");
    }
    const cursor =
      before === null || before === undefined || before === ""
        ? null
        : Number(before);
    if (cursor !== null && (!Number.isInteger(cursor) || cursor < 1)) {
      throw new Error("before must be a positive turn id.");
    }

    const rows =
      cursor === null
        ? sql
            .prepare(
              `SELECT id, status, usage, provider, model, client_message_id,
                      kind, trigger_ref, created_at
                 FROM turn WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
            )
            .all(session_id, limit)
        : sql
            .prepare(
              `SELECT id, status, usage, provider, model, client_message_id,
                      kind, trigger_ref, created_at
                 FROM turn WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
            )
            .all(session_id, cursor, limit);

    return rows.map((row) => ({
      ...row,
      usage: parseJson(row.usage, null),
    }));
  }

  setTurnModel(turnId, provider, model) {
    const id = Number(turnId);
    if (!Number.isInteger(id) || id < 1) {
      throw new Error("turn_id must be a positive integer.");
    }
    const nextProvider = optionalString(provider, "provider", { max: 64 });
    const nextModel = optionalString(model, "model", { max: 256 });
    sql
      .prepare("UPDATE turn SET provider = ?, model = ? WHERE id = ?")
      .run(nextProvider, nextModel, id);
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

  createSession(nameOrOptions = null, initialPrompt = null) {
    const options =
      nameOrOptions !== null &&
      typeof nameOrOptions === "object" &&
      !Array.isArray(nameOrOptions)
        ? nameOrOptions
        : { name: nameOrOptions, initialPrompt };

    const id = randomUUID();
    const finalName =
      optionalString(options.name, "name", { max: 200 }) ??
      `session-${id.slice(0, 8)}`;
    const channel = optionalString(options.channel, "channel", { max: 64 });
    const externalRef = optionalString(
      options.externalRef ?? options.external_ref,
      "external_ref",
      { max: 256 },
    );
    const parentSessionId = optionalString(
      options.parentSessionId ?? options.parent_session_id,
      "parent_session_id",
    );
    const kind =
      optionalString(options.kind, "kind", { max: 32 }) ?? "chat";
    const model = optionalString(options.model, "model", { max: 256 });

    sql
      .prepare(
        `INSERT INTO session
           (id, name, initial_prompt, channel, external_ref,
            parent_session_id, kind, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        finalName,
        options.initialPrompt ?? options.prompt ?? initialPrompt ?? null,
        channel,
        externalRef,
        parentSessionId,
        kind,
        model,
      );
    return sql.prepare("SELECT * FROM session WHERE id = ?").get(id);
  }

  /**
   * Resolve a channel identity to its session, creating it on first contact.
   * The unique partial index makes this safe if two channel adapters race.
   */
  resolveSession({ channel, externalRef, model = null } = {}) {
    const nextChannel = requiredString(channel, "channel", { max: 64 });
    const nextExternalRef = requiredString(externalRef, "external_ref", {
      max: 256,
    });

    const find = () =>
      sql
        .prepare(
          "SELECT * FROM session WHERE channel = ? AND external_ref = ?",
        )
        .get(nextChannel, nextExternalRef);

    const existing = find();
    if (existing) return existing;

    try {
      return this.createSession({
        channel: nextChannel,
        externalRef: nextExternalRef,
        model,
      });
    } catch (error) {
      if (String(error?.code ?? "").startsWith("SQLITE_CONSTRAINT")) {
        const winner = find();
        if (winner) return winner;
      }
      throw error;
    }
  }

  getSessionById(id) {
    assertSessionId(id);
    return sql.prepare("SELECT * FROM session WHERE id = ?").get(id);
  }

  getSessionInfo(id) {
    assertSessionId(id);
    return sql
      .prepare(
        `SELECT id, name, initial_prompt, token, channel, external_ref,
                parent_session_id, kind, model, created_at, updated_at
           FROM session WHERE id = ?`,
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

  setSessionModel(id, model) {
    assertSessionId(id);
    const nextModel =
      model === null || model === undefined
        ? null
        : requiredString(model, "model", { max: 256 });
    sql.prepare("UPDATE session SET model = ? WHERE id = ?").run(nextModel, id);
    return this.getSessionById(id);
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
    this.turns.delete(id);
  }
}

export const sessionStore = new SessionStore();
