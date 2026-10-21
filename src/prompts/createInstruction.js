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

  let jobNotice = "";
  if (typeof options?.jobNotice === "string" && options.jobNotice.trim() !== "") {
    jobNotice = `
# Background job update

A background job finished and woke this turn. The UI-only notice is not part of
the conversation history. Inspect it, then continue the user's work if needed.
Use the process tool for more detail; do not repeat the whole log.

${options.jobNotice.trim()}
`;
  }

  const ins = `
Username: ${username}
Your name: Nano

${insDefault}

${getWorkEnv()}

${summary}
${jobNotice}
`;

  return ins;
}
