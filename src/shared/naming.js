// src/shared/naming.js
// Pure helpers with no native dependencies, safe to import from any channel
// (CLI included) without pulling in sqlite.

export function nameFromPrompt(prompt) {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("prompt must be a non-empty string.");
  }

  const words = prompt.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  return words.length > 0 ? words.join(" ") : "session";
}
