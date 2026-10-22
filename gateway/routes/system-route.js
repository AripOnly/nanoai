// gateway/routes/system-route.js

import { Router } from "express";
import { systemController } from "../controllers/system-controller.js";

const systemRouter = Router();

systemRouter.post("/shutdown", systemController.shutdown);

export { systemRouter };
