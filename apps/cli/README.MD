# CLI Application (apps/cli/)

This directory contains the Command Line Interface (CLI) application built using React and Ink for interactive terminal rendering.

## Overview

The CLI application provides an interactive terminal interface for communicating with the NanoAI agent. It leverages React components and Ink to render streaming AI responses, markdown styling, syntax-highlighted code blocks, tool invocations, session management, and slash commands.

## Architecture & Core Files

*   **`main.jsx`**: Initializes the CLI runtime, prints the banner, and mounts `<App />` using Ink's `render()`.
*   **`App.jsx`**: Main UI container orchestrating session history, streaming status, interactive input, and token usage indicators.

## Components (`components/`)

*   **`Banner.jsx`**: Renders the ASCII art header banner at the top of each session view.
*   **`BoxChat.jsx`**: Renders message turns (user prompts, AI responses, compaction markers, tool calls, and errors).
*   **`CommandBox.jsx`**: Slash command picker (`/session`, `/new`, `/model`, `/provider`, `/exit`).
*   **`ModelList.jsx`**: Interactive model selection menu per provider.
*   **`PromptInput.jsx`**: Text and command input controller with modal flows for renaming sessions and entering provider keys.
*   **`Response.jsx`**: Renders AI assistant messages and compaction summaries with markdown formatting.
*   **`SelectInput.jsx`**: Accessible arrow/vi-key navigable terminal selection list.
*   **`SessionList.jsx`**: Interactive session picker.
*   **`Spinner.jsx`**: Animated terminal loading spinner.
*   **`Thinking.jsx`**: Reasoning / thinking state indicator.
*   **`ToolCall.jsx`**: Renders live and completed tool executions with arguments and output previews.
*   **`User.jsx`**: User prompt display box.
*   **`markdown/Markdown.jsx`**: Markdown renderer supporting headings, lists, blockquotes, tables, and Monokai syntax highlighting.
*   **`markdown/monokai.js`**: Monokai color palette and code tokenizer powered by `highlight.js`.

## Custom Hooks (`hooks/`)

*   **`useChat.js`**: Manages chat state, discrete session view epochs (`viewKey`), FIFO prompt queue, SSE streaming, and session switching/renaming.
*   **`useConfig.js`**: Loads and switches LLM providers and models from the gateway settings.
*   **`useColumns.js`**: Tracks terminal width dynamically on terminal resize events.

## Utilities (`lib/`)

*   **`api.js`**: Authenticated HTTP & SSE client for communicating with the NanoAI gateway.
*   **`terminal.js`**: ANSI screen and scrollback buffer clearing utility (`clearTerminal`).
*   **`tool-display.js`**: Formatting helpers for tool call targets and preview truncation.

