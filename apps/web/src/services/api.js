// src/services/api.js
//
// When the gateway serves the built dashboard, the API lives on the same
// origin. During `vite dev` the dashboard runs on its own port, so fall back
// to the default gateway port. VITE_API_BASE overrides both.
//
// The actual HTTP + SSE implementation is shared with the CLI in apps/client.
import { createGatewayClient } from "#client";

const baseUrl =
  import.meta.env.VITE_API_BASE ??
  (import.meta.env.DEV
    ? "http://localhost:3060/api/v1"
    : `${window.location.origin}/api/v1`);

const TOKEN_STORAGE_KEY = "nano_gateway_token";

function gatewayToken() {
  return typeof localStorage !== "undefined"
    ? localStorage.getItem(TOKEN_STORAGE_KEY)
    : null;
}

export const gateway = createGatewayClient({
  baseUrl,
  getToken: gatewayToken,
});
