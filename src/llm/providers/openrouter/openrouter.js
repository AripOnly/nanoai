// src/llm/providers/openrouter/openrouter.js
//
// OpenRouter speaks the OpenAI-compatible wire. Model ids keep their own slash
// (for example "deepseek/deepseek-v4.1-flash"); the resolver splits only the
// first provider/model slash.

import { createOpenAICompatibleProvider } from "#src/llm/providers/shared/openai-compatible.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function createOpenRouterProvider(options = {}) {
  return createOpenAICompatibleProvider({
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseURL: OPENROUTER_BASE_URL,
    defaultHeaders: { "X-Title": "NanoAI" },
    preserveToolSignatures: true,
    ...options,
  });
}
