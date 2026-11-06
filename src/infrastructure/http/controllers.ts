import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { WagerService } from "../../application/wager-service.ts";
import { AppError } from "../../application/errors.ts";
import { Database } from "../database/database.ts";
import { SqsGateway } from "../messaging/sqs-gateway.ts";
import { Telemetry } from "../telemetry.ts";
import { ProviderIdentityGuard } from "./auth.ts";
import type { AuthenticatedRequest } from "./auth.ts";
import { EventProjector } from "../notifications/event-projector.ts";

@Controller()
@UseGuards(ProviderIdentityGuard)
export class FinancialController {
  constructor(@Inject(WagerService) private readonly service: WagerService,
    @Inject(EventProjector) private readonly events: EventProjector) {}

  @Post("wallets")
  createWallet(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    if (!request.principal) throw new AppError(401, "AUTHENTICATION_REQUIRED");
    return this.service.createWallet(body, { tenantId: request.principal.tenantId });
  }

  @Get("wallets/:walletId")
  wallet(@Param("walletId") id: string) { return this.service.getWallet(id); }

  @Get("wallets/:walletId/ledger")
  ledger(@Param("walletId") id: string, @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    if ((cursor !== undefined && typeof cursor !== "string") || (limit !== undefined && typeof limit !== "string")) throw new AppError(400, "INVALID_PAGINATION");
    return this.service.ledger(id, cursor, limit);
  }

  @Post("wallets/:walletId/reconciliation")
  @HttpCode(200)
  reconcile(@Param("walletId") id: string) { return this.service.reconcile(id); }

  @Get("wallets/:walletId/notifications")
  notifications(@Param("walletId") id: string, @Query("limit") limit?: string) {
    if (limit !== undefined && typeof limit !== "string") throw new AppError(400, "INVALID_PAGINATION");
    return this.events.listNotifications(id, limit);
  }

  @Get("wallets/:walletId/balance-projection")
  async balanceProjection(@Param("walletId") id: string) {
    const result = await this.events.balanceProjection(id);
    if (!result) throw new AppError(404, "BALANCE_PROJECTION_NOT_READY");
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  transaction(@Param("transactionId") id: string) { return this.service.getTransaction(id); }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  providerTransaction(@Param("providerId") provider: string, @Param("externalTransactionId") external: string) {
    return this.service.getProviderTransaction(provider, external);
  }

  @Post("wagering/transactions")
  async submit(@Body() body: unknown, @Headers("idempotency-key") key: string | undefined,
    @Headers("x-correlation-id") rawCorrelation: string | undefined, @Res() response: Response) {
    if (!key) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED");
    const correlationId = rawCorrelation ?? randomUUID();
    if (!/^[A-Za-z0-9_.:-]{1,180}$/.test(correlationId)) throw new AppError(400, "INVALID_CORRELATION_ID");
    const result = await this.service.submit(body, key, { correlationId });
    const code = result.status === "REJECTED" ? 422 : result.status === "FAILED" ? 500
      : ["PENDING", "PENDING_REFERENCE"].includes(result.status) ? 202 : 200;
    response.setHeader("X-Correlation-Id", correlationId);
    response.status(code).json(result);
  }
}

@Controller()
export class OperationsController {
  constructor(@Inject(Database) private readonly db: Database,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
    @Inject(Telemetry) private readonly telemetry: Telemetry) {}

  @Get("health/live")
  live() { return { status: "alive" }; }

  @Get("health/ready")
  async ready() {
    try {
      await Promise.all([this.db.source.query("SELECT 1"), this.sqs.ready()]);
      return { status: "ready", postgres: "up", sqs: "up" };
    } catch { throw new AppError(503, "DEPENDENCY_UNAVAILABLE"); }
  }

  @Get("metrics")
  @UseGuards(ProviderIdentityGuard)
  async metrics(@Res() response: Response) {
    const [row] = await this.db.source.query<Array<{ lag: string }>>(
      "SELECT coalesce(extract(epoch FROM now()-min(occurred_at)),0)::text AS lag FROM outbox WHERE published_at IS NULL",
    );
    this.telemetry.set("outbox_current_lag_seconds", Math.max(0, Number(row?.lag ?? "0")));
    response.setHeader("Content-Type", this.telemetry.registry.contentType);
    response.send(await this.telemetry.registry.metrics());
  }
}
