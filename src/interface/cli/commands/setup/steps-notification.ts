import * as p from "@clack/prompts";
import * as fs from "node:fs";
import * as path from "node:path";
import { getPulseedDirPath } from "../../../../base/utils/paths.js";
import {
  NotificationConfigSchema,
  type NotificationChannel,
} from "../../../../runtime/types/notification.js";
import { guardCancel } from "./utils.js";

function validateUrl(value: string | undefined): string | undefined {
  if (!value) return "Enter a valid URL.";
  try {
    new URL(value);
    return undefined;
  } catch {
    return "Enter a valid URL.";
  }
}

export async function stepNotification(): Promise<{ channels: NotificationChannel[] } | null> {
  p.note(
    "Tip: Run `seedpulse telegram setup` to add Telegram notifications later.",
    "Notifications"
  );

  const choice = guardCancel(
    await p.select({
      message: "How would you like to receive notifications?",
      options: [
        { value: "console" as const, label: "Console only (default)" },
        { value: "slack" as const, label: "Slack webhook" },
        { value: "webhook" as const, label: "Generic webhook" },
        { value: "skip" as const, label: "Skip for now" },
      ],
    })
  );

  if (choice === "skip") {
    const confirmed = guardCancel(
      await p.confirm({
        message: "Skip notification setup for now?",
        initialValue: true,
      })
    );
    return confirmed ? null : stepNotification();
  }

  const channels: NotificationChannel[] = [];

  if (choice === "slack") {
    const webhookUrl = guardCancel(
      await p.text({
        message: "Enter Slack webhook URL:",
        placeholder: "https://hooks.slack.com/services/...",
        validate: validateUrl,
      })
    );
    channels.push({
      type: "slack",
      webhook_url: webhookUrl,
      report_types: [],
      format: "compact",
    });
  }

  if (choice === "webhook") {
    const url = guardCancel(
      await p.text({
        message: "Enter webhook URL:",
        placeholder: "https://example.com/webhooks/pulseed",
        validate: validateUrl,
      })
    );
    channels.push({
      type: "webhook",
      url,
      report_types: [],
      format: "json",
    });
  }

  const config = NotificationConfigSchema.parse({ channels });
  const configPath = path.join(getPulseedDirPath(), "notification.json");
  fs.mkdirSync(getPulseedDirPath(), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

  return { channels: config.channels };
}
