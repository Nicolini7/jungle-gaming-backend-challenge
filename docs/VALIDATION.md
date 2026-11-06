# Evidências de validação

Execução observada em **05/11/2026**: **263 testes aprovados, zero falhas e 1.792
verificações**. TypeScript aprovado. Os resultados abrangem serviços reais e processos
independentes; os tempos da suíte não representam capacidade de produção.

| Grupo | Testes | Verificações |
| --- | ---: | ---: |
| Unidade | 140 | 401 |
| Integração | 123 | 1.391 |
| Total | 263 | 1.792 |

## Ambiente em containers

| Componente | Versão |
| --- | --- |
| Bun | 1.4.4 |
| PostgreSQL | 17 |
| LocalStack | 4.7.0 |
| Keycloak | 26.4.7 |
| Docker Engine | 29.8.1 |
| Docker Compose | 5.5.1 |

PostgreSQL, SQS e o Identity Provider participam das integrações. A aplicação usa o papel
restrito `jungle_app`; migrations usam uma conexão administrativa separada. Configurações
e segredos de teste são gerados por ambiente, sem credenciais persistidas no repositório.

## Reprodução

O [README](../README.md) contém os pré-requisitos, o setup e os comandos completos.
Com os serviços iniciados, interrompa as APIs antes da suíte para que seus publishers
não disputem a outbox com os workers dos testes:

```sh
docker compose stop api1 api2 api3
docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps test bun run typecheck
docker compose -f compose.yaml -f compose.test.yaml run --build --rm test bun test --timeout 60000
docker compose up -d api1 api2 api3
```

O workflow [Backend checks](https://github.com/Nicolini7/jungle-gaming-backend-challenge/actions/workflows/ci.yml)
executa typecheck, unidade e integração em containers, com configuração isolada por execução.

## Cobertura verificada

| Área | Cenários |
| --- | --- |
| Dinheiro e domínio | Escala fixa, moedas, limites, operações exatas e transições terminais |
| Concorrência | Cinquenta submissões da mesma aposta, disputa de saldo, carteiras independentes e três processos |
| Idempotência | Replay persistente, saldo original e conflitos de chave, conteúdo ou identidade externa |
| Atomicidade | Falha SQL na outbox desfaz operação, saldo, ledger e inbox |
| Ledger e banco | Constraints, imutabilidade, cadeia de saldos, versões e migrations reversíveis |
| Referências | REFUND e ROLLBACK antes da referência, rejeições, backoff e limite de retomadas |
| Mensageria | Redelivery, morte após commit e antes do ack, publishers concorrentes, retry, DLQ e reinício |
| Identidade | Tokens emitidos pelo Keycloak, assinatura e claims, papéis e isolamento entre operadores e provedores |
| Privilégios | Recusa de conexão administrativa no runtime e negação de alterações indevidas no banco |
| Eventos | Recibos persistentes, duplicatas, versões invertidas, snapshots inválidos e cartões sem regressão |

Os cenários financeiros terminam com reconciliação entre o saldo materializado e o ledger.
Falhas pontuais são injetadas nas fronteiras sem substituir PostgreSQL e SQS por memória.

## Demonstração com três APIs

A demonstração autenticada distribuiu 50 chamadas da mesma aposta entre três instâncias:
um processamento, 49 replays e saldo final `75.00`. Duas apostas simultâneas de `80.00`
sobre saldo `100.00` produziram um aceite, uma rejeição e saldo final `20.00`.
As duas reconciliações retornaram `consistent=true` e diferença `0.00`.

Um SIGTERM real encerrou o processo em um segundo, com exit code zero e sem OOM. Após o
reinício, os saldos e as reconciliações permaneceram consistentes. As consultas das três
APIs confirmaram projeções de saldo compatíveis e um único cartão por operação.

O script `scripts/validate-containers.sh` reproduz a demonstração e as verificações de
shutdown, reinício, reconciliação e leituras dos eventos.

## Limitações

As evidências correspondem ao ambiente de desenvolvimento descrito. Keycloak `start-dev`,
SQS emulado e endpoints locais não constituem uma configuração de produção. A validação
não equivale a uma certificação de segurança ou a um teste de invasão da infraestrutura.
A versão principal não inclui benchmark de carga; os experimentos adicionais acompanham
a versão complementar. TLS, gestão de segredos, backups e operação em produção exigem
planejamento próprio.
