import { Inject, Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { AppError } from "../../application/errors.ts";
import { OidcIdentityVerifier } from "../security/identity.ts";
import type { Principal } from "../security/identity.ts";
import { TenantAccessPolicy } from "../security/policy.ts";

export interface AuthenticatedRequest extends Request { principal?: Principal }

@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  constructor(@Inject(OidcIdentityVerifier) private readonly identities: OidcIdentityVerifier,
    @Inject(TenantAccessPolicy) private readonly policy: TenantAccessPolicy) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = await this.identities.verify(request.headers.authorization);
    const handler = context.getHandler().name;
    const parameter = (name: string): string => {
      const value = request.params[name];
      if (typeof value !== "string") throw new AppError(400, "INVALID_IDENTIFIER");
      return value;
    };
    switch (handler) {
      case "createWallet":
      case "metrics": this.policy.requireAdministrator(principal); break;
      case "wallet":
      case "ledger":
      case "notifications":
      case "balanceProjection":
      case "reconcile": await this.policy.wallet(parameter("walletId"), principal.tenantId); break;
      case "transaction": await this.policy.transaction(parameter("transactionId"), principal); break;
      case "providerTransaction": await this.policy.externalTransaction(parameter("providerId"), parameter("externalTransactionId"), principal); break;
      case "submit": await this.policy.submission(request.body, principal); break;
      default: throw new AppError(403, "OPERATION_NOT_AUTHORIZED");
    }
    request.principal = principal;
    return true;
  }
}
