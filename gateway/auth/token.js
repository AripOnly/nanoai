// gateway/auth/token.js
//
// Resolve the gateway token. Priority: environment variable, then the
// persisted setting. Auth reads the current settings snapshot on every call,
// so rotating the token via PUT /api/v1/settings takes effect immediately.
// The environment override wins and cannot be changed from the API.

import { randomBytes } from "node:crypto";
import { initSettings, settings } from "../../src/config/index.js";

const ENV_NAME = "NANO_GATEWAY_TOKEN";

let creating = null;

export function isGatewayTokenEnvLocked() {
  return Boolean(process.env[ENV_NAME]);
}

/**
 * On first boot a random token is generated, persisted, and must be shown to
 * the operator exactly once (`created: true`). Concurrent first requests share
 * one generation attempt.
 */
export async function getGatewayToken() {
  if (process.env[ENV_NAME]) {
    return { token: process.env[ENV_NAME], created: false };
  }

  await initSettings();

  const stored = await settings.get("gateway_token");
  if (typeof stored === "string" && stored.length > 0) {
    return { token: stored, created: false };
  }

  if (!creating) {
    creating = (async () => {
      // The environment could have been set while we waited for the snapshot.
      if (process.env[ENV_NAME]) {
        return { token: process.env[ENV_NAME], created: false };
      }
      const latest = await settings.get("gateway_token");
      if (typeof latest === "string" && latest.length > 0) {
        return { token: latest, created: false };
      }
      const fresh = randomBytes(32).toString("hex");
      await settings.update({ gateway_token: fresh });
      return { token: fresh, created: true };
    })().finally(() => {
      creating = null;
    });
  }

  return creating;
}
