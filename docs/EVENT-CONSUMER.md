# Consumo de eventos e notificações internas

O consumidor demonstra efeitos internos seguros diante de duplicatas, concorrência,
reentrega e eventos fora de ordem. Ele não acrescenta movimentações financeiras nem muda
as regras de apostas, referências, REFUND ou ROLLBACK.

## Contrato aceito

São aceitos os quatro envelopes de integração existentes, na versão 1:

| Evento | Efeito interno |
| --- | --- |
| WagerTransactionProcessed | Criar ou concluir o cartão da operação como processado |
| WagerTransactionRejected | Criar ou concluir o cartão da operação como rejeitado |
| WagerTransactionPendingReference | Criar cartão pendente se a operação ainda aguarda referência |
| WalletBalanceChanged | Aplicar o snapshot absoluto de saldo se a versão for superior |

O envelope é estrito: IDs, timestamp ISO, tipo, versão e dados precisam ter o formato
esperado. Dinheiro permanece em string decimal de duas casas, validado por `Money`.

Este consumidor é local ao produtor financeiro. Cada evento recebido é comparado com a
outbox persistida pelo ID, aggregate, tipo e hash canônico do payload completo. Um evento
de saldo também é confrontado com seu lançamento no ledger. Identidade da carteira,
destinatário e operador vêm do banco. Eventos desconhecidos ou alterados são recusados;
não se assume que dados financeiros arbitrários da fila são verdadeiros.

## Atomicidade e duplicatas

O recebimento e seus efeitos participam da mesma transação SQL:

```text
validar evento e origem persistida
    ↓
inserir event_receipts
    ↓
aplicar snapshot ou cartão de notificação
    ↓
commit
    ↓
confirmar mensagem SQS
```

A chave de recibo é `(consumer_name, event_id)`. Duas instâncias disputando o mesmo evento
precisam passar pela mesma constraint. A segunda só encontra um recibo definitivo depois
que a primeira confirma o commit. Se a primeira falhar, sua inserção e seus efeitos são
desfeitos juntos, permitindo nova tentativa.

Repetir o evento retorna `duplicate: true`, sem repetir seus efeitos. O uso do mesmo ID
com conteúdo divergente é conflito permanente. O recibo é protegido contra alteração,
exclusão e truncamento. A credencial da aplicação não tem DDL nem DELETE/TRUNCATE nas
estruturas de consumo.

## Eventos fora de ordem

`wallet_balance_projections` guarda o último snapshot aplicado. O `UPSERT` troca o estado
somente quando a versão recebida é maior que a armazenada. Essa comparação ocorre no banco,
de forma atômica, sem depender de cache ou da ordem de conclusão de promises.

Exemplo: se a versão 4 chegar antes da 2 e da 3, o saldo da versão 4 é aplicado. As versões
anteriores podem ser reconhecidas, mas não substituem o snapshot. Isso é válido porque
`WalletBalanceChanged` contém `balanceAfter` absoluto; a projeção não soma débitos ou
créditos recebidos fora de ordem. Não é necessário esperar versões intermediárias.

A leitura é eventualmente consistente. Antes do consumo, pode não existir snapshot;
durante um atraso, ele pode estar atrás da carteira financeira. A autorização de novas
apostas usa a carteira e seu lock, nunca esta projeção.

## Um cartão por operação

`in_app_notifications` tem unicidade por `(transaction_id, recipient_id, channel)`.
O canal implementado é `in_app`. A operação é identificada por seu ID financeiro, e o
destinatário é o `playerId` da carteira. O operador também é derivado dessa carteira.

Um cartão pendente pode ser atualizado para `PROCESSED` ou `REJECTED`. Um estado terminal
não volta para pendente nem muda para o outro terminal. Um evento pendente atrasado não
cria um cartão pendente se a transação financeira já terminou.

Uma BET que publica `WagerTransactionProcessed` e `WalletBalanceChanged` produz um único
cartão de operação: o evento de saldo só atualiza a projeção. Uma abertura com saldo positivo
é uma operação interna `OPENING` e também pode ter seu próprio cartão.

Esses cartões persistidos não equivalem ao envio de mensagens externas. E-mail, push e
WebSocket não fazem parte da implementação. Um canal externo precisaria de seu próprio
registro de entrega e do contrato de idempotência do provedor, quando disponível.

## Fila e recuperação

O consumidor usa `wager-events.fifo` e provisiona `wager-events-dlq.fifo` ao inicializar.
O envio para a DLQ precisa concluir antes de confirmar a mensagem de origem. Falhas
transitórias usam backoff e limite de recebimentos. O worker mantém visibilidade durante
o processamento e cancela polling/devolve visibilidade no desligamento quando necessário.

Uma morte depois do commit e antes da confirmação pode provocar reentrega. O recibo
persistente impede criar outro cartão ou reaplicar a projeção. O transporte continua
at-least-once; a aplicação não depende da janela temporária de deduplicação FIFO.

## Consultas HTTP

| Método e caminho | Retorno |
| --- | --- |
| GET /wallets/:walletId/notifications?limit=50 | `{ walletId, items }`, com no máximo 100 cartões |
| GET /wallets/:walletId/balance-projection | Snapshot `{ walletId, balance, walletVersion, eventId, updatedAt }` |

As duas rotas exigem token válido e o mesmo operador da carteira, conforme a política de
acesso existente. Identidade de destinatário/operador não pode ser escolhida por query ou
body. Uma carteira inexistente ou fora de escopo responde 404; a ausência de snapshot
responde `404 BALANCE_PROJECTION_NOT_READY`. Limite fora de 1 a 100 é inválido.

A lista usa ordem estável por criação e ID do cartão. Ela não promete ordem causal global
de publicação. A atualização de cada cartão e do saldo projetado é protegida contra
regressão independentemente dessa ordem.
