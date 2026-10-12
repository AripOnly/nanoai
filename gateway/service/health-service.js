// gateway/service/health-service.js
//
// Liveness + readiness probe backing GET /health (unauthenticated by design:
// monitors must reach it without a token). Cheap by construction: one settings
// read and one SELECT 1, both guarded so a broken dependency degrades the
// verdict instead of crashing the probe.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "../../src/session/sql.js";
import { settings } from "../../src/config/config.js";

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

export async function buildHealth() {
  const checks = { settings: "ok", database: "ok" };
  try {
    const model = await settings.get("model");
    if (typeof model !== "string" || model === "") throw new Error("model setting is empty");
  } catch (error) {
    checks.settings = error instanceof Error ? error.message : String(error);
  }
  try {
    sql.prepare("SELECT 1").get();
  } catch (error) {
    checks.database = error instanceof Error ? error.message : String(error);
  }
  const degraded = Object.values(checks).some((status) => status !== "ok");
  return {
    status: degraded ? "degraded" : "ok",
    uptime: Math.round(process.uptime()),
    version: gatewayVersion(),
    checks,
  };
}
