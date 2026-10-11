import nodemailer from "nodemailer";
import { env } from "../config/env";
import { errSummary, logger } from "./logger";

const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465,
  // In production, refuse to send if the server doesn't upgrade to TLS (no plaintext fallback).
  requireTLS: env.isProduction && env.SMTP_PORT !== 465,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
});

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendMail(message: MailMessage): Promise<void> {
  try {
    await transport.sendMail({ from: env.EMAIL_FROM, ...message });
  } catch (err) {
    // Auth flows must not leak whether delivery failed; log and continue.
    logger.error({ err: errSummary(err), subject: message.subject }, "email delivery failed");
  }
}
