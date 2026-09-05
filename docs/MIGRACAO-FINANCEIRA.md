# GesCondu — Migração do modelo financeiro

Este documento descreve a estratégia de evolução do modelo financeiro para o fluxo:

**Orçamento anual → distribuição → plano de quotas → emissão → pagamento → movimento bancário → saldo**

## Situação atual

- `orcamento_itens` = apenas `ano + categoria_id + valor_orcamentado` (sem entidade de orçamento, sem período, sem estados).
- `quotas` = valor mensal manual por fração (o admin define o valor todos os meses).
- `contas_bancarias` = tem `saldo_inicial` mas sem datas de início/saldo.
- Saldos calculados somando `pagamentos` e `despesas` (não há movimentos bancários).
- Não existe bloqueio nem histórico de alterações ao orçamento.

## Modelo alvo

| Tabela (nova/alterada) | Papel |
| --- | --- |
| `orcamentos` (nova) | Entidade de orçamento: período (1 ano), estados, aprovação, assembleia/documento |
| `orcamento_rubricas` (nova) | Rubricas do orçamento: categoria, valor anual, método de distribuição, periodicidade, ativa |
| `orcamento_distribuicoes` (nova) | Distribuição calculada por rubrica × fração (valor anual) |
| `orcamento_alteracoes` (nova) | Histórico/versionamento de alterações (valor anterior/novo, justificação, utilizador) |
| `planos_quota` (nova) | Plano de cobrança derivado do orçamento aprovado (período × fração × valor) |
| `movimentos_bancarios` (nova) | Movimentos de entrada/saída/transferência por conta |
| `quota_rubricas` (nova) | Discriminação das rubricas dentro de cada quota emitida |
| `contas_bancarias` (alterada) | + `data_inicio`, `data_saldo_inicial` |
| `quotas` (alterada) | + `orcamento_id` (FK opcional), ligação ao plano |

## Regras de migração (não-destrutivas)

1. **Migrations aditivas** — nunca apagar tabelas/colunas existentes; nunca `sync({force:true})`.
2. **Dados existentes preservados** — `orcamento_itens` é migrado para `orcamentos`+`orcamento_rubricas` (a tabela antiga mantém-se).
3. **Dinheiro em `DECIMAL`** e cálculo em cêntimos (`helpers/money.js`); arredondamento explícito para que **soma das frações = total**.
4. **Transações Sequelize** em todas as operações compostas (emissão, pagamento, transferência, alteração extraordinária).
5. **Nunca apagar** — preferir anulação/nova versão/correção auditada; numeração de documentos nunca reutilizada.

## Fases

| Fase | Âmbito | Estado |
| --- | --- | --- |
| 1 | Novo modelo de orçamento (entidade + rubricas + histórico) + migrations | ✅ |
| 2 | Distribuição do orçamento pelas frações (permilagem / igual / valor fixo) | ✅ |
| 3 | Plano de quotas (derivado do orçamento aprovado) | ✅ |
| 4 | Nova emissão de quotas baseada no plano aprovado | ✅ |
| 5 | Bloqueio de alterações + histórico (`orcamento_alteracoes`) | ✅ |
| 6 | Movimentos bancários + saldos derivados | ✅ |
| 7 | Integração pagamentos/despesas → movimentos bancários | ✅ |
| 8 | Refatoração dos PDFs (sistema de layout) | ✅ |
| 9 | Redesign Material Design | ✅ |
| 10 | Testes + documentação | ✅ |
