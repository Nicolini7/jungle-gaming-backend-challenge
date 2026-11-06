import { describe, expect, test } from "bun:test";
import { DomainError } from "../../src/domain/domain-error.ts";
import { Money } from "../../src/domain/money.ts";
import type { MoneyProps } from "../../src/domain/money.ts";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });

function expectCode(run: () => unknown, expectedCode: DomainError["code"]): void {
  expect(run).toThrow(DomainError);
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(expectedCode);
  }
}

describe("Money — representação e exatidão", () => {
  test("serializa valor e moeda como strings, com duas casas", () => {
    expect(brl("25.10").toJSON()).toEqual({ amount: "25.10", currency: "BRL" });
    expect(JSON.stringify(brl("25.10"))).toBe('{"amount":"25.10","currency":"BRL"}');
  });

  test("soma dez e vinte centavos sem erro de ponto flutuante", () => {
    expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
  });

  test("preserva centavos acima do limite de inteiros exatos de number", () => {
    expect(brl("9007199254740993.01").add(brl("0.02")).toString()).toBe(
      "9007199254740993.03",
    );
  });

  test("faz empréstimo de centavos ao subtrair", () => {
    expect(brl("1.00").subtract(brl("0.01")).toString()).toBe("0.99");
  });

  test("representa diferenças negativas sem autorizar saldo negativo na Wallet", () => {
    const difference = brl("0.10").subtract(brl("0.20"));
    expect(difference.toJSON()).toEqual({ amount: "-0.10", currency: "BRL" });
    expect(difference.isNegative()).toBe(true);
  });

  test("nega sem perder precisão e retorna ao valor original", () => {
    const money = brl("12.34");
    expect(money.negate().toString()).toBe("-12.34");
    expect(money.negate().negate().equals(money)).toBe(true);
  });

  test("zero e seu inverso têm uma única representação", () => {
    const zero = Money.zero("BRL");
    expect(zero.toString()).toBe("0.00");
    expect(zero.negate().toString()).toBe("0.00");
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });

  test("compara valores positivos e negativos na mesma moeda", () => {
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.01").isLessThan(brl("0.02"))).toBe(true);
    expect(brl("0.01").isLessThan(brl("0.01"))).toBe(false);
    expect(brl("0.01").negate().isLessThan(Money.zero("BRL"))).toBe(true);
    expect(brl("0.01").equals(brl("0.02"))).toBe(false);
  });

  test("uma operação retorna outra instância e preserva os operandos", () => {
    const original = brl("10.00");
    const increment = brl("2.00");
    const result = original.add(increment);
    expect(result).not.toBe(original);
    expect(original.toString()).toBe("10.00");
    expect(increment.toString()).toBe("2.00");
    expect(result.toString()).toBe("12.00");
    expect(Object.isFrozen(original)).toBe(true);
    expect(() => Object.assign(original, { currency: "USD" })).toThrow(TypeError);
  });

  test("reidrata uma diferença negativa exata", () => {
    const restored = Money.rehydrate({ amount: "-123.45", currency: "BRL" });
    expect(restored.toString()).toBe("-123.45");
    expect(restored.add(brl("123.45")).isZero()).toBe(true);
  });

  test.each(["BRL", "USD", "EUR"])("preserva a moeda suportada %s", (currency) => {
    expect(Money.from({ amount: "1.00", currency }).toJSON().currency).toBe(currency);
  });
});

describe("Money — fronteira de entrada", () => {
  test.each([
    "",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e3",
    "1E3",
    "1.001",
    "1.005",
    "1.0",
    "1",
    "-1.00",
    "-0.00",
    "+1.00",
    " 1.00",
    "1.00 ",
    "1.00\n",
    "1.00\r",
    "1.00\r\n",
    "01.00",
    "00.00",
    ".10",
    "1,00",
    "1_000.00",
    "0x01.00",
  ])("rejeita valor inválido %j sem arredondamento silencioso", (amount) => {
    expectCode(() => brl(amount), "INVALID_MONEY_AMOUNT");
  });

  test.each(["25", "null", "true", "{}", "[]"])(
    "rejeita amount de tipo inválido no JSON: %s",
    (jsonAmount) => {
      // Simula dados recebidos na fronteira, antes da validação do futuro DTO HTTP.
      const props = JSON.parse(`{"amount":${jsonAmount},"currency":"BRL"}`) as MoneyProps;
      expectCode(() => Money.from(props), "INVALID_MONEY_AMOUNT");
    },
  );

  test("rejeita objeto ausente ou incompleto na fronteira", () => {
    expectCode(() => Money.from(JSON.parse("null") as MoneyProps), "INVALID_MONEY_AMOUNT");
    expectCode(() => Money.from(JSON.parse("{}") as MoneyProps), "INVALID_MONEY_AMOUNT");
  });

  test.each(["", "brl", "XYZ", "JPY"])("rejeita moeda fora do recorte: %s", (currency) => {
    expectCode(() => Money.from({ amount: "1.00", currency }), "UNSUPPORTED_CURRENCY");
    expectCode(() => Money.zero(currency), "UNSUPPORTED_CURRENCY");
  });

  test("também exige representação decimal válida na reidratação", () => {
    expectCode(
      () => Money.rehydrate({ amount: "-1.001", currency: "BRL" }),
      "INVALID_MONEY_AMOUNT",
    );
  });
});

describe("Money — conflito de moedas", () => {
  const real = brl("1.00");
  const dollar = Money.from({ amount: "1.00", currency: "USD" });

  test("não soma moedas diferentes", () => {
    expectCode(() => real.add(dollar), "CURRENCY_MISMATCH");
  });

  test("não subtrai moedas diferentes", () => {
    expectCode(() => real.subtract(dollar), "CURRENCY_MISMATCH");
  });

  test("não ordena moedas diferentes", () => {
    expectCode(() => real.isLessThan(dollar), "CURRENCY_MISMATCH");
  });

  test("não compara igualdade de moedas diferentes", () => {
    expectCode(() => real.equals(dollar), "CURRENCY_MISMATCH");
  });
});
