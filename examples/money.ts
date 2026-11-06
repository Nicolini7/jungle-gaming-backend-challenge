import { Money } from "../src/domain/money.ts";

const tenCents = Money.from({ amount: "0.10", currency: "BRL" });
const twentyCents = Money.from({ amount: "0.20", currency: "BRL" });
const total = tenCents.add(twentyCents);

console.log("Soma exata:", JSON.stringify(total));
console.log("Original preservado:", JSON.stringify(tenCents));

const balance = Money.from({ amount: "100.00", currency: "BRL" });
const bet = Money.from({ amount: "80.00", currency: "BRL" });
const remaining = balance.subtract(bet);

console.log("Saldo após uma aposta:", JSON.stringify(remaining));
console.log("Outra aposta de 80.00 cabe no saldo?", !remaining.isLessThan(bet));
// A proteção contra duas instâncias apostarem ao mesmo tempo virá do PostgreSQL.
