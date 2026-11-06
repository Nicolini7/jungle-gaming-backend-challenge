import { expect, test } from "bun:test";
import { Money } from "../../src/domain/money.ts";

const money = (amount: string) => Money.from({ amount, currency: "BRL" });

test("Money preserva o máximo de 18 dígitos inteiros exatamente", () => {
  const maximum = money("999999999999999999.99");
  expect(maximum.toString()).toBe("999999999999999999.99");
  expect(maximum.subtract(money("0.01")).toString()).toBe("999999999999999999.98");
  expect(Money.rehydrate({ amount: "-999999999999999999.99", currency: "BRL" }).toString())
    .toBe("-999999999999999999.99");
});

test("Money rejeita overflow na entrada e no resultado de operações", () => {
  expect(() => money("1000000000000000000.00")).toThrow("supported maximum");
  expect(() => money("999999999999999999.99").add(money("0.01"))).toThrow("supported maximum");
  expect(() => money("999999999999999999.99").negate().subtract(money("0.01"))).toThrow("supported maximum");
  expect(() => Money.rehydrate({ amount: "-1000000000000000000.00", currency: "BRL" })).toThrow("supported maximum");
});
