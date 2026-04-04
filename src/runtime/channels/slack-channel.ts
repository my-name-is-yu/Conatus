import type { Report } from "../../base/types/report.js";
import type { NotificationResult, SlackChannel } from "../../base/types/notification.js";
import { httpPost } from "./http-post.js";

type SlackBlock =
  | { type: "header"; text: { type: "plain_text"; text: string; emoji: boolean } }
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "divider" };

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function formatReportForSlack(
  report: Report,
  format: "compact" | "full"
): { blocks: SlackBlock[]; text: string } {
  const goalLabel = report.goal_id ? `Goal: ${report.goal_id}` : "(no goal)";
  const fallbackText = `[${report.report_type}] ${report.title}`;

  if (format === "compact") {
    const blocks: SlackBlock[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${truncate(report.title, 150)}*\n${goalLabel} | _${report.report_type}_`,
        },
      },
    ];
    return { blocks, text: fallbackText };
  }

  // full format
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: truncate(report.title, 150),
        emoji: false,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Type*: ${report.report_type} | *${goalLabel}*`,
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        // Slack mrkdwn max text block is 3000 chars
        text: truncate(report.content, 2900),
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `_Generated at ${report.generated_at}_`,
      },
    },
  ];

  return { blocks, text: fallbackText };
}

export async function sendSlack(
  channel: SlackChannel,
  report: Report
): Promise<NotificationResult> {
  const payload = formatReportForSlack(report, channel.format);
  try {
    const response = await httpPost(channel.webhook_url, payload as unknown as Record<string, unknown>);
    if (response.statusCode === 200) {
      return {
        channel_type: "slack",
        success: true,
        delivered_at: new Date().toISOString(),
        suppressed: false,
      };
    }
    return {
      channel_type: "slack",
      success: false,
      error: `Slack webhook returned HTTP ${response.statusCode}: ${truncate(response.body, 200)}`,
      suppressed: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      channel_type: "slack",
      success: false,
      error: `Slack webhook error: ${message}`,
      suppressed: false,
    };
  }
}
