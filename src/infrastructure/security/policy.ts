import { AppError } from "../../application/errors.ts";
import { parseWager, requireUuid } from "../../application/contracts.ts";
import { Database } from "../database/database.ts";
import { TransactionRow, WalletRow } from "../database/rows.ts";
import type { Principal } from "./identity.ts";

export class TenantAccessPolicy {
  constructor(private readonly db: Database, readonly providerTenants: ReadonlyMap<string, string>) {}

  requireAdministrator(principal: Principal): void {
    if (!principal.roles.has("wallet-admin")) throw new AppError(403, "ADMINISTRATOR_REQUIRED");
  }

  providerTenant(providerId: string): string {
    const tenant = this.providerTenants.get(providerId);
    if (!tenant) throw new AppError(403, "PROVIDER_NOT_REGISTERED");
    return tenant;
  }

  assertProvider(principal: Principal, providerId: string): void {
    if (this.providerTenant(providerId) !== principal.tenantId ||
      (!principal.roles.has("wallet-admin") && principal.providerId !== providerId)) throw new AppError(403, "PROVIDER_IDENTITY_MISMATCH");
  }

  async wallet(walletId: string, tenantId: string): Promise<void> {
    requireUuid(walletId);
    const row = await this.db.source.manager.findOneBy(WalletRow, { id: walletId, tenantId });
    if (!row) throw new AppError(404, "WALLET_NOT_FOUND");
  }

  async transaction(transactionId: string, principal: Principal): Promise<void> {
    requireUuid(transactionId);
    const row = await this.db.source.manager.findOneBy(TransactionRow, { id: transactionId });
    if (!row) throw new AppError(404, "TRANSACTION_NOT_FOUND");
    await this.wallet(row.walletId, principal.tenantId);
    if (!principal.roles.has("wallet-admin") && row.providerId !== principal.providerId) throw new AppError(404, "TRANSACTION_NOT_FOUND");
  }

  async externalTransaction(providerId: string, externalTransactionId: string, principal: Principal): Promise<void> {
    this.assertProvider(principal, providerId);
    const row = await this.db.source.manager.findOneBy(TransactionRow, { providerId, externalTransactionId });
    if (!row) throw new AppError(404, "TRANSACTION_NOT_FOUND");
    await this.wallet(row.walletId, principal.tenantId);
  }

  async submission(raw: unknown, principal: Principal): Promise<void> {
    const input = parseWager(raw);
    this.assertProvider(principal, input.providerId);
    await this.wallet(input.walletId, principal.tenantId);
  }

  async internalProviderSubmission(raw: unknown): Promise<void> {
    const input = parseWager(raw);
    await this.wallet(input.walletId, this.providerTenant(input.providerId));
  }
}
