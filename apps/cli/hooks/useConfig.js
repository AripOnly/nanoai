import React, { useState, useEffect, useCallback } from "react";

import { api } from "../lib/api.js";

export function useConfig() {
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState({});
  const [configError, setConfigError] = useState("");

  const switchModel = useCallback(
    async (newModel) => {
      if (!newModel || typeof newModel !== "string") return;
      try {
        setConfigError("");
        const fullModel = newModel.includes("/") ? newModel : `${provider}/${newModel}`;
        await api.updateModel(fullModel);

        const [p, m] = fullModel.split("/");
        if (p) setProvider(p);
        if (m) setModel(m);
      } catch (error) {
        setConfigError(error.message);
      }
    },
    [provider],
  );

  const saveProviderKey = useCallback(async (providerName, key) => {
    try {
      setConfigError("");
      await api.updateProviderKeys({ [providerName]: key });
    } catch (error) {
      setConfigError(error.message);
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const current = await api.getSettings();
      const modelStr = typeof current?.model === "string" ? current.model : "";
      const [currentProvider = "", currentModel = ""] = modelStr.split("/");

      const available = await api.listProviders();
      const byProvider = {};
      if (Array.isArray(available)) {
        for (const entry of available) {
          if (entry?.provider) {
            byProvider[entry.provider] = entry.models ?? [];
          }
        }
      }

      setProvider(currentProvider);
      setModel(currentModel);
      setModels(byProvider);
      setConfigError("");
    } catch {
      // Gateway offline: leave provider/model empty. The chat area already
      // shows the connection error, so stay quiet here to avoid duplicates.
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  return {
    model,
    provider,
    models,
    configError,
    switchModel,
    saveProviderKey,
    reloadConfig: loadConfig,
  };
}
