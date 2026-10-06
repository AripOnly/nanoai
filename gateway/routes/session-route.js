// gateway/routes/session-route.js

import { Router } from "express";
import sessionController from "../controllers/session-controller.js";

const sessionRouter = Router();

sessionRouter.post("/", sessionController.createSession);
sessionRouter.get("/list-session", sessionController.listSession);
sessionRouter.get("/:session_id", sessionController.getHistory);
sessionRouter.get("/info/:session_id", sessionController.getSessionInfo);

export { sessionRouter };
