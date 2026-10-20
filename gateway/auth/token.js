// gateway/auth/token.js
//
// Resolve the gateway token. Priority: environment variable, then the
// persisted setting. Read fresh on every call (the settings layer caches with
// a short TTL), so rotating the token — in the settings file or via
// PUT /api/v1/settings — takes effect without a restart.

import { randomBytes } from "node:crypto";
import { settings } from "../../src/config/config.js";

const ENV_NAME = "NANO_GATEWAY_TOKEN";

/**
 * On first boot a random token is generated, persisted, and must be shown to
 * the operator exactly once (`created: true`).
 */
export async function getGatewayToken() {
  if (process.env[ENV_NAME]) {
    return { token: process.env[ENV_NAME], created: false };
  }

  let stored = null;
  try {
    stored = await settings.get("gateway_token");
  } catch {
    stored = null;
  }

  if (typeof stored === "string" && stored.length > 0) {
    return { token: stored, created: false };
  }

  const fresh = randomBytes(32).toString("hex");
  await settings.set("gateway_token", fresh);
  return { token: fresh, created: true };
}
