# CondoFy — Evolução completa do sistema de gestão de condomínios

## 1. Auditoria (arquitetura encontrada)

**Stack:** Node.js 22 + Express 4 + Sequelize 6 (dialeto `mysql`/mysql2 → MariaDB) + express-handlebars 7 + Bootstrap 5 (CDN) + PDFKit + googleapis + nodemailer + node-cron + multer + passport-local.

**Estrutura:**
- `app.js` — bootstrap Express, sessão, flash, passport, `res.locals` (user, isAdmin, condominio, currentPath), montagem de rotas `/`, `/admin` (admin, financeiro, extra-quotas, orcamento, assembleias, documentos, avisos, configuracao, sistema), `/condomino`.
- `models/` — 32 modelos; associações centralizadas em `models/index.js`. Dinheiro em `DECIMAL`, `snake_case`/`underscored`.
- `migrations/` — 00001…00038 (aditivas). Tabelas já incluem o fluxo orçamento→rubrica→distribuição→plano→emissão, movimentos bancários, quotas extra.
- `helpers/` — `money` (cêntimos/`formatEUR`), `quotas-calc`, `quotas-config`, `distribuicao` (maior resto), `plano`, `extra-quotas`, `movimentos`, `pagamentos`, `saldos`, `dashboard`, `pdf` (classe `Layout`), `numeracao`, `audit`, `drive`, `mailer`, `email-fila`, `avisos`, `config`, `dates`, `condominio`, `handlebars-helpers`.
- `views/` — layout `main.handlebars` (sidebar + header já Material), partials `_flash`/`_empty-state`.
- `public/css/styles.css` — design system (tokens, sidebar responsiva/offcanvas).
- `jobs/` — `scheduler`, `automatizacao` (gerar quotas mensais idempotente + lembretes), `backup`.

**Reutilizável (não duplicar):** `Quota` (com `valor_base`/`valor_fcr`), `Orcamento`+`OrcamentoRubrica`+`OrcamentoDistribuicao`+`PlanoQuota`+`OrcamentoAlteracao`, `Pagamento`+`PagamentoQuota`, `MovimentoBancario`, `ExtraQuota`+`ExtraQuotaParcela`, `Assembleia`+`AssembleiaParticipante`, `Documento`, `helpers/pdf.js`, `helpers/movimentos.js`, `helpers/dashboard.js`.

## 2. Lacunas identificadas vs. especificação

| # | Item | Estado atual | Ação |
| --- | --- | --- | --- |
| 1 | Sidebar | grupos Estrutura/Finanças/Condomínio/Sistema | Reorganizar (Frações, Membros, Finanças, Condomínio, Serviços) + placeholders Votações/Calendário/Amenidades/Tickets/Fornecedores/Seguros/Comunicações |
| 2 | Dashboard | tem Finanças + mês + Orçamento (1 card) | Adicionar 3 cards orçamento (Receitas/Despesas/Saldo previstos) |
| 3 | Orçamento lista | Designação/Período/Estado/Receitas/Despesas/Saldo | + Ano, Editar; "Não existe orçamento para {ano}" + Criar |
| 4 | Orçamento criar | designação + datas (1 ano) | + Ano (pre), Saldo transitado, Período (civil/personalizado) |
| 5 | Método orçamento | só despesas (rubricas) | + Modo A (valor 1000‰) / Modo B (receita anual) |
| 6–8 | Quotas config/histórico | "valor por 1‰" (0.1000), sem histórico | "valor por 1000‰" (100,0000), guardar valor_por_1000/permilagem/fcr na quota |
| 9–12 | Grelha/geração | grelha e idempotência OK | Detalhe em modal; preview nº frações×meses, existentes, novas |
| 13–14 | Cálculo/permilagem | fórmula por 1‰; sem validação | `(permilagem/1000)×valor_por_1000`; avisar soma ≠ 1000‰ |
| 15–23 | Quotas extra | quase completo | Coluna "Em falta" no detalhe; contador "X de Y" |
| 24 | Documentos | lista plana | Estrutura de pastas (Biblioteca, Recibos, Assembleias, Seguros, Faturas) |
| 25–29 | Assembleias | simples (data/hora/local/ordem texto) | nº, tipo, estado rascunho, cards+filtros, ordem de trabalhos (itens), anexos, convocatória PDF melhorada |
| 30 | Integração financeira | ok (movimentos) | garantir FCR incluído nas previstas |
| 33 | Seeds | sem frações demo | Fração A 500‰ + Fração B 500‰; valor 1000‰=100€, FCR 10% → 55€/55€ |

## 3. Plano de implementação (módulos, nesta ordem)

1. **Dados** — migrations 00039+ (histórico quotas, campos orçamento, assembleia nº/tipo/estado, `agenda_items`, `documentos.pasta`, conversão config 1000‰); modelos + associações; seeds demo.
2. **Semântica 1000‰** — `quotas-config`/`quotas-calc` passam a usar "valor por 1000‰"; fórmula `(permilagem/1000)×valor`.
3. **Quotas** — modal config, validação permilagem, detalhe modal com histórico, preview de geração.
4. **Orçamento** — ano/saldo/período/Método A-B, estados Rascunho/Ativo/Fechado, editar, lista.
5. **Dashboard** — cards orçamento.
6. **Assembleias** — nº/tipo/estado, cards+filtros, ordem de trabalhos (itens), anexos, convocatória PDF.
7. **Documentos** — pastas.
8. **Sidebar** — reorganizar + placeholders.
9. **Testes + docs**.

Regras transversais: migrations aditivas; dinheiro em cêntimos; soma exata (maior resto / resto na última parcela); geração idempotente (constraint `fracao_id+ano+mes` e `extra_quota_id+fracao_id+parcela_numero`); nunca alterar quotas pagas; PT-PT; Bootstrap 5/Material.
