import { DomainError } from "./domain-error.ts";

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Recorte explícito de moedas ISO-4217 com duas casas decimais.
// Os endpoints do desafio poderão restringir a BRL sem acoplar o domínio a BRL.
const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(["BRL", "USD", "EUR"]);
const INPUT_AMOUNT = /^(0|[1-9]\d*)\.\d{2}$/;
const STORED_AMOUNT = /^-?(0|[1-9]\d*)\.\d{2}$/;
const MAX_MINOR_UNITS = 99_999_999_999_999_999_999n;

/**
 * Valor monetário imutável. "25.10" vira 2510n centavos, sem passar por number.
 * Valores negativos só surgem em cálculos internos ou na reidratação.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    if (minorUnits > MAX_MINOR_UNITS || minorUnits < -MAX_MINOR_UNITS) {
      throw new DomainError("MONEY_OVERFLOW", "Money exceeds the supported maximum of 999999999999999999.99.");
    }
    Object.freeze(this);
  }

  /** Fronteira de entrada: exige uma string não negativa com duas casas. */
  static from(props: MoneyProps): Money {
    Money.assertProps(props, INPUT_AMOUNT);
    return new Money(Money.parseMinorUnits(props.amount), props.currency);
  }

  /** Reconstrói uma representação persistida, inclusive diferenças negativas. */
  static rehydrate(props: MoneyProps): Money {
    Money.assertProps(props, STORED_AMOUNT);
    return new Money(Money.parseMinorUnits(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const negative = this.isNegative();
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const integer = (absolute / 100n).toString();
    const fraction = (absolute % 100n).toString().padStart(2, "0");
    return `${negative ? "-" : ""}${integer}.${fraction}`;
  }

  private static assertProps(props: MoneyProps, pattern: RegExp): void {
    if (
      props === null ||
      typeof props !== "object" ||
      typeof props.amount !== "string" ||
      !pattern.test(props.amount)
    ) {
      throw new DomainError(
        "INVALID_MONEY_AMOUNT",
        "Amount must be a canonical decimal string with exactly two decimal places.",
      );
    }

    Money.assertCurrency(props.currency);
  }

  private static assertCurrency(currency: string): void {
    if (typeof currency !== "string" || !SUPPORTED_CURRENCIES.has(currency)) {
      throw new DomainError(
        "UNSUPPORTED_CURRENCY",
        "Supported currencies are BRL, USD and EUR.",
      );
    }
  }

  private static parseMinorUnits(amount: string): bigint {
    // O formato já foi validado. BigInt recebe uma string, nunca um number.
    return BigInt(amount.replace(".", ""));
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(
        "CURRENCY_MISMATCH",
        "Money operations require the same currency.",
      );
    }
  }
}
