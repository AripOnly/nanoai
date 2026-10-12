// src/components/BoxChat.jsx

import { useLayoutEffect, useRef } from "react";
import MarkdownRenderer from "./MarkdownRenderer.jsx";

export default function BoxChat({
  context,
  isStreaming = false,
  newPrompt = false,
}) {
  /** @type {import("react").RefObject<HTMLDivElement | null>} */
  const containerRef = useRef(null);

  /** @type {import("react").RefObject<HTMLDivElement | null>} */
  const lastUserBubbleRef = useRef(null);

  const lastUserIndex = context.findLastIndex((value) => value.role === "user");

  /** @type {import("react").RefObject<HTMLDivElement | null>} */
  const spacerRef = useRef(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const spacer = spacerRef.current;
    const lastUserBubble = lastUserBubbleRef.current;

    if (!container || !spacer || !lastUserBubble) return;

    spacer.style.height = "";
    if (container.scrollHeight <= container.clientHeight) return;

    spacer.style.height = `${container.clientHeight - 130}px`;
    const containerTop = container.getBoundingClientRect().top;
    const bubbleTop = lastUserBubble.getBoundingClientRect().top;
    const scrollTop = container.scrollTop + bubbleTop - containerTop;
    if (typeof container.scrollTo === "function") {
      container.scrollTo({ top: scrollTop - 25, behavior: "smooth" });
    } else {
      container.scrollTop = scrollTop;
    }
  }, [context, newPrompt]);

  return (
    <div
      ref={containerRef}
      className="flex-1 flex w-full justify-center overflow-y-auto"
    >
      <div className="w-full max-w-3xl flex flex-col">
        {context.map((value, index) => {
          if (value.role === "user") {
            return (
              <div
                key={index}
                ref={index === lastUserIndex ? lastUserBubbleRef : null}
                className="chat-user-message border max-w-[75%] md:max-w-[50%] p-2 mt-4 rounded-md bg-gray-100 ml-auto"
              >
                {value.content.text}
              </div>
            );
          }

          if (value.role === "assistant") {
            return (
              <div
                id={"assistant"}
                key={index}
                className="w-full min-w-0 p-2 mt-4"
              >
                <MarkdownRenderer
                  content={value.content?.text ?? ""}
                  isStreaming={isStreaming && index === context.length - 1}
                />
              </div>
            );
          }

          if (value.role === "tool_call") {
            return (
              <div key={index} className="w-full p-2 mt-4 text-gray-500 italic">
                🔧 {value.content.name}
              </div>
            );
          }

          if (value.role === "error") {
            return (
              <div
                key={index}
                className="w-full p-2 mt-4 text-red-600 bg-red-50 rounded-md"
              >
                ⚠️ {value.content.message}
              </div>
            );
          }

          return null;
        })}

        <div ref={spacerRef} data-chat-spacer className="w-full shrink-0"></div>
      </div>
    </div>
  );
}
