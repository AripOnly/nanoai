// gateway/routes/settings-route.js

import { Router } from "express";
import settingsController from "../controllers/settings-controller.js";

const settingsRouter = Router();

settingsRouter.get("/", settingsController.getSettings);
settingsRouter.put("/", settingsController.updateSettings);
settingsRouter.get("/providers", settingsController.listProviders);

export { settingsRouter };
