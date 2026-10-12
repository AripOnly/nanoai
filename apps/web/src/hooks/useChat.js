// src/hooks/useChat.js
import { useState, useCallback, useEffect, useRef } from "react";
import { agent } from "../services/agent.js";

export default function useChat({ sessionId, pastConversation, updateConversation }) {
  const [stream, setStream] = useState([]);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const sessionIdRef = useRef(sessionId);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    updateConversation(sessionId);
  }, [sessionId, updateConversation]);

  const conversation = [...pastConversation, ...stream];

  const sendMessage = useCallback(async ({ prompt }) => {
    if (!prompt) return;

    setLoadingMessage(true);
    setStream((prev) => [...prev, { role: "user", content: { text: prompt } }]);

    try {
      for await (const event of agent({
        name: "nano",
        prompt,
        session_id: sessionIdRef.current,
      })) {
        setLoadingMessage(false);
        if (event.role === "reasoning_summary") {
          console.log("Reasoning Summary:", event.content.summary);
        }

        if (event.role === "tool_call") {
          // eventHandler(event, "tool_call");
        }

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

        if (event.role === "error") {
          setStream((prev) => [
            ...prev,
            { role: "error", content: { message: event.content.message } },
          ]);
        }
      }
    } catch (error) {
      console.error("Stream error:", error);
      setStream((prev) => [
        ...prev,
        { role: "error", content: { message: error.message } },
      ]);
    } finally {
      setLoadingMessage(false);
    }
  }, []);

  return { sendMessage, conversation, loadingMessage };
}
