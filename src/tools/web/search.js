// src/tools/web/search.js
//
// Web search via MCP providers (Exa / Parallel).
// Unlike snippet APIs, these return LLM-optimized page content, which is why
// search answers are richer than nano's old Serper integration.

import { providerLabel, searchExa, searchParallel, selectProvider } from "./mcp.js";

const year = new Date().getFullYear();

const SEARCH_TYPES = ["auto", "fast", "deep"];
const LIVECRAWL_MODES = ["fallback", "preferred"];

export const webSearchTool = {
  type: "function",
  name: "webSearch",
  description:
    "Search the web using the session's web search provider - performs real-time web searches and returns content from the most relevant websites. " +
    "Provides up-to-date information for current events and recent data. " +
    "Use this tool for accessing information beyond the knowledge cutoff. " +
    "Searches are performed automatically within a single call. " +
    "Usage notes: " +
    `The current year is ${year}. You MUST use this year when searching for recent information or current events. ` +
    "Live crawl modes: 'fallback' (backup if cached content unavailable) or 'preferred' (prioritize live crawling). " +
    "Search types: 'auto' (balanced), 'fast' (quick results), 'deep' (comprehensive search). " +
    "Do not use webSearch when the user provided a specific URL and you only need its content (use webFetch), " +
    "or when you already have enough information. Keep queries focused; avoid redundant searches.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Websearch query.",
      },
      numResults: {
        type: "number",
        description: "Number of search results to return (default: 8, max 20).",
      },
      livecrawl: {
        type: "string",
        enum: LIVECRAWL_MODES,
        description: "Live crawl mode (default: 'fallback').",
      },
      type: {
        type: "string",
        enum: SEARCH_TYPES,
        description: "Search type (default: 'auto').",
      },
      contextMaxCharacters: {
        type: "number",
        description: "Maximum characters for LLM-optimized context (default: 10000).",
      },
    },
    required: ["query"],
  },
};

function fail(error) {
  return { success: false, error };
}

export async function webSearch(params = {}, context = {}) {
  try {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return fail("Parameters must be an object with 'query' and optional search options.");
    }
    const { query, numResults = 8, livecrawl = "fallback", type = "auto", contextMaxCharacters = 10000 } = params;
    if (typeof query !== "string" || query.trim() === "") {
      return fail("Parameter 'query' must be a non-empty string.");
    }
    if (!Number.isInteger(numResults) || numResults < 1 || numResults > 20) {
      return fail("Parameter 'numResults' must be an integer between 1 and 20.");
    }
    if (!LIVECRAWL_MODES.includes(livecrawl)) {
      return fail(`Parameter 'livecrawl' must be one of: ${LIVECRAWL_MODES.join(", ")}.`);
    }
    if (!SEARCH_TYPES.includes(type)) {
      return fail(`Parameter 'type' must be one of: ${SEARCH_TYPES.join(", ")}.`);
    }
    if (!Number.isInteger(contextMaxCharacters) || contextMaxCharacters < 1) {
      return fail("Parameter 'contextMaxCharacters' must be a positive integer.");
    }

    const provider = selectProvider(context.sessionID);
    let content;
    try {
      content =
        provider === "parallel"
          ? await searchParallel(query, context)
          : await searchExa(query, { type, numResults, livecrawl, contextMaxCharacters }, context);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (!content || content.trim() === "") {
      return { success: true, content: "No search results found. Please try a different query.", provider };
    }
    return { success: true, content, provider: providerLabel(provider) };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
