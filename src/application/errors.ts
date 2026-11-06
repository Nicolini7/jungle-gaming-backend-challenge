import { DomainError } from "../domain/domain-error.ts";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function databaseCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: string; driverError?: { code?: string } };
  return candidate.driverError?.code ?? candidate.code;
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DomainError) return new AppError(400, error.code, error.message);
  const code = databaseCode(error);
  if (code === "23505") return new AppError(409, "RESOURCE_CONFLICT");
  // Infrastructure failures remain retryable; SQL/payloads never leave the adapter.
  if (code && (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "40P01", "40001", "55P03", "57014", "57P01", "57P02", "57P03"].includes(code) || /^(08|53)/.test(code))) {
    return new AppError(503, "INFRASTRUCTURE_UNAVAILABLE");
  }
  return new AppError(500, "INTERNAL_ERROR");
}
