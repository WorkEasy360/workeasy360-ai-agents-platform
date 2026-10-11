import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { errSummary, logger } from "./logger";
import { EgressBlockedError } from "./safe-fetch";

/** Errors that are safe to show to the client. Serialized as RFC 9457 problem+json. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, "bad_request", message, details);
  }
  static unauthorized(message = "Sign in to continue.") {
    return new AppError(401, "unauthorized", message);
  }
  static forbidden(message = "You don't have permission to do this.", code = "forbidden") {
    return new AppError(403, code, message);
  }
  static notFound(what = "Resource") {
    return new AppError(404, "not_found", `${what} not found.`);
  }
  static conflict(message: string, code = "conflict") {
    return new AppError(409, code, message);
  }
}

const titles: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, "route_not_found", `No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let code = "internal_error";
  let detail = "Something went wrong. Please try again.";
  let errors: unknown;

  if (err instanceof AppError) {
    ({ status, code } = err);
    detail = err.message;
    errors = err.details;
  } else if (err instanceof ZodError) {
    status = 400;
    code = "validation_failed";
    detail = "Some fields are invalid.";
    errors = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  } else if (err instanceof EgressBlockedError) {
    status = 400;
    code = "url_blocked";
    detail = err.message;
  } else if (err?.code === "LIMIT_FILE_SIZE") {
    status = 400;
    code = "file_too_large";
    detail = "File is too large (max 20 MB).";
  } else if (err?.type === "entity.parse.failed") {
    status = 400;
    code = "invalid_json";
    detail = "Request body is not valid JSON.";
  }

  if (status >= 500) logger.error({ err: errSummary(err), reqId: req.id }, "unhandled error");

  res
    .status(status)
    .type("application/problem+json")
    .json({ type: "about:blank", title: titles[status] ?? "Error", status, code, detail, errors, request_id: req.id });
};
