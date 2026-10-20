// src/hooks/useChat.js
import { useState, useCallback, useEffect, useRef } from "react";
import { EVENT } from "#src/shared/event-type.js";
import { getCallId } from "#src/shared/call-id.js";
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
    setStream((prev) => [
      ...prev,
      { role: EVENT.USER, content: { text: prompt } },
    ]);

    try {
      for await (const event of agent({
        name: "nano",
        prompt,
        session_id: sessionIdRef.current,
      })) {
        setLoadingMessage(false);

        if (event.role === EVENT.ASSISTANT) {
          const text = event.content?.text ?? "";
          setStream((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];

            if (last?.role === EVENT.ASSISTANT) {
              next[next.length - 1] = {
                ...last,
                content: {
                  ...last.content,
                  text: (last.content.text ?? "") + text,
                },
              };
              return next;
            }

            return [...next, { role: EVENT.ASSISTANT, content: { text } }];
          });
        }

        if (event.role === EVENT.TOOL_CALL) {
          setStream((prev) => [...prev, event]);
        }

        if (event.role === EVENT.TOOL_UPDATE) {
          const callId = getCallId(event.content);
          const preview = event.content?.preview ?? "";
          if (callId !== undefined) {
            setStream((prev) => {
              for (let i = prev.length - 1; i >= 0; i--) {
                const item = prev[i];
                if (
                  item?.role === EVENT.TOOL_CALL &&
                  getCallId(item?.content) === callId
                ) {
                  // Late update after the result arrived, or identical
                  // preview: return prev so React skips the re-render.
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

        if (event.role === EVENT.TOOL_RESULT) {
          const callId = getCallId(event.content);
          setStream((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              const item = next[i];
              if (
                item?.role === EVENT.TOOL_CALL &&
                getCallId(item?.content) === callId
              ) {
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

        if (event.role === EVENT.ERROR) {
          setStream((prev) => [...prev, event]);
        }
      }
    } catch (error) {
      setStream((prev) => [
        ...prev,
        { role: EVENT.ERROR, content: { message: error.message } },
      ]);
    } finally {
      setLoadingMessage(false);
    }
  }, []);

  return { sendMessage, conversation, loadingMessage };
}
