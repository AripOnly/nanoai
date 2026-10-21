// src/models/ref.js
//
// Model references are "provider/model". The split happens on the FIRST
// slash only, so OpenRouter-style ids such as
// "openrouter/deepseek/deepseek-chat" keep their full model id.

export class ModelRefError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelRefError";
    this.code = "MODEL_REF_INVALID";
  }
}

export function parseModelRef(value) {
  if (typeof value !== "string") {
    throw new ModelRefError("Model reference must be a string.");
  }

  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");

  if (slash < 1 || slash === trimmed.length - 1) {
    throw new ModelRefError(
      'Model reference must use the "provider/model" format.',
    );
  }

  const provider = trimmed.slice(0, slash).trim();
  const id = trimmed.slice(slash + 1).trim();

  if (provider === "" || id === "") {
    throw new ModelRefError(
      'Model reference must use the "provider/model" format.',
    );
  }

  return Object.freeze({ provider, id, ref: `${provider}/${id}` });
}

export function formatModelRef(provider, id) {
  return `${provider}/${id}`;
}
