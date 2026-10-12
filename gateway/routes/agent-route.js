// gateway/routes/agent-route.js

import { Router } from "express";
import { agentController } from "../controllers/agent-controller.js";
import { rateLimit } from "../middlewares/rate-limit-middleware.js";

const agentRouter = Router();

// Streaming agent runs accept POST only and cost LLM money, so they get the
// tightest rate window. Other methods fall through to the JSON 404 handler
// so API clients get a consistent envelope.
const agentLimiter = rateLimit({ windowMs: 60_000, max: 30, scope: "agent" });

agentRouter.post("/", agentLimiter, agentController);

export { agentRouter };
