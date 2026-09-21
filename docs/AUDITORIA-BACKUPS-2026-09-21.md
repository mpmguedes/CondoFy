# Auditoria — Sistema de backups do GesCondu (Fase 1, 2026-09-21)

> **Âmbito:** auditoria READ-ONLY do sistema de backups, antes de qualquer alteração.
> Nenhum ficheiro de implementação foi modificado para produzir este documento.
> **Fora de âmbito:** armazenamento de documentos (por condomínio), OAuth, `ENCRYPTION_KEY`,
> localizadores `gd:`/`dbx:`/`od:`, branding, B10.

---

## 1. Arquitetura atual

### 1.1 Peças

| Peça | Ficheiro | Papel |
|---|---|---|
| Job | `jobs/backup.js` (171 linhas) | Gera o dump, escreve a cópia local, tenta a cópia cloud, aplica a retenção |
| Agendador | `jobs/scheduler.js` (41) | `cron('0 ${BACKUP_HOUR\|3} * * *')` → **só** `executarBackup('diario')` |
| Rota manual | `routes/sistema.js` (22) | `POST /admin/sistema/backup` → `executarBackup('manual')` |
| Interpretação | `helpers/backup-estado.js` (140) | Puro: `backup_logs` → 5 estados apresentáveis |
| Modelo | `models/BackupLog.js` (26) | Tabela `backup_logs` — **sem `condominio_id`** (é da instalação) |
| Configuração | `Configuracao` (`storage:backup`) | Destino cloud dos backups (chave-valor, sem migration) |
| UI | `views/admin/configuracao/armazenamento.handlebars` | Escolha do destino (página **por condomínio**) |
| Painel | `routes/admin.js` + `helpers/dashboard.js` | Linha «Último backup» + sinal de atenção |
| Fachada | `helpers/storage.js` | `destinoDeBackup`, `ligacaoDeBackup`, `pastaDeBackups`, `uploadComProvedor`, `apagarArquivo` |

### 1.2 Fluxo real hoje (`executarBackup(tipo)`)

1. `BackupLog.create({ tipo, estado: 'em_curso' })`
2. `mysqldump -h … -u … --single-transaction --quick --skip-lock-tables <DB>` (`execFile`, `MYSQL_PWD`, `maxBuffer` 1 GiB)
3. `zlib.gzipSync(dump)`
4. Nome: `backup_${tipo}_${YYYY-MM-DD}_${Date.now()}.sql.gz`
5. **Cópia local (sempre):** `fs.mkdirSync(pastaLocal())` + `fs.writeFileSync`
6. `log.update({ tamanho: gz.length })` — `tamanho` é a prova de que a cópia local existe
7. **Cópia cloud (opcional):** só se `destinoDeBackup()` **e** `ligacaoDeBackup(destino).origem`
8. `log.update({ estado:'concluido', ficheiro_drive_id, erro:null })` + `limparBackupsAntigos(tipo)`
   — ou `concluido` com `erro: 'Cópia cloud não criada: …'` (a cópia local fica intacta)
9. `catch`: se a cópia local já foi escrita ⇒ `concluido` + `erro`; senão ⇒ `erro`

**O que já está correto e NÃO deve ser reescrito:** a ordem local→cloud, o `tamanho` como prova,
a semântica `concluido` (uma falha de cloud nunca invalida um backup válido) e os 5 estados de
`helpers/backup-estado.js`. Está provado por `scripts/test-backup-estado.js`.

### 1.3 Onde ficam os ficheiros

- Pasta local: `BACKUP_LOCAL_DIR` (testes) ou `<repo>/backups/local` (produção) — ignorada pelo git (`.gitignore:9`).
- Cloud: pasta `Backups` na raiz do serviço escolhido (`pastaDeBackups`), com a ligação de
  **plataforma** quando existe, senão a do primeiro condomínio com esse serviço ligado.
- **Nenhuma coluna guarda o nome do ficheiro.** O único rasto na BD é `backup_logs`
  (`tipo`, `data`, `tamanho`, `estado`, `ficheiro_drive_id`, `erro`).

### 1.4 Retenção atual

```js
retencaoDias(tipo) = { diario: BACKUP_DAILY_RETENTION||30,
                       semanal: BACKUP_WEEKLY_RETENTION||90,
                       mensal:  BACKUP_MONTHLY_RETENTION||365,
                       manual:  30 }[tipo] || 30
```

`limparBackupsAntigos(tipo)` procura `backup_logs` com `tipo`, `estado='concluido'`,
`data < agora − dias` e `ficheiro_drive_id IS NOT NULL`, e chama `storage.apagarArquivo(...)`.

---

## 2. Problemas e inconsistências (com evidência)

| # | Problema | Evidência | Requisito afetado |
|---|---|---|---|
| P1 | **A cópia local nunca é limpa.** Não existe uma única linha que remova um ficheiro de `backups/local`. | `jobs/backup.js:55-77` só chama `storage.apagarArquivo` (cloud) | 4, 6 |
| P2 | **Não existe proteção do último backup.** Nada impede apagar todas as cópias. | `jobs/backup.js:55-77` | 6, 11 |
| P3 | **A limpeza de cloud só corre quando o upload corre bem.** Se a cloud falhar, `limparBackupsAntigos` nunca é chamada — a retenção fica congelada. | `jobs/backup.js:143-146` (dentro do `if (referencia)`) | 7 |
| P4 | **`apagarArquivo` é chamado sem âmbito.** `storage.apagarArquivo(localizador)` → `p.apagarArquivo(id, undefined)`. Se o backup foi enviado com a ligação de um **condomínio**, o `DELETE` resolve os tokens do âmbito **plataforma** → 404 → o OneDrive devolve `true` («apagado») e o ficheiro **fica lá**. Falso sucesso silencioso. | `jobs/backup.js:71` vs. `helpers/storage.js:352-357` | 7 |
| P5 | **Dropbox não suporta remoção.** `dropbox.js` não exporta `apagarArquivo` ⇒ `storage.apagarArquivo` devolve `false` e a retenção de cloud é um **no-op** silencioso: as cópias acumulam-se sem limite. | `helpers/armazenamento/provedores/dropbox.js:794-818` | 7, 20 |
| P6 | **A retenção vem só do `.env`.** Não há UI, não há mínimo de 30 dias, não há validação (`0` cai em `|| 30`; negativos passam; `NaN` cai em `30` por acidente). | `jobs/backup.js:45-53` | 4, 12, 13 |
| P7 | **Não existe medição de nada.** Nenhum código lê `backups/local`; não há «espaço utilizado» nem «nº de backups». | não existe `statSync`/`readdirSync` sobre a pasta de backups | 8, 9, 14 |
| P8 | **Não existe área de armazenamento do Super Admin.** `/global` tem índice, condomínios, utilizadores, auditoria e suporte — nenhuma página de armazenamento/backups. | `routes/global-admin.js`, `views/admin/global/` | 8, 12 |
| P9 | **A configuração de backups é feita numa página POR CONDOMÍNIO.** `POST /admin/config/armazenamento/backups` (guardado por `comPapel('admin')` do condomínio ativo) escreve `storage:backup`, que é um valor da **instalação**. Um admin de um condomínio muda o destino dos backups de todos. | `routes/configuracao.js:327-362`; `helpers/storage.js:212` (`avisoPartilhado`) | 12, 16, 17 |
| P10 | **Um admin de condomínio pode disparar um backup da instalação.** `POST /admin/sistema/backup` está atrás de `comPapel('admin')` e não tem UI que o invoque (rota órfã, mas alcançável). É *fire-and-forget*: responde «Backup manual iniciado.» e nunca comunica o resultado. | `routes/sistema.js:9-20`; `app.js:294` | 16, 17 |
| P11 | **O nome do ficheiro não é persistido.** `backup_logs` não tem coluna de nome ⇒ não é possível juntar com exatidão o ficheiro em disco ao registo. | `models/BackupLog.js` | 10 |
| P12 | **`backup_logs` nunca é podada.** Uma linha por backup, para sempre. Contar linhas ≠ contar ficheiros. | `jobs/backup.js:105` | 8, 9 |
| P13 | **Não existe eliminação manual de backups** (nem individual, nem «anteriores a X»). | — | 11 |
| P14 | **Retenções por `tipo` sem separação local/cloud.** A mesma constante decide as duas cópias; não há conceito de retenção local ≠ retenção cloud. | `jobs/backup.js:45-77` | 4, 5 |
| P15 | **Só o `diario` é agendado.** `semanal`, `mensal` e `manual` existem no ENUM mas não têm agendamento — as respetivas retenções nunca se aplicam na prática. | `jobs/scheduler.js:32-36` | 4 |
| P16 | **Sem limite de espaço, sequer informativo.** `Espaço reservado` / `Utilizado: X / Y` não existem. | — | 14 |

### 2.1 Inconsistência estrutural (a mais importante)

**Os backups são da INSTALAÇÃO, não por condomínio.** Um único dump contém os dados de todos os
condomínios; `backup_logs` não tem `condominio_id` e está em `TABELAS_PARTILHADAS`.

Os requisitos 8/9/10 pedem uma **tabela por condomínio** (Nº backups, Espaço, Mais antigo, Mais
recente) e um **detalhe de backups por condomínio**. Isso **não existe e não é derivável** da
arquitetura atual: não há como atribuir um ficheiro `backup_diario_….sql.gz` a um condomínio.

O eixo que **é** per-condomínio e mensurável é o dos **documentos** (`documentos.condominio_id`,
`documentos.tamanho`, `documentos.data`). É essa a informação real que o Super Admin pode ver por
condomínio, sem ficção.

---

## 3. Proposta de implementação

### 3.1 Princípio

> **A cópia local é a cópia base, obrigatória. A cloud é uma cópia adicional, opcional.
> Uma falha, ausência ou indisponibilidade da cloud NUNCA impede a cópia local.**

Isto já é verdade no fluxo; o que falta é **governação**: retenção, medição, painel e eliminação —
e tudo isso tem de ser feito **sem tocar no fluxo de documentos**.

### 3.2 Peças novas

1. **`helpers/backup-inventario.js`** (novo, puro + I/O de leitura)
   - `listarLocais(dir)` → `[{ nome, caminho, tamanho, criadoEm, tipo, referencia }]`, a partir de
     `fs.readdirSync` + `fs.statSync`; o nome (`backup_<tipo>_<YYYY-MM-DD>_<epoch>.sql.gz`) é
     auto-descritivo ⇒ **não é precisa migration** para o nome.
   - `medirLocais(dir)` → `{ numero, bytes, maisAntigo, maisRecente }` (medição real).
   - `interpretarItem(item, logs)` → estado apresentável, juntando ao registo por `(tipo, tamanho)`
     com tolerância temporal; **sem correspondência diz «sem registo» — nunca inventa**.
2. **`helpers/backup-retencao.js`** (novo, puro — decisão separada do I/O)
   - `selecionarParaApagar({ itens, dias, protegerUltimo })` → lista a apagar.
   - **Proteção obrigatória:** nunca devolve a lista completa; mantém sempre ≥ 1 cópia local válida
     (a mais recente). É a única regra que impede a perda do último backup.
   - Retenção **local** e **cloud** independentes (duas listas, duas decisões).
3. **`jobs/backup.js`** (alterado)
   - `retencaoDias` passa a ler a **configuração persistida** (`Configuracao`) com o `.env` como
     *fallback*, com **mínimo 30** aplicado no servidor.
   - `limparBackupsLocais(...)` (nova) — apaga ficheiros de `backups/local` fora do prazo,
     respeitando a proteção do último.
   - `limparBackupsAntigos` (cloud) — corrigida: chamada **fora** do `if (referencia)`, com o
     **âmbito** (`ligacao.condominioId`) passado a `storage.apagarArquivo`, e registando erro
     quando o provedor não suporta remoção (Dropbox) em vez de falhar em silêncio.
   - Novos exports: `listarBackupsLocais`, `medirBackupsLocais`, `apagarBackupsLocais`,
     `configuracaoRetencao` — para a rota do Super Admin usar exatamente a mesma lógica (uma só verdade).
4. **`routes/global-admin.js` + `views/admin/global/armazenamento.handlebars`** (novo)
   - `GET /global/armazenamento`: espaço e nº reais (medidos), tabela de backups (nome, data/hora,
     tamanho, estado, cópia cloud), **tabela por condomínio dos documentos** (nº, espaço, mais
     antigo, mais recente), formulário de retenção (local/cloud, mín. 30, presets + campo numérico),
     interruptor «Eliminar automaticamente backups locais antigos» e o limite informativo
     «Espaço reservado para backups locais» (`Utilizado: X / Y`) que **nunca apaga**.
   - `POST /global/armazenamento/retencao` e `POST /global/armazenamento/apagar` (individual e
     «anteriores a data»), com confirmação forte e proteção do último backup.
5. **`helpers/handlebars-helpers.js`** — novo helper `bytes` (`31,4 GB`). **Nunca** usar `{{money …}}`
   (compila mas rebenta no render).
6. **Testes** — `scripts/test-backup-retencao.js` (novo) + `scripts/test-backup-estado.js` (estendido),
   cobrindo os cenários A–J do requisito 19.

### 3.3 Migrações

**Nenhuma.** Tudo cabe nas colunas existentes:

- retenção e limite → `Configuracao` (chave-valor, como `storage:backup`);
- nome/tipo/data/tamanho dos ficheiros → lidos do **próprio nome** e do disco;
- estado → `backup_logs` existente (`helpers/backup-estado.js`, sem alterações).

*Se* o utilizador preferir exatidão absoluta na junção ficheiro↔registo, uma coluna **aditiva**
`ficheiro VARCHAR(255) NULL` em `backup_logs` resolve — mas não é necessária e não a proponho por omissão.

### 3.4 Fora de âmbito (propostas, não implementadas)

- **P9/P10** (configuração e disparo de backups por um admin de condomínio) são defeitos de
  **autorização**, não de backups. Corrigi-los mexe em `routes/configuracao.js` e `routes/sistema.js`
  (frentes de autorização). **Sinalizo e não toco** sem autorização explícita.
- Enviar os backups cloud para um destino por condomínio, ou dividir o dump por condomínio.

---

## 4. Ficheiros a alterar

| Ficheiro | Tipo |
|---|---|
| `helpers/backup-inventario.js` | novo |
| `helpers/backup-retencao.js` | novo |
| `jobs/backup.js` | alterado (retenção + limpeza local + âmbito da cloud + exports) |
| `routes/global-admin.js` | alterado (rotas da área de armazenamento) |
| `views/admin/global/armazenamento.handlebars` | novo |
| `views/layouts/main.handlebars` | alterado (1 link «Armazenamento» na navegação global) |
| `helpers/handlebars-helpers.js` | alterado (helper `bytes`) |
| `scripts/test-backup-retencao.js` | novo |
| `scripts/test-backup-estado.js` | alterado (casos novos) |
| `package.json` | alterado (1 passo em `test:offline`) |
| `docs/BACKUPS.md` | novo (documentação técnica — requisito 22) |
| `.env.example` | alterado (documentar as chaves de retenção, se aplicável) |

**Não se toca:** `helpers/storage.js`, `helpers/armazenamento/**`, `models/**`, `helpers/config.js`,
`routes/configuracao.js`, `routes/sistema.js`, `views/admin/configuracao/armazenamento.handlebars`,
nem nada de branding/documentos.

---

## 5. Decisão pendente — **RESOLVIDA pelo utilizador**

**P8/2.1:** os requisitos iniciais pressupunham backups **por condomínio**, que não existem.

**Resolução (regra de produto, fixada pelo utilizador):** os backups do GesCondu são **backups da
instalação** — um único dump completo da base de dados, que contém os dados de vários condomínios.
Consequências que passaram a orientar a implementação:

- **não** se introduz `condominio_id` em `backup_logs` só para satisfazer a interface;
- **não** se infere que parte de um dump pertence a determinado condomínio;
- **não** se transformam os backups em backups por condomínio;
- a área do Super Admin mostra os **backups da instalação** (data, tipo, tamanho, estado, cópia
  cloud) e, **claramente separada**, a utilização de **armazenamento documental por condomínio**
  (onde essa relação existe de facto);
- **documentos nunca** entram nas métricas nem no backup local.

A implementação seguiu esta resolução; ver `docs/BACKUPS.md`.
