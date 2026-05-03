import { randomUUID } from "node:crypto";
import type { ChatEventHandler } from "../chat/chat-events.js";
import type { ChatRunResult, ChatRunnerDeps } from "../chat/chat-runner.js";
import { CrossPlatformChatSessionManager } from "../chat/cross-platform-session.js";
import type { CrossPlatformIngressMessage } from "../chat/cross-platform-session.js";

export interface TuiChatSurface {
  onEvent?: ChatEventHandler;
  startSession(cwd: string): void;
  getConversationId?(): string;
  execute(input: string, cwd: string): Promise<ChatRunResult>;
  interruptAndRedirect(input: string, cwd: string): Promise<ChatRunResult>;
  executeIngressMessage(ingress: CrossPlatformIngressMessage, cwd: string): Promise<ChatRunResult>;
}

export class SharedManagerTuiChatSurface implements TuiChatSurface {
  onEvent: ChatEventHandler | undefined = undefined;

  private readonly conversationId = randomUUID();
  private readonly userId = "local_tui_user";
  private sessionCwd: string | null = null;
  private readonly manager: CrossPlatformChatSessionManager;

  constructor(deps: ChatRunnerDeps) {
    this.manager = new CrossPlatformChatSessionManager(deps);
  }

  startSession(cwd: string): void {
    this.sessionCwd = cwd;
  }

  getConversationId(): string {
    return this.conversationId;
  }

  execute(input: string, cwd: string): Promise<ChatRunResult> {
    const effectiveCwd = this.sessionCwd ?? cwd;
    const messageId = randomUUID();
    return this.manager.execute(input, {
      channel: "tui",
      platform: "local_tui",
      conversation_id: this.conversationId,
      user_id: this.userId,
      message_id: messageId,
      cwd: effectiveCwd,
      onEvent: this.onEvent,
      runtimeControl: {
        allowed: true,
        approvalMode: "interactive",
      },
      replyTarget: {
        surface: "tui",
        channel: "tui",
        platform: "local_tui",
        conversation_id: this.conversationId,
        user_id: this.userId,
        message_id: messageId,
      },
    });
  }

  interruptAndRedirect(input: string, cwd: string): Promise<ChatRunResult> {
    const effectiveCwd = this.sessionCwd ?? cwd;
    const messageId = randomUUID();
    return this.manager.interruptAndRedirect({
      channel: "tui",
      platform: "local_tui",
      conversation_id: this.conversationId,
      user_id: this.userId,
      message_id: messageId,
      cwd: effectiveCwd,
      text: input,
      onEvent: this.onEvent,
    });
  }

  executeIngressMessage(ingress: CrossPlatformIngressMessage, cwd: string): Promise<ChatRunResult> {
    const effectiveCwd = this.sessionCwd ?? cwd;
    const messageId = ingress.message_id ?? ingress.replyTarget?.message_id ?? randomUUID();
    return this.manager.executeIngress({
      ...ingress,
      channel: ingress.channel ?? "tui",
      platform: ingress.platform ?? "local_tui",
      conversation_id: ingress.conversation_id ?? this.conversationId,
      user_id: ingress.user_id ?? ingress.actor?.user_id ?? ingress.replyTarget?.user_id ?? this.userId,
      message_id: messageId,
      replyTarget: {
        ...ingress.replyTarget,
        channel: ingress.replyTarget?.channel ?? "tui",
        platform: ingress.replyTarget?.platform ?? ingress.platform ?? "local_tui",
        conversation_id: ingress.replyTarget?.conversation_id ?? ingress.conversation_id ?? this.conversationId,
        user_id: ingress.replyTarget?.user_id ?? ingress.user_id ?? this.userId,
        message_id: messageId,
      },
      actor: {
        ...ingress.actor,
        surface: ingress.actor?.surface ?? "tui",
        platform: ingress.actor?.platform ?? ingress.platform ?? "local_tui",
        conversation_id: ingress.actor?.conversation_id ?? ingress.conversation_id ?? this.conversationId,
        user_id: ingress.actor?.user_id ?? ingress.user_id ?? this.userId,
      },
    }, {
      cwd: effectiveCwd,
      onEvent: this.onEvent,
    });
  }
}
