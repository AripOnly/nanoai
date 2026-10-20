// src/tools/shared/fail.js
//
// The single failure envelope every tool returns for expected failures
// (bad input, missing file, blocked command). Import this instead of
// defining a local copy — duplicated versions drifted apart before.
export function fail(error) {
  return { success: false, error };
}
