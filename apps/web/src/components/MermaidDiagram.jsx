import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

let isMermaidInitialized = false;
let diagramSequence = 0;

function prepareSvg(svgSource) {
  const parsed = new DOMParser().parseFromString(svgSource, "image/svg+xml");
  const svg = parsed.documentElement;

  if (parsed.querySelector("parsererror") || svg.localName !== "svg") {
    throw new Error("Mermaid returned invalid SVG");
  }

  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    if (element.localName === "script") {
      element.remove();
      continue;
    }

    if (
      element.localName === "style" &&
      /url\(\s*['"]?(?!#)/i.test(element.textContent)
    ) {
      element.remove();
      continue;
    }

    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) {
        element.removeAttribute(attribute.name);
      } else if (
        ["href", "xlink:href"].includes(attribute.name.toLowerCase()) &&
        !attribute.value.trim().startsWith("#")
      ) {
        element.removeAttribute(attribute.name);
      } else if (
        attribute.name.toLowerCase() === "style" &&
        /url\(\s*['"]?(?!#)/i.test(attribute.value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return document.importNode(svg, true);
}

export default function MermaidDiagram({ chart }) {
  const diagramRef = useRef(null);
  const [renderState, setRenderState] = useState({
    chart,
    status: "loading",
  });
  const status = renderState.chart === chart ? renderState.status : "loading";
  const error = status === "error";

  useEffect(() => {
    let active = true;
    const diagramId = `mermaid-${++diagramSequence}`;
    const diagramElement = diagramRef.current;

    if (!isMermaidInitialized) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      isMermaidInitialized = true;
    }

    diagramElement?.replaceChildren();

    async function renderDiagram() {
      const renderContainer = document.createElement("div");
      renderContainer.setAttribute("aria-hidden", "true");
      Object.assign(renderContainer.style, {
        position: "fixed",
        top: "0",
        left: "-10000px",
        visibility: "hidden",
        pointerEvents: "none",
      });
      document.body.appendChild(renderContainer);

      try {
        const { svg } = await mermaid.render(diagramId, chart, renderContainer);
        if (!active || !diagramElement) return;
        diagramElement.replaceChildren(prepareSvg(svg));
        setRenderState({ chart, status: "ready" });
      } catch {
        if (active) setRenderState({ chart, status: "error" });
      } finally {
        renderContainer.remove();
      }
    }

    renderDiagram();

    return () => {
      active = false;
      diagramElement?.replaceChildren();
    };
  }, [chart]);

  return (
    <div className="markdown-mermaid-wrap max-w-full overflow-x-auto bg-white p-4">
      <div
        ref={diagramRef}
        className="markdown-mermaid flex min-w-max justify-center [&_svg]:h-auto [&_svg]:max-w-full"
        role="img"
        aria-label="Diagram Mermaid"
        aria-busy={status === "loading"}
      />
      {error && (
        <div className="markdown-mermaid-error">
          <p className="mb-2 text-sm text-red-800" role="alert">
            Diagram Mermaid tidak valid. Sumber tersedia di bawah.
          </p>
          <pre className="markdown-mermaid-source m-0 overflow-x-auto rounded border border-gray-200 bg-gray-50 p-3 text-xs leading-6 whitespace-pre">
            <code>{chart}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
