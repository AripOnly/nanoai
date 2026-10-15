// test/suite/gateway-health.test.js
// CLI tetap jalan tanpa restart: error saat gateway mati, auto hilang +
// resync saat gateway hidup lagi.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useGateway } from "../../apps/cli/hooks/useGateway.js";
import { useChat } from "../../apps/cli/hooks/useChat.js";
import { useConfig } from "../../apps/cli/hooks/useConfig.js";
import { api, isConnectionError } from "../../apps/cli/lib/api.js";

function Probe({ check, onReconnect, intervalMs }) {
  const { connected } = useGateway({ check, onReconnect, intervalMs });
  return React.createElement(Text, null, connected ? "up" : "down");
}

async function lastFrameWith(props, waitMs = 80) {
  const app = render(React.createElement(Probe, props));
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const frame = app.lastFrame();
  app.unmount();
  return frame;
}

describe("useGateway", () => {
  it("shows down when the gateway is unreachable", async () => {
    const frame = await lastFrameWith({ check: async () => false, intervalMs: 10000 });
    assert.ok(frame.includes("down"), frame);
  });

  it("stays up when the gateway answers", async () => {
    const frame = await lastFrameWith({ check: async () => true, intervalMs: 10000 });
    assert.ok(frame.includes("up"), frame);
  });

  it("re-syncs once on down -> up without restart", async () => {
    let alive = false;
    let calls = 0;
    const app = render(
      React.createElement(Probe, {
        check: async () => alive,
        onReconnect: () => {
          calls += 1;
        },
        intervalMs: 20,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(app.lastFrame().includes("down"), app.lastFrame());
    alive = true;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const frame = app.lastFrame();
    app.unmount();
    assert.ok(frame.includes("up"), frame);
    assert.equal(calls, 1);
  });
});

describe("api.health", () => {
  it("resolves to a boolean and never throws", async () => {
    assert.equal(typeof (await api.health()), "boolean");
  });
});

describe("reconnect resync wiring", () => {
  it("exposes reloadConfig (model/provider refresh) without throwing offline", async () => {
    let cfg;
    function C() {
      cfg = useConfig();
      return null;
    }
    const app = render(React.createElement(C));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(typeof cfg.reloadConfig, "function");
    await cfg.reloadConfig();
    assert.equal(cfg.provider, "");
    assert.equal(cfg.model, "");
    app.unmount();
  });

  it("exposes resync (error clear + session refresh) without throwing offline", async () => {
    let chat;
    function H() {
      chat = useChat();
      return null;
    }
    const app = render(React.createElement(H));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(typeof chat.resync, "function");
    await chat.resync();
    app.unmount();
  });

  it("suppresses only connection errors, keeps the rest", () => {
    assert.equal(isConnectionError(new Error("Cannot reach the gateway at http://localhost:3060/api/v1. Start it first.")), true);
    assert.equal(isConnectionError(new Error("Gateway unauthorized (401).")), false);
    assert.equal(isConnectionError(new Error("Gateway token not found.")), false);
    assert.equal(isConnectionError(null), false);
  });
});
