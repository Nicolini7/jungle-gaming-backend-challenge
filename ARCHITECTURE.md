# Arquitetura e decisões

Implementação do [Distributed Wagering Processor](https://github.com/junglegaming/backend-challenge).
Os mecanismos descritos correspondem ao código implementado. Consulte [README](README.md)
e [evidências de validação](docs/VALIDATION.md) para comandos, resultados e limites.

## Estrutura e fronteiras

Monólito modular NestJS, TypeScript estrito e Bun 1.x. Cada processo pode executar HTTP,
consumer de comandos SQS, publisher de outbox, consumer de eventos e worker de referências. PostgreSQL é a autoridade para
saldo, idempotência e coordenação entre instâncias.

```text
HTTP controller        SQS consumer de comandos
             ↘        ↙
              WagerService
                   ↓
       EntityManager transacional
          e lock da carteira
                   ↓
operação + wallet + ledger + inbox + outbox
                   ↓
                 COMMIT
                   ↓
resposta HTTP ou confirmação da mensagem

Outbox confirmada → publisher → fila de eventos
Fila de eventos → EventProjector → recibo + snapshot/cartão
Pendências → worker → mesmo processamento financeiro
```

`src/domain` contém classes com construtores privados/protegidos, factories e transições
explícitas. O domínio permanece independente de NestJS, TypeORM e SQS. As classes persistidas
em `src/infrastructure/database/rows.ts` representam o armazenamento. O caso de uso as mapeia
para o domínio por `rehydrate`, reconstruindo estado sem repetir regras de transição.

## Money e precisão

O contrato recebe e devolve `{ amount: "25.10", currency: "BRL" }`. Internamente `Money`
guarda `2510n`, um inteiro bigint em centavos. Soma, subtração, inversão e comparação são
exatas e não convertem dinheiro para `number`. Operações retornam novas instâncias congeladas.

O esqueleto do enunciado usa Decimal e permite adaptar o modelo preservando suas garantias.
Centavos em bigint cobrem a escala fixa e as operações exigidas sem outra dependência.
Câmbio, juros ou divisão exigiriam uma política explícita de escala e arredondamento,
que está fora deste escopo.

- Duas casas obrigatórias: `"1.00"` é válido; `"1"`, `"1.0"` e `"1.005"` são rejeitados.
- Entradas rejeitam negativos, expoentes, NaN/Infinity, espaços, sinal positivo e zeros
  adicionais à esquerda. Não há arredondamento silencioso.
- Moedas suportadas pela API e pelo domínio: BRL, USD e EUR, todas com duas casas.
- Operações entre moedas diferentes falham com `CURRENCY_MISMATCH`.
- Limite absoluto: `999999999999999999.99` - 18 dígitos inteiros e dois decimais.
- Cálculos internos e reidratação permitem diferenças negativas. Wallet e banco asseguram
  que o saldo disponível permaneça não negativo.

PostgreSQL usa [`NUMERIC` sem typmod](https://www.postgresql.org/docs/current/datatype-numeric.html), acompanhado de checks de escala, intervalo e
não-negatividade. Isso evita que `NUMERIC(p,2)` arredonde uma entrada SQL antes da validação.
NaN e infinidades são excluídos pelo intervalo. O driver `pg` entrega strings; o transformer
TypeORM apenas completa casas com `split`/`padEnd`, sem conversão numérica. A leitura retorna
ao domínio por `Money.rehydrate`.

## ORM e transação

Foi escolhido **TypeORM**, uma das opções aceitas. `EntitySchema` mapeia classes de
persistência sem decorators no domínio. `EntityManager` transacional e `pessimistic_write`
tornam explícitos o pool, o escopo da transação e a aquisição de locks. Essa configuração
funciona com Bun sem depender de reflexão de metadados das entidades.

Trade-off de simplicidade: o caso de uso conhece o EntityManager e o mapeamento das rows,
mantendo a unidade transacional visível. Não se afirma uma arquitetura de dependências
inteiramente invertidas. Portas de repositório/Unit of Work poderiam isolar essa dependência
na aplicação; as classes de domínio já permanecem independentes da infraestrutura.

`Database.transaction()` executa em **READ COMMITTED**. Todo código no callback usa o
EntityManager recebido. Criação da operação, alteração da wallet, ledger, inbox e outbox
são confirmados na mesma transação; uma falha em qualquer escrita desfaz o conjunto.

Migrations são versionadas e reversíveis, com `synchronize` desabilitado. Um advisory lock
coordena somente a execução das migrations no startup simultâneo. Transações financeiras
nunca usam esse lock global.

## Concorrência e garantias do schema

O primeiro lock financeiro é sempre a wallet (`SELECT ... FOR UPDATE`), inclusive no worker
de referências. Movimentos da mesma carteira se serializam; carteiras diferentes progridem
em paralelo. Optimistic locking exigiria mais retries em uma carteira disputada. A estratégia
pessimista simplifica a demonstração das garantias dentro do timebox.

O schema reforça a proteção, inclusive para SQL direto:

- Uma wallet por `(player_id, currency)`, saldo não negativo e moeda suportada.
- `tenant_id` identifica o operador dono da carteira e é imutável; registros legados
  permanecem no escopo interno reservado, sem atribuição automática a um dono externo.
- Idempotency key global única e identidade `(provider_id, external_transaction_id)` única.
- Um lançamento por `(transaction_id, wallet_id)` e uma posição por versão da wallet.
- Aritmética correta e correspondência de moeda/wallet entre transação e lançamento.
- Triggers bloqueiam UPDATE, DELETE e TRUNCATE do ledger.
- Identidades financeiras são imutáveis e transações terminais não mudam de estado.
- Constraint triggers `DEFERRABLE INITIALLY DEFERRED` conferem no commit que saldo é a soma
  do ledger, que a cadeia `before/after` é contínua, que versões correspondem a movimentos
  e que cada transação financeira processada possui seu lançamento.

As validações diferidas permitem escrever os componentes em sequência durante a transação
e exigem consistência no commit. OPENING positivo gera crédito na versão 1. Abertura zero
não gera lançamento. Alterações posteriores incrementam a versão; LOSS preserva saldo e
versão. Operações financeiras exigem valor positivo e LOSS exige `0.00`, resolvendo
explicitamente a ambiguidade do enunciado sobre movimentos de valor zero.

Rejeições por player/moeda divergentes podem ser persistidas para auditoria. Por isso a
transação referencia a wallet por ID, enquanto igualdade financeira completa é exigida
no ledger e nas transações PROCESSED. Uma FK composta nessa entrada impediria a rejeição.

Trade-off: os triggers cruzados reconstroem o histórico da carteira no commit. O custo cresce
com o ledger. Uma evolução poderia validar a cadeia incrementalmente e executar reconciliação
completa em lotes, com benchmarks e política de privilégios próprios.

## Idempotência, hash e replay

O header HTTP `Idempotency-Key` é obrigatório. Na fila, o valor vem em `data.idempotencyKey`.
O escopo escolhido é global; o formato recomendado continua sendo
`providerId:externalTransactionId`. Outra key com a mesma identidade externa é conflito.

O payload financeiro validado é serializado em JSON canônico: chaves de objetos ordenadas
recursivamente, ordem de arrays preservada e valores JSON estáveis. O hash é SHA-256
hexadecimal. Header de idempotência, correlationId e metadados de transporte ficam fora desse
hash. A inbox usa outro hash, do envelope completo, para detectar reutilização de messageId.

Um pedido igual retorna a operação existente com `idempotentReplay: true`. Outra carga com
a mesma key gera conflito. O saldo observado fica persistido em `balance_after`; o replay
terminal retorna esse saldo mesmo após outras movimentações. Pendências podem evoluir e
consultas/replays refletem essa evolução até o estado terminal.

Constraints resolvem disputas de unicidade que cruzam wallets diferentes. Após rollback de
uma violação, o caso de uso consulta a operação vencedora e verifica key/hash. A garantia
não depende de cache em memória ou deduplicação temporária do SQS FIFO.

## Operações, referências e transições

BET debita; WIN credita; LOSS registra resultado; REFUND devolve uma BET; ROLLBACK inverte
BET, WIN ou REFUND. OPENING é interno e o provider `system` é reservado.

Referências são resolvidas por `(providerId, referenceExternalTransactionId)` e devem
coincidir em provider, player, wallet, moeda e rodada. REFUND e ROLLBACK exigem referência
e valor integral igual. WIN e LOSS podem referenciar uma BET da mesma rodada.

O limite de reversão foi interpretado literalmente como **uma reversão por referência e tipo**.
O índice parcial único `(reference_transaction_id, kind)` para reversões processadas implementa
essa regra. Assim, REFUND e ROLLBACK distintos podem referenciar a mesma BET. Essa consequência
merece alinhamento de produto: exclusividade entre tipos seria outra regra, exigindo mudar
o índice e as validações. Reversões parciais e rollback de rollback ficam fora do escopo.

Referência ausente ou ainda pendente produz PENDING_REFERENCE. O worker retoma com base de
1 segundo, crescimento exponencial, teto de 60 segundos, limite de 20 retomadas e TTL de
24 horas, valendo o primeiro limite atingido. Isso mantém a recuperação finita; um provedor
real pode exigir outra janela. Mesmo na última tentativa, uma referência disponível é
resolvida antes da expiração. Se continuar faltando, a operação termina como
REJECTED/REFERENCE_NOT_FOUND, com evento correspondente.

Transições válidas:

```text
PENDING           -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
PENDING_REFERENCE -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
PROCESSED, REJECTED, FAILED -> terminais
```

O modelo oferece FAILED. No fluxo atual, falhas permanentes de mensagens são preservadas
em DLQ sem reescrever uma operação já terminal. Falhas SQL anteriores ao commit são revertidas,
em vez de inventar um resultado financeiro confirmado.

## Falhas e HTTP

| Código de negócio | Significado |
| --- | --- |
| INSUFFICIENT_FUNDS | BET acima do saldo disponível |
| REVERSAL_INSUFFICIENT_FUNDS | Desfazer um crédito produziria saldo negativo |
| PLAYER_MISMATCH / CURRENCY_MISMATCH | Identidade/moeda incompatível com a wallet |
| REFERENCE_NOT_FOUND | Referência ausente após o limite de espera |
| REFERENCE_NOT_PROCESSED | Referência terminou rejeitada ou falhou |
| REFERENCE_MISMATCH | Referência de outra wallet, player, moeda ou rodada |
| INVALID_REFERENCE_KIND | Tipo de referência incompatível |
| REFERENCE_AMOUNT_MISMATCH | Tentativa de reversão parcial ou de outro valor |
| REFERENCE_ALREADY_REVERSED | Outra reversão do mesmo tipo já aplicada |
| MONEY_OVERFLOW | O crédito excederia o limite monetário suportado |

| HTTP | Situação |
| --- | --- |
| 200 / 201 | Operação processada / wallet criada; consultas e reconciliação |
| 202 | Aceite com referência pendente |
| 400 | Payload, valor, referência obrigatória, ID, header ou cursor inválido |
| 404 | Wallet ou transação não encontrada |
| 409 | Wallet duplicada, conflito de key/hash ou identidade externa |
| 422 | Rejeição financeira persistida, com failureCode estável |
| 503 | Dependência indisponível ou falha transitória de infraestrutura |
| 500 | Erro interno inesperado; mapeamento reservado também a resultado FAILED |

Erros do adaptador têm `{ error: { code }, retryable }`; retryable é verdadeiro para 503.
Resultados carregam transactionId, status, balance, idempotentReplay e, quando aplicável,
failureCode. SQL e payloads financeiros completos não saem no erro.

## SQS, inbox, outbox e shutdown

`wager-transactions.fifo` recebe comandos; `wager-transactions-dlq.fifo` preserva falhas
permanentes/esgotadas; **`wager-events.fifo`** recebe eventos de saída. Eventos não retornam
à fila de comandos. MessageGroupId usa wallet; essas otimizações FIFO não substituem o banco.

Inbox deduplica `(consumerName, messageId)` com hash persistido na transação financeira.
O ack pelo receipt handle acontece depois que submit retorna após o commit. Resultados
REJECTED recebem ack. Payload inválido e conflitos permanentes vão à DLQ. Erros transitórios
recebem backoff exponencial até 300 segundos e no máximo cinco recebimentos por padrão.
O envio durável à DLQ precede o ack da origem.

Há heartbeat de visibilidade durante o processamento. No shutdown, polling é cancelado e
mensagens em andamento podem concluir; após a janela de 25 segundos, sua visibilidade é
devolvida. Compose concede 35 segundos antes de encerrar o container.

O publisher seleciona até dez eventos com `FOR UPDATE SKIP LOCKED`, publica e marca
published_at na transação de coordenação. Publishers concorrentes pegam conjuntos distintos.
Uma falha incrementa attempts e agenda backoff até 300 segundos. Eventos confirmados não
são descartados por um limite arbitrário de publicação.

Um crash depois que o SQS aceita e antes do commit da marca pode repetir a publicação.
O eventId permanece estável; consumidores de integração devem deduplicá-lo persistentemente.
A deduplicação temporária FIFO não fornece uma garantia end-to-end de exactly once.

Os quatro eventos mínimos têm subclasses concretas de IntegrationEvent, envelope versionado,
correlationId/causationId e MoneyProps em strings. WalletBalanceChanged só sai quando o saldo
muda. O evento de pendência é emitido ao entrar nesse estado, sem outra cópia a cada retry.

## Consumo de eventos e notificações

`EventProjector` mantém três estruturas separadas do ledger: `event_receipts`,
`wallet_balance_projections` e `in_app_notifications`. As três são alteradas na mesma
transação SQL. Um recibo só fica definitivo junto com seus efeitos; falhar antes do commit
desfaz tudo e permite que a nova entrega retome o processamento.

O consumidor é local a este produtor e usa sua outbox como origem confiável. O envelope
precisa corresponder ao evento persistido por ID, tipo, aggregate e hash canônico. Um evento
de saldo também precisa corresponder ao lançamento real do ledger, incluindo transação,
versão, moeda, direção e valores. IDs de destinatário e operador vêm da carteira persistida.
Dados arbitrários de fila não podem substituir essa identidade.

Um snapshot de saldo só substitui outro quando sua `walletVersion` é maior. O `UPSERT`
condicionado é atômico no PostgreSQL e suporta consumidores concorrentes. Como cada evento
contém o saldo absoluto, uma versão superior pode ser aplicada mesmo que versões anteriores
ainda não tenham chegado. A retomada dessas versões antigas não faz o saldo retroceder.
Essa projeção é eventualmente consistente; débitos continuam usando a carteira financeira.

As notificações são cartões internos `in_app`, com unicidade por transação, destinatário e
canal. Eventos de processamento, rejeição e referência pendente atualizam esse cartão;
`WalletBalanceChanged` atualiza somente a projeção, evitando um segundo cartão para a mesma
aposta. O cartão pode passar de pendente para processado ou rejeitado. Estados terminais
não regridem. Uma pendência antiga é descartada se a operação financeira já terminou.

`SqsEventConsumer` confirma a mensagem somente após `EventProjector.process` concluir o
commit. Falhas transitórias recebem backoff; falhas permanentes e tentativas esgotadas vão
para `wager-events-dlq.fifo` antes da confirmação na origem. A quarta fila é provisionada
quando o consumidor de eventos é inicializado. Há cancelamento do polling, heartbeat e
devolução de visibilidade durante o desligamento.

As consultas de notificações e projeção usam a mesma autorização de carteira/operador das
rotas financeiras. Uma projeção ainda não disponível responde `404 BALANCE_PROJECTION_NOT_READY`.
Não há entrega externa de e-mail, push ou WebSocket. A publicação continua sendo
at-least-once; os efeitos internos são deduplicados pelo recibo persistente.

O contrato detalhado está em [docs/EVENT-CONSUMER.md](docs/EVENT-CONSUMER.md).

## Consultas e reconciliação

O cursor do ledger é base64url opaco com versão do formato, walletId e última walletVersion.
A ordenação usa uma versão única e imutável por carteira; novas entradas não deslocam páginas
anteriores. O limite é de 1 a 100. Cursor de outra wallet ou representação inválida gera 400.

Reconciliação adquire o mesmo lock da wallet antes de somar o ledger, evitando leituras de
momentos diferentes. Compara saldo armazenado e calculado, devolve diferença em MoneyProps
e registra divergência em log/métrica. Não corrige o saldo silenciosamente.

## Observabilidade e configuração

Logs JSON incluem correlationId, messageId, transactionId, walletId e providerId, usando null
quando indisponíveis. Uma allowlist impede incluir objetos completos ou campos monetários.
X-Correlation-Id válido é propagado na submissão HTTP.

GET /metrics expõe Prometheus com prefixo `jungle_`: submissões por status, duplicatas,
latência, retries, DLQ, conflitos de lock, erros por worker, publicações e lag da outbox.
transactions_total conta submissões observadas, incluindo replays; não é um inventário atual
das linhas do banco. Contadores principais são inicializados em zero; histogramas e outras
métricas são registrados conforme os caminhos são usados.
Liveness verifica o processo; readiness consulta PostgreSQL e as filas SQS provisionadas,
quatro no perfil completo com consumidor de eventos.

WORKERS_ENABLED=false executa somente HTTP. O entrypoint da aplicação rejeita
RUN_MIGRATIONS=true: migrations usam o entrypoint e a conexão administrativa separados.
Compose executa o migrador antes das três instâncias e aguarda as dependências saudáveis.
HOST é 0.0.0.0 dentro dos containers, com portas publicadas somente em loopback;
localmente o padrão é 127.0.0.1.

## Identidade, operador e autorização

A entrega integra Keycloak 26.4.7 como Identity Provider externo. `OidcIdentityVerifier`
usa `jose` e o JWKS configurado para validar assinatura RS256, issuer, audience, expiração
e claims obrigatórias. A aplicação falha no startup quando a configuração de identidade
não está completa; não há modo permissivo no guard nem autenticação própria por senha.

O principal contém subject, `tenant_id`, papéis em `realm_access.roles` e, para provedores,
`provider_id`. O registro `PROVIDER_TENANTS_JSON` é configuração confiável do servidor;
um provider do token precisa estar associado ao mesmo operador. Os claims só são usados
depois da verificação criptográfica. Em production, issuer e JWKS exigem HTTPS.

`wallet-admin` cria carteiras no próprio operador e consulta métricas. `wager-provider`
não possui esses privilégios. Carteiras, ledger e reconciliação exigem o mesmo tenant;
consultas de transação também verificam o provedor do principal quando ele não é admin.
Submissões validam o vínculo entre provedor, principal e carteira antes de chamar o core,
inclusive quando o resultado será um replay.

O tenant da criação vem do principal, não de campos livres do body. A migration de
ownership torna esse campo imutável, preservando a autorização entre a checagem e o lock
financeiro. A unicidade global `(playerId, currency)` permanece igual à do enunciado.
O escopo legado `__internal__` não é válido em tokens nem no registro de provedores.

Health permanece aberto. Métricas operacionais exigem administrador. A política é
aplicada nos dez handlers conforme sua finalidade; o isolamento por operador é realizado
na aplicação e não por RLS de cada usuário no PostgreSQL.

SQS continua sendo um canal interno confiável, sem exigir JWT no envelope. Antes do mesmo
caso financeiro, `AuthorizedWagerProcessor` verifica o provedor registrado e o tenant da
carteira. Assim, mudar o transporte não permite contornar o escopo de operador.

O perfil local provisiona cinco clientes `client_credentials`: admins A/B, providers A/B
e provider C no operador A. Seus segredos são aleatórios por ambiente, mantidos em `.env`,
fora do repositório e do build. O template do realm contém referências a variáveis,
sem embutir os valores dos segredos.

## Credenciais e privilégios do PostgreSQL

`bun run setup` gera credenciais exclusivas e configuração local. Conexões deixam de ter
fallback com senha pública; o banco exige SCRAM. O processo normal usa `jungle_app`, sem
superuser, criação de database/roles, ownership do schema ou permissão para alterar o ledger.
O runtime verifica os privilégios da conexão e rejeita uma credencial administrativa usada
por engano na aplicação.

A conexão de migrations é separada em `MIGRATION_DATABASE_URL`. O migrador possui os
privilégios necessários para DDL e fica fora do processo HTTP/worker. O papel de aplicação
recebe SELECT/INSERT e somente as colunas UPDATE indispensáveis ao processamento, sem
UPDATE de identidade/tenant e sem DELETE/TRUNCATE/DDL.

Atualizar credenciais de um volume existente exige um procedimento explícito: mudar
variáveis de bootstrap não atualiza contas já persistidas. Os helpers verificam que o alvo
é o cluster deste projeto, atualizam autenticação e papéis preservando os dados e recusam
estados de ownership ambíguos. O papel legado pode manter seu OID para preservar ownership.

## Validação e limites

As evidências e versões executadas estão em `docs/VALIDATION.md`. Os testes de autorização
usam tokens emitidos pelo Keycloak real, PostgreSQL e SQS, incluindo anonimato, papéis
insuficientes, troca de operador/provedor, IDs cruzados e assinatura/claims inválidos.
Os testes de banco verificam autenticação e negação de privilégios, além das garantias
financeiras existentes.

O Compose é um perfil de desenvolvimento com Keycloak start-dev e emulador SQS. Uso em
produção exige gestão de segredos, TLS, provisionamento do IdP, backup e operação próprios.
Não foi realizado benchmark de carga; dashboard, tracing e double-entry continuam opcionais.
