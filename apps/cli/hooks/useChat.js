import React, { useCallback, useEffect, useRef, useState } from "react";

import { api, isConnectionError } from "../lib/api.js";
import { clearTerminal } from "../lib/terminal.js";
import { getCallId } from "../../../src/shared/call-id.js";
import { nameFromPrompt } from "../../../src/shared/naming.js";

export function useChat() {
  const [chat, setChat] = useState([]);
  const [conversation, setConversation] = useState([]);
  const [thinking, setThinking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeSession, setActiveSession] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const [viewKey, setViewKey] = useState(1);

  // FIFO queue: prompts sent while a run is in progress wait their turn
  // instead of being rejected or interleaved with the active stream.
  const queueRef = useRef([]);
  const processingRef = useRef(false);
  const sessionRef = useRef(null);

  useEffect(() => {
    sessionRef.current = activeSession;
  }, [activeSession]);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await api.listSessions());
    } catch (error) {
      // Gateway mati: diam saja, banner merah "Gateway not connected" yang
      // bicara. Pesan mentah "Cannot reach the gateway..." tidak ditempel ke
      // chat agar tidak jadi noise permanen. Error non-koneksi tetap tampil.
      if (isConnectionError(error)) return;
      setChat((prev) => [
        ...prev,
        { role: "error", content: { message: error.message } },
      ]);
    }
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  const refreshConversation = useCallback(async (sessionId) => {
    const result = await api.getConversation(sessionId);

    setConversation(result);
  }, []);

  const appendError = useCallback((message) => {
    setChat((prev) => [...prev, { role: "error", content: { message } }]);
  }, []);

  const runPrompt = useCallback(
    async (prompt) => {
      let session = sessionRef.current;

      try {
        if (!session) {
          session = await api.createSession(prompt);
          sessionRef.current = session;
          setActiveSession(session);
        } else if ((await api.getConversation(session.id)).length === 0) {
          const name = nameFromPrompt(prompt);
          session = await api.renameSession(session.id, name);
          sessionRef.current = session;
          setActiveSession(session);
        }
      } catch (error) {
        appendError(error.message);
        return;
      }

      setChat((prev) => [
        ...prev,
        { role: "user", content: { text: prompt } },
      ]);

      try {
        for await (const event of api.streamAgent({
          name: "nano",
          prompt,
          session_id: session.id,
        })) {
          if (event.role === "assistant") {
            const text = event.content?.text ?? "";

            setChat((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];

              if (last?.role === "assistant") {
                const prevContent =
                  typeof last.content === "string"
                    ? last.content
                    : (last.content?.text ?? "");
                next[next.length - 1] = {
                  ...last,
                  content: prevContent + text,
                };
              } else {
                next.push({ role: "assistant", content: text });
              }

              return next;
            });
          }

          if (event.role === "tool_call" || event.role === "error") {
            setChat((prev) => [...prev, event]);
          }

          if (event.role === "tool_update") {
            const callId = getCallId(event.content);
            const preview = event.content?.preview ?? "";
            if (callId !== undefined) {
              setChat((prev) => {
                for (let i = prev.length - 1; i >= 0; i--) {
                  const item = prev[i];
                  if (item?.role === "tool_call" && getCallId(item?.content) === callId) {
                    // Update telat setelah result / preview sama: kembalikan prev
                    // agar tidak ada render ulang sia-sia.
                    if (item?.content?.result !== undefined) return prev;
                    if (item?.content?.preview === preview) return prev;
                    const next = [...prev];
                    next[i] = {
                      ...item,
                      content: { ...item.content, preview },
                    };
                    return next;
                  }
                }
                return prev;
              });
            }
          }

          if (event.role === "tool_result") {
            const callId = getCallId(event.content);
            setChat((prev) => {
              const next = [...prev];
              for (let i = next.length - 1; i >= 0; i--) {
                const item = next[i];
                if (item?.role === "tool_call" && getCallId(item?.content) === callId) {
                  next[i] = {
                    ...item,
                    content: { ...item.content, result: event.content?.result },
                  };
                  return next;
                }
              }
              return [...next, event];
            });
          }

          if (event.role === "compaction") {
            setChat((prev) => {
              const text = event.content?.text ?? "";
              const next = [...prev];
              const last = next[next.length - 1];

              if (last?.role === "compaction") {
                const prevContent =
                  typeof last.content === "string"
                    ? last.content
                    : (last.content?.text ?? "");
                next[next.length - 1] = {
                  ...last,
                  content: prevContent + text,
                };
              } else {
                next.push({ role: "compaction", content: text });
              }

              return next;
            });
          }

          setThinking(event.role === "reasoning_summary");
        }

        const result = await api.getConversation(session.id);
        setConversation(result);
        // Conversation loaded into history: clear active stream events so
        // items (including errors) are not rendered twice.
        setChat([]);
      } catch (error) {
        appendError(error.message);
      } finally {
        setThinking(false);
        refreshSessions();
      }
    },
    [appendError, refreshSessions],
  );

  const processQueue = useCallback(async () => {
    if (processingRef.current) {
      return;
    }
    processingRef.current = true;
    setLoading(true);
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift();
        setQueuedCount(queueRef.current.length);
        await runPrompt(next);
      }
    } finally {
      processingRef.current = false;
      setLoading(false);
    }
  }, [runPrompt]);

  const send = useCallback(
    (prompt) => {
      if (!prompt || typeof prompt !== "string" || !prompt.trim()) return;

      // Drop stale errors: a new attempt starts with a clean slate.
      setChat((prev) => prev.filter((event) => event.role !== "error"));

      queueRef.current.push(prompt.trim());
      setQueuedCount(queueRef.current.length);
      void processQueue();
    },
    [processQueue],
  );

  const clearQueue = useCallback(() => {
    queueRef.current = [];
    setQueuedCount(0);
  }, []);

  const newSession = useCallback(() => {
    clearTerminal();
    clearQueue();
    setViewKey((k) => k + 1);
    sessionRef.current = null;
    setActiveSession(null);
    setChat([]);
    setConversation([]);
    setLoading(false);
    setThinking(false);
    refreshSessions();
  }, [clearQueue, refreshSessions]);

  const switchSession = useCallback(
    async (sessionId) => {
      try {
        const session = await api.getSessionInfo(sessionId);
        if (!session) return;
        // Fresh screen for the new session. Clean terminal completely
        // and advance viewKey so Static remounts cleanly with the banner.
        clearTerminal();
        clearQueue();
        setViewKey((k) => k + 1);
        sessionRef.current = session;
        setActiveSession(session);
        setChat([]);
        setConversation([]);
        await refreshConversation(sessionId);
        refreshSessions();
      } catch (error) {
        appendError(error.message);
      }
    },
    [appendError, clearQueue, refreshConversation, refreshSessions],
  );

  const deleteSession = useCallback(
    async (sessionId) => {
      if (!sessionId) return;
      try {
        await api.deleteSession(sessionId);
      } catch (error) {
        appendError(error.message);
        return;
      }
      clearTerminal();
      clearQueue();
      setViewKey((k) => k + 1);
      sessionRef.current = null;
      setActiveSession(null);
      setChat([]);
      setConversation([]);
      setLoading(false);
      setThinking(false);
      refreshSessions();
    },
    [appendError, clearQueue, refreshSessions],
  );

  const renameSession = useCallback(
    async (sessionId, name) => {
      if (!name || !name.trim()) return;
      const finalName = name.trim();
      try {
        const session = await api.renameSession(sessionId, finalName);
        sessionRef.current = session;
        setActiveSession((prev) =>
          prev?.id === sessionId ? session : prev,
        );
      } catch (error) {
        appendError(error.message);
        return;
      }
      refreshSessions();
    },
    [appendError, refreshSessions],
  );

  // Re-sync after a gateway outage: drop stale connection errors, reload
  // sessions + active conversation so the UI matches the backend again
  // without restarting the CLI.
  const resync = useCallback(async () => {
    setChat((prev) =>
      prev.some((event) => event.role === "error")
        ? prev.filter((event) => event.role !== "error")
        : prev,
    );
    await refreshSessions();
    const session = sessionRef.current;
    if (session?.id) {
      try {
        await refreshConversation(session.id);
      } catch (error) {
        appendError(error.message);
      }
    }
  }, [appendError, refreshConversation, refreshSessions]);

  return {
    chat,
    conversation,
    thinking,
    loading,
    queuedCount,
    send,
    sessions,
    activeSession,
    viewKey,
    newSession,
    switchSession,
    deleteSession,
    renameSession,
    resync,
  };
}
