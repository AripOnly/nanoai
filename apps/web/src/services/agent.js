// src/services/agent.js
async function* agent(request) {
  try {
    const response = await fetch("http://localhost:3060/api/v1/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

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
    console.error(error.message);
  }
}

export { agent };
