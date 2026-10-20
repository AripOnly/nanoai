// src/services/api.js
//
// When the gateway serves the built dashboard, the API lives on the same
// origin. During `vite dev` the dashboard runs on its own port, so fall back
// to the default gateway port. VITE_API_BASE overrides both.
const baseUrl =
  import.meta.env.VITE_API_BASE ??
  (import.meta.env.DEV
    ? "http://localhost:3060/api/v1"
    : `${window.location.origin}/api/v1`);

const TOKEN_STORAGE_KEY = "nano_gateway_token";

function authHeaders() {
  const token =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(TOKEN_STORAGE_KEY)
      : null;

  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * fetch() wrapper for the NanoAI gateway. Attaches the gateway token and
 * converts a 401 into an actionable message (the settings UI that manages
 * the token does not exist yet).
 */
export async function apiFetch(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.headers ?? {}),
    },
  });

  if (response.status === 401) {
    throw new Error(
      "Gateway unauthorized (401). Save your gateway token with: " +
        `localStorage.setItem('${TOKEN_STORAGE_KEY}', '<token>'). ` +
        "The token is printed once on the gateway's first boot.",
    );
  }

  return response;
}
