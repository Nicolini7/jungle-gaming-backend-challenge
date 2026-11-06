import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { Message } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";

export interface SqsGatewayOptions {
  endpoint: string;
  region: string;
  queueName?: string;
  eventQueueName?: string;
  dlqName?: string;
  visibilityTimeout?: number;
  maxReceives?: number;
}

/** SQS is a transport. PostgreSQL remains the authority for financial deduplication. */
export class SqsGateway {
  readonly client: SQSClient;
  readonly visibilityTimeout: number;
  readonly maxReceives: number;
  commandQueueUrl = "";
  eventQueueUrl = "";
  dlqUrl = "";
  eventDlqUrl = "";

  constructor(private readonly options: SqsGatewayOptions) {
    this.visibilityTimeout = options.visibilityTimeout ?? 30;
    this.maxReceives = options.maxReceives ?? 5;
    if (!Number.isInteger(this.visibilityTimeout) || this.visibilityTimeout < 1 || this.visibilityTimeout > 43_200) {
      throw new Error("SQS visibilityTimeout must be an integer between 1 and 43200 seconds.");
    }
    if (!Number.isInteger(this.maxReceives) || this.maxReceives < 1 || this.maxReceives > 1000) {
      throw new Error("SQS maxReceives must be an integer between 1 and 1000.");
    }
    this.client = new SQSClient({
      endpoint: options.endpoint,
      region: options.region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
      useQueueUrlAsEndpoint: false,
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 25_000, throwOnRequestTimeout: true },
    });
  }

  async ensureQueues(): Promise<void> {
    this.dlqUrl = await this.createQueue(this.options.dlqName ?? "wager-transactions-dlq.fifo");
    const deadLetter = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: this.dlqUrl,
      AttributeNames: ["QueueArn"],
    }));
    const deadLetterArn = deadLetter.Attributes?.QueueArn;
    if (!deadLetterArn) throw new Error("SQS did not return the dead-letter queue ARN.");

    this.commandQueueUrl = await this.createQueue(this.options.queueName ?? "wager-transactions.fifo");
    this.eventQueueUrl = await this.createQueue(this.options.eventQueueName ?? "wager-events.fifo");
    await this.client.send(new SetQueueAttributesCommand({
      QueueUrl: this.commandQueueUrl,
      Attributes: {
        VisibilityTimeout: String(this.visibilityTimeout),
        ReceiveMessageWaitTimeSeconds: "10",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: deadLetterArn,
          maxReceiveCount: String(this.maxReceives),
        }),
      },
    }));
  }

  async ready(): Promise<void> {
    for (const QueueUrl of [this.commandQueueUrl, this.eventQueueUrl, this.dlqUrl, ...(this.eventDlqUrl ? [this.eventDlqUrl] : [])]) {
      if (!QueueUrl) throw new Error("SQS queues have not been initialized.");
      await this.client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }));
    }
  }

  async ensureEventConsumerQueue(): Promise<void> {
    if (!this.eventQueueUrl) throw new Error("Initialize the queues before the event consumer.");
    const name = this.options.eventQueueName ?? "wager-events.fifo";
    this.eventDlqUrl = await this.createQueue(`${name.replace(/\.fifo$/, "")}-dlq.fifo`);
    const dead = await this.client.send(new GetQueueAttributesCommand({ QueueUrl: this.eventDlqUrl, AttributeNames: ["QueueArn"] }));
    if (!dead.Attributes?.QueueArn) throw new Error("SQS did not return the event dead-letter queue ARN.");
    await this.client.send(new SetQueueAttributesCommand({ QueueUrl: this.eventQueueUrl, Attributes: {
      VisibilityTimeout: String(this.visibilityTimeout),
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dead.Attributes.QueueArn, maxReceiveCount: String(this.maxReceives) }),
    } }));
  }

  async receiveEvents(waitTimeSeconds = 10, signal?: AbortSignal): Promise<Message[]> {
    const response = await this.client.send(new ReceiveMessageCommand({ QueueUrl: this.eventQueueUrl,
      MaxNumberOfMessages: 10, WaitTimeSeconds: waitTimeSeconds, VisibilityTimeout: this.visibilityTimeout,
      MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
    }), signal ? { abortSignal: signal } : {});
    return response.Messages ?? [];
  }

  async acknowledgeEvent(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.eventQueueUrl, ReceiptHandle: receiptHandle }));
  }

  async changeEventVisibility(receiptHandle: string, seconds: number, signal?: AbortSignal): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.eventQueueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }), signal ? { abortSignal: signal } : {});
  }

  async deadLetterEvent(message: Message, failureCode: string, receiveCount: number): Promise<void> {
    if (!this.eventDlqUrl) throw new Error("The event dead-letter queue has not been initialized.");
    await this.client.send(new SendMessageCommand({ QueueUrl: this.eventDlqUrl,
      MessageGroupId: message.Attributes?.MessageGroupId ?? "invalid-event",
      MessageDeduplicationId: `event-dlq:${message.MessageId ?? randomUUID()}`,
      MessageBody: JSON.stringify({ type: "FinancialEventDeadLettered", occurredAt: new Date().toISOString(),
        sourceMessageId: message.MessageId, failureCode, receiveCount, originalBody: message.Body ?? "" }),
    }));
  }

  async sendEvent(payload: Record<string, unknown>, eventId: string, aggregateId: string): Promise<void> {
    if (!this.eventQueueUrl) throw new Error("SQS event queue has not been initialized.");
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.eventQueueUrl,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: aggregateId,
      MessageDeduplicationId: eventId,
    }));
  }

  /** Convenience entry for the demo and integration tests; the consumer validates the envelope. */
  async sendCommand(envelope: unknown): Promise<string> {
    if (!this.commandQueueUrl) throw new Error("SQS command queue has not been initialized.");
    const value = isRecord(envelope) ? envelope : {};
    const data = isRecord(value.data) ? value.data : {};
    const response = await this.client.send(new SendMessageCommand({
      QueueUrl: this.commandQueueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: typeof data.walletId === "string" ? data.walletId : "invalid-envelope",
      MessageDeduplicationId: typeof value.messageId === "string" ? value.messageId : randomUUID(),
    }));
    return response.MessageId ?? "";
  }

  async receive(waitTimeSeconds = 10, signal?: AbortSignal): Promise<Message[]> {
    const response = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.commandQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitTimeSeconds,
      VisibilityTimeout: this.visibilityTimeout,
      MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
    }), signal ? { abortSignal: signal } : {});
    return response.Messages ?? [];
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.commandQueueUrl, ReceiptHandle: receiptHandle }));
  }

  async changeVisibility(receiptHandle: string, seconds: number, signal?: AbortSignal): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.commandQueueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: seconds,
    }), signal ? { abortSignal: signal } : {});
  }

  async deadLetter(message: Message, failureCode: string, receiveCount: number): Promise<void> {
    // The original body belongs in the durable DLQ, never in application logs.
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.dlqUrl,
      MessageGroupId: message.Attributes?.MessageGroupId ?? "invalid-envelope",
      MessageDeduplicationId: `dlq:${message.MessageId ?? randomUUID()}`,
      MessageBody: JSON.stringify({
        type: "WagerTransactionDeadLettered",
        occurredAt: new Date().toISOString(),
        sourceMessageId: message.MessageId,
        failureCode,
        receiveCount,
        originalBody: message.Body ?? "",
      }),
    }));
  }

  destroy(): void {
    this.client.destroy();
  }

  private async createQueue(queueName: string): Promise<string> {
    const response = await this.client.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
    }));
    if (!response.QueueUrl) throw new Error(`SQS did not return a URL for ${queueName}.`);
    // LocalStack can advertise localhost even when the caller runs in another container.
    const advertised = new URL(response.QueueUrl);
    const configured = new URL(this.options.endpoint);
    advertised.protocol = configured.protocol;
    advertised.host = configured.host;
    return advertised.toString();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
