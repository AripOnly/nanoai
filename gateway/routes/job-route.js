// gateway/routes/job-route.js

import { Router } from "express";
import { jobController } from "../controllers/job-controller.js";

const jobRouter = Router();

jobRouter.get("/", jobController.listJobs);
jobRouter.get("/:job_id", jobController.getJob);
jobRouter.post("/:job_id/kill", jobController.killJob);
jobRouter.delete("/:job_id/log", jobController.removeLog);

export { jobRouter };
