// src/hooks/useChat.js
import { useState, useCallback, useEffect, useRef } from "react";
import { agent } from "../services/agent.js";

export default function useChat({ sessionId, history, updateHistory }) {
  const [stream, setStream] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const sessionIdRef = useRef(sessionId);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    updateHistory(sessionId);
  }, [sessionId, updateHistory]);

  const context = [...history, ...stream];

  const handleMessage = useCallback(async ({ prompt }) => {
    if (!prompt) return;

    setIsLoading(true);

    setStream((prev) => [...prev, { role: "user", content: { text: prompt } }]);

    try {
      for await (const event of agent({
        name: "nano",
        prompt,
        session_id: sessionIdRef.current,
      })) {
        if (event.role === "assistant") {
          const text = event.content?.text ?? "";

          setStream((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];

            if (last?.role === "assistant") {
              next[next.length - 1] = {
                ...last,
                content: {
                  ...last.content,
                  text: (last.content.text ?? "") + text,
                },
              };
              return next;
            }

            return [...next, { role: "assistant", content: { text } }];
          });
        }
      }
    } catch (error) {
      console.error("Stream error:", error);
      setStream((prev) => [
        ...prev,
        { role: "error", content: { message: error.message } },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { handleMessage, context, isLoading };
}
