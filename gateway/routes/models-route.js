// gateway/routes/models-route.js

import { Router } from "express";
import modelsController from "../controllers/models-controller.js";

const modelsRouter = Router();

modelsRouter.get("/", modelsController.listModels);

export { modelsRouter };
