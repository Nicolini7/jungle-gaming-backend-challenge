export type DomainErrorCode = string;

/** Erro de regra de domínio. A tradução para HTTP/SQS pertence aos adaptadores. */
export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** Uma transição depois de um estado terminal representa erro de programação. */
export class InvalidTransactionStateError extends DomainError {
  constructor(status: string) {
    super("INVALID_TRANSACTION_STATE", `Transaction in terminal state ${status} cannot transition.`);
    this.name = "InvalidTransactionStateError";
  }
}
