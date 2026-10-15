// src/shared/call-id.js
//
// Satu-satunya tempat untuk membaca ID panggilan tool. Backend, gateway,
// dan CLI pernah memakai dua ejaan (call_id snake_case vs callId camelCase);
// semua pencocokan tool_call <-> tool_update <-> tool_result WAJIB lewat sini
// agar result tidak pernah orphan (yang bikin header tool kecetak ulang di bawah).

export function getCallId(content) {
  if (!content || typeof content !== "object") return undefined;
  return content.call_id ?? content.callId ?? undefined;
}
