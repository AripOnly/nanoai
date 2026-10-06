// src/pages/home.jsx
import { useNavigate, useOutletContext } from "react-router-dom";
import UserInput from "../components/UserInput";

export default function Home() {
  const navigate = useNavigate();
  const { createSession, refreshListSession } = useOutletContext();

  // src/pages/home.jsx
  async function handleCreateSession({ prompt }) {
    const sessionNew = await createSession(prompt);
    await refreshListSession();
    navigate(`/c/${sessionNew.id}`, {
      state: { initialPrompt: prompt },
      replace: true,
    });
  }

  return (
    <div className="w-full h-full relative justify-center items-center content-center">
      <UserInput sendMessage={handleCreateSession} newSession={true} />
    </div>
  );
}
