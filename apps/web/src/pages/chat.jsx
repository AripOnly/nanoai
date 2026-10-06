// src/pages/chat.jsx
import { useCallback, useEffect, useState } from "react";
import { useOutletContext, useParams, useLocation } from "react-router-dom";
import UserInput from "../components/UserInput.jsx";
import BoxChat from "../components/BoxChat.jsx";
import useChat from "../hooks/useChat.js";

export default function Chat() {
  const { sessionId } = useParams();
  const location = useLocation();
  const { history, updateHistory } = useOutletContext();

  const { handleMessage, context, isLoading } = useChat({
    sessionId,
    history,
    updateHistory,
  });

  const [newPrompt, setNewPrompt] = useState(false);

  const sendPrompt = useCallback(
    async ({ prompt }) => {
      setNewPrompt(true);
      try {
        await handleMessage({ prompt });
      } finally {
        setNewPrompt(false);
      }
    },
    [handleMessage],
  );

  useEffect(() => {
    const prompt = location.state?.initialPrompt;
    if (!prompt) return;

    let cancelled = false;

    const t = setTimeout(async () => {
      if (cancelled) return;

      void sendPrompt({ prompt });
      window.history.replaceState({}, "");
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [location.state, sendPrompt]);

  return (
    <>
      <BoxChat
        sessionId={sessionId}
        context={context}
        isStreaming={isLoading}
        newPrompt={newPrompt}
      />
      <UserInput
        newSession={false}
        sendMessage={sendPrompt}
        newPrompt={setNewPrompt}
        disabled={isLoading}
      />
    </>
  );
}
