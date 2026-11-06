import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money.ts";

const currencies = ["BRL", "USD", "EUR"] as const;
const maximum = 99_999_999_999_999_999_999n;

/** Independent decimal codec for the oracle; no Money helpers are used. */
function decimal(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const digits = (cents < 0n ? -cents : cents).toString().padStart(3, "0");
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function cents(decimalAmount: string): bigint {
  const negative = decimalAmount.startsWith("-");
  const [whole, fraction] = decimalAmount.replace(/^-/, "").split(".");
  const magnitude = BigInt(whole!) * 100n + BigInt(fraction!);
  return negative ? -magnitude : magnitude;
}

function generator(seed: bigint): () => bigint {
  let state = seed;
  return () => {
    state = (state * 1_664_525n + 1_013_904_223n) & 0xffff_ffffn;
    return state;
  };
}

describe("Enhanced Money properties with reproducible bigint oracle", () => {
  test.each(currencies)("%s: 256 seeded arithmetic samples preserve identities and operands", currency => {
    const next = generator(0x4a554e47n);
    for (let sample = 0; sample < 256; sample += 1) {
      const a = (next() * next()) % (maximum / 4n);
      const b = (next() * next()) % (maximum / 4n);
      const c = (next() * next()) % (maximum / 4n);
      const left = Money.from({ amount: decimal(a), currency });
      const right = Money.from({ amount: decimal(b), currency });
      const third = Money.from({ amount: decimal(c), currency });
      expect(left.add(right).toString()).toBe(decimal(a + b));
      expect(left.subtract(right).toString()).toBe(decimal(a - b));
      expect(left.add(right).subtract(right).toString()).toBe(decimal(a));
      expect(left.add(right).add(third).equals(left.add(right.add(third)))).toBe(true);
      expect(left.negate().negate().equals(left)).toBe(true);
      expect(left.isLessThan(right)).toBe(a < b);
      expect(cents(left.toJSON().amount)).toBe(a);
      expect(left.toString()).toBe(decimal(a));
      expect(right.toString()).toBe(decimal(b));
      expect(Object.isFrozen(left)).toBe(true);
    }
  });

  test.each(currencies)("%s: boundary representations survive signed rehydration exactly", currency => {
    const boundaries = [0n, 1n, 9n, 10n, 99n, 100n, 101n, 9_007_199_254_740_993n, maximum - 1n, maximum];
    for (const value of boundaries) {
      const positive = Money.from({ amount: decimal(value), currency });
      expect(positive.toString()).toBe(decimal(value));
      expect(Money.rehydrate(positive.negate().toJSON()).toString()).toBe(decimal(-value));
      expect(positive.add(positive.negate()).equals(Money.zero(currency))).toBe(true);
    }
  });

  test.each(currencies)("%s: arithmetic rejects both sides of the supported range", currency => {
    const top = Money.from({ amount: decimal(maximum), currency });
    const cent = Money.from({ amount: "0.01", currency });
    for (const action of [() => top.add(cent), () => top.negate().subtract(cent)]) {
      try {
        action();
        throw new Error("Expected overflow rejection");
      } catch (error) {
        expect(error).toMatchObject({ code: "MONEY_OVERFLOW" });
      }
    }
    expect(top.subtract(cent).toString()).toBe(decimal(maximum - 1n));
    expect(top.toString()).toBe(decimal(maximum));
  });

  test("currency is part of value identity for every supported pair", () => {
    for (const leftCurrency of currencies) {
      for (const rightCurrency of currencies) {
        const left = Money.from({ amount: "0.01", currency: leftCurrency });
        const right = Money.from({ amount: "0.01", currency: rightCurrency });
        if (leftCurrency === rightCurrency) {
          expect(left.equals(right)).toBe(true);
          continue;
        }
        for (const action of [() => left.add(right), () => left.subtract(right), () => left.equals(right), () => left.isLessThan(right)]) {
          try {
            action();
            throw new Error("Expected currency mismatch");
          } catch (error) {
            expect(error).toMatchObject({ code: "CURRENCY_MISMATCH" });
          }
        }
      }
    }
  });
});
