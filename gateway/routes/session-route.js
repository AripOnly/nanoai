// gateway/routes/session-route.js

import { Router } from "express";
import sessionController from "../controllers/session-controller.js";

const sessionRouter = Router();

sessionRouter.post("/", sessionController.createSession);
sessionRouter.get("/list-session", sessionController.listSession);
sessionRouter.get("/:session_id", sessionController.getConversation);
sessionRouter.get("/info/:session_id", sessionController.getSessionInfo);
sessionRouter.put("/:session_id", sessionController.renameSession);
sessionRouter.delete("/:session_id", sessionController.deleteSession);

export { sessionRouter };
