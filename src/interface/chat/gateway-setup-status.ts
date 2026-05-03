import * as path from "node:path";
import { readJsonFileOrNull } from "../../base/utils/json-io.js";
import { getGatewayChannelDir, getPulseedDirPath } from "../../base/utils/paths.js";
import { isDaemonRunning } from "../../runtime/daemon/client.js";
import type { TelegramGatewayConfig } from "../../runtime/gateway/telegram-gateway-adapter.js";

export type TelegramSetupState = "unconfigured" | "partially_configured" | "configured";

export interface TelegramSetupStatus {
  channel: "telegram";
  state: TelegramSetupState;
  configPath: string;
  daemon: {
    running: boolean;
    port: number;
  };
  gateway: {
    loadState: "unknown";
  };
  config: {
    exists: boolean;
    hasBotToken: boolean;
    hasHomeChat: boolean;
    allowAll: boolean;
    allowedUserCount: number;
    runtimeControlAllowedUserCount: number;
    identityKeyConfigured: boolean;
  };
}

export interface GatewaySetupStatusProvider {
  getTelegramStatus(baseDir?: string): Promise<TelegramSetupStatus>;
}

export interface GatewaySetupStatusProviderDeps {
  daemonStatus?: (baseDir: string) => Promise<{ running: boolean; port: number }>;
}

export function createGatewaySetupStatusProvider(
  deps: GatewaySetupStatusProviderDeps = {}
): GatewaySetupStatusProvider {
  return {
    async getTelegramStatus(baseDir = getPulseedDirPath()): Promise<TelegramSetupStatus> {
      const configPath = path.join(getGatewayChannelDir("telegram-bot", baseDir), "config.json");
      const config = await readJsonFileOrNull<Partial<TelegramGatewayConfig>>(configPath);
      const daemon = await (deps.daemonStatus ?? isDaemonRunning)(baseDir);
      const hasBotToken = typeof config?.bot_token === "string" && config.bot_token.trim().length > 0;
      const hasHomeChat = typeof config?.chat_id === "number";
      const state: TelegramSetupState = !hasBotToken
        ? "unconfigured"
        : hasHomeChat
          ? "configured"
          : "partially_configured";
      return {
        channel: "telegram",
        state,
        configPath,
        daemon: {
          running: daemon.running,
          port: daemon.port,
        },
        gateway: {
          loadState: "unknown",
        },
        config: {
          exists: config !== null,
          hasBotToken,
          hasHomeChat,
          allowAll: config?.allow_all === true,
          allowedUserCount: Array.isArray(config?.allowed_user_ids) ? config.allowed_user_ids.length : 0,
          runtimeControlAllowedUserCount: Array.isArray(config?.runtime_control_allowed_user_ids)
            ? config.runtime_control_allowed_user_ids.length
            : 0,
          identityKeyConfigured: typeof config?.identity_key === "string" && config.identity_key.trim().length > 0,
        },
      };
    },
  };
}
