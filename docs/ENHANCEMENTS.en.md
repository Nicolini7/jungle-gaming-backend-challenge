# Extended validation

The primary delivery is [v1.0.1](https://github.com/Nicolini7/jungle-gaming-backend-challenge/releases/tag/v1.0.1).
Branch `enhancements` and version `v1.1.0-enhanced.2` add tests and the optional load
experiment described in the challenge. Production code and financial rules are unchanged
from the primary version.

Both versions include durable event receipts, one internal notification per operation,
recipient and channel, monotonic balance projections and terminal notification states.
Events are verified against the committed outbox and ledger. Acknowledgement follows the
database commit; retry, DLQ and bounded shutdown handle failures. See [EVENT-CONSUMER.md](EVENT-CONSUMER.md).
These guarantees apply to internal notifications exposed through authenticated HTTP.
External email, push and WebSocket delivery are not implemented.

The additional financial matrix has 43 integration tests using real PostgreSQL and two
independent restricted application connections. It covers BRL, USD and EUR, all five
transaction kinds, representative balance boundaries, one-cent values, overflow, currency
conflicts, replay, reference ordering, provider isolation, per-type reversal uniqueness,
separate wallets and concurrent operations. Reconciliation checks expected amounts and
currencies, plus ledger entries and wallet versions where applicable.

Ten Money tests use 256 reproducible samples per currency with seed `0x4a554e47`, an
independent bigint oracle, algebraic identities, immutable operands, signed values and
range boundaries. Twelve load-oracle tests check planned effects independently of server
responses, including detection of distinct commands incorrectly returned as one operation.

The challenge allows one reversal of each type per reference. REFUND and ROLLBACK may
therefore each credit the same BET once. Changing that rule requires a business decision.
The matrix covers finite representative combinations; it cannot exhaust every monetary
value or execution schedule.

On November 5, 2026, the full container suite passed: **328 tests, zero failures and
12,174 assertions across 20 files**, in 41.96 seconds, with TypeScript checks passing.
PostgreSQL used a new isolated volume while prior volumes were preserved. APIs sharing
that environment were stopped during the suite. The revised financial matrix also passed
natively with 43 tests and 2,552 assertions. The 22 additional unit tests passed with 7,844
assertions. Assertions within concurrent branches may vary with valid execution ordering.

Normal README commands run the additional tests on this branch. Integration requires
the real services and environment variables, including `RUN_INTEGRATION=1`. Stop APIs
consuming the same outbox before the suite, as explained in [VALIDATION.md](VALIDATION.md).
Records are preserved. Load methodology, commands, measurements and limitations are in
[load/README.md](load/README.md).

Use `main` or `v1.0.1` for the primary delivery and `enhancements` or `v1.1.0-enhanced.2`
for supplementary validation. Each release has a separate ZIP, manifest and SHA-256.
The supplementary version is a prerelease.
