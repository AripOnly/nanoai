// src/prompts/createInstruction.js
//
// Instruction assembly is a pure prompt concern: callers pass the username
// from their turn-scoped settings snapshot instead of this module reading
// settings itself.

import { getWorkEnv } from "./workEnv.js";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createInstruction(name, options = {}) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("Instruction name must be a non-empty string.");
  }

  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`Invalid instruction name "${name}".`);
  }

  const username =
    typeof options?.username === "string" && options.username.trim() !== ""
      ? options.username
      : "your name";

  let insDefault;
  try {
    insDefault = await readFile(
      path.join(__dirname, `../prompts/${name}.txt`),
      "utf-8",
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Unknown instruction "${name}". Expected file: prompts/${name}.txt.`,
      );
    }
    throw error;
  }

  let summary = "";
  if (options?.summary) {
    summary = `
# Summary

${options.summary}
`;
  }

  const ins = `
Username: ${username}
Your name: Nano

${insDefault}

${getWorkEnv()}

${options?.summary ? summary : ""}
`;

  return ins;
}
