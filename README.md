<p align="center"><img src="public/img/logo_gescondu.png" alt="GesCondu" width="180" /></p>

# GesCondu

Aplicação moderna, simples e profissional de **gestão de condomínios em Portugal**
(PT-PT), desenhada para correr num servidor pequeno/LXC.

Baseada no conceito do [CondoSystem](https://github.com/correaito/condosystem), mas
com arquitetura relacional correta (MariaDB/Sequelize) e funcionalidades orientadas ao
contexto português.

## Stack

- **Node.js + Express** (servidor HTTP)
- **MariaDB + Sequelize** (base de dados relacional, migrations versionadas)
- **Handlebars** (vistas no servidor)
- **Bootstrap 5** (UI responsiva, leve, sem build)
- **PDFKit** (geração de PDFs)
- **Google Drive API** (repositório documental e backups)
- **Nodemailer** (SMTP configurável) e **node-cron** (tarefas agendadas)

## Requisitos

- Node.js 18+
- MariaDB 10.6+ (ou MySQL 8+)
- (opcional) Docker + Docker Compose

## Instalação

```bash
cd condofy
cp .env.example .env          # editar as credenciais
npm install
npm run db:setup              # cria as tabelas + seeds (admin, categorias, ...)
npm start
```

Aceda a `http://localhost:3000`.

### Conta de administrador (seed)

- Email: `admin@condofy.local`
- Palavra-passe: `Admin123!`

Defina `ADMIN_EMAIL` e `ADMIN_PASSWORD` no `.env` **antes** do primeiro
`npm run db:setup` para usar outras credenciais. Altere a palavra-passe após o
primeiro login.

### Com Docker

```bash
docker compose up -d --build
```

## Scripts

| Comando | Descrição |
| --- | --- |
| `npm start` | Inicia a aplicação |
| `npm run dev` | Inicia com nodemon (reinício automático) |
| `npm run db:migrate` | Aplica migrations |
| `npm run db:seed` | Aplica seeds |
| `npm run db:setup` | Migrations + seeds |
| `node scripts/test-financeiro.js` | Testes do modelo financeiro (distribuição, plano, PDFs) |
| `node scripts/test-drive.js` | Testes do helper Google Drive (sem rede) |
| `node scripts/test-comunicacoes.js` | Testes das comunicações (destinatários, mensagens SMTP) |
| `node scripts/check-templates.js` | Valida que as vistas Handlebars compilam/renderizam |

## Documentação

- [`docs/MODELO-DADOS.md`](docs/MODELO-DADOS.md) — modelo de dados e relações
- [`docs/MIGRACAO-FINANCEIRA.md`](docs/MIGRACAO-FINANCEIRA.md) — novo modelo financeiro e fases
- [`docs/PLANO.md`](docs/PLANO.md) — análise do projeto base e fases de implementação
- [`docs/GOOGLE_DRIVE.md`](docs/GOOGLE_DRIVE.md) — integração Google Drive (OAuth, pastas, uploads, backups)
- [`docs/EMAIL_SMTP.md`](docs/EMAIL_SMTP.md) — integração Email/SMTP (Gmail, fila, retry, envio de teste)

## Funcionalidades

- **Condomínio**: configuração completa (designação, NIF, morada, IBAN, logótipo/identidade visual).
- **Frações e condóminos**: gestão com relações por ID (proprietários/arrendatários).
- **Financeiro**: quotas (geração manual/automática), pagamentos com distribuição parcial, despesas, contas bancárias, categorias, orçamento anual com execução.
- **Documentos PDF**: avisos de quota, recibos, convocatórias e atas (profissionais, PT-PT, EUR).
- **Google Drive**: repositório documental + estrutura automática de pastas + backups.
- **Comunicação**: avisos (manual/programado/automático), fila de email, SMTP configurável.
- **Ações sobre documentos**: ver/descarregar, guardar no Google Drive e enviar por email de forma transversal (Documentos, Avisos, Assembleias/Convocatórias).
- **Automações de documentos**: comportamento automático por tipo (Drive/email/automático) em **Configurações → Documentos e Automações**.
- **Envios em lote**: quotas e recibos por email com histórico, sem duplicados e reenvio controlado.
- **Emails profissionais**: templates centrais PT-PT com HTML+texto, PDF em anexo por destinatário + link online, e remetente = administração/condomínio/GesCondu.
- **Automatização**: node-cron (quotas, lembretes, fila de email, backups).
- **Segurança e auditoria**: autenticação local (preparada para OAuth), recuperação de password, registo de operações.
- **Dashboards**: administrador (financeiro, quotas, orçamento, sistema) e condómino (situação própria + transparência global).

## Estado

Todas as 8 fases implementadas. O código foi validado (modelos, migrations, vistas,
PDFs e arranque), mas **não foi executado contra uma MariaDB real** neste ambiente
(sem servidor de BD disponível). Para testar:

```bash
docker compose up -d --build   # ou: npm run db:setup && npm start
```
