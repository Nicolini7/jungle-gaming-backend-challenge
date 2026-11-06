# Experimento de carga

Execuções observadas em 05/11/2026, entre 19:27:21 e 19:27:34 de Brasília, em Docker
num ambiente isolado da VPS. Cada execução fez 120 chamadas HTTP com concorrência 8,
distribuídas entre três APIs. Cada BET teve valor de BRL 0.01. Não houve retries no cliente.

| Cenário | Carteiras | Requisições/s | p50 ms | p95 ms | p99 ms | Erros | Operações únicas | Replays |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Independentes | 4 | 27,25 | 209,03 | 836,02 | 1.142,39 | 0 | 120 | 0 |
| Mesma carteira | 1 | 30,86 | 204,58 | 605,99 | 1.032,96 | 0 | 120 | 0 |
| Mesma aposta repetida | 1 | 110,14 | 56,40 | 152,86 | 172,88 | 0 | 1 | 119 |

Todas as carteiras reconciliaram com diferença zero e com o saldo esperado pelo plano
independente de comandos. As quatro carteiras independentes terminaram com BRL 0.91
cada; a carteira disputada, BRL 0.01; as duplicatas, BRL 1.20. O saldo inicial era BRL 1.21.

| Cenário | Conflitos SQL registrados | Outbox lag antes, s | Outbox lag depois, s |
| :--- | ---: | ---: | ---: |
| Independentes | 0 | 0,192303 | 2,423566 |
| Mesma carteira | 0 | 2,965861 | 3,687154 |
| Mesma aposta repetida | 0 | 4,715010 | 5,012873 |

Conflitos SQL são exceções registradas pelo contador, não tempo de espera por row locks.
O lag é a idade global da outbox pendente, compartilhada com registros anteriores,
medida antes e depois de cada execução. Não representa latência de entrega por evento.
O experimento não exige que a outbox termine drenada dentro da janela de medição.

## Ambiente e método

Linux x64, Bun 1.4.4, três APIs com limite individual de 1 CPU e 192 MiB. PostgreSQL com
1 CPU, 384 MiB, shared_buffers de 64 MB e work_mem de 2 MB. O cliente teve limite de
2 CPUs e 1.536 MiB. Cliente, PostgreSQL e APIs compartilharam a VPS e a rede Docker.
A memória total reportada pelo sistema nos JSONs identifica o host, não a quota do cliente.

O tempo medido inclui envio HTTP, autenticação, processamento, locks, PostgreSQL e leitura
da resposta. Setup de carteiras, readiness, métricas e reconciliação ficam fora dessa janela.
Não há aquecimento com transações medidas. Os percentis usam nearest rank sobre todas
as requisições concluídas, incluindo erros. Throughput conta requisições, inclusive replays.

Cada modo foi executado uma vez. A amostra curta e o host compartilhado não permitem
inferir capacidade de produção ou comparar desempenho dos cenários com significância
estatística. As medições servem para reproduzir carga concorrente e verificar correção.

O prazo configurado limita o agendamento de novas requisições. Requisições em andamento
podem levar até mais 30 segundos para concluir ou atingir seu timeout. Uma execução
incompleta, com erro, identidades incorretas ou reconciliação divergente termina com falha.
Os efeitos esperados vêm dos comandos planejados, sem usar os IDs devolvidos pelo servidor
para decidir quantas operações deveriam existir. Os registros financeiros são preservados.

## Reproduzir

Com o ambiente padrão do README em execução:

```sh
LOAD_MODE=independent LOAD_REQUESTS=120 LOAD_CONCURRENCY=8 LOAD_WALLETS=4 bun run test:load
LOAD_MODE=hot LOAD_REQUESTS=120 LOAD_CONCURRENCY=8 bun run test:load
LOAD_MODE=duplicates LOAD_REQUESTS=120 LOAD_CONCURRENCY=8 bun run test:load
```

No PowerShell, atribua as mesmas variáveis por `$env:LOAD_MODE`, `$env:LOAD_REQUESTS` e
`$env:LOAD_CONCURRENCY` antes de executar `bun run test:load`. O Bun carrega o `.env` do
setup. `OIDC_TOKEN_URL` deve ser alcançável pelo cliente e emitir tokens para o issuer das APIs.

`LOAD_URLS` aceita URLs de loopback ou os serviços Docker `api1`, `api2`, `api3`.
O padrão usa as portas locais 3000, 3001 e 3002. `LOAD_ENVIRONMENT` registra os limites
efetivos do servidor, que o cliente não consegue descobrir sozinho. O script recusa
redirecionamentos e alvos externos. Há limites de 10.000 chamadas, concorrência 100,
32 carteiras e 120 segundos de agendamento. Essas opções devem ser explícitas para
experimentos maiores; o teste de carga não roda automaticamente no CI.

## Dados completos

- [Carteiras independentes](4b1b2055-1570-44da-abbc-ac5e43361a36.json).
- [Mesma carteira](1a3d7d52-d169-4ea5-b181-e8901de598d3.json).
- [Duplicatas](8ecf17fc-486c-4625-8592-91f7da75212d.json).

Os JSONs incluem configuração, contagens, percentis, métricas, reconciliações e limitações,
sem tokens, senhas ou dados pessoais.
