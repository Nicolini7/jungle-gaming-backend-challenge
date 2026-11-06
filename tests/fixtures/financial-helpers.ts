import { randomUUID } from "node:crypto";
import type { WagerInput } from "../../src/application/contracts.ts";
import type { WagerService } from "../../src/application/wager-service.ts";

export const integrationEnabled = process.env.RUN_INTEGRATION === "1";
export const integrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL ?? "";
if (integrationEnabled && !integrationDatabaseUrl) throw new Error("MIGRATION_DATABASE_URL is required for privileged isolated integration fixtures.");

export interface TestWallet { id: string; playerId: string }

export async function createTestWallet(service: WagerService, amount = "100.00"): Promise<TestWallet> {
  return service.createWallet({ playerId: randomUUID(), initialBalance: { amount, currency: "BRL" } });
}

export function commandFor(wallet: TestWallet, overrides: Partial<WagerInput> = {}): WagerInput {
  return {
    providerId: `provider-${randomUUID()}`,
    externalTransactionId: `external-${randomUUID()}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: `round-${randomUUID()}`,
    gameId: "integration-game",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  };
}

export function submitCommand(service: WagerService, command: WagerInput, key?: string) {
  return service.submit(command, key ?? `${command.providerId}:${command.externalTransactionId}`,
    { correlationId: randomUUID() });
}
