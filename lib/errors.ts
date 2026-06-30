export type ErrorSource = "server" | "birdeye" | "helius";

export class ApiError extends Error {
  source: ErrorSource;
  status: number;
  details: string;
  retryAfterMs?: number;

  constructor(message: string, options: { source: ErrorSource; status?: number; details?: string; retryAfterMs?: number }) {
    super(message);
    this.name = "ApiError";
    this.source = options.source;
    this.status = options.status ?? 500;
    this.details = options.details ?? message;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function safeSnippet(value: string, length = 300) {
  return value.replace(/\s+/g, " ").trim().slice(0, length);
}

export function statusFromError(error: unknown) {
  return isApiError(error) ? error.status : 500;
}

export function sourceFromError(error: unknown): ErrorSource {
  return isApiError(error) ? error.source : "server";
}

export function messageFromError(error: unknown) {
  if (isApiError(error)) return error.message;
  if (error instanceof Error) return error.message || "Internal server error";
  return "Internal server error";
}

export function detailsFromError(error: unknown) {
  if (isApiError(error)) return error.details;
  if (error instanceof Error) return safeSnippet(error.message || "Unexpected server error");
  return "Unexpected server error";
}
