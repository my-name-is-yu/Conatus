import type { Report } from "../../types/report.js";
import type { NotificationResult, WebhookChannel } from "../../types/notification.js";
import { httpPost } from "./http-post.js";

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function formatReportForWebhook(report: Report): Record<string, unknown> {
  return {
    id: report.id,
    report_type: report.report_type,
    goal_id: report.goal_id,
    title: report.title,
    content: report.content,
    verbosity: report.verbosity,
    generated_at: report.generated_at,
  };
}

export async function sendWebhook(
  channel: WebhookChannel,
  report: Report
): Promise<NotificationResult> {
  const payload = formatReportForWebhook(report);
  try {
    const response = await httpPost(channel.url, payload, channel.headers);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return {
        channel_type: "webhook",
        success: true,
        delivered_at: new Date().toISOString(),
        suppressed: false,
      };
    }
    return {
      channel_type: "webhook",
      success: false,
      error: `Webhook returned HTTP ${response.statusCode}: ${truncate(response.body, 200)}`,
      suppressed: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      channel_type: "webhook",
      success: false,
      error: `Webhook error: ${message}`,
      suppressed: false,
    };
  }
}
