// src/services/agent.js
import { apiFetch } from "./api.js";

/**
 * Stream one agent turn. Yields every SSE frame as a parsed event; transport
 * and HTTP failures throw so the caller can show them (silence is worse).
 */
async function* agent(request) {
  const response = await apiFetch(`/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Agent request failed with HTTP ${response.status}.`);
  }

  if (!response.body) {
    throw new Error("The gateway returned an empty response body.");
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  let buffer = "";

  const parse = (frame) => {
    const line = frame.trim();
    if (!line.startsWith("data: ")) return null;
    try {
      return JSON.parse(line.slice("data: ".length).trim());
    } catch {
      // One malformed frame must not kill the rest of the stream.
      return null;
    }
  };

  while (true) {
    const { value, done } = await reader.read();

    if (done) break;

    buffer = (buffer + value).replace(/\r\n/g, "\n");

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const event = parse(frame);
      if (event !== null) yield event;
    }
  }

  // A stream that ends without a trailing blank line still carries one event.
  const trailing = parse(buffer);
  if (trailing !== null) yield trailing;
}

export { agent };
