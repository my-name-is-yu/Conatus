import type { Report } from "../../types/report.js";
import type { NotificationResult, EmailChannel } from "../../types/notification.js";

/** Escape user-controlled strings before embedding in HTML to prevent XSS. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Build a simple HTML body for a report. */
function buildEmailHtml(report: Report): string {
  const rows = [
    ["ID", escapeHtml(report.id)],
    ["Type", escapeHtml(report.report_type)],
    ["Goal", escapeHtml(report.goal_id ?? "(none)")],
    ["Generated", escapeHtml(report.generated_at)],
  ]
    .map(
      ([k, v]) =>
        `<tr><th style="text-align:left;padding:4px 8px;background:#f5f5f5">${k}</th>` +
        `<td style="padding:4px 8px">${v}</td></tr>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;color:#333">
<h2>${escapeHtml(report.title)}</h2>
<table border="0" cellpadding="0" cellspacing="4" style="border-collapse:collapse">
${rows}
</table>
<hr>
<pre style="white-space:pre-wrap;background:#fafafa;padding:12px;border-radius:4px">${escapeHtml(report.content)}</pre>
</body>
</html>`;
}

export async function sendEmail(
  channel: EmailChannel,
  report: Report
): Promise<NotificationResult> {
  try {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.default.createTransport({
      host: channel.smtp.host,
      port: channel.smtp.port,
      secure: channel.smtp.secure,
      auth: {
        user: channel.smtp.auth.user,
        pass: channel.smtp.auth.pass,
      },
    });

    await transport.sendMail({
      from: channel.smtp.auth.user,
      to: channel.address,
      subject: report.title,
      text: `${report.title}\n\n${report.content}`,
      html: buildEmailHtml(report),
    });

    return {
      channel_type: "email",
      success: true,
      delivered_at: new Date().toISOString(),
      suppressed: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      channel_type: "email",
      success: false,
      error: `Email send error: ${message}`,
      suppressed: false,
    };
  }
}
