// src/services/agent.js
import { apiFetch } from "./api.js";

async function* agent(request) {
  const body = request;
  try {
    const response = await apiFetch(`/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    console.log('[web/services/agent] Fetch response ok:', response.ok);

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("Response body is empty");
    }

    const stream = response.body.pipeThrough(new TextDecoderStream());

    const reader = stream.getReader();

    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      buffer += value;

      const events = buffer.split("\n\n");

      buffer = events.pop() ?? "";

      for (const event of events) {
        if (!event.startsWith("data: ")) continue;

        const data = JSON.parse(event.slice(6));
        yield data;
      }
    }

    // Proses event yang masih tersisa di buffer.
    if (buffer.startsWith("data: ")) {
      const data = JSON.parse(buffer.slice(6));
      yield data;
    }
  } catch (error) {
    console.error('[web/services/agent] Error:', error.message);
  }
}

export { agent };
