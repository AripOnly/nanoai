// src/runtime/subagent.js
//
// Child-session execution for `delegate`. A subagent is a separate session:
// it receives only the delegated task and optional explicit context, keeps its
// own transcript/token accounting, and returns one bounded report to the
// parent. It never inherits the parent's conversation or compaction summary.
//
// The runner is dependency-injected with runTurn() so tests can exercise the
// lifecycle without a provider or database. The runtime composition root wires
// the real turn runner and session door.

import { EVENT } from "#src/shared/event-type.js";
import { toolNamesFor } from "#src/agents/index.js";
import { getAgentDefinition } from "#src/agents/registry.js";

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 300_000;
export const MAX_SUBAGENT_TASK_BYTES = 16 * 1024;
export const MAX_SUBAGENT_CONTEXT_BYTES = 16 * 1024;
export const MAX_SUBAGENT_SUMMARY_BYTES = 16 * 1024;

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

function addUsage(usage, content) {
  if (!content || typeof content !== "object") return;
  usage.requests += 1;
  for (const field of USAGE_FIELDS) {
    const value = content[field];
    if (Number.isFinite(value)) {
      usage[field] = (usage[field] ?? 0) + value;
    }
  }
}

function finalizedUsage(usage) {
  return usage.requests > 0 ? { ...usage } : null;
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value, maxBytes, marker = "\n\n[truncated]") {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (byteLength(text) <= maxBytes) return text;

  const room = Math.max(0, maxBytes - byteLength(marker));
  let end = Math.min(text.length, room);
  while (end > 0 && byteLength(text.slice(0, end)) > room) end -= 1;
  return `${text.slice(0, end)}${marker}`;
}

function failed(message, childSessionId = null) {
  return {
    status: "failed",
    summary: "",
    usage: null,
    childSessionId,
    error: message,
  };
}

function allowedToolNames(definition, parentAllowedTools) {
  const names = toolNamesFor(definition).filter((name) => name !== "delegate");
  if (parentAllowedTools == null) return names;

  const allowed = parentAllowedTools;
  return names.filter((name) => {
    if (typeof allowed.has === "function") return allowed.has(name);
    if (Array.isArray(allowed)) return allowed.includes(name);
    return false;
  });
}

function childPrompt(task, context) {
  const parts = [task];
  if (typeof context === "string" && context.trim() !== "") {
    parts.push(
      "---\n\n# Context from the parent\n\n" +
        "This is the only parent-provided context. Do not assume access to the " +
        "parent's conversation or summary.\n\n" +
        context.trim(),
    );
  }
  return parts.join("\n\n");
}

/**
 * Create a runner with a fresh child session per delegate call.
 *
 * @param {object} options
 * @param {object} options.session       session door (createSession required)
 * @param {Function} options.runTurn     runtime turn runner
 * @param {object} options.deps          dependencies passed to the child turn
 * @param {number} [options.timeoutMs]   hard child-turn timeout
 * @param {number} [options.maxTaskBytes]
 * @param {number} [options.maxContextBytes]
 * @param {number} [options.maxSummaryBytes]
 * @param {object} [options.logger]
 */
export function createSubagentRunner({
  session,
  runTurn,
  deps,
  timeoutMs = DEFAULT_SUBAGENT_TIMEOUT_MS,
  maxTaskBytes = MAX_SUBAGENT_TASK_BYTES,
  maxContextBytes = MAX_SUBAGENT_CONTEXT_BYTES,
  maxSummaryBytes = MAX_SUBAGENT_SUMMARY_BYTES,
  logger = console,
} = {}) {
  if (!session || typeof session.createSession !== "function") {
    throw new TypeError("createSubagentRunner requires options.session.");
  }
  if (typeof runTurn !== "function") {
    throw new TypeError("createSubagentRunner requires options.runTurn.");
  }
  if (!deps || typeof deps !== "object") {
    throw new TypeError("createSubagentRunner requires options.deps.");
  }

  return async function runSubagent(input = {}, parentContext = {}) {
    const agent = input.agent;
    const definition = getAgentDefinition(agent);
    if (
      !definition ||
      definition.mode !== "subagent" ||
      definition.delegatable !== true
    ) {
      return failed(`Unknown or non-delegatable subagent "${String(agent)}".`);
    }

    const depth = Number.isInteger(parentContext.depth)
      ? parentContext.depth
      : 0;
    if (depth >= 1) {
      return failed("Subagent delegation depth is limited to 1.");
    }

    if (typeof input.task !== "string" || input.task.trim() === "") {
      return failed("Subagent task must be a non-empty string.");
    }
    if (byteLength(input.task) > maxTaskBytes) {
      return failed(
        `Subagent task exceeds the ${maxTaskBytes}-byte limit.`,
      );
    }

    const context =
      input.context == null
        ? null
        : typeof input.context === "string"
          ? input.context
          : null;
    if (input.context != null && context === null) {
      return failed("Subagent context must be a string when provided.");
    }
    if (context !== null && byteLength(context) > maxContextBytes) {
      return failed(
        `Subagent context exceeds the ${maxContextBytes}-byte limit.`,
      );
    }

    if (parentContext.signal?.aborted) {
      return {
        status: "aborted",
        summary: "",
        usage: null,
        childSessionId: null,
        error: "Subagent was aborted before it started.",
      };
    }

    let child;
    try {
      child = session.createSession({
        name: `explore: ${input.task.trim().replace(/\s+/g, " ").slice(0, 80)}`,
        prompt: null,
        kind: "subagent",
        parentSessionId: parentContext.parentSessionId ?? null,
        model: parentContext.model ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failed(`Could not create the subagent session: ${message}`);
    }

    if (!child?.id) {
      return failed("The subagent session could not be created.");
    }

    const onUpdate =
      typeof parentContext.onUpdate === "function"
        ? parentContext.onUpdate
        : null;
    const emit = (role, content) => {
      if (!onUpdate) return;
      try {
        onUpdate({ role, content });
      } catch (error) {
        logger.warn?.(
          `[runtime] subagent update failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };

    emit(EVENT.SUBAGENT_START, {
      child_session_id: child.id,
      parent_session_id: parentContext.parentSessionId ?? null,
      agent,
      task_preview: truncateUtf8(input.task, 400),
      status: "running",
    });

    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    let failedTurn = false;
    let errorMessage = "";
    let assistantText = "";
    const usage = createUsage();

    const abortChild = (reason) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const onParentAbort = () =>
      abortChild(
        parentContext.signal?.reason ??
          Object.assign(new Error("Parent turn was aborted."), {
            name: "AbortError",
          }),
      );

    if (parentContext.signal) {
      parentContext.signal.addEventListener("abort", onParentAbort, {
        once: true,
      });
      // Close the race between the preflight check and listener registration.
      if (parentContext.signal.aborted) onParentAbort();
    }

    if (Number.isInteger(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        abortChild(
          Object.assign(
            new Error(`Subagent timed out after ${timeoutMs}ms.`),
            { name: "TimeoutError" },
          ),
        );
      }, timeoutMs);
    }

    try {
      const childDeps = { ...deps, subagent: null };
      const stream = runTurn({
        name: agent,
        prompt: childPrompt(input.task, context),
        session_id: child.id,
        model: parentContext.model ?? null,
        allowSubagent: true,
        policy: parentContext.policy ?? null,
        allowedTools: allowedToolNames(
          definition,
          parentContext.allowedTools,
        ),
        signal: controller.signal,
        turnKind: "chat",
        deps: childDeps,
      });

      for await (const event of stream) {
        if (event?.role === EVENT.ASSISTANT) {
          assistantText += event.content?.text ?? "";
          continue;
        }

        if (event?.role === EVENT.TOKEN) {
          addUsage(usage, event.content);
          continue;
        }

        if (event?.role === EVENT.ERROR) {
          failedTurn = true;
          errorMessage =
            event.content?.message ?? "The subagent returned an error.";
          continue;
        }

        if (event?.role === EVENT.TOOL_CALL) {
          emit(EVENT.SUBAGENT_UPDATE, {
            child_session_id: child.id,
            agent,
            status: "tool_started",
            tool: event.content?.name ?? null,
            child_call_id: event.content?.call_id ?? null,
          });
          continue;
        }

        if (event?.role === EVENT.TOOL_RESULT) {
          const result = event.content?.result;
          emit(EVENT.SUBAGENT_UPDATE, {
            child_session_id: child.id,
            agent,
            status:
              result?.success === false ? "tool_failed" : "tool_completed",
            tool: event.content?.name ?? null,
            child_call_id: event.content?.call_id ?? null,
          });
          continue;
        }

        if (event?.role === EVENT.TOOL_UPDATE) {
          emit(EVENT.SUBAGENT_UPDATE, {
            child_session_id: child.id,
            agent,
            status: "tool_progress",
            tool: event.content?.name ?? null,
            child_call_id: event.content?.call_id ?? null,
            preview: truncateUtf8(event.content?.preview ?? "", 1000),
          });
        }
      }
    } catch (error) {
      failedTurn = true;
      errorMessage = error instanceof Error ? error.message : String(error);
      logger.error?.("[runtime] subagent turn failed:", errorMessage);
    } finally {
      if (timer) clearTimeout(timer);
      if (parentContext.signal) {
        parentContext.signal.removeEventListener("abort", onParentAbort);
      }
    }

    const parentAborted = parentContext.signal?.aborted === true;
    const status = parentAborted
      ? "aborted"
      : timedOut || failedTurn
        ? "failed"
        : "completed";

    if (status === "failed" && errorMessage === "") {
      errorMessage = timedOut
        ? `Subagent timed out after ${timeoutMs}ms.`
        : "The subagent failed before returning a report.";
    }

    let summary = assistantText.trim();
    if (summary === "" && status === "completed") {
      summary = "The subagent completed without a final report.";
    } else if (summary === "" && status !== "completed") {
      summary = errorMessage;
    }
    summary = truncateUtf8(summary, maxSummaryBytes);

    const finalUsage = finalizedUsage(usage);
    const result = {
      status,
      summary,
      usage: finalUsage,
      childSessionId: child.id,
    };
    if (status !== "completed") {
      result.error =
        status === "aborted"
          ? "Subagent was aborted."
          : truncateUtf8(errorMessage, 2000);
    }

    emit(EVENT.SUBAGENT_END, {
      child_session_id: child.id,
      agent,
      status,
      usage: finalUsage,
      summary: truncateUtf8(summary, 4000),
    });

    return result;
  };
}
