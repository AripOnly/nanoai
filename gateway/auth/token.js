// gateway/auth/token.js

import { randomBytes } from "node:crypto";
import { settings } from "../../src/config/config.js";

const ENV_NAME = "NANO_GATEWAY_TOKEN";

let cachedToken = null;

/**
 * Resolve the gateway token. Priority: environment variable, then the
 * persisted setting. On first boot a random token is generated, persisted,
 * and must be shown to the operator exactly once.
 */
export async function getGatewayToken() {
  if (process.env[ENV_NAME]) {
    return { token: process.env[ENV_NAME], created: false };
  }

  if (cachedToken) {
    return { token: cachedToken, created: false };
  }

  let stored = null;
  try {
    stored = await settings.get("gateway_token");
  } catch {
    stored = null;
  }

  if (typeof stored === "string" && stored.length > 0) {
    cachedToken = stored;
    return { token: stored, created: false };
  }

  const fresh = randomBytes(32).toString("hex");
  await settings.set("gateway_token", fresh);
  cachedToken = fresh;
  return { token: fresh, created: true };
}
