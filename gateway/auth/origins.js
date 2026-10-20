// gateway/auth/origins.js
//
// Allowed browser origins for CORS. The settings snapshot is the source; the
// environment can add origins for deployments that cannot edit the config
// file. getOrigins() is intentionally synchronous and cache-free: it reads
// the current snapshot on every request, so an API update takes effect on the
// very next CORS check.

import { getSync, initSettings } from "../../src/config/index.js";

function environmentOrigins() {
  return (process.env.NANO_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** Boot-time initialization: wait for the first settings snapshot. */
export async function initOrigins() {
  await initSettings();
  return getOrigins();
}

export function getOrigins() {
  let stored = [];
  try {
    const value = getSync("cors_origins");
    if (Array.isArray(value)) stored = value;
  } catch {
    // Settings not initialized (or unreadable): environment origins still
    // work. Normal boot always initializes before the middleware is used.
  }
  return [...new Set([...environmentOrigins(), ...stored])];
}
