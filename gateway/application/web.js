// /gateway/application/web.js

import express from "express";
import cors from "cors";
import { sessionRouter } from "../routes/session-route.js";
import { agentController } from "../controllers/agent-controller.js";
import { errorMiddleware } from "../middlewares/error-middleware.js";

export const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/v1/session", sessionRouter);
app.use("/api/v1/agent", agentController);

app.use(errorMiddleware);
