// src/llm/providers/opencode-zen/opencode-zen.js
//
// OpenCode Zen exposes OpenAI-compatible Responses and Chat Completions routes.
// Its native Anthropic and Google routes are deliberately outside this
// adapter's supportedWires, so selecting such a model fails explicitly with
// WIRE_UNSUPPORTED instead of silently using the wrong protocol.

import { createOpenAICompatibleProvider } from "#src/llm/providers/shared/openai-compatible.js";

export const OPENCODE_ZEN_BASE_URL =
  "https://opencode.ai/inference/openai/v1";

export function createOpenCodeZenProvider(options = {}) {
  return createOpenAICompatibleProvider({
    id: "opencode-zen",
    label: "OpenCode Zen",
    defaultBaseURL: OPENCODE_ZEN_BASE_URL,
    ...options,
  });
}
