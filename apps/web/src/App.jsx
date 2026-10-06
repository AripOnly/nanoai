// src/App.jsx

import { BrowserRouter, Routes, Route } from "react-router-dom";
import AppLayout from "./components/Layout/AppLayout.jsx";
import ChatRoute from "./pages/chatRoute.jsx";
import Home from "./pages/home.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Home />} />
          <Route path="/c/:sessionId" element={<ChatRoute />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
