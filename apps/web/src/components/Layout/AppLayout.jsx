// src/components/Layout/index.jsx
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar.jsx";
import useSession from "../../hooks/useSession.js";

export default function AppLayout() {
  const {
    createSession,
    listSession,
    refreshListSession,
    conversation,
    updateConversation,
    resetConversation,
    getSessionInfo,
  } = useSession();

  return (
    <div className="flex w-screen h-screen relative">
      {/* sidebar */}
      <Sidebar listSession={listSession} resetConversation={resetConversation}></Sidebar>

      {/* main content */}
      <main className="flex-1 flex flex-col min-h-0 bg-white relative">
        <Outlet
          context={{
            conversation,
            updateConversation,
            createSession,
            refreshListSession,
            getSessionInfo,
          }}
        ></Outlet>
      </main>
    </div>
  );
}
