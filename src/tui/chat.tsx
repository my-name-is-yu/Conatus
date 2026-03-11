// ─── Chat ───
//
// Chat area component with message log and text input.
// Renders visible messages based on terminal height, with scroll indicator,
// styled user/AI distinction, spinner, timestamps, and color-coded message types.

import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { renderMarkdownLines, type MarkdownLine } from "./markdown-renderer.js";

export interface ChatMessage {
  role: "user" | "motiva";
  text: string;
  timestamp: Date;
  messageType?: "info" | "error" | "warning" | "success";
}

interface ChatProps {
  messages: ChatMessage[];
  onSubmit: (input: string) => void;
  isProcessing: boolean; // show "thinking..." indicator
}

function getMessageTypeColor(
  messageType: ChatMessage["messageType"]
): string | undefined {
  switch (messageType) {
    case "error":
      return "red";
    case "warning":
      return "yellow";
    case "success":
      return "green";
    case "info":
      return "blue";
    default:
      return undefined;
  }
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Render a single MarkdownLine with appropriate styling */
function MarkdownLineComponent({
  line,
  color,
}: {
  line: MarkdownLine;
  color?: string;
}) {
  const props: Record<string, unknown> = {};
  if (line.bold) props.bold = true;
  if (line.dim) props.dimColor = true;
  if (color) props.color = color;

  // Empty line -> render as blank space
  if (line.text === "") {
    return <Text> </Text>;
  }

  return <Text {...props}>{line.text}</Text>;
}

const COMMANDS = [
  { name: '/run', aliases: ['/start'], description: 'Start the goal loop' },
  { name: '/stop', aliases: ['/quit'], description: 'Stop the running loop' },
  { name: '/status', aliases: [] as string[], description: 'Show current progress' },
  { name: '/report', aliases: [] as string[], description: 'Generate a summary report' },
  { name: '/goals', aliases: [] as string[], description: 'List all goals' },
  { name: '/help', aliases: ['?'], description: 'Show help overlay' },
];

function getMatchingCommands(input: string): typeof COMMANDS {
  if (!input.startsWith('/')) return [];
  const query = input.toLowerCase();
  return COMMANDS.filter(
    (cmd) =>
      cmd.name.startsWith(query) ||
      cmd.aliases.some((a) => a.startsWith(query))
  ).slice(0, 6);
}

export function Chat({ messages, onSubmit, isProcessing }: ChatProps) {
  const [input, setInput] = useState("");

  const handleSubmit = (value: string) => {
    if (!value.trim() || isProcessing) return;
    onSubmit(value.trim());
    setInput("");
  };

  // Cap visible messages based on terminal height
  const termRows = process.stdout.rows || 40;
  const visibleCount = Math.max(termRows - 12, 8);
  const startIdx = Math.max(messages.length - visibleCount, 0);
  const visibleMessages = messages.slice(startIdx);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Scroll indicator */}
      {startIdx > 0 && (
        <Text dimColor>{"\u2191"} {startIdx} earlier messages</Text>
      )}

      {/* Message log */}
      <Box flexDirection="column" flexGrow={1}>
        {visibleMessages.map((msg, i) => {
          const timeStr = formatTime(msg.timestamp ?? new Date());

          if (msg.role === "user") {
            return (
              <Box key={i} flexDirection="column" marginBottom={2}>
                <Box>
                  <Text color="cyan" bold>
                    {"\u276F "}
                  </Text>
                  <Text>{msg.text}</Text>
                  <Text dimColor> {timeStr}</Text>
                </Box>
              </Box>
            );
          }

          // Motiva message — render markdown lines individually
          const typeColor = getMessageTypeColor(msg.messageType);
          const mdLines = renderMarkdownLines(msg.text);

          return (
            <Box key={i} flexDirection="column" marginBottom={1} marginLeft={2}>
              <Box justifyContent="space-between">
                <Text color="magenta" bold>
                  Motiva
                </Text>
                <Text dimColor>{timeStr}</Text>
              </Box>
              <Box flexDirection="column">
                {mdLines.map((line, j) => (
                  <MarkdownLineComponent
                    key={j}
                    line={line}
                    color={typeColor}
                  />
                ))}
              </Box>
            </Box>
          );
        })}

        {/* Thinking spinner */}
        {isProcessing && (
          <Box>
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
            <Text color="yellow"> Thinking...</Text>
          </Box>
        )}
      </Box>

      {/* Input area with borders */}
      {(() => {
        const termCols = process.stdout.columns || 80;
        const borderLine = "\u2500".repeat(termCols);
        const matches = getMatchingCommands(input);
        return (
          <Box flexDirection="column">
            <Text dimColor>{borderLine}</Text>
            <Box>
              <Text color="green" bold>
                {"\u276F "}
              </Text>
              <TextInput
                value={input}
                onChange={setInput}
                onSubmit={handleSubmit}
              />
            </Box>
            <Text dimColor>{borderLine}</Text>
            {matches.length > 0 && (
              <Box flexDirection="column">
                {matches.map((cmd, idx) => {
                  const label = `  ${cmd.name.padEnd(20)}${cmd.description}`;
                  return idx === 0 ? (
                    <Text key={cmd.name} bold color="blue">{label}</Text>
                  ) : (
                    <Text key={cmd.name} dimColor>{label}</Text>
                  );
                })}
              </Box>
            )}
          </Box>
        );
      })()}
    </Box>
  );
}
