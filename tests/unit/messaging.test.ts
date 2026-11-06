import { describe, expect, test } from "bun:test";
import { InboxMessage } from "../../src/domain/inbox-message.ts";
import { OutboxMessage } from "../../src/domain/outbox-message.ts";
import { WalletBalanceChanged, WagerTransactionPendingReference, WagerTransactionProcessed,
  WagerTransactionRejected } from "../../src/domain/integration-event.ts";

const at = () => new Date("2026-11-05T11:00:00.000Z");
const eventProps = () => ({ eventId: "event-1", aggregateId: "wallet-1", correlationId: "correlation-1",
  occurredAt: at(), data: { transactionId: "transaction-1", money: { amount: "25.00", currency: "BRL" } } });

describe("IntegrationEvent", () => {
  test.each([
    ["WagerTransactionProcessed", WagerTransactionProcessed.create],
    ["WagerTransactionRejected", WagerTransactionRejected.create],
    ["WagerTransactionPendingReference", WagerTransactionPendingReference.create],
    ["WalletBalanceChanged", WalletBalanceChanged.create],
  ] as const)("%s possui tipo/version no próprio evento e envelope JSON estável", (type, factory) => {
    const event = factory(eventProps());
    expect(event.toJSON()).toEqual({ ...eventProps(), eventType: type, version: 1, occurredAt: at().toISOString() });
    expect(JSON.parse(JSON.stringify(event)).occurredAt).toBe(at().toISOString());
    expect(Object.hasOwn(event.toJSON(), "causationId")).toBe(false);
    expect(Object.isFrozen(event)).toBe(true);
  });

  test("causationId é preservado quando informado", () => {
    expect(WagerTransactionProcessed.create({ ...eventProps(), causationId: "message-1" }).toJSON().causationId)
      .toBe("message-1");
  });

  test("payload e datas são snapshots que não expõem estado mutável", () => {
    const props = eventProps();
    const event = WalletBalanceChanged.create(props);
    props.data.money.amount = "999.00";
    props.occurredAt.setUTCFullYear(2000);
    expect(event.data.money.amount).toBe("25.00");
    expect(() => Object.assign(event.data.money, { amount: "1.00" })).toThrow(TypeError);
    event.occurredAt.setUTCFullYear(2001);
    expect(event.occurredAt.getUTCFullYear()).toBe(2026);
  });

  test("rejeita payload que não pode ser publicado como JSON", () => {
    expect(() => WalletBalanceChanged.create({ ...eventProps(), data: { amount: 25n } })).toThrow();
    expect(() => WalletBalanceChanged.create({ ...eventProps(), occurredAt: new Date("invalid") })).toThrow();
  });
});

describe("InboxMessage", () => {
  test("recebe, compara hash e marca processamento uma única vez", () => {
    const inbox = InboxMessage.receive({ messageId: "message-1", consumerName: "wager-worker", payloadHash: "hash-1" });
    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.matchesPayload("hash-1")).toBe(true);
    expect(inbox.matchesPayload("divergent")).toBe(false);
    const completed = at();
    inbox.markProcessed(completed);
    completed.setUTCFullYear(2000);
    inbox.processedAt?.setUTCFullYear(2001);
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt?.getUTCFullYear()).toBe(2026);
    expect(() => inbox.markProcessed(at())).toThrow();
  });

  test("reidrata deduplicação persistida depois de um reinício", () => {
    const inbox = InboxMessage.rehydrate({ messageId: "m", consumerName: "worker", payloadHash: "h",
      receivedAt: at(), processedAt: at() });
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.matchesPayload("h")).toBe(true);
    expect(inbox.receivedAt.toISOString()).toBe(at().toISOString());
  });

  test("exige identidade de mensagem, consumidor e hash", () => {
    expect(() => InboxMessage.receive({ messageId: "", consumerName: "worker", payloadHash: "hash" })).toThrow();
    expect(() => InboxMessage.receive({ messageId: "m", consumerName: "", payloadHash: "hash" })).toThrow();
    expect(() => InboxMessage.receive({ messageId: "m", consumerName: "worker", payloadHash: "" })).toThrow();
  });
});

describe("OutboxMessage", () => {
  const enqueue = () => OutboxMessage.enqueue(WagerTransactionProcessed.create(eventProps()));

  test("enfileira envelope completo usando eventId estável como identidade", () => {
    const outbox = enqueue();
    expect(outbox.id).toBe("event-1");
    expect(outbox.payload.eventId).toBe(outbox.id);
    expect(outbox.payload.eventType).toBe("WagerTransactionProcessed");
    expect(outbox.payload.occurredAt).toBe(at().toISOString());
    expect(outbox.attempts).toBe(0);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(at())).toBe(true);
  });

  test("backoff exponencial agenda 1s, 2s e limita intervalo a 60s", () => {
    const outbox = enqueue();
    outbox.scheduleRetry(at());
    expect(outbox.attempts).toBe(1);
    expect(outbox.isDue(new Date(at().getTime() + 999))).toBe(false);
    expect(outbox.isDue(new Date(at().getTime() + 1_000))).toBe(true);
    outbox.scheduleRetry(at());
    expect(outbox.nextAttemptAt?.getTime()).toBe(at().getTime() + 2_000);
    for (let attempt = 0; attempt < 10; attempt++) outbox.scheduleRetry(at());
    expect(outbox.nextAttemptAt?.getTime()).toBe(at().getTime() + 60_000);
    expect(outbox.payload.eventId).toBe("event-1");
  });

  test("publicação é terminal e cancela retry pendente", () => {
    const outbox = enqueue();
    outbox.scheduleRetry(at());
    outbox.markPublished(at());
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
    expect(outbox.nextAttemptAt).toBeUndefined();
    expect(() => outbox.scheduleRetry(at())).toThrow();
    expect(() => outbox.markPublished(at())).toThrow();
  });

  test("reidrata tentativas e publicação sem perder envelope nem expor payload mutável", () => {
    const payload = { eventId: "event-1", data: { amount: "25.00" } };
    const outbox = OutboxMessage.rehydrate({ id: "event-1", aggregateId: "w", eventType: "type", payload,
      occurredAt: at(), attempts: 3, nextAttemptAt: at(), publishedAt: undefined });
    payload.data.amount = "99.00";
    expect(outbox.attempts).toBe(3);
    expect(outbox.isDue(at())).toBe(true);
    expect((outbox.payload.data as { amount: string }).amount).toBe("25.00");
    expect(() => Object.assign(outbox.payload, { eventId: "changed" })).toThrow();
  });
});
