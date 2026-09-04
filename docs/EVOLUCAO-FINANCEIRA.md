# CondoFy — Evolução do módulo financeiro (orçamento, quotas, FCR, quotas extra)

## Análise do existente (reutilizar, não duplicar)

- **`Quota`** — `fracao_id`, `orcamento_id`, `ano`, `mes`, `valor` (total), `data_emissao`, `data_vencimento`, `estado`, `observacoes`; unique `(fracao_id, ano, mes)`. *(agora com `valor_base` + `valor_fcr`)*
- **`Orcamento`** — entidade + `OrcamentoRubrica` + `OrcamentoDistribuicao` + `PlanoQuota` + `OrcamentoAlteracao` (fluxo orçamento→distribuição→plano→emissão).
- **`Pagamento`** + **`PagamentoQuota`** — pagamentos e distribuição por quotas.
- **`MovimentoBancario`** — movimentos de entrada/saída por conta.
- **`Configuracao`** — key/value (já usado para `quota_valor_mensal`, lembretes).
- **Geração de quotas** — wizard `/admin/quotas/gerar` (fixo/permilagem) + emissão do orçamento `/admin/orcamento/:id/emitir` + auto `jobs/automatizacao.js` (`quota_valor_mensal`).
- **PDFs** — `helpers/pdf.js` (avisos e recibos) com sistema de layout.

## O que falta / vai mudar

| Item | Ação |
| --- | --- |
| Configuração de quotas (valor por permilagem + % FCR) | Novas chaves em `Configuracao` + modal de configuração |
| Quota com valor base/FCR | ✅ `valor_base` + `valor_fcr` adicionados (Fase 1) |
| Geração com FCR | Atualizar wizard + auto para usar `calcularQuota()` |
| Grelha anual (fração × mês) | Nova vista/tabela na página de quotas |
| Quotas Extraordinárias | Novos models `ExtraQuota` + `ExtraQuotaParcela` + rotas + vistas |
| Dashboard (previstas/recebidas/atraso/orçamento) | Melhorar dashboard |

## Fases de implementação

1. ✅ **Dados + cálculo** — `Quota.valor_base/valor_fcr`, seeds de config, `helpers/quotas-calc.js`.
2. ✅ **Config UI** — cards + modal "Configuração das quotas" + rotas `GET/POST /quotas/config`.
3. ✅ **Geração de quotas com FCR** — wizard + auto usando `calcularQuota()`, regra "não alterar quotas pagas", idempotente.
4. ✅ **Grelha anual** — `GET /quotas/grelha` + `views/admin/quotas/grelha.handlebars` (estado por fração × mês).
5. ✅ **Quotas Extraordinárias** — `ExtraQuota` + `ExtraQuotaParcela` + rotas `/admin/quotas-extra` + parcelamento (permilagem/igual) + movimentos bancários.
6. ✅ **Dashboard + integração financeira** — `helpers/dashboard.js` (previstas mês, recebidas, em atraso, total atraso, orçamento do ano).
7. ✅ **Lista de orçamentos** — colunas Receitas / Despesas / Saldo (receitas = plano de quotas emitido, despesas = rubricas).
8. ✅ **Método 2 — orçamento define a receita** — no wizard "Gerar quotas" pode-se escolher entre *permilagem + FCR (config)* e *orçamento define a receita* (total de rubricas distribuído por permilagem ÷ 12; FCR tratado como rubrica do orçamento).
9. ✅ **Testes** — `scripts/test-financeiro.js` cobre distribuição (permilagem/igual), plano de quotas, parcelamento com resto na última parcela, quota extra, periodicidades e Método 2 (soma exata).

## Regras

- Migrations aditivas; nunca apagar dados; dinheiro em `DECIMAL`/cêntimos.
- Não alterar quotas já pagas; configuração nova só afeta quotas futuras.
- Validação no backend (nunca só no browser).
- PT-PT em toda a interface.
