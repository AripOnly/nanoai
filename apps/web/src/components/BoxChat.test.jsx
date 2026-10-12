// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import BoxChat from "./BoxChat.jsx";

vi.mock("./MarkdownRenderer.jsx", () => ({
  default: () => null,
}));

describe("BoxChat", () => {
  it("aligns the latest user bubble to the top of the chat viewport for a new prompt", () => {
    const context = [
      { role: "user", content: { text: "previous prompt" } },
      { role: "user", content: { text: "new prompt" } },
    ];
    const { container, rerender } = render(
      <BoxChat context={context} newPrompt={false} />,
    );
    const chatViewport = container.firstChild;
    const latestUserBubble =
      container.querySelectorAll(".chat-user-message")[1];

    Object.defineProperty(chatViewport, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(chatViewport, "scrollHeight", {
      configurable: true,
      value: 900,
    });
    chatViewport.scrollTop = 25;
    chatViewport.scrollTo = vi.fn();
    chatViewport.getBoundingClientRect = () => ({ top: 40 });
    latestUserBubble.getBoundingClientRect = () => ({ top: 180 });

    rerender(<BoxChat context={context} newPrompt />);

    expect(container.querySelector("[data-chat-spacer]").style.height).toBe(
      "600px",
    );
    expect(chatViewport.scrollTo).toHaveBeenCalledWith({
      top: 165,
      behavior: "auto",
    });
  });

  it("does not enable auto-scroll when the chat content fits in the viewport", () => {
    const context = [{ role: "user", content: { text: "short prompt" } }];
    const { container, rerender } = render(
      <BoxChat context={context} newPrompt={false} />,
    );
    const chatViewport = container.firstChild;

    Object.defineProperty(chatViewport, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(chatViewport, "scrollHeight", {
      configurable: true,
      value: 300,
    });
    chatViewport.scrollTo = vi.fn();

    rerender(<BoxChat context={context} newPrompt />);

    expect(container.querySelector("[data-chat-spacer]").style.height).toBe("");
    expect(chatViewport.scrollTo).not.toHaveBeenCalled();
  });
});
