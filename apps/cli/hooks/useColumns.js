// useColumns.js

import { useEffect, useState } from "react";
import { useStdout } from "ink";

const subscribers = new Set();
let sharedHandler = null;

export function useColumns() {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(stdout?.columns ?? 80);

  useEffect(() => {
    subscribers.add(setColumns);
    if (sharedHandler === null && stdout) {
      sharedHandler = () => {
        const cols = stdout?.columns ?? 80;
        for (const sub of subscribers) sub(cols);
      };
      stdout.on?.("resize", sharedHandler);
    }
    return () => {
      subscribers.delete(setColumns);
      if (subscribers.size === 0 && sharedHandler !== null) {
        stdout?.off?.("resize", sharedHandler);
        sharedHandler = null;
      }
    };
  }, [stdout]);

  return columns;
}
