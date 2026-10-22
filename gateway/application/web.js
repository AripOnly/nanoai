// /gateway/application/web.js
//
// HTTP transport factory. The composition root (gateway/server.js) builds the
// runtime and passes it here; the app stays transport-only and keeps no
// process-wide singleton state.

import express from "express";
import cors from "cors";
import { sessionRouter } from "../routes/session-route.js";
import { settingsRouter } from "../routes/settings-route.js";
import { modelsRouter } from "../routes/models-route.js";
import { agentRouter } from "../routes/agent-route.js";
import { jobRouter } from "../routes/job-route.js";
import { skillRouter } from "../routes/skill-route.js";
import { systemRouter } from "../routes/system-route.js";
import { errorMiddleware } from "../middlewares/error-middleware.js";
import { authMiddleware } from "../middlewares/auth-middleware.js";
import { auditMiddleware } from "../middlewares/audit-middleware.js";
import { rateLimit } from "../middlewares/rate-limit-middleware.js";
import { ResponseError } from "../error/response-error.js";
import { EVENT } from "../../src/shared/event-type.js";
import { buildHealth } from "../service/health-service.js";
import { getOrigins, initOrigins } from "../auth/origins.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build the Express app for one runtime instance.
 *
 * @param {object} [options]
 * @param {object} [options.runtime] createRuntime() result; agent requests
 *   reach turns through app.locals.runtime.
 * @param {object} [options.jobs] durable job manager; reaches HTTP through
 *   app.locals.jobs and tools through the runtime.
 * @param {object} [options.skills] skill registry; reaches HTTP through
 *   app.locals.skills and the runtime through its turn view.
 * @param {object} [options.logger] structured logger for transport events.
 * @param {Function} [options.shutdown] graceful shutdown callback invoked by
 *   POST /api/v1/system/shutdown after the response is sent.
 */
export async function createApp({
  runtime,
  jobs = null,
  skills = null,
  logger = console,
  shutdown = null,
} = {}) {
  const app = express();
  app.locals.runtime = runtime;
  app.locals.jobs = jobs;
  app.locals.skills = skills;
  app.locals.logger = logger;
  app.locals.shutdown = shutdown;
  app.locals.shuttingDown = false;

  // First settings snapshot (and therefore the CORS list) must be ready before
  // requests arrive. Later changes are read from the live snapshot on each
  // request; there is no TTL.
  await initOrigins();

  app.use(
    cors({
      origin: (origin, callback) => {
        // No Origin header: curl, CLIs, and other non-browser clients.
        if (!origin || getOrigins().includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new ResponseError(403, `Origin not allowed: ${origin}`));
      },
      exposedHeaders: [
        "X-Settings-Revision",
        "X-Restart-Required",
        "X-Models-Revision",
        "X-Models-Error",
        "X-Skills-Revision",
        "X-Skills-Error",
      ],
    }),
  );
  // Audit first: it sits before the remaining middleware so even body-parser
  // rejections (e.g. 413) and auth failures (401) leave a trail. The entry is
  // written on response finish, when status and body are already known.
  app.use("/api", auditMiddleware);

  app.use(express.json({ limit: "1mb" }));

  // Public probe for process monitors. Liveness AND readiness: a 200 means
  // serving, a 503 means up but degraded (settings/database). No auth.
  app.get("/health", async (req, res, next) => {
    try {
      const health = await buildHealth({ jobs, skills });
      res.status(health.status === "ok" ? 200 : 503).send(health);
    } catch (error) {
      next(error);
    }
  });

  app.use("/api", authMiddleware);

  // Generous caps: a human never hits them, a runaway loop does.
  app.use("/api", rateLimit({ windowMs: 60_000, max: 300, scope: "api" }));

  app.use("/api/v1/session", sessionRouter);
  app.use("/api/v1/settings", settingsRouter);
  app.use("/api/v1/models", modelsRouter);
  app.use("/api/v1/agent", agentRouter);
  app.use("/api/v1/jobs", jobRouter);
  app.use("/api/v1/skills", skillRouter);
  app.use("/api/v1/system", systemRouter);

  // Web dashboard: served from the prebuilt client (npm run build:web) so that
  // `gateway start` activates API + web together with no dev server. Missing
  // build is a clear message, not a silent 404.
  {
    const distDir = path.join(__dirname, "..", "..", "apps", "web", "dist");
    const indexHtml = path.join(distDir, "index.html");
    if (fs.statSync(indexHtml, { throwIfNoEntry: false })?.isFile()) {
      app.use(express.static(distDir));
      // SPA fallback: client-side routes (/c/<session>, …) must survive a hard
      // refresh. Real files were already served above; every GET that is not an
      // API route resolves to index.html.
      app.use((req, res, next) => {
        if (req.method !== "GET" || req.path.startsWith("/api")) {
          return next();
        }
        // Looks like a missing asset (has a file extension)? Let it 404 as
        // JSON instead of returning the app shell with a 200.
        if (path.extname(req.path)) {
          return next();
        }
        res.sendFile(indexHtml);
      });
      logger?.info?.("Serving web dashboard", {
        event: "gateway.web.serving",
        directory: distDir,
      });
    } else {
      logger?.info?.("Web dashboard not built yet — run: npm run build:web", {
        event: "gateway.web.missing",
      });
    }
  }

  // Unknown routes get the same error envelope, not Express's HTML page.
  app.use((req, res) => {
    res.status(404).json({
      role: EVENT.ERROR,
      content: { message: `Route not found: ${req.method} ${req.path}` },
    });
  });

  app.use(errorMiddleware);

  return app;
}
