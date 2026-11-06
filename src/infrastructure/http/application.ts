import "reflect-metadata";
import { Catch, HttpException, Module } from "@nestjs/common";
import type { ArgumentsHost, DynamicModule, ExceptionFilter } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Response } from "express";
import { WagerService } from "../../application/wager-service.ts";
import { toAppError } from "../../application/errors.ts";
import { Database } from "../database/database.ts";
import { SqsGateway } from "../messaging/sqs-gateway.ts";
import { Telemetry } from "../telemetry.ts";
import { FinancialController, OperationsController } from "./controllers.ts";
import { ProviderIdentityGuard } from "./auth.ts";
import { OidcIdentityVerifier, identityConfiguration } from "../security/identity.ts";
import { TenantAccessPolicy } from "../security/policy.ts";
import { EventProjector } from "../notifications/event-projector.ts";

@Catch()
class ErrorFilter implements ExceptionFilter {
  constructor(private readonly telemetry: Telemetry) {}
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const converted = error instanceof HttpException
      ? { statusCode: error.getStatus(), code: error.getStatus() === 400 ? "INVALID_PAYLOAD" : "HTTP_ERROR" }
      : toAppError(error);
    this.telemetry.log("request_error", { code: converted.code, status: converted.statusCode });
    response.status(converted.statusCode).json({ error: { code: converted.code }, retryable: converted.statusCode === 503 });
  }
}

@Module({})
class AppModule {
  static register(db: Database, service: WagerService, sqs: SqsGateway, telemetry: Telemetry): DynamicModule {
    const configuration = identityConfiguration();
    return { module: AppModule, controllers: [FinancialController, OperationsController], providers: [
      { provide: Database, useValue: db }, { provide: WagerService, useValue: service },
      { provide: SqsGateway, useValue: sqs }, { provide: Telemetry, useValue: telemetry }, ProviderIdentityGuard,
      { provide: OidcIdentityVerifier, useValue: new OidcIdentityVerifier(configuration) },
      { provide: TenantAccessPolicy, useValue: new TenantAccessPolicy(db, configuration.providerTenants) },
      { provide: EventProjector, useValue: new EventProjector(db) },
    ] };
  }
}

export async function createApplication(db: Database, service: WagerService, sqs: SqsGateway, telemetry: Telemetry) {
  const app = await NestFactory.create(AppModule.register(db, service, sqs, telemetry), { logger: false, bodyParser: true });
  app.useGlobalFilters(new ErrorFilter(telemetry));
  return app;
}
