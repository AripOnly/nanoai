import { useParams } from "react-router-dom";
import Chat from "./chat.jsx";

function ChatRoute() {
  const { sessionId } = useParams();

  return <Chat key={sessionId} />;
}

export default ChatRoute;
