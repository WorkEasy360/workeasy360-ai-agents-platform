import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { env } from "../config/env";
import { errSummary, logger } from "./logger";
import { getEmailQueue } from "./queue";

/**
 * Email goes through a queue: the request that triggers it only adds a job, and the worker delivers it
 * (with retries). A slow or failing mail service never fails or slows the user's request.
 *
 * Transports (env.mailTransport):
 *  - ses: Amazon SES v2. Credentials come from the default AWS chain, i.e. the EC2 instance role.
 *  - log: prints the message to the worker's log instead of sending it (development, or testing a server
 *         before SES is set up). The log then contains links from the emails; don't leave it on for real users.
 *  - off: nothing is queued; callers fall back (e.g. invite links are shown to the admin on screen).
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** For logs and metrics only. */
export type MailKind =
  | "verify-email"
  | "reset-password"
  | "invitation"
  | "password-changed"
  | "two-factor-changed"
  | "account-deleted"
  | "organization-status"
  | "usage-alert"
  | "agent-tool";

/**
 * Queues a message. Never throws: auth flows must not reveal or depend on delivery.
 * Returns false when email is off or the queue is unreachable.
 */
export async function queueMail(kind: MailKind, message: MailMessage): Promise<boolean> {
  if (!env.emailEnabled) {
    logger.info({ kind }, "email is off (SES_REGION not set); message not sent");
    return false;
  }
  try {
    await getEmailQueue().add(kind, message, {
      attempts: 6,
      backoff: { type: "exponential", delay: 10_000 },
      // The body can hold a sign-in link: don't keep it in Redis longer than needed.
      removeOnComplete: true,
      removeOnFail: { age: 24 * 3600 },
    });
    return true;
  } catch (err) {
    logger.error({ kind, err: errSummary(err) }, "could not queue email");
    return false;
  }
}

let ses: SESv2Client | undefined;

/** Delivers one message. Called by the worker; throws so the job is retried. */
export async function deliverMail(kind: string, message: MailMessage): Promise<void> {
  if (env.mailTransport === "log") {
    logger.info({ kind, to: message.to, subject: message.subject, text: message.text }, "email (MAIL_TRANSPORT=log, not sent)");
    return;
  }
  if (env.mailTransport !== "ses") return;
  ses ??= new SESv2Client({ region: env.SES_REGION });
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: env.MAIL_FROM,
      Destination: { ToAddresses: [message.to] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: { Text: { Data: message.text, Charset: "UTF-8" } },
        },
      },
    }),
  );
}

/** A date and time in the organization's timezone (APP_TIMEZONE), for email text. */
export function formatEmailDate(date: Date): string {
  // dateStyle/timeStyle can't be combined with timeZoneName, hence the individual fields.
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: env.APP_TIMEZONE,
    timeZoneName: "short",
  }).format(date);
}
