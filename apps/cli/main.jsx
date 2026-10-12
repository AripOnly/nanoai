import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import App from "./App.jsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startCLI() {
  try {
    // Plain-stdout banner: printed once before Ink starts, so it can never
    // be replayed, erased, or reordered by Static remounts, clears, or
    // re-renders. Ink only manages what it renders itself.
    console.log(
      readFileSync(path.join(__dirname, "components", "banner.txt"), "utf-8"),
    );

    const { waitUntilExit } = render(<App />);
    await waitUntilExit();
  } catch (error) {
    console.log(error.stack);
  }
}
