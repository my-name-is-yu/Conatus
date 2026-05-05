import {
  clearRegisteredGatewayChatSessionPort,
  exposeRegisteredGatewayChatSessionPort,
  registerGatewayChatSessionPort,
  type GatewayChatSessionPortGetter,
} from "../../runtime/gateway/chat-session-port.js";

export type GlobalCrossPlatformChatSessionManagerGetter = GatewayChatSessionPortGetter;

export function registerGlobalCrossPlatformChatSessionManager(
  getter: GlobalCrossPlatformChatSessionManagerGetter,
): void {
  registerGatewayChatSessionPort(getter);
}

export function exposeRegisteredCrossPlatformChatSessionManager(): void {
  exposeRegisteredGatewayChatSessionPort();
}

export function clearRegisteredCrossPlatformChatSessionManager(): void {
  clearRegisteredGatewayChatSessionPort();
}
