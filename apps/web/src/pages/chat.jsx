// src/pages/chat.jsx
import { useCallback, useEffect, useState } from "react";
import { useOutletContext, useParams, useLocation } from "react-router-dom";
import UserInput from "../components/UserInput.jsx";
import BoxChat from "../components/BoxChat.jsx";
import useChat from "../hooks/useChat.js";

export default function Chat() {
  const { sessionId } = useParams();
  const location = useLocation();
  const { conversation: pastConversation, updateConversation } =
    useOutletContext();

  const { sendMessage, conversation, loadingMessage } = useChat({
    sessionId,
    pastConversation,
    updateConversation,
  });

  const [newPrompt, setNewPrompt] = useState(false);

  const sendPrompt = useCallback(
    async ({ prompt }) => {
      setNewPrompt(true);
      try {
        await sendMessage({ prompt });
      } finally {
        setNewPrompt(false);
      }
    },
    [sendMessage],
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
        context={conversation}
        isStreaming={loadingMessage}
        newPrompt={newPrompt}
      />
      <UserInput
        newSession={false}
        sendMessage={sendPrompt}
        newPrompt={setNewPrompt}
        disabled={loadingMessage}
        loadingMessage={loadingMessage}
      />
    </>
  );
}
