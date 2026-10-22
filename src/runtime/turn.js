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
import {
  getAgent,
  listAgentNames,
  toolNamesFor,
} from "#src/agents/index.js";
import { getAgentDefinition } from "#src/agents/registry.js";
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

function unknownAgentMessage(name) {
  const internal = getAgentDefinition(name);
  if (internal?.mode === "subagent") {
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

const USAGE_FIELDS = Object.freeze([
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cached_tokens",
  "reasoning_tokens",
]);

function createUsage() {
  return {
    requests: 0,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cached_tokens: null,
    reasoning_tokens: null,
  };
}

/** Sum provider step usage across the whole turn (one turn may have many calls). */
function addUsage(usage, content) {
  if (!content || typeof content !== "object") return usage;
  usage.requests += 1;
  for (const field of USAGE_FIELDS) {
    const value = content[field];
    if (Number.isFinite(value)) {
      usage[field] = (usage[field] ?? 0) + value;
    }
  }
  return usage;
}

function finalizedUsage(usage) {
  return usage && usage.requests > 0 ? { ...usage } : null;
}

function turnStartEvent({
  turnId = null,
  sessionId,
  replayed = false,
  provider = null,
  model = null,
}) {
  return {
    role: EVENT.TURN_START,
    content: {
      turn_id: turnId,
      session_id: sessionId,
      replayed,
      provider,
      model,
    },
  };
}

/**
 * Replay an already persisted turn for a retry with the same client message
 * id. User text is omitted because the caller already has its own copy; tokens
 * are re-emitted from the stored per-turn accounting.
 */
function* replayTurn(existing, sessionId) {
  yield turnStartEvent({
    turnId: existing.id,
    sessionId,
    replayed: true,
    provider: existing.provider ?? null,
    model: existing.model ?? null,
  });

  const parts = Array.isArray(existing.parts) ? existing.parts : [];
  for (const event of parts) {
    if (
      event?.role === EVENT.USER ||
      event?.role === EVENT.TOKEN ||
      event?.role === EVENT.TOOL_UPDATE ||
      event?.role === EVENT.JOB_UPDATE ||
      event?.role === EVENT.SUBAGENT_START ||
      event?.role === EVENT.SUBAGENT_UPDATE ||
      event?.role === EVENT.SUBAGENT_END ||
      event?.role === EVENT.TURN_START
    ) {
      continue;
    }
    yield event;
  }

  const usage = existing.usage;
  if (usage && typeof usage === "object") {
    const content = {};
    for (const field of USAGE_FIELDS) {
      if (Number.isFinite(usage[field])) content[field] = usage[field];
    }
    if (Object.keys(content).length > 0) {
      yield { role: EVENT.TOKEN, content };
    }
  }
}

function visibleInput(conversation) {
  return conversation.filter(
    (event) =>
      event?.role !== EVENT.ERROR &&
      event?.role !== EVENT.COMPACTION &&
      event?.role !== EVENT.TOOL_UPDATE &&
      event?.role !== EVENT.JOB_UPDATE &&
      event?.role !== EVENT.JOB_NOTICE &&
      event?.role !== EVENT.SUBAGENT_START &&
      event?.role !== EVENT.SUBAGENT_UPDATE &&
      event?.role !== EVENT.SUBAGENT_END &&
      event?.role !== EVENT.TURN_START,
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
    // Nested capability: background jobs can only ever be narrowed, never
    // granted by a caller's policy.
    shell: {
      background:
        definitionPolicy.shell?.background === true &&
        policy.shell?.background !== false,
    },
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
  agentName,
  prompt,
  session_id,
  sessionId,
  channel,
  external_ref,
  externalRef,
  client_message_id,
  clientMessageId,
  model,
  modelRef,
  signal,
  allowedTools,
  policy,
  turnKind,
  triggerRef,
  jobNotice,
  allowSubagent = false,
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
  let turnId = null;
  let failed = false;
  let idempotencyKey = clientMessageId ?? client_message_id ?? null;
  let requestedModel = modelRef ?? model ?? null;
  let targetChannel = channel ?? null;
  let targetExternalRef = externalRef ?? external_ref ?? null;
  const usage = createUsage();
  const kind = turnKind ?? "chat";
  const notice =
    typeof jobNotice === "string" && jobNotice.trim() !== ""
      ? jobNotice.trim()
      : null;

  // Accept the HTTP snake_case names and the internal camelCase names. The
  // old `name`/`session_id` call shape remains valid for existing callers.
  name = agentName ?? name;
  session_id = sessionId ?? session_id;

  try {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error("prompt must be a non-empty string.");
    }
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("agent name must be a non-empty string.");
    }
    if (kind !== "chat" && kind !== "job") {
      throw new Error('turnKind must be "chat" or "job".');
    }
    if (kind === "job" && notice === null) {
      throw new Error("jobNotice is required for a job turn.");
    }
    if (idempotencyKey !== null) {
      if (
        typeof idempotencyKey !== "string" ||
        idempotencyKey.trim() === ""
      ) {
        throw new Error("client_message_id must be a non-empty string.");
      }
      idempotencyKey = idempotencyKey.trim();
    }
    if (requestedModel !== null) {
      if (typeof requestedModel !== "string") {
        throw new Error("model must be a string.");
      }
      requestedModel = requestedModel.trim();
      if (requestedModel === "") {
        throw new Error("model must be a non-empty string.");
      }
      if (requestedModel.length > 256) {
        throw new Error("model must be at most 256 characters.");
      }
    }

    const hasExplicitSession =
      session_id !== undefined && session_id !== null;

    if (hasExplicitSession) {
      if (
        typeof session_id !== "string" ||
        session_id.trim() === ""
      ) {
        throw new Error("session_id must be a non-empty string.");
      }
      if (targetChannel !== null || targetExternalRef !== null) {
        throw new Error(
          "Provide either session_id or channel + external_ref, not both.",
        );
      }
    } else if (
      typeof targetChannel !== "string" ||
      targetChannel.trim() === "" ||
      typeof targetExternalRef !== "string" ||
      targetExternalRef.trim() === ""
    ) {
      throw new Error("session_id or channel + external_ref is required.");
    }

    // Validate the agent and the aborted signal before resolving a channel
    // identity: a rejected request must not create a session as a side effect.
    // Child turns run internal subagents. This flag is never set by a gateway
    // door; only the subagent runner can request a non-public definition.
    const definition = allowSubagent ? getAgentDefinition(name) : getAgent(name);
    if (!definition || (allowSubagent && definition.mode !== "subagent")) {
      throw new Error(unknownAgentMessage(name));
    }

    if (abortRequested(signal)) return;

    if (!hasExplicitSession) {
      if (typeof session.resolveSession !== "function") {
        throw new Error("Session door does not support channel resolution.");
      }
      const resolved = session.resolveSession({
        channel: targetChannel,
        externalRef: targetExternalRef,
      });
      if (!resolved?.id) {
        throw new Error("Session resolver returned no session.");
      }
      session_id = resolved.id;
    }

    if (!session.getSession(session_id)) {
      throw new Error(`Session ${session_id} not found`);
    }

    if (session.isSessionBusy(session_id)) {
      throw new SessionBusyError(session_id);
    }

    // A previous process may have died mid-stream. Mark that partial turn as
    // aborted before reserving the session for this one.
    session.recoverInterruptedTurn(session_id);

    // Duplicate client message: return the existing turn instead of creating
    // another one. A live duplicate still takes the single-flight path above.
    if (
      idempotencyKey !== null &&
      typeof session.findTurnByClientMessageId === "function"
    ) {
      const existing = session.findTurnByClientMessageId(
        session_id,
        idempotencyKey,
      );
      if (existing) {
        yield* replayTurn(existing, session_id);
        return;
      }
    }

    const before = session.getSession(session_id) ?? {};
    let summary = before.summary ?? null;
    let conversation = session.getConversation(session_id) ?? [];
    token = before.token ?? 0;

    // Reserve the session first: the prompt is durable from here on and a
    // concurrent turn fails before doing model work.
    const started = session.beginTurn(session_id, prompt, {
      clientMessageId: idempotencyKey,
      provider: null,
      model: before.model ?? null,
      turnKind: kind,
      triggerRef: triggerRef ?? null,
      eventRole: kind === "job" ? EVENT.JOB_NOTICE : EVENT.USER,
      eventContent:
        kind === "job"
          ? { text: prompt, job_id: triggerRef ?? null }
          : undefined,
    });
    if (started?.replayed) {
      yield* replayTurn(started, session_id);
      return;
    }
    began = true;
    turnId = Number.isInteger(started?.id) ? started.id : null;
    if (kind !== "job") {
      session.autoNameSession(session_id, prompt);
    }

    yield turnStartEvent({
      turnId,
      sessionId: session_id,
      replayed: false,
      provider: null,
      model: requestedModel ?? before.model ?? null,
    });

    if (abortRequested(signal)) return;

    const config = getConfig() ?? {};
    const catalog = typeof getCatalog === "function" ? getCatalog() : null;
    const currentSession = session.getSession(session_id) ?? before;
    const effectiveModelRef =
      requestedModel ?? currentSession.model ?? config.model;
    const modelHandle = await resolveModel({
      config,
      catalog,
      modelRef: effectiveModelRef,
      requiredCapabilities: ["streaming", "toolCalling"],
    });
    if (!modelHandle?.adapter || !modelHandle?.model) {
      throw new Error("Model resolver returned an incomplete handle.");
    }

    if (
      turnId !== null &&
      typeof session.setTurnModel === "function"
    ) {
      session.setTurnModel(
        turnId,
        modelHandle.providerId ?? null,
        modelHandle.modelId ?? null,
      );
    }

    // Persist an explicit model only after the resolver accepted it. A bad
    // model ref must fail the turn without pinning the session to a broken
    // override for every later turn.
    if (
      requestedModel !== null &&
      typeof session.setSessionModel === "function"
    ) {
      session.setSessionModel(session_id, requestedModel);
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

        if (event.role === EVENT.TOKEN) {
          addUsage(usage, event.content);
        }

        if (event.role === EVENT.ERROR) {
          // The compaction request failed. Do not send the oversized history
          // anyway; persist the provider error, surface it, and close the turn.
          failed = true;
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

    // A job notice lives in the system instruction and the persisted
    // JOB_NOTICE event, never in the provider's conversation input. The turn
    // itself still exists so the UI can show what woke the agent.
    if (kind !== "job") {
      conversation.push({ role: EVENT.USER, content: { text: prompt } });
    }

    const canDelegate =
      definition.mode === "primary" && typeof deps.subagent === "function";
    const definitionTools = toolNamesFor(definition).filter(
      (tool) => tool !== "delegate" || canDelegate,
    );
    const effectivePolicy = mergePolicy(definition.policy, policy);
    const effectiveAllowedTools = Array.isArray(allowedTools)
      ? definitionTools.filter((tool) => allowedTools.includes(tool))
      : definitionTools;

    // Skill tools are a runtime capability, not an agent-level guarantee.
    // Only advertise them when this turn actually has a usable skill view.
    const nonSkillTools = effectiveAllowedTools.filter(
      (tool) => tool !== "loadSkill" && tool !== "searchSkills",
    );
    let skillView = null;
    if (deps.skills?.turnView) {
      try {
        const view = deps.skills.turnView({
          agentSkills: definition.skills ?? [],
          allowedTools: nonSkillTools,
          settings: config.skills ?? null,
        });
        if (view?.enabled) skillView = view;
      } catch (error) {
        logger.warn?.(
          `[runtime] skills are unavailable for this turn: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const turnAllowedTools = skillView ? effectiveAllowedTools : nonSkillTools;
    const delegateToSubagent = canDelegate
      ? (input, toolContext = {}) =>
          deps.subagent(input, {
            parentSessionId: session_id,
            parentTurnId: turnId,
            parentAgent: name,
            model: effectiveModelRef,
            policy: effectivePolicy,
            allowedTools: turnAllowedTools,
            depth: 0,
            signal,
            onUpdate: toolContext.onUpdate,
            logger,
          })
      : null;
    const autoSkills = skillView
      ? skillView.autoLoad(prompt)
      : { skill: null, content: "", hints: [] };

    const instruction = await createInstruction(definition.instruction, {
      summary,
      username: config.username,
      jobNotice: kind === "job" ? notice : null,
      skillCatalog: skillView?.catalog ?? "",
      skillAutoLoad: autoSkills.content || null,
      skillHints: autoSkills.hints,
    });

    // Prune with the compaction marker still present, then strip UI-only
    // events before handing history to the provider. Filtering first would
    // hide the marker and silently defeat compaction.
    const input = visibleInput(
      pruneConversation(conversation, keepTurn),
    );

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
          if (event.role === EVENT.TOKEN) {
            addUsage(usage, event.content);
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
      tools: tools.schemasFor(turnAllowedTools),
      policy: effectivePolicy,
      allowedTools: turnAllowedTools,
      signal,
      session_id,
      jobs: deps.jobs ?? null,
      sentAttachments: collectAttachmentIds(input),
      executeTool: (toolCall, context = {}) =>
        executeTool(toolCall, {
          ...context,
          skills: skillView,
          delegate: delegateToSubagent,
        }),
      requestCompaction,
    };

    for await (const event of agentLoop(request)) {
      session.recordEvent(session_id, event);

      if (event.role === EVENT.ERROR) failed = true;
      if (event.role === EVENT.TOKEN) {
        addUsage(usage, event.content);
        if (Number.isFinite(event.content?.total_tokens)) {
          token = event.content.total_tokens;
        }
      }

      yield event;
    }
  } catch (error) {
    // Busy sessions are transport-level: the gateway maps this to 409 without
    // turning it into an in-stream error event.
    if (error instanceof SessionBusyError) throw error;
    if (abortRequested(signal)) return;

    failed = true;
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
      const status = abortRequested(signal)
        ? "aborted"
        : failed
          ? "error"
          : "complete";
      try {
        session.commitTurn(
          session_id,
          token,
          finalizedUsage(usage),
          status,
        );
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
