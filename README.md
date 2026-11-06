Esta branch contém a validação ampliada: 328 testes aprovados em containers e três experimentos de carga com saldo reconciliado. A entrega principal está na release [v1.0.1](https://github.com/Nicolini7/jungle-gaming-backend-challenge/releases/tag/v1.0.1). Os testes e experimentos adicionais estão em [docs/ENHANCEMENTS.md](docs/ENHANCEMENTS.md).

# Jungle Gaming - Distributed Wagering Processor

Serviço financeiro distribuído em **NestJS, TypeScript estrito e Bun**, com **PostgreSQL,
TypeORM, SQS e Keycloak/OIDC**. HTTP e fila compartilham o processamento financeiro.

Saldo, operação, ledger, inbox e outbox são confirmados em uma única transação SQL.
Locks por carteira e constraints persistentes mantêm correção entre instâncias. A API
exige identidade assinada, vínculo de operador/provedor e permissões verificadas no servidor.

**Validação da versão principal:** 263 testes, zero falhas e 1.792 verificações em execução nativa e em containers;
TypeScript aprovado. Os resultados e ambientes estão em [docs/VALIDATION.md](docs/VALIDATION.md).

Enunciado: [docs/CHALLENGE.md](docs/CHALLENGE.md). Decisões: [ARCHITECTURE.md](ARCHITECTURE.md).

## Executar

Pré-requisitos: Bun 1.x e Docker com Compose. Na raiz do projeto:

```sh
bun run setup
docker compose up --build -d
docker compose ps
```

O setup cria segredos exclusivos em `.env` e o template do realm em
`.local/keycloak/jungle-realm.json`. Valores válidos existentes são reutilizados. Os
segredos ficam fora do Git, do contexto de build e do pacote de entrega.

O Compose inicia PostgreSQL, LocalStack, Keycloak, o migrador e três APIs. As migrations
usam uma conexão própria; a aplicação usa `jungle_app`, com privilégios limitados.

| Serviço | Endereço local |
| --- | --- |
| API 1 | http://127.0.0.1:3000 |
| API 2 | http://127.0.0.1:3001 |
| API 3 | http://127.0.0.1:3002 |
| Keycloak | http://localhost:18080 |
| PostgreSQL | 127.0.0.1:5432 |
| LocalStack | http://127.0.0.1:4566 |

As portas são publicadas em loopback. `docker compose stop` encerra os serviços sem
remover volumes. Para bancos já existentes, use o procedimento de atualização preservando
dados; trocar variáveis de bootstrap não altera as credenciais já persistidas.

## Identidade e autorização

As rotas financeiras exigem `Authorization: Bearer <access_token>`. O servidor valida
RS256, JWKS, issuer, audience, expiração e claims. O tenant vem de `tenant_id`; o vínculo
de provedor usa `provider_id` e o registro configurado no servidor.

| Cliente de demonstração | Operador | Provedor | Papel |
| --- | --- | --- | --- |
| `jg-admin-a` | operator-a | - | wallet-admin |
| `jg-provider-a` | operator-a | provider-a | wager-provider |
| `jg-admin-b` | operator-b | - | wallet-admin |
| `jg-provider-b` | operator-b | provider-b | wager-provider |
| `jg-provider-c` | operator-a | provider-c | wager-provider |

O fluxo é `client_credentials`; cada segredo é gerado pelo setup. `wallet-admin` cria
carteiras no próprio operador e acessa métricas. `wager-provider` opera seu provedor e
objetos permitidos no mesmo operador. A carteira tem tenant imutável. Health permanece aberto.

As mensagens SQS não precisam de JWT: são canal interno confiável, mas passam pela mesma
política de vínculo entre provedor registrado e tenant da carteira antes do caso financeiro.

O perfil local usa HTTP no IdP. Para `NODE_ENV=production`, os endpoints OIDC precisam de
HTTPS. Keycloak `start-dev` e emulador SQS são configurações de desenvolvimento.

## Validar

Interrompa os publishers das APIs antes da integração, para não disputar a outbox com os
testes. O teste executa seus próprios workers e processos.

```sh
docker compose stop api1 api2 api3
docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps test bun run typecheck
docker compose -f compose.yaml -f compose.test.yaml run --build --rm test bun test --timeout 60000
docker compose up -d api1 api2 api3
```

A suíte cobre dinheiro, constraints, atomicidade, idempotência, 50 pedidos paralelos,
três processos, referências fora de ordem, crash após commit/antes do ack, publishers
concorrentes, retry/DLQ, restart, autorização cruzada e privilégios do banco. Os resultados
da revisão atual estão em [docs/VALIDATION.md](docs/VALIDATION.md).

Para executar somente integração: `bun run test:integration`, com conexões de teste e
IdP configurados. `bun test` ignora integrações quando `RUN_INTEGRATION` não é `1`.
A CI executa as verificações em containers e não publica imagens.

## Eventos e notificações internas

Cada instância também consome os eventos confirmados para manter notificações internas e
uma projeção de saldo. O recibo persistente impede reaplicar um evento. Uma operação tem
um único cartão de notificação, cujo estado pode avançar de pendente para processado ou
rejeitado. A projeção só aceita uma versão de carteira superior à armazenada, mesmo se
eventos chegarem invertidos ou com lacunas de versão.

O saldo financeiro continua sendo o da carteira e do ledger. A projeção é uma leitura
eventualmente consistente; não participa da autorização de débitos. Não há envio de e-mail,
push ou WebSocket. O contrato está em [docs/EVENT-CONSUMER.md](docs/EVENT-CONSUMER.md).

## Demonstração HTTP autenticada

A demonstração obtém o token no IdP sem imprimi-lo e distribui 50 duplicatas e duas apostas
concorrentes entre as três instâncias. Ao final, reconcilia ambas as carteiras.

```powershell
$env:DEMO_URLS = 'http://127.0.0.1:3000,http://127.0.0.1:3001,http://127.0.0.1:3002'
bun run demo:http
```

Os dados e as reconciliações ficam em `.artifacts/demo-http.json`.

## API

| Método | Caminho | Uso |
| --- | --- | --- |
| POST | /wallets | Criar carteira; exige wallet-admin |
| GET | /wallets/:walletId | Saldo e versão |
| GET | /wallets/:walletId/ledger?limit=50&cursor=... | Histórico com cursor estável |
| GET | /wallets/:walletId/notifications?limit=50 | Cartões internos da carteira; mesmo operador |
| GET | /wallets/:walletId/balance-projection | Último snapshot de saldo consumido; mesmo operador |
| POST | /wallets/:walletId/reconciliation | Comparar saldo e ledger |
| POST | /wagering/transactions | Operação; exige Idempotency-Key |
| GET | /wagering/transactions/:transactionId | Resultado persistido |
| GET | /providers/:providerId/wagering/transactions/:externalTransactionId | Consulta pela identidade externa |
| GET | /health/live | Processo vivo; público |
| GET | /health/ready | PostgreSQL e SQS alcançáveis; público |
| GET | /metrics | Prometheus; exige wallet-admin |

Abertura de carteira:

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

Operação de aposta, usando o ID retornado pela criação:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-1",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "<id retornado pela criação>",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Envie `Idempotency-Key: provider-a:bet-1`. Processamento/replay retorna 200; criação, 201;
pendência, 202; payload inválido, 400; token ausente/inválido, 401; privilégio insuficiente,
403; objeto ausente ou fora de escopo, 404; conflito, 409; rejeição financeira, 422;
infraestrutura transitória, 503; erro inesperado, 500.

## Versões da entrega

A referência principal é [v1.0.1](https://github.com/Nicolini7/jungle-gaming-backend-challenge/releases/tag/v1.0.1),
alinhada às regras do enunciado e incluindo o consumidor seguro de eventos.
Testes e experimentos adicionais ficam na branch
[enhancements](https://github.com/Nicolini7/jungle-gaming-backend-challenge/tree/enhancements)
e na pré-release v1.1.0-enhanced.2, com evidências próprias. O código de produção e as
regras financeiras são os mesmos da versão principal.

## Regras e navegação

- Valores monetários são strings; Money usa centavos bigint e limite de 18 dígitos inteiros.
- BRL, USD e EUR; operações financeiras positivas e LOSS com zero.
- OPENING é interno; REFUND/ROLLBACK são integrais e únicos por referência e tipo.
- Replay conserva o saldo observado originalmente; hash canônico usa SHA-256.
- Referências pendentes: backoff de 1s até 60s, até 20 retomadas ou 24h.
- Comandos: wager-transactions.fifo; DLQ: wager-transactions-dlq.fifo; eventos: wager-events.fifo.
- O consumidor de eventos provisiona wager-events-dlq.fifo; mensagens permanentes ou esgotadas ficam nessa fila.

[Arquitetura](ARCHITECTURE.md) · [Validação](docs/VALIDATION.md) ·
[Eventos e notificações](docs/EVENT-CONSUMER.md).
