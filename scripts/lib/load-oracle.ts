export interface PlannedLoadCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
}

export interface LoadEffectPlan {
  readonly effectsByWallet: ReadonlyMap<string, number>;
  readonly logicalOperationCount: number;
  readonly expectedReplays: number;
}

/** Expected effects come from planned command identities, never from server responses. */
export function planLoadEffects(commands: readonly PlannedLoadCommand[]): LoadEffectPlan {
  const identityWallets = new Map<string, string>();
  const effectsByWallet = new Map<string, number>();
  for (const command of commands) {
    if ([command.providerId, command.externalTransactionId, command.walletId]
      .some(value => typeof value !== "string" || value.length === 0)) {
      throw new Error("Every planned load command requires provider, external transaction and wallet identities.");
    }
    const identity = JSON.stringify([command.providerId, command.externalTransactionId]);
    const previousWallet = identityWallets.get(identity);
    if (previousWallet !== undefined) {
      if (previousWallet !== command.walletId) throw new Error("The same planned operation cannot target different wallets.");
      continue;
    }
    identityWallets.set(identity, command.walletId);
    effectsByWallet.set(command.walletId, (effectsByWallet.get(command.walletId) ?? 0) + 1);
  }
  return Object.freeze({ effectsByWallet, logicalOperationCount: identityWallets.size,
    expectedReplays: commands.length - identityWallets.size });
}

export function identityResultsMatch(plan: LoadEffectPlan, uniqueProcessedIds: number, replays: number): boolean {
  return Number.isSafeInteger(uniqueProcessedIds) && uniqueProcessedIds >= 0 && Number.isSafeInteger(replays) && replays >= 0 &&
    uniqueProcessedIds === plan.logicalOperationCount && replays === plan.expectedReplays;
}
