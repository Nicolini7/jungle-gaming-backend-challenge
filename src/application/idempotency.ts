import { AppError } from "./errors.ts";

export interface ExistingRequestIdentity {
  readonly idempotencyKey: string;
  readonly payloadHash: string;
}

/** Classifica replay após unicidade persistente resolver qual operação já existe. */
export function assertSameRequest(existing: ExistingRequestIdentity, key: string, hash: string): void {
  if (existing.idempotencyKey !== key) throw new AppError(409, "EXTERNAL_TRANSACTION_CONFLICT");
  if (existing.payloadHash !== hash) throw new AppError(409, "IDEMPOTENCY_CONFLICT");
}
