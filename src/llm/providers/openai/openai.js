// src/llm/providers/openai/openai.js
//
// Native OpenAI adapter. Both the Responses and Chat Completions wires are
// supported, with one SDK client per credential/endpoint fingerprint.

import { createOpenAICompatibleProvider } from "#src/llm/providers/shared/openai-compatible.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export function createOpenAIProvider(options = {}) {
  return createOpenAICompatibleProvider({
    id: "openai",
    label: "OpenAI",
    defaultBaseURL: OPENAI_BASE_URL,
    ...options,
  });
}
