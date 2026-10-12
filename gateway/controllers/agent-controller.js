// gateway/controllers/agent-controller.js

import { agentService } from "../service/agent-service.js";
import { ResponseError } from "../error/response-error.js";
import { agents } from "../../src/agents/registry.js";

async function agentController(req, res, next) {
  try {
    const { name, prompt } = req.body ?? {};

    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new ResponseError(400, "prompt must be a non-empty string.");
    }

    if (typeof name !== "string" || !(name in agents)) {
      throw new ResponseError(
        400,
        `Unknown agent "${name}". Available agents: ${Object.keys(agents).join(", ")}.`,
      );
    }

    res.status(200);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    for await (const event of agentService({
      ...req.body,
    })) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  } catch (error) {
    // Validation failed before streaming started: let the error
    // middleware respond with the proper HTTP status code.
    if (!res.headersSent) {
      return next(error);
    }

    console.error("Error in chat controller:", error);
    try {
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ role: "error", content: { message: error.message } })}\n\n`,
        );
      }
    } catch {
      // Client already gone, ignore write errors.
    }
    try {
      if (!res.writableEnded) {
        res.end();
      }
    } catch {
      // Client already gone, ignore end errors.
    }
  }
}

export { agentController };
