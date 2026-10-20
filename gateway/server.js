// gateway/server.js

import { app } from "./application/web.js";
import { getGatewayToken } from "./auth/token.js";
import { closeDatabase } from "../src/session/index.js";
import sessionService from "./service/session-service.js";
import { bootGateway, resolveListen } from "./boot.js";
import { abortActiveTurns } from "./lifecycle/active-turns.js";
import {
  getSnapshot,
  initSettings,
  startSettingsWatcher,
  stopSettingsWatcher,
} from "../src/config/index.js";

// The web module already awaits initOrigins(), which initializes the snapshot.
// Calling init again is cheap and makes the bootstrap order explicit here.
await initSettings();

const { token, created } = await getGatewayToken();

if (created) {
  console.log(
    "[nanoai] First boot: generated a gateway token and saved it to nano.config.json.",
  );
  console.log(`[nanoai] Gateway token: ${token}`);
  console.log(
    "[nanoai] Save it now. Every /api request needs: Authorization: Bearer <token>.",
  );
}

const { port: PORT, host: HOST } = resolveListen({
  gateway: getSnapshot().value.gateway,
});

// Hot settings must be observable before the first request, but after the
// initial snapshot and token bootstrap so our own writes are not reloaded as
// external edits. stopSettingsWatcher() runs on every failure and shutdown.
startSettingsWatcher();

let booted;
try {
  // Recovery runs inside bootGateway, before the port starts accepting
  // requests. A fresh request must never race the interrupted-turn sweep.
  booted = bootGateway({
    app,
    sessionService,
    port: PORT,
    host: HOST,
    onListen: () => {
      console.log(`Server is running on http://${HOST}:${PORT}`);
    },
  });
} catch (error) {
  stopSettingsWatcher();
  console.error("[nanoai] Boot failed:", error);
  process.exit(1);
}

const { server, recovered } = booted;
if (recovered > 0) {
  console.log(
    `[nanoai] Recovered ${recovered} interrupted turn(s) from the previous run.`,
  );
}

// A stale instance still holding the port is the most common boot failure
// (e.g. rapid restarts). Say so plainly instead of dumping EADDRINUSE.
server.on("error", (error) => {
  stopSettingsWatcher();
  if (error?.code === "EADDRINUSE") {
    console.error(
      `[nanoai] Port ${PORT} on ${HOST} is already in use. Another gateway instance is probably still running — stop it first, then boot again.`,
    );
    process.exit(1);
    return;
  }
  console.error("[nanoai] Server error:", error);
  process.exit(1);
});

// SSE agent streams can run for a long time; do not let Node's default
// request timeout kill them. Auth and (later) rate limiting are the real
// protections, not a short idle timer.
server.requestTimeout = 0;

function shutdown(signal) {
  console.log(`[nanoai] Received ${signal}, shutting down...`);

  // Stop observing the file before closing sockets; no reload should race
  // the shutdown path.
  stopSettingsWatcher();

  // Stop provider/tool work first. The controllers' generators then commit
  // their partial turns before server.close() finishes waiting for sockets.
  abortActiveTurns(new Error(`Gateway shutdown (${signal})`));

  const forceExit = setTimeout(() => {
    console.log("[nanoai] Shutdown timed out, forcing exit.");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(() => {
    try {
      closeDatabase();
    } catch {
      // Already closed or never opened; nothing to do.
    }
    console.log("[nanoai] Shutdown complete.");
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
