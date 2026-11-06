# Validação ampliada

A entrega principal está em [v1.0.1](https://github.com/Nicolini7/jungle-gaming-backend-challenge/releases/tag/v1.0.1).
A branch `enhancements` e a versão `v1.1.0-enhanced.2` acrescentam testes e um experimento
de carga opcional, previsto pelo enunciado. O código de produção e as regras financeiras
são os mesmos da versão principal.

## Notificações e ordenação

As duas versões incluem o consumidor persistente descrito em [EVENT-CONSUMER.md](EVENT-CONSUMER.md):

- Recibo por consumidor e evento, gravado na mesma transação da projeção e da notificação.
- Uma notificação interna por operação, destinatário e canal.
- Projeção de saldo que só aceita uma versão maior da carteira.
- Estado pendente que pode avançar para um estado terminal, sem regressão.
- Validação do evento contra a outbox e o ledger confirmados no PostgreSQL.
- Ack após o commit, retry, DLQ e encerramento com prazo limitado.

Essas garantias cobrem redelivery e concorrência entre consumidores. Um evento antigo pode
ter seu recebimento registrado sem substituir o saldo mais recente. A lista de notificações
é consultável por HTTP autenticado. Não há envio de e-mail, push ou WebSocket; um futuro
provedor externo exigiria sua própria política de idempotência e confirmação.

## Matriz financeira adicional

Os 43 testes de integração adicionais usam PostgreSQL real e duas conexões independentes
com o papel restrito da aplicação. Os cenários são exercitados em BRL, USD e EUR:

- BET, WIN, LOSS, REFUND e ROLLBACK, incluindo replay e conflitos de referência.
- Saldo zero, um centavo, abaixo do necessário, valor exato, sobra e limite de armazenamento.
- Crédito no limite e overflow, valores inválidos e conflito de moeda.
- Reversão antes da aposta, isolamento de provedor e unicidade por tipo de reversão.
- Carteiras distintas do mesmo jogador e operações simultâneas na mesma carteira.
- Sequência reproduzível de operações com resultado calculado em centavos inteiros.

Cada reconciliação confere saldo, moeda e, quando pertinente, versão e lançamentos do ledger.
No cenário misto, WIN e LOSS precisam processar; somente BET pode ser rejeitado por saldo.
O saldo esperado é calculado a partir do plano de operações e de seus débitos aceitos,
com limites independentes para a quantidade de apostas que podem ser aceitas.

Os 10 testes adicionais de Money incluem 256 amostras por moeda com semente `0x4a554e47`,
aritmética em bigint, preservação dos operandos, identidades algébricas, valores assinados,
moedas e limites. Outros 12 testes verificam o cálculo independente dos efeitos esperados
no experimento de carga, inclusive a detecção de operações distintas respondidas como uma só.

A regra do enunciado permite uma reversão de cada tipo por referência. Portanto, REFUND e
ROLLBACK podem creditar a mesma BET uma vez cada. O teste registra esse comportamento
expressamente. Uma política de estorno único entre tipos exigiria confirmação do negócio.

Esta é uma matriz finita com limites e combinações representativos. Ela não esgota todos
os valores monetários ou todas as possíveis ordens de execução.

## Executar

Em 05/11/2026, a suíte completa desta versão passou em containers: **328 testes, zero
falhas e 12.174 verificações em 20 arquivos**, em 41,96 segundos, com TypeScript aprovado.
PostgreSQL foi iniciado em um volume novo e exclusivo; os volumes anteriores foram
preservados. As APIs do mesmo ambiente estavam paradas para não disputar a outbox.
A matriz revisada também passou nativamente: 43 testes e 2.552 verificações. Os 22 testes
unitários adicionais passaram com 7.844 verificações. Contagens de verificações em ramos
concorrentes podem variar com a ordem legítima das operações; o resultado esperado é estável.

Os comandos normais do README executam também os novos testes nesta branch. Para conferir
somente as adições:

```sh
bun test tests/unit/enhanced-money-properties.test.ts tests/unit/load-oracle.test.ts
bun test tests/integration/enhanced-financial-matrix.test.ts
```

A integração requer as variáveis de ambiente e os serviços reais descritos no README,
com `RUN_INTEGRATION=1`. Pare as APIs que consomem a mesma outbox antes da suíte, conforme
[VALIDATION.md](VALIDATION.md). As carteiras e o ledger dos testes são preservados.

O experimento de carga exige as APIs e o Keycloak em execução. Metodologia, comandos,
resultados completos e limitações estão em [load/README.md](load/README.md).

## Versões

Use `main` ou a tag `v1.0.1` para a entrega principal. Use `enhancements` ou
`v1.1.0-enhanced.2` para examinar a validação complementar. As releases têm ZIP, manifesto
e SHA-256 próprios. A versão complementar é uma pré-release e não substitui a principal.

[English version](ENHANCEMENTS.en.md).
