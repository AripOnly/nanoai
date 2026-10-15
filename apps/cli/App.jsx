// App.jsx

import React, { useEffect, useMemo, useState } from "react";
import { Box, useApp, Static, Text } from "ink";

import { useChat } from "./hooks/useChat.js";
import { useConfig } from "./hooks/useConfig.js";
import { useColumns } from "./hooks/useColumns.js";
import { api } from "./lib/api.js";
import { attachToolResults } from "./lib/tool-display.js";
import Banner from "./components/Banner.jsx";
import PromptInput from "./components/PromptInput.jsx";
import Spinner from "./components/Spinner.jsx";
import BoxChat from "./components/BoxChat.jsx";
import Thinking from "./components/Thinking.jsx";

export default function App({ onExitRequest }) {
  const columns = useColumns();
  const { exit } = useApp();
  // Embedded mode (nanoai console): leaving chat returns to the console
  // instead of quitting the process.
  const handleExit = onExitRequest ?? exit;
  const {
    chat,
    conversation,
    thinking,
    loading,
    queuedCount,
    send,
    sessions,
    activeSession,
    viewKey,
    newSession,
    switchSession,
    deleteSession,
    renameSession,
  } = useChat();

  const { provider, model, models, configError, switchModel, saveProviderKey } =
    useConfig();
  const [token, setToken] = useState(0);

  const sessionItems = useMemo(
    () => [
      <Banner key={`banner-${viewKey}`} />,
      ...attachToolResults(conversation).map((item, i) => (
        <BoxChat key={`h-${item?.content?.call_id ?? item?.id ?? i}`} chat={[item]} />
      )),
    ],
    [viewKey, conversation],
  );

  const boxLoading = (
    <Text color="#FFA500">
      <Spinner type="dotsCircle" />
      {" Loading..."}
    </Text>
  );

  useEffect(() => {
    if (!activeSession?.id) {
      setToken(0);
      return;
    }
    let cancelled = false;
    api
      .getSessionInfo(activeSession.id)
      .then((session) => {
        if (!cancelled) {
          setToken(session?.token ?? 0);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setToken(0);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [conversation, activeSession?.id]);

  return (
    <>
      <Static
        key={viewKey}
        items={[...sessionItems]}
        style={{ width: columns, paddingLeft: 1, paddingRight: 1 }}
      >
        {(el) => el}
      </Static>

      <Box flexDirection="column" width={columns} paddingX={1}>
        <Box width={"100%"} flexDirection="column" flexWrap="nowrap">
          <BoxChat chat={chat} />
        </Box>

        <Box marginTop={1} justifyContent="center" paddingX={2}>
          <Box width={"100%"}>{thinking && <Thinking />}</Box>
        </Box>

        <PromptInput
          onSend={send}
          onExit={handleExit}
          onNew={newSession}
          onSwitchSession={switchSession}
          onDeleteSession={deleteSession}
          onRenameSession={renameSession}
          sessions={sessions}
          provider={provider}
          providers={Object.keys(models)}
          models={models}
          onSwitchModel={switchModel}
          onSaveProviderKey={saveProviderKey}
        />

        <Box
          marginTop={1}
          marginBottom={2}
          paddingX={2}
          flexDirection="row"
          flexWrap="nowrap"
          justifyContent="space-between"
        >
          <Box>{loading ? boxLoading : ""}</Box>
          <Box flexDirection="row" flexWrap="nowrap" gap={2}>
            {configError ? <Text color="red">{configError}</Text> : null}
            {queuedCount > 0 ? <Text color="yellow">antrean: {queuedCount}</Text> : null}
            {columns < 70 ? (
              <>
                <Text>T:{token}</Text>
                <Text>|</Text>
                <Text>{activeSession?.name ?? "-"}</Text>
                <Text>|</Text>
                <Text>
                  {provider && model ? `${provider}/${model}` : "-"}
                </Text>
              </>
            ) : (
              <>
                <Text>Token: {token}</Text>
                <Text>|</Text>
                <Text>session: {activeSession?.name ?? "-"}</Text>
                <Text>|</Text>
                <Text>agent: Nano</Text>
                <Text>|</Text>
                <Text>
                  model: {provider && model ? `${provider}/${model}` : "-"}
                </Text>
              </>
            )}
          </Box>
        </Box>
      </Box>
    </>
  );
}
