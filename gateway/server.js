// gateway/server.js

import { app } from "./application/web.js";
import { getGatewayToken } from "./auth/token.js";
import { closeDatabase } from "../src/session/index.js";
import sessionService from "./service/session-service.js";

const PORT = Number(process.env.PORT ?? 3060);

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

const server = app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

const recovered = sessionService.init();
if (recovered > 0) {
  console.log(
    `[nanoai] Recovered ${recovered} interrupted turn(s) from the previous run.`,
  );
}

// A stale instance still holding the port is the most common boot failure
// (e.g. rapid restarts). Say so plainly instead of dumping EADDRINUSE.
server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `[nanoai] Port ${PORT} is already in use. Another gateway instance is probably still running — stop it first, then boot again.`,
    );
    process.exit(1);
    return;
  }
  throw error;
});

// SSE agent streams can run for a long time; do not let Node's default
// request timeout kill them. Auth and (later) rate limiting are the real
// protections, not a short idle timer.
server.requestTimeout = 0;

function shutdown(signal) {
  console.log(`[nanoai] Received ${signal}, shutting down...`);

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
