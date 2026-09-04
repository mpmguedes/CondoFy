# Condofy — Análise do projeto base e plano de implementação

## 1. O que existe no projeto base (correaito/condosystem)

- **Stack:** Node.js + Express + MongoDB/Mongoose + Handlebars + Passport + PDFKit.
- **Modelos (Mongoose):** `Usuario`, `Morador`, `Conta`, `Despesa`, `DespesaConta`,
  `Pagamento`, `Saldo`, `TipoDespesa`, `Caixinha`, `MovimentoCaixinha`.

### Problemas estruturais identificados

1. **Relações por nome** — o utilizador é ligado ao "morador" por igualdade de nome
   (`Morador.findOne({ nome: usuario.nome })`). Frágil e proibido pela especificação.
2. **Dinheiro como `String`** — `valor`/`saldo` em texto; soma com `parseFloat`.
3. **Sem frações** — usa-se `apto` (string) solto em vários modelos.
4. **Sem Pessoa separada da conta** — mistura morador/proprietário/inquilino.
5. **Saldo derivado persistido** — guardado e manipulado manualmente em vez de calculado.
6. **`conta` referenciado por número** (sem FK), e o mesmo campo ora guarda ObjectId
   ora String (contas antigas).
7. **Sem numeração de documentos**, sem auditoria, sem orçamento, sem assembleias,
   sem Google Drive, sem backups, sem fila de email.
8. **PT-BR / R$ / timezone São Paulo** — data/hora e moeda brasileiras.

## 2. O que o Condofy faz diferente

- MariaDB + Sequelize com **migrations versionadas** (nunca `sync({force:true})`).
- Modelo relacional completo (ver `docs/MODELO-DADOS.md`).
- Dinheiro em `DECIMAL`, processado em cêntimos (helper `helpers/money.js`).
- PT-PT em toda a interface e documentos (datas `DD/MM/YYYY`, moeda EUR).
- Arquitetura preparada para OAuth/Google (`users.provider`), mas só email+password agora.

## 3. Plano de migração

Não há migração automática de dados do MongoDB (o modelo é diferente demais).
O caminho recomendado para quem tem dados no sistema antigo é **reexportar para o
Condofy via CSV/planilha**: frações, condóminos e saldos iniciais são recriados uma
única vez. Scripts de importação podem ser adicionados se necessário.

## 4. Fases de implementação

| Fase | Âmbito | Estado |
| --- | --- | --- |
| **1** | MariaDB + Sequelize + modelo de dados + autenticação + utilizadores + frações + condóminos | ✅ implementada |
| 2 | Quotas + pagamentos + saldos + contas bancárias + despesas | ✅ implementada |
| 3 | PDFs (avisos de quota, recibos) + numeração | ✅ implementada |
| 4 | Google Drive + documentos + estrutura automática de pastas | ✅ implementada |
| 5 | Emails + envio manual/automático + fila de envio | ✅ implementada |
| 6 | Orçamento + relatórios + dashboards (admin e condómino) | ✅ implementada |
| 7 | Assembleias + convocatórias + atas | ✅ implementada |
| 8 | Backups + auditoria + segurança + otimização | ✅ implementada |

> A numeração de documentos, a auditoria e as tabelas das fases futuras já estão no
> modelo (migrations), para que cada fase seja apenas código de funcionalidade e não
> alterações estruturais de base de dados.

## 5. Regra final

Implementar uma fase de cada vez, testar cada fase e nunca fazer alterações
destrutivas sem confirmação.
