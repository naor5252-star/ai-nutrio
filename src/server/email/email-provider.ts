import type { RuntimeEnv } from "../context";
import { logEvent } from "../services/logger";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export async function sendApplicationEmail(options: {
  env: RuntimeEnv;
  message: EmailMessage;
  correlationId: string;
}): Promise<{ sent: boolean }> {
  if (options.env.EMAIL_ENABLED !== "true") {
    logEvent({
      severity: "info",
      event: "email_disabled",
      correlationId: options.correlationId,
      outcome: "skipped",
      details: { recipientDomain: options.message.to.split("@")[1] ?? "unknown" },
    });
    return { sent: false };
  }
  const result = await options.env.EMAIL.send({
    to: options.message.to,
    from: options.env.EMAIL_FROM,
    subject: options.message.subject,
    text: options.message.text,
    html: options.message.html,
  });
  logEvent({
    severity: "info",
    event: "email_sent",
    correlationId: options.correlationId,
    outcome: "success",
    details: { messageId: result.messageId },
  });
  return { sent: true };
}
