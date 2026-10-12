import React, { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api.js";
import { nameFromPrompt } from "../../../src/shared/naming.js";

export function useChat() {
  const [chat, setChat] = useState([]);
  const [conversation, setConversation] = useState([]);
  const [thinking, setThinking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeSession, setActiveSession] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [queuedCount, setQueuedCount] = useState(0);

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
          setActiveSession(session);
        } else if ((await api.getConversation(session.id)).length === 0) {
          const name = nameFromPrompt(prompt);
          session = await api.renameSession(session.id, name);
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
                last.content += text;
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
            const callId = event.content?.call_id;
            const preview = event.content?.preview ?? "";
            setChat((prev) => {
              const next = [...prev];
              for (let i = next.length - 1; i >= 0; i--) {
                const item = next[i];
                if (item?.role === "tool_call" && item?.content?.call_id === callId) {
                  next[i] = {
                    ...item,
                    content: { ...item.content, preview },
                  };
                  break;
                }
              }
              return next;
            });
          }

          if (event.role === "tool_result") {
            const callId = event.content?.call_id;
            setChat((prev) => {
              const next = [...prev];
              for (let i = next.length - 1; i >= 0; i--) {
                const item = next[i];
                if (item?.role === "tool_call" && item?.content?.call_id === callId) {
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
                last.content += text;
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
      } catch (error) {
        appendError(error.message);
      } finally {
        // Move the finished exchange to history, but keep error entries
        // visible. Blanket-clearing here used to swallow stream failures,
        // leaving unanswered prompts with no explanation.
        setChat((prev) => prev.filter((event) => event.role === "error"));
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
      if (!prompt) return;

      // Drop stale errors: a new attempt starts with a clean slate.
      setChat((prev) => prev.filter((event) => event.role !== "error"));

      queueRef.current.push(prompt);
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
    console.clear();
    clearQueue();
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
        // Fresh screen for the new session. Direct console access is
        // normally avoided inside Ink, but a session switch is a discrete
        // reset point and Ink redraws the new tree right after.
        console.clear();
        clearQueue();
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
      clearQueue();
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

  return {
    chat,
    conversation,
    thinking,
    loading,
    queuedCount,
    send,
    sessions,
    activeSession,
    newSession,
    switchSession,
    deleteSession,
    renameSession,
  };
}
