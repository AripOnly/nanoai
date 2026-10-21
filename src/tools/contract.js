// src/tools/contract.js
//
// The tool contract is deliberately small: a name, the provider-facing JSON
// schema, declarative capabilities the executor checks against the agent
// policy, and one execute function. Tool families own their implementation;
// this file only defines and validates the shape they must expose.

export const TOOL_CAPABILITY_KEYS = Object.freeze([
  "fs",
  "net",
  "shell",
]);

export const WRITE_TOOLS = Object.freeze([
  "write",
  "writeWord",
  "writeExcel",
  "edit",
]);

export function assertToolContract(definition) {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("Tool definition must be an object.");
  }

  if (typeof definition.name !== "string" || definition.name.trim() === "") {
    throw new TypeError("Tool definition name must be a non-empty string.");
  }

  if (!definition.schema || typeof definition.schema !== "object") {
    throw new TypeError(`Tool "${definition.name}" must expose a schema object.`);
  }

  if (typeof definition.execute !== "function") {
    throw new TypeError(`Tool "${definition.name}" must expose execute().`);
  }

  if (
    definition.timeoutMs !== undefined &&
    (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs <= 0)
  ) {
    throw new TypeError(
      `Tool "${definition.name}" timeoutMs must be a positive integer.`,
    );
  }

  const capabilities = definition.capabilities ?? {};
  if (typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new TypeError(`Tool "${definition.name}" capabilities must be an object.`);
  }

  for (const key of Object.keys(capabilities)) {
    if (!TOOL_CAPABILITY_KEYS.includes(key)) {
      throw new TypeError(
        `Tool "${definition.name}" has an unknown capability "${key}".`,
      );
    }
  }

  if (
    capabilities.fs !== undefined &&
    !["read", "write", false].includes(capabilities.fs)
  ) {
    throw new TypeError(
      `Tool "${definition.name}" capability "fs" must be "read", "write", or false.`,
    );
  }

  for (const key of ["net", "shell"]) {
    if (
      capabilities[key] !== undefined &&
      typeof capabilities[key] !== "boolean"
    ) {
      throw new TypeError(
        `Tool "${definition.name}" capability "${key}" must be a boolean.`,
      );
    }
  }

  return definition;
}
