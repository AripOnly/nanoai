// src/components/Layout/Sidebar.jsx
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Settings,
  Search,
  PanelRightOpen,
  SquarePen,
  PanelLeftOpen,
} from "lucide-react";
import ListSessions from "../../components/ListSession";

export default function Sidebar({ listSession, resetHistory }) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  const widthSidebar = isCollapsed ? "w-16" : "w-64";

  function toggleSidebar() {
    setIsCollapsed((current) => !current);
  }

  return (
    <aside
      className={`relative ${widthSidebar} border border-zinc-500 flex flex-col flex-nowrap transition-all`}
    >
      {/* Sidebar nav */}
      <nav className="flex-1 min-h-0 overflow-y-auto">
        {/* Sidebar header */}
        <div
          className={`sticky top-0 flex flex-row flex-nowrap bg-gray-200 p-2 items-center shadow-lg shadow-gray-300 ${
            isCollapsed ? "justify-center" : ""
          }`}
        >
          {!isCollapsed && <p className="text-2xl flex-1 font-medium">Nano</p>}

          <div className="flex flex-row flex-nowrap gap-x-4">
            {!isCollapsed && (
              <button className="hover:cursor-pointer active:scale-95 transition-all">
                <Search />
              </button>
            )}

            <button
              className="hover:cursor-pointer active:scale-95 transition-all"
              onClick={toggleSidebar}
            >
              {isCollapsed ? <PanelLeftOpen /> : <PanelRightOpen />}
            </button>
          </div>
        </div>

        {/* Sidebar menu */}
        <div className={`mt-4 ${isCollapsed ? "flex justify-center" : "px-2"}`}>
          <ul>
            <li>
              <Link
                to={"/"}
                className="px-2 py-1 flex flex-nowrap gap-x-2 hover:bg-gray-200 rounded-sm"
                onClick={() => resetHistory()}
              >
                <SquarePen />

                {!isCollapsed && <span>New Chat</span>}
              </Link>
            </li>
          </ul>
        </div>

        {/* Sidebar sessions */}
        {!isCollapsed && <ListSessions listSessions={listSession} />}
      </nav>

      {/* Sidebar footer */}
      <div
        className={`w-full px-2 py-3 flex flex-row flex-nowrap gap-x-4 bg-gray-200 hover:bg-gray-300 hover:cursor-pointer ${
          isCollapsed ? "justify-center" : ""
        }`}
      >
        <Settings />

        {!isCollapsed && <span>Setting</span>}
      </div>
    </aside>
  );
}
