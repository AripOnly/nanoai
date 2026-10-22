// src/tools/delegate.js
//
// The model-facing door to a child session. This tool deliberately contains no
// session or agent imports: the runtime injects the delegate implementation
// into the tool context for primary agents only. A child agent never receives
// this tool, so delegation depth cannot grow beyond one.

export const delegateTool = Object.freeze({
  type: "function",
  name: "delegate",
  description: `Delegate one focused task to a read-only subagent with a fresh context.

The child receives only the task and the optional context you provide. It does
not inherit this conversation, its summary, or its loaded skills. Its full
transcript is stored in a separate child session; only a bounded final report
returns here.

Use this for independent exploration or research. Do not use it for work that
requires writing files, running shell commands, or relying on details from this
conversation without passing them in context.`,
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        enum: ["explore"],
        description: "Subagent to run. Currently only `explore` is available.",
      },
      task: {
        type: "string",
        description:
          "A self-contained task. The child cannot see this conversation.",
      },
      context: {
        type: "string",
        description:
          "Optional bounded information the child needs: file paths, snippets, constraints, or what has already been ruled out.",
      },
    },
    required: ["agent", "task"],
    additionalProperties: false,
  },
});

function failed(message) {
  return {
    status: "failed",
    summary: "",
    usage: null,
    childSessionId: null,
    error: message,
  };
}

export async function delegate(args = {}, context = {}) {
  if (typeof context.delegate !== "function") {
    return failed("Subagent delegation is not available for this agent.");
  }

  if (typeof args.agent !== "string" || args.agent.trim() === "") {
    return failed("Subagent agent must be a non-empty string.");
  }
  if (typeof args.task !== "string" || args.task.trim() === "") {
    return failed("Subagent task must be a non-empty string.");
  }
  if (
    args.context !== undefined &&
    args.context !== null &&
    typeof args.context !== "string"
  ) {
    return failed("Subagent context must be a string when provided.");
  }

  try {
    return await context.delegate(
      {
        agent: args.agent.trim(),
        task: args.task,
        context: args.context ?? null,
      },
      context,
    );
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}
