// gateway/auth/origins.js
//
// Allowed browser origins for CORS. Loaded from the environment and the
// settings file; refreshed lazily after a short TTL so edits made outside the
// gateway (config file, env) are picked up without a restart — CORS checks
// are synchronous, so a stale snapshot triggers a background reload instead
// of blocking the request. The settings API also calls setOrigins() directly
// for instant effect.

import { settings } from "../../src/config/config.js";

const REFRESH_MS = 10_000;

let current = [];
let loadedAt = 0;
let inflight = null;

async function load() {
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

/** Boot-time load: the first snapshot must be ready before requests arrive. */
export async function initOrigins() {
  current = await load();
  loadedAt = Date.now();
  return current;
}

export function getOrigins() {
  if (Date.now() - loadedAt > REFRESH_MS && !inflight) {
    inflight = load()
      .then((list) => {
        current = list;
        loadedAt = Date.now();
      })
      .catch(() => {
        // Unreadable settings: keep the snapshot and back off a full TTL.
        loadedAt = Date.now();
      })
      .finally(() => {
        inflight = null;
      });
  }

  return current;
}

export function setOrigins(list) {
  current = [...new Set(Array.isArray(list) ? list : [])];
  loadedAt = Date.now();
}
