// ─── App ───
//
// Root Ink component that composes Dashboard + Chat and manages shared state.
// Wires LoopController state updates into React state and routes chat input
// through IntentRecognizer → ActionHandler.

import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { Dashboard } from "./dashboard.js";
import { Chat, type ChatMessage } from "./chat.js";
import { HelpOverlay } from "./help-overlay.js";
import type { LoopController, LoopState } from "./use-loop.js";
import type { ActionHandler } from "./actions.js";
import type { IntentRecognizer } from "./intent-recognizer.js";

interface AppProps {
  loopController: LoopController;
  actionHandler: ActionHandler;
  intentRecognizer: IntentRecognizer;
}

const StatusBar: React.FC<{
  goalCount: number;
  trustScore: number;
  status: string;
  iteration: number;
}> = ({ goalCount, trustScore, status, iteration }) => (
  <Box
    borderStyle="single"
    borderColor="gray"
    paddingX={1}
    justifyContent="space-between"
  >
    <Text dimColor>
      Active: {goalCount}  Trust: {trustScore >= 0 ? "+" : ""}
      {trustScore}  Status: {status}  Iter: {iteration}
    </Text>
    <Text dimColor>?:help  Ctrl-C:quit</Text>
  </Box>
);

export function App({ loopController, actionHandler, intentRecognizer }: AppProps) {
  const [loopState, setLoopState] = useState<LoopState>(loopController.getState());
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "motiva",
      text: "What would you like to do? Type '/help' for available commands.",
      timestamp: new Date(),
      messageType: "info",
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    loopController.setOnUpdate(setLoopState);
    return () => loopController.setOnUpdate(null);
  }, [loopController]);

  // F1 key toggles help overlay (in addition to '?' shortcut via chat).
  // F1 sends escape sequences: "\u001bOP" (xterm) or "\u001b[11~" (vt100).
  // isActive:false when help is shown — HelpOverlay handles its own ESC key,
  // and we avoid competing with TextInput for input events during normal chat.
  useInput((rawInput) => {
    if (
      rawInput === "\u001bOP" ||
      rawInput === "\u001b[11~" ||
      rawInput === "\u001b[[A"
    ) {
      setShowHelp((prev) => !prev);
    }
  }, { isActive: !showHelp });

  const handleInput = useCallback(
    async (input: string) => {
      // Add user message
      setMessages((prev) => [
        ...prev,
        { role: "user", text: input, timestamp: new Date() },
      ]);
      setIsProcessing(true);

      // Recognize intent
      const intent = await intentRecognizer.recognize(input);

      // Execute action
      const result = await actionHandler.handle(intent);

      // Handle help overlay signal — do not add messages to chat
      if (result.showHelp) {
        setShowHelp(true);
        setIsProcessing(false);
        return;
      }

      // Add response messages
      setMessages((prev) => [
        ...prev,
        ...result.messages.map((text) => ({
          role: "motiva" as const,
          text,
          timestamp: new Date(),
          messageType: (text.startsWith("Failed") || text.startsWith("Error"))
            ? ("error" as const)
            : ("info" as const),
        })),
      ]);

      // Handle loop signals
      if (result.startLoop) {
        void loopController.start(result.startLoop.goalId);
      }
      if (result.stopLoop) {
        loopController.stop();
      }

      setIsProcessing(false);
    },
    [intentRecognizer, actionHandler, loopController]
  );

  // goalCount: 1 when there is an active goal in the loop, 0 otherwise
  const goalCount = loopState.goalId !== null ? 1 : 0;

  return (
    <Box flexDirection="column" height={process.stdout.rows || 24}>
      {/* App header */}
      <Text bold color="blue">
        [ MOTIVA ]
      </Text>

      <Dashboard state={loopState} />

      {showHelp ? (
        <HelpOverlay onDismiss={() => setShowHelp(false)} />
      ) : (
        <Chat messages={messages} onSubmit={handleInput} isProcessing={isProcessing} />
      )}

      <StatusBar
        goalCount={goalCount}
        trustScore={loopState.trustScore}
        status={loopState.status}
        iteration={loopState.iteration}
      />
    </Box>
  );
}
