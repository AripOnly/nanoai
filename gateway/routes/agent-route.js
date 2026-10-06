// src/gateway/routes/chat-route.js

import { Router } from "express";
import { agentController } from "../controllers/agent-controller.js";

const agentRouter = Router();

agentRouter.post("/", agentController);

export { agentRouter };
