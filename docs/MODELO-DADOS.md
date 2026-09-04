# Condofy — Modelo de dados (MariaDB / Sequelize)

O CondoSystem original usava MongoDB e um modelo com vários problemas estruturais
(valores monetários em `String`, relações por **nome**, saldos derivados guardados
como texto, sem frações, sem numeração persistente, sem auditoria).

O Condofy redesenha o modelo como uma base de dados **relacional correta**. Todas as
relações usam **IDs e chaves estrangeiras (foreign keys)**. Nenhuma relação é feita
por nome.

## Convenções

- Chaves primárias: `id` inteiro (`INT UNSIGNED AUTO_INCREMENT`).
- Tabelas em `snake_case`, timestamps automáticos (`created_at`, `updated_at`).
- Valores monetários: `DECIMAL(10,2)` ou `DECIMAL(12,2)` — **nunca** texto/float.
- Datas em `DATE`/`DATEONLY`; apresentação em `DD/MM/YYYY`; moeda EUR (€).
- Movimentos financeiros nunca são apagados definitivamente (são anulados).

## Entidades e relações

| Tabela | Descrição | Relações |
| --- | --- | --- |
| `condominios` | Configuração do condomínio (designação, NIF, morada, IBAN, logótipo, identidade visual) | 1 linha |
| `users` | Conta de utilizador (email + password; `provider` local/google preparado) | `pessoa_id` → `pessoas.id` |
| `pessoas` | Pessoa / condómino (independente da conta de utilizador) | — |
| `fracoes` | Fração (designação, permilagem, andar, estado) | — |
| `fracao_pessoas` | Vínculo fração ↔ pessoa com papel | `fracao_id` → `fracoes.id`; `pessoa_id` → `pessoas.id` |
| `contas_bancarias` | Contas do condomínio (corrente, poupança, fundo de reserva) | — |
| `categorias` | Categorias de despesa/receita | — |
| `metodos_pagamento` | Métodos de pagamento | — |
| `orcamento_itens` | Orçamento anual por categoria | `categoria_id` → `categorias.id` |
| `quotas` | Quota mensal por fração (número de documento, estado, vencimento) | `fracao_id` → `fracoes.id` |
| `pagamentos` | Pagamento (recibo, método, data, referência) | `fracao_id` → `fracoes.id`; `conta_bancaria_id`; `metodo_pagamento_id` |
| `pagamento_quotas` | Distribuição de um pagamento pelas quotas (pagamentos parciais) | `pagamento_id`; `quota_id` |
| `despesas` | Despesa (número de documento, categoria, fornecedor) | `categoria_id`; `conta_bancaria_id`; `metodo_pagamento_id` |
| `documentos` | Metadados de documento no Google Drive (nunca o binário em BD) | `created_by` → `users.id` |
| `assembleias` | Assembleia (data, hora, local, ordem de trabalhos, ata) | `convocatoria_documento_id`/`ata_documento_id` → `documentos.id` |
| `assembleia_participantes` | Participantes/representação | `assembleia_id`; `fracao_id`; `pessoa_id` |
| `avisos` | Aviso/comunicação (manual, automático, programado) | `documento_id`; `created_by` |
| `aviso_destinatarios` | Destinatários de um aviso (todos, frações, pessoas) | `aviso_id`; `fracao_id`; `pessoa_id`; `user_id` |
| `email_fila` | Fila de envio de email (estado, tentativas, erro) | `documento_id`; `aviso_id` |
| `numeracoes` | Numeração sequencial por tipo de documento e ano (ex.: 2026/0001) | — |
| `configuracoes` | Configurações chave-valor (SMTP, Drive, regras, backups) | — |
| `audit_logs` | Auditoria (utilizador, data, ação, entidade, detalhes) | `user_id` → `users.id` |
| `backup_logs` | Estado dos backups (concluído/erro, ficheiro no Drive) | — |

## Diagrama (relações principais)

```
pessoas ────< fracao_pessoas >──── fracoes
   ▲                                  │
   │ users.pessoa_id                  │ quotas.fracao_id
users                                ├─ pagamentos.fracao_id
                                      │
categorias ──< orcamento_itens        │
categorias ──< despesas               │
                                      ▼
contas_bancarias ──< despesas / pagamentos
metodos_pagamento ──< despesas / pagamentos

quotas ──< pagamento_quotas >──── pagamentos

documentos ──< assembleias (convocatória / ata)
documentos ──< avisos
documentos ──< email_fila

avisos ──< aviso_destinatarios >──── fracoes / pessoas / users
users ──< audit_logs
```

## Regras importantes

1. **Pessoa ≠ conta de utilizador.** Um condómino (Pessoa) pode estar associado a
   várias frações; uma conta (User) liga-se a uma Pessoa por `users.pessoa_id`.
2. **Pagamentos parciais** são modelados em `pagamento_quotas` (valor aplicado por quota).
3. **Saldo** é calculado (quota − pagamentos aplicados), não guardado como texto.
4. **Numeração** (`numeracoes`) é persistente, independente do `id` interno e nunca
   reutiliza números — anular mantém o número e marca o documento como anulado.
5. **Documentos** no Google Drive guardam apenas metadados na MariaDB
   (`drive_file_id`, nome, tipo, tamanho, data, entidade, URL).
6. **Auditoria** regista criação/alteração/anulação de quotas, pagamentos, despesas,
   documentos, envios e configurações.

## Novo modelo financeiro (orçamento → quota → movimento → saldo)

Fluxo: **orçamento anual → distribuição pelas frações → plano de quotas → emissão → pagamento → movimento bancário → saldo**.

| Tabela | Papel |
| --- | --- |
| `orcamentos` | Entidade de orçamento: período de 1 ano, estados (`rascunho/aprovado/em_execucao/encerrado/anulado`), aprovação, assembleia/documento |
| `orcamento_rubricas` | Rubricas do orçamento: categoria, valor anual, método de distribuição (`permilagem/igual/valor_fixo`), periodicidade (`mensal/trimestral/semestral/anual/unica`) |
| `orcamento_distribuicoes` | Valor anual calculado por rubrica × fração (distribuição explícita) |
| `orcamento_alteracoes` | Histórico/versionamento de alterações (valor anterior/novo, justificação, utilizador, assembleia) |
| `planos_quota` | Plano de cobrança derivado do orçamento (período × fração × valor), estados `planeada/emitida/cancelada` |
| `movimentos_bancarios` | Movimentos de `entrada`/`saida`/`transferencia` por conta (valor sempre positivo; o tipo dá o sentido) |
| `contas_bancarias` | + `data_inicio`, `data_saldo_inicial` |
| `quotas` | + `orcamento_id` (ligação ao orçamento que a originou) |

### Regras do novo modelo

- **Dinheiro em `DECIMAL`** e cálculo em cêntimos (`helpers/money.js`); arredondamento por "maior resto" para que a soma das frações = total.
- **Saldo bancário derivado**: `saldo_inicial + entradas − saídas` (calculado pelos movimentos, nunca editável).
- **Orçamento aprovado não é editado normalmente** — alterações exigem justificação e ficam em `orcamento_alteracoes`.
- **Transações Sequelize** em emissão, pagamento, transferência e alteração extraordinária.
- `orcamento_itens` (modelo antigo) é mantido e migrado para o novo modelo (sem perda de dados).
