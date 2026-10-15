// apps/cli/components/Markdown.jsx

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { marked } from "marked";
import { highlightBlock, highlightInline, languageName } from "./monokai.js";
import { useColumns } from "../../hooks/useColumns.js";

const CODE_BG = "#272822";
const CODE_TEXT = "#f8f8f2";
const LANG_LABEL = "#66d9ef";

function inlineTokens(tokens) {
  return (tokens || []).map((t, i) => {
    switch (t.type) {
      case "strong":
        return (
          <Text key={i} bold>
            {inlineTokens(t.tokens)}
          </Text>
        );
      case "em":
        return (
          <Text key={i} italic color="yellow">
            {inlineTokens(t.tokens)}
          </Text>
        );
      case "del":
        return (
          <Text key={i} strikethrough color="gray">
            {inlineTokens(t.tokens)}
          </Text>
        );
      case "codespan":
        return (
          <Text key={i}>
            {highlightInline(t.text).map((seg, k) => (
              <Text key={k} color={seg.color}>
                {seg.text}
              </Text>
            ))}
          </Text>
        );
      case "link":
        return (
          <Text key={i} color="cyan" underline>
            {inlineTokens(t.tokens)}
          </Text>
        );
      case "br":
        return "\n";
      case "text":
        if (t.tokens) {
          return <Text key={i}>{inlineTokens(t.tokens)}</Text>;
        }
        return t.text;
      default:
        return <Text key={i}>{t.raw}</Text>;
    }
  });
}

function Inline({ tokens, dim }) {
  return (
    <Text wrap="wrap" color={dim ? "gray" : undefined}>
      {inlineTokens(tokens)}
    </Text>
  );
}

// Pecah inline tokens jadi baris-baris (mendukung teks mengandung \n).
function splitLines(tokens) {
  const lines = [];
  let current = [];

  for (const t of tokens || []) {
    if (t.type === "br" || (t.type === "text" && /\n/.test(t.text ?? ""))) {
      const parts = (t.text ?? "").split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          lines.push(current);
          current = [];
        }
        if (parts[i]) {
          current.push({ ...t, text: parts[i], tokens: undefined });
        }
      }
    } else {
      current.push(t);
    }
  }

  lines.push(current);
  return lines;
}

// Render the highlighted segment array of a single code line. Empty lines keep
// a single space so the block preserves its vertical rhythm.
function renderCodeLine(line) {
  return line.map((seg, i) => (
    <Text key={i} color={seg.color}>
      {seg.text}
    </Text>
  ));
}

export default function Markdown({ content, width }) {
  const winColumns = useColumns();
  const columns = width ?? winColumns ?? 80;
  const tokens = useMemo(
    () =>
      marked.lexer(
        typeof content === "string" ? content : (content?.text ?? ""),
      ),
    [content],
  );

  function renderBlock(token, key, hasMargin = false) {
    const margin = hasMargin ? 1 : 0;

    switch (token.type) {
      case "heading": {
        const depth = Math.min(Math.max(token.depth, 1), 6);
        return (
          <Box
            key={key}
            marginBottom={1}
            marginTop={depth <= 2 ? 1 : 0}
            flexDirection="column"
          >
            <Text bold underline={depth === 1} color="#61afef">
              {inlineTokens(token.tokens)}
            </Text>
          </Box>
        );
      }

      case "paragraph":
        return (
          <Box key={key} marginBottom={margin}>
            <Inline tokens={token.tokens} />
          </Box>
        );

      case "list": {
        const markerWidth = token.ordered ? 3 : 2;
        return (
          <Box key={key} marginBottom={margin} flexDirection="column">
            {token.items.map((item, j) => {
              const marker = token.ordered
                ? `${j + 1}. `
                : item.task
                  ? item.checked
                    ? "☑ "
                    : "☐ "
                  : "• ";
              const markerColor = item.task
                ? item.checked
                  ? "green"
                  : "gray"
                : "#ffb86c";
              const blocks = item.tokens.filter(
                (blk) => blk.type !== "checkbox",
              );
              return (
                <Box key={j} flexDirection="row">
                  <Text color={markerColor}>{marker}</Text>
                  <Box
                    flexDirection="column"
                    width={Math.max(columns - markerWidth - 4, 10)}
                  >
                    {blocks.map((blk, k) => {
                      if (blk.type === "paragraph" || blk.type === "text") {
                        return (
                          <Inline
                            key={k}
                            dim={item.task && item.checked}
                            tokens={
                              blk.type === "paragraph" ? blk.tokens : [blk]
                            }
                          />
                        );
                      }
                      return renderBlock(
                        blk,
                        k,
                        blocks[k + 1]?.type === "space",
                      );
                    })}
                  </Box>
                </Box>
              );
            })}
          </Box>
        );
      }

      case "blockquote": {
        const blocks = token.tokens
          .map((blk) => (blk.type === "paragraph" ? blk.tokens : [blk]))
          .flat();
        return (
          <Box key={key} marginBottom={margin} flexDirection="column">
            {splitLines(blocks).map((line, j) => (
              <Box key={j} flexDirection="row">
                <Text color="yellow">│ </Text>
                <Box width={Math.max(columns - 4, 10)}>
                  <Inline dim tokens={line} />
                </Box>
              </Box>
            ))}
          </Box>
        );
      }

      case "code": {
        const lines = highlightBlock(token.text, token.lang);
        return (
          <Box key={key} flexDirection="column" marginBottom={margin}>
            {token.lang && (
              <Box flexDirection="row">
                <Text color={LANG_LABEL} bold>
                  ▌ {languageName(token.lang)}
                </Text>
              </Box>
            )}
            <Box
              flexDirection="column"
              backgroundColor={CODE_BG}
              paddingX={2}
              paddingY={1}
            >
              {lines.map((line, j) => (
                <Text key={j} color={CODE_TEXT}>
                  {renderCodeLine(line)}
                </Text>
              ))}
            </Box>
          </Box>
        );
      }

      case "hr":
        return (
          <Box key={key} marginBottom={margin}>
            <Text color="gray">{"─".repeat(Math.max(columns - 1, 0))}</Text>
          </Box>
        );

      case "space":
        return null;

      case "text":
        return (
          <Box key={key} marginBottom={margin}>
            <Inline tokens={token.tokens} />
          </Box>
        );

      case "table": {
        const widths = token.header.map((_, c) =>
          Math.max(
            token.header[c].text.length,
            ...token.rows.map((r) => (r[c]?.text ?? "").length),
          ),
        );
        const border = (left, mid, right) =>
          `${left}${widths.map((w) => "─".repeat(w + 2)).join(mid)}${right}`;

        const renderCellInner = (cell, w, isHeader) => {
          const align = cell.align || "left";
          const node = (
            <Text bold={isHeader} wrap="wrap">
              {cell.tokens ? inlineTokens(cell.tokens) : cell.text}
            </Text>
          );

          if (align === "right") {
            return (
              <Box width={w + 2} justifyContent="flex-end" paddingRight={1}>
                {node}
              </Box>
            );
          }
          if (align === "center") {
            return (
              <Box width={w + 2} justifyContent="center">
                {node}
              </Box>
            );
          }
          return (
            <Box width={w + 2} paddingLeft={1}>
              {node}
            </Box>
          );
        };

        const renderRow = (row, isHeader, rowKey) => (
          <Box key={rowKey} flexDirection="row">
            <Text color="gray">│</Text>
            {row.map((cell, c) => (
              <Box key={c} flexDirection="row">
                {renderCellInner(cell, widths[c], isHeader)}
                <Text color="gray">│</Text>
              </Box>
            ))}
          </Box>
        );

        return (
          <Box key={key} marginBottom={margin} flexDirection="column">
            <Text color="gray">{border("┌", "┬", "┐")}</Text>
            {renderRow(token.header, true, "h")}
            <Text color="gray">{border("├", "┼", "┤")}</Text>
            {token.rows.map((r, i) => renderRow(r, false, i))}
            <Text color="gray">{border("└", "┴", "┘")}</Text>
          </Box>
        );
      }

      case "html":
        return null;

      default:
        return <Box key={key} marginBottom={margin}></Box>;
    }
  }

  return (
    <Box flexDirection="column" width={columns}>
      {tokens.map((t, i) => renderBlock(t, i, tokens[i + 1]?.type === "space"))}
    </Box>
  );
}
