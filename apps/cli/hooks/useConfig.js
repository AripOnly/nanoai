import React, { useState, useEffect, useCallback } from "react";

import { api } from "../lib/api.js";

export function useConfig() {
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState({});
  const [configError, setConfigError] = useState("");

  const switchModel = useCallback(
    async (newModel) => {
      try {
        setConfigError("");
        await api.updateModel(`${provider}/${newModel}`);

        setModel(newModel);
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

  useEffect(() => {
    async function loadConfig() {
      try {
        const current = await api.getSettings();
        const [currentProvider, currentModel] = current.model.split("/");

        const available = await api.listProviders();
        const byProvider = {};
        for (const entry of available) {
          byProvider[entry.provider] = entry.models;
        }

        setProvider(currentProvider);
        setModel(currentModel);
        setModels(byProvider);
      } catch {
        // Gateway offline: leave provider/model empty. The chat area already
        // shows the connection error, so stay quiet here to avoid duplicates.
      }
    }

    loadConfig();
  }, []);

  return {
    model,
    provider,
    models,
    configError,
    switchModel,
    saveProviderKey,
  };
}
