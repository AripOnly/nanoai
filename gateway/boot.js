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

/**
 * Resolve the effective listen address. Environment variables win over the
 * persisted gateway settings, matching the token precedence rule; the defaults
 * keep a fresh install on loopback:3060. A settings change is restart-required
 * because the already-bound socket cannot move.
 */
export function resolveListen({ env = process.env, gateway = {} } = {}) {
  const rawPort = typeof env.PORT === "string" ? env.PORT.trim() : "";
  let port = rawPort === "" ? gateway?.port ?? 3060 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${rawPort || port}`);
  }

  const envHost = typeof env.HOST === "string" ? env.HOST.trim() : "";
  const host =
    envHost !== ""
      ? envHost
      : typeof gateway?.host === "string" && gateway.host.trim() !== ""
        ? gateway.host.trim()
        : "127.0.0.1";

  return { host, port };
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
