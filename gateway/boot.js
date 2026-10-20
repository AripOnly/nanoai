// gateway/boot.js
//
// Boot order is a safety property: recover interrupted turns BEFORE binding
// the port, otherwise a fresh request can race the recovery sweep. Keeping the
// sequence in one small function also makes it testable without starting a
// real server.

/** Default to loopback: NanoAI is a single-user gateway, not a LAN service. */
export function resolveHost(env = process.env) {
  const configured = typeof env.HOST === "string" ? env.HOST.trim() : "";
  return configured || "127.0.0.1";
}

export function bootGateway({ app, sessionService, port, host, onListen }) {
  if (!app || typeof app.listen !== "function") {
    throw new TypeError("bootGateway requires an Express app (app.listen).");
  }
  if (!sessionService || typeof sessionService.init !== "function") {
    throw new TypeError("bootGateway requires sessionService.init().");
  }

  const recovered = sessionService.init();
  const server = app.listen(port, host, onListen);
  return { server, recovered };
}
