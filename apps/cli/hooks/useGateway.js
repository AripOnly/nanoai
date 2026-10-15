// apps/cli/hooks/useGateway.js
//
// Live gateway connectivity for the CLI. Polls the public /health probe;
// the UI shows "gateway not connected" while down, and auto re-syncs
// (sessions + active conversation) the moment it comes back — no CLI restart.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";

export const GATEWAY_POLL_MS = 5000;

export function useGateway({ intervalMs = GATEWAY_POLL_MS, onReconnect, check = () => api.health() } = {}) {
  const [connected, setConnected] = useState(true);
  const prevRef = useRef(true);
  const busyRef = useRef(false);
  const onReconnectRef = useRef(onReconnect);

  useEffect(() => {
    onReconnectRef.current = onReconnect;
  }, [onReconnect]);

  const probe = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      let ok = false;
      try {
        ok = (await check()) === true;
      } catch {
        ok = false;
      }
      const was = prevRef.current;
      prevRef.current = ok;
      setConnected(ok);
      if (ok && !was) {
        try {
          await onReconnectRef.current?.();
        } catch {
          // Re-sync failure surfaces on the next poll, never crashes the UI.
        }
      }
    } finally {
      busyRef.current = false;
    }
  }, [check]);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive) void probe();
    };
    void probe();
    const timer = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [probe, intervalMs]);

  return { connected, recheck: probe };
}
