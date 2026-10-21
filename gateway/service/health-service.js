// gateway/service/health-service.js
//
// Liveness + readiness probe backing GET /health (unauthenticated by design:
// monitors must reach it without a token). Reads the settings snapshot rather
// than the file, so a broken external edit is visible as settings_error while
// the last-known-good configuration keeps serving. Database ping is guarded
// separately.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ping } from "../../src/session/index.js";
import {
  getSnapshot,
  initSettings,
} from "../../src/config/index.js";
import { getCatalogSnapshot } from "../../src/models/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedVersion = null;

function gatewayVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")).version ?? "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

function safeError(error) {
  if (error?.name === "ConfigError") return error.message;
  if (error?.code === "ENOENT") return "settings file is missing";
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return "settings file is not readable";
  }
  return "settings could not be loaded";
}

export async function buildHealth({ jobs = null } = {}) {
  const checks = { settings: "ok", models: "ok", database: "ok" };
  let snapshot = null;
  let modelsSnapshot = null;
  let jobStats = null;

  try {
    await initSettings();
    snapshot = getSnapshot();
    if (!snapshot) {
      throw new Error("settings snapshot is unavailable");
    }
    const model = snapshot.value.model;
    if (typeof model !== "string" || model === "") {
      throw new Error("model setting is empty");
    }
    if (snapshot.lastError) {
      checks.settings = snapshot.lastError;
    }
  } catch (error) {
    checks.settings = safeError(error);
  }

  try {
    modelsSnapshot = getCatalogSnapshot();
    if (!modelsSnapshot) {
      throw new Error("model catalog snapshot is unavailable");
    }
    if (modelsSnapshot.lastError) {
      checks.models = modelsSnapshot.lastError.message;
    }
  } catch (error) {
    checks.models =
      error instanceof Error ? error.message : String(error);
  }

  try {
    ping();
  } catch (error) {
    checks.database = error instanceof Error ? error.message : String(error);
  }

  if (jobs && typeof jobs.stats === "function") {
    try {
      jobStats = jobs.stats();
      checks.jobs = "ok";
    } catch (error) {
      checks.jobs = error instanceof Error ? error.message : String(error);
    }
  }

  const degraded = Object.values(checks).some((status) => status !== "ok");
  return {
    status: degraded ? "degraded" : "ok",
    uptime: Math.round(process.uptime()),
    version: gatewayVersion(),
    checks,
    settings_revision: snapshot?.revision ?? null,
    settings_error: snapshot?.lastError ?? (checks.settings === "ok" ? null : checks.settings),
    settings_source: snapshot?.source ?? null,
    restart_required: snapshot?.restartRequired ?? false,
    models_revision: modelsSnapshot?.revision ?? null,
    models_error: modelsSnapshot?.lastError?.message ?? null,
    jobs: jobStats,
  };
}
