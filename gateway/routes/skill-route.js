// gateway/routes/skill-route.js
//
// Skills are inspected and hot-reloaded here. Mutations stay in the CLI
// (`nanoai skills add|remove|update`) by design.

import { Router } from "express";
import { skillController } from "../controllers/skill-controller.js";

const skillRouter = Router();

skillRouter.get("/", skillController.listSkills);
skillRouter.post("/reload", skillController.reloadSkills);

export { skillRouter };
