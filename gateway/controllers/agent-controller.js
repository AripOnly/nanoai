// src/gateway/chat-controller.js

import { agentService } from "../service/agent-service.js";

async function agentController(req, res, next) {
  try {
    res.status(200);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    for await (const event of agentService(req.body)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  } catch (error) {
    console.error("Error in chat controller:", error);
  }
}

export { agentController };
