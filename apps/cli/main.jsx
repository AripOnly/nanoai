import React from "react";
import { render } from "ink";
import App from "./App.jsx";
import { clearTerminal } from "./lib/terminal.js";

export async function startCLI() {
  try {
    clearTerminal();

    const { waitUntilExit } = render(<App />);
    await waitUntilExit();
  } catch (error) {
    console.error(error.stack ?? error);
  }
}
