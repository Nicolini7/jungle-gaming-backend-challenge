import type { WagerService } from "../../application/wager-service.ts";
import type { ProcessingContext } from "../../application/contracts.ts";
import { TenantAccessPolicy } from "./policy.ts";

/** Internal SQS commands do not need JWTs, but their provider/wallet scope is enforced. */
export class AuthorizedWagerProcessor {
  constructor(private readonly service: WagerService, private readonly policy: TenantAccessPolicy) {}
  async submit(data: unknown, key: string, context: ProcessingContext) {
    await this.policy.internalProviderSubmission(data);
    return this.service.submit(data, key, context);
  }
  retryPending(limit?: number) { return this.service.retryPending(limit); }
}
