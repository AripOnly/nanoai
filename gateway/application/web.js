// /gateway/application/web.js

import express from "express";
import cors from "cors";
import { sessionRouter } from "../routes/session-route.js";
import { settingsRouter } from "../routes/settings-route.js";
import { agentRouter } from "../routes/agent-route.js";
import { errorMiddleware } from "../middlewares/error-middleware.js";
import { authMiddleware } from "../middlewares/auth-middleware.js";
import { auditMiddleware } from "../middlewares/audit-middleware.js";
import { rateLimit } from "../middlewares/rate-limit-middleware.js";
import { ResponseError } from "../error/response-error.js";
import { settings } from "../../src/config/config.js";
import { buildHealth } from "../service/health-service.js";
import { setOrigins, getOrigins } from "../auth/origins.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();

async function resolveOrigins() {
  const fromEnv = (process.env.NANO_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  let fromSettings = [];
  try {
    const stored = await settings.get("cors_origins");
    if (Array.isArray(stored)) {
      fromSettings = stored;
    }
  } catch {
    fromSettings = [];
  }

  return [...new Set([...fromEnv, ...fromSettings])];
}

setOrigins(await resolveOrigins());

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
    const health = await buildHealth();
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
app.use("/api/v1/agent", agentRouter);

// Web dashboard: served from the prebuilt client (npm run build:web) so that
// `gateway start` activates API + web together with no dev server. Missing
// build is a clear message, not a silent 404.
{
  const distDir = path.join(__dirname, "..", "..", "apps", "web", "dist");
  const indexHtml = path.join(distDir, "index.html");
  if (fs.statSync(indexHtml, { throwIfNoEntry: false })?.isFile()) {
    app.use(express.static(distDir));
    app.get(["/", "/index.html"], (req, res) => res.sendFile(indexHtml));
    console.log(`[nanoai] Serving web dashboard from ${distDir}`);
  } else {
    console.log("[nanoai] Web dashboard not built yet — run: npm run build:web");
  }
}

// Unknown routes get the same error envelope, not Express's HTML page.
app.use((req, res) => {
  res.status(404).json({
    role: "error",
    content: { message: `Route not found: ${req.method} ${req.path}` },
  });
});

app.use(errorMiddleware);
