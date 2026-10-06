// src/hooks/useSession.js
import { useState, useEffect, useCallback } from "react";
import session from "../services/session.js";

export default function useSession() {
  const [listSession, setListSession] = useState([]);
  const [history, setHistory] = useState([]);

  // list session
  useEffect(() => {
    async function getSession() {
      setListSession(await session.list());
    }

    getSession();
  }, []);

  // create session
  const createSession = useCallback(async (prompt) => {
    const sessionNew = await session.create(prompt);

    return sessionNew;
  }, []);

  // refresh session
  const refreshListSession = useCallback(async () => {
    setListSession(await session.list());
  }, []);

  const updateHistory = useCallback(async (sessionId) => {
    setHistory([]);
    const result = await session.getHistory(sessionId);
    setHistory(result);
  }, []);

  const resetHistory = useCallback(() => {
    setHistory([]);
  }, []);

  // session info
  const getSessionInfo = useCallback(async (sessionId) => {
    return await session.getSessionInfo(sessionId);
  }, []);

  return {
    createSession,
    listSession,
    refreshListSession,
    history,
    updateHistory,
    resetHistory,
    getSessionInfo,
  };
}
