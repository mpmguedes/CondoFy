# Backups do GesCondu — arquitetura

> **Resumo:** os backups são da **instalação**. Cada backup é um **dump completo da base de
> dados**, que contém os dados de **todos os condomínios**. A cópia **local é obrigatória**; a
> cópia **cloud é adicional**. As **retenções são independentes** (local e cloud), por **idade**,
> com um mínimo de **30 dias**. O **último backup local válido é sempre preservado**.
>
> **Os documentos dos condomínios não fazem parte dos backups.**

---

## 1. O que é um backup (e o que não é)

```
                    GESCONDU
                       │
              Base de dados global
                       │
                 BACKUP DA INSTALAÇÃO
                 (dump completo, .sql.gz)
                       │
              ┌────────┴────────┐
              │                 │
           LOCAL              CLOUD
         obrigatório         adicional
              │                 │
         retenção A         retenção B
              │                 │
              └────────┬────────┘
                       │
                   dados da BD


       DOCUMENTOS DOS CONDOMÍNIOS
                       │
              armazenamento próprio
         Google Drive / Dropbox / OneDrive
         (por condomínio — NUNCA no backup)
```

Um ficheiro como `backup_diario_2026-09-21_1790000000000.sql.gz` representa a **instalação
inteira**. Não existe — e não se tenta inferir — uma correspondência `backup → condomínio`:

* a tabela `backup_logs` **não tem** `condominio_id`;
* não se introduz `condominio_id` só para satisfazer a interface;
* não se tenta determinar que parte de um dump pertence a um condomínio;
* não se transformam os backups em backups por condomínio.

A área de administração **não** apresenta uma tabela «Condomínio A → 400 MB»: não há informação
que a permita. O que existe por condomínio são os **documentos**, e isso é um eixo separado
(secção 6).

---

## 2. Fluxo de um backup

```
Base de dados da instalação
        ↓
1. mysqldump --single-transaction --quick --skip-lock-tables
        ↓
2. gzip
        ↓
3. CÓPIA LOCAL (obrigatória)  →  backups/local/backup_<tipo>_<data>_<epoch>.sql.gz
        ↓
4. VALIDAÇÃO da cópia local   →  existe, não está vazia, começa por 1f 8b (gzip)
        ↓
5. `tamanho` registado em backup_logs   ← é a PROVA de que o backup existe
        ↓
6. CÓPIA CLOUD (opcional)     →  só se houver destino configurado E ligação utilizável
        ↓
7. RETENÇÃO (local e cloud, independentes)
```

**Regras que não se alteram sem revisão:**

| Situação | Resultado |
|---|---|
| Sem cloud configurada | Cópia local criada; **não é erro**; o ciclo conclui |
| Cloud funcional | Cópia local + cópia cloud, ambas registadas |
| Cloud indisponível | Cópia local **preservada**; `erro` registado; estado «local, cópia cloud falhada» |
| Credenciais cloud inválidas | Igual ao anterior — o local é independente |
| **Falha da cópia local** | **O ciclo FALHA** (`estado='erro'`) — a cloud **nunca** é tratada como substituto |
| Falha a seguir à cópia local | O backup continua **válido**; regista-se a falha sem o invalidar |

`estado='concluido'` significa sempre **«o BACKUP concluiu»**. Uma falha apenas da cópia cloud
não transforma um backup válido em erro.

---

## 3. Onde ficam as cópias

| Cópia | Onde | Âmbito |
|---|---|---|
| Local | `BACKUP_LOCAL_DIR` ou `backups/local` (não versionada, `.gitignore:9`) | instalação |
| Cloud | pasta `Backups` na raiz do serviço escolhido | instalação |

A pasta local contém **apenas dumps da base de dados**. Não contém — e não passa a conter —
documentos, PDFs, imagens, anexos, ZIP de documentos nem espelhos locais do Drive/Dropbox/OneDrive.
Qualquer ficheiro que não siga o formato `backup_<tipo>_<AAAA-MM-DD>_<epoch>.sql.gz` é
**ignorado** pelo inventário: nunca é contado, nunca é apagado.

---

## 4. Retenção

* **Duas retenções independentes:** uma para a cópia local, outra para a cloud.
  `Local 30 / Cloud 90` é uma combinação válida.
* **Por idade**, nunca por número de ficheiros: «eliminar os backups com mais de 30 dias» —
  não «manter os últimos 30».
* **Mínimo: 30 dias.** Não há máximo artificial (`30 / 60 / 90 / 180 / 365` são sugestões; o
  campo aceita mais). A validação é feita **no servidor**, não no browser.
* A limpeza local **nunca** apaga ficheiros da cloud; a limpeza cloud **nunca** apaga ficheiros
  locais. Uma falha de autenticação da cloud não provoca nenhuma eliminação local.
* A limpeza automática pode ser **desligada**; a limpeza manual corre sempre.

### ⛔ Proteção do último backup válido

A limpeza automática **nunca** deixa a instalação sem qualquer backup local válido. Mesmo que a
retenção indique que **todos** os backups estão fora do prazo, o **mais recente válido** é
preservado. A mesma regra é aplicada às **operações manuais** (individual e por data).

```
retenção automática → apaga tudo → instalação sem backup local     ⛔ NÃO ACONTECE
```

### Configuração

Guardada em `configuracoes` (chave-valor — **sem migration**), editável em
**Administração global → Backups**:

| Chave | Significado |
|---|---|
| `backup_retencao_local` | dias de retenção da cópia local (mín. 30) |
| `backup_retencao_cloud` | dias de retenção da cópia cloud (mín. 30) |
| `backup_limpeza_automatica` | `1`/`0` |
| `backup_limite_local_gb` | limite **informativo** (nunca apaga) |
| `backup_ultima_limpeza` | instante da última limpeza |
| `backup_resultado_limpeza` | resumo da última limpeza |

`.env` (apenas *fallback*, quando nada está guardado): `BACKUP_DAILY_RETENTION` (local),
`BACKUP_CLOUD_RETENTION` (cloud), `BACKUP_LOCAL_LIMIT_GB`, `BACKUP_LOCAL_DIR`, `BACKUP_HOUR`.

---

## 5. Administração (Super Admin)

**Administração global → Backups** (`/global/armazenamento`), acessível **apenas** a
`users.role_global = 'super_admin'`. Um administrador de condomínio é recusado (302) — o dump
contém dados de todos os condomínios.

A página mostra:

* **Cópia local:** espaço ocupado, nº de backups válidos (e ficheiros inválidos), backup mais
  antigo/mais recente, último backup válido, espaço do volume, pasta, retenção configurada,
  estado da limpeza automática e resultado da última limpeza. Tudo **medido a partir dos
  ficheiros reais** (`fs.readdirSync` + `fs.statSync`).
* **Cópia cloud:** destino, conta, ligação utilizável, nº de cópias **registadas**, mais
  antiga/mais recente, retenção.
  * **Espaço ocupado pela pasta de backups:** continua **não disponível** — nenhuma das três
    APIs devolve a dimensão de uma pasta numa só chamada, e não se soma o que não se mede.
  * **Espaço da conta do serviço:** é **medido** pela API do destino (`storage.espacoNaCloud`):
    Google Drive `about.get({fields:'storageQuota'})`, Dropbox `users/get_space_usage`,
    OneDrive `GET /me/drive?$select=quota`. A página apresenta-o como «espaço da conta» e diz
    explicitamente que **inclui todos os ficheiros da conta, não só os backups**. Quando o
    serviço não responde (ou não expõe a quota) mostra «não disponível» — nunca uma estimativa.
* **Lista de backups:** data/hora, tipo, destino, tamanho, estado.
* **Eliminação manual:** um backup individual, ou todos os anteriores a uma data. Ambas com
  confirmação explícita e a proteção do último backup válido.
* **Armazenamento documental:** secção **separada**, com o tamanho **registado** por condomínio
  (`documentos.tamanho`), mais antigo/mais recente e a contagem de documentos sem tamanho
  registado. **Nunca somado** ao espaço dos backups.

### Limite informativo de espaço

`Limite informativo local (GB)` serve para **alertar** e prevenir crescimento inesperado.
**Não** provoca eliminação automática. A retenção continua a ser por idade.

---

## 6. Documentos ≠ backups

| | Backups | Documentos |
|---|---|---|
| O que protegem | os **dados da instalação** (base de dados) | os **ficheiros** de cada condomínio |
| Âmbito | instalação (todos os condomínios) | **por condomínio** |
| Onde | `backups/local` + destino cloud de backups | serviço escolhido pelo condomínio (Drive/Dropbox/OneDrive) |
| Retenção | por idade, configurável | não é gerida pelo sistema de backups |

* O espaço dos documentos **não** conta como espaço de backups locais.
* Os documentos **não** são incluídos nas métricas de armazenamento dos backups.
* A retenção de backups **nunca** elimina documentos.
* Os documentos **nunca** são movidos para o armazenamento local de backups.

---

## 7. Segurança

* Acesso exclusivo do **Super Admin** (`role_global`), com validação no servidor.
* Os nomes de ficheiro vindos do cliente **nunca** são usados como caminhos: só passa um nome
  simples, conforme ao formato de backup, e o resultado tem de ficar **dentro** do diretório
  (`helpers/backup-inventario.js:caminhoSeguro`). Isto bloqueia *path traversal*.
* Nenhum dump é servido por endpoint público; não são criados links do fornecedor nem links
  partilhados.
* Não são expostos tokens nem credenciais (os tokens continuam cifrados em repouso e não
  aparecem nos registos).
* As operações administrativas são auditadas (`backup_retencao_alterada`,
  `backup_retencao_recusada`, `backup_eliminado`, `backup_eliminado_por_data`,
  `backup_eliminacao_recusada`, `backup_limpeza_manual`).

---

## 8. Implementação

| Ficheiro | Papel |
|---|---|
| `jobs/backup.js` | o ciclo (dump → local → validar → cloud → retenção) e as funções de inventário/retenção reutilizadas pela administração |
| `helpers/backup-inventario.js` | lê o **disco**: nome, tipo, data, tamanho, validade; junta ao registo por `tipo|tamanho`; segurança de caminho |
| `helpers/backup-retencao.js` | decisão pura: validação de dias (mín. 30), seleção por idade, proteção do último válido, configuração persistida |
| `helpers/backup-estado.js` | interpretação pura de `backup_logs` (os 5 estados) |
| `routes/global-admin.js` | rotas de `/global/armazenamento` (ver, retenção, limpeza, eliminação) |
| `views/admin/global/armazenamento.handlebars` | a interface (PT-PT) |
| `jobs/scheduler.js` | registo das tarefas cron dos backups (diário, semanal, mensal) |
| `helpers/backup-agenda.js` | **decisão pura** da agenda (hora, dias, ligar/desligar) — o que `jobs/scheduler.js` regista |

**Sem migration.** Tudo cabe nas estruturas existentes: `backup_logs` (sem alterações) e
`configuracoes` (chave-valor). O **nome do ficheiro é auto-descritivo** — `tipo`, data e instante
saem do próprio nome —, pelo que não foi preciso acrescentar uma coluna de nome.

### Limitações conhecidas

* **Remoção no fornecedor:** implementada nos **três** provedores — Google Drive (`files.delete`),
  Dropbox (`files/delete_v2`) e OneDrive (`DELETE /me/drive/items/{id}`). A retenção **cloud**
  funciona, portanto, com qualquer destino. É **idempotente** em todos: um ficheiro que já não
  existe conta como removido (Dropbox `path_lookup/not_found`, OneDrive 404) — sem isso a
  retenção ficava presa num ficheiro que já desapareceu. Um provedor sem a capacidade faz
  `storage.apagarArquivo` devolver `false` e o resumo da limpeza di-lo («o serviço de destino não
  suporta remoção»).
* **Espaço ocupado pela pasta de backups** não é medível (nenhuma das três APIs devolve a
  dimensão de uma pasta numa só chamada). Apresenta-se «não disponível» para esse campo; em
  alternativa, mede-se a **quota da conta** do serviço (ver §5) — uma métrica diferente, dita
  como tal.
* **Âmbito da remoção cloud:** a remoção usa a ligação **atual** do destino. Se o destino for
  mudado para outra conta entre o upload e a limpeza, a remoção de uma cópia antiga pode não
  encontrar o ficheiro (o OneDrive devolve `true` num 404, por ser idempotente).
* **Retenções por tipo** (`BACKUP_WEEKLY_RETENTION`, `BACKUP_MONTHLY_RETENTION`) foram
  substituídas por retenções **por destino**. **Agendamento:** `diario`, `semanal` e `mensal`
  correm no cron (`jobs/scheduler.js`), com a decisão em `helpers/backup-agenda.js` —
  `BACKUP_HOUR` (hora comum), `BACKUP_WEEKLY_DAY` (por omissão **`0`** = domingo),
  `BACKUP_MONTHLY_DAY` (1–28; por omissão 1) e
  `BACKUP_WEEKLY_ENABLED`/`BACKUP_MONTHLY_ENABLED` para desligar um ciclo. O máximo **28** no
  dia mensal é deliberado: os dias 29–31 não existem em todos os meses, pelo que um
  agendamento para 31 nunca correria em fevereiro. `manual` **não** é agendado (dispara-se à
  mão em Administração global → Backups).
* **`BACKUP_WEEKLY_DAY` — nome ou número.** Aceita o **número** (`0` = domingo … `6` =
  sábado) **ou** o nome de 3 letras (`SU`, `MO`, `TU`, `WE`, `TH`, `FR`, `SA`; minúsculas
  também) e **normaliza sempre para o número** antes de construir a expressão; um valor
  inválido (`7`, `XX`, vazio) cai no valor por omissão `0`. Assim, `BACKUP_WEEKLY_DAY=SU` e
  `BACKUP_WEEKLY_DAY=0` produzem a **mesma** expressão, `0 3 * * 0`.
  ⛔ **Porquê numérico:** o **node-cron 3.x** valida o campo do dia da semana com
  `/^(?:\d+|\*|\*\/\d+)$/` e **rejeita os nomes** — `cron.schedule('0 3 * * SU', …)` lançava
  «SU is a invalid expression for week day», o que **abortava** o registo das tarefas
  seguintes (o ciclo `mensal` deixava de ser agendado) e, no arranque, derrubava o processo.
  Os nomes são, por isso, aceites **apenas à entrada** e nunca chegam à expressão.
* **Fora de âmbito (documentado, não corrigido):** a escolha do destino de backups
  (`POST /admin/config/armazenamento/backups`) e o disparo de um backup manual
  (`POST /admin/sistema/backup`) continuam acessíveis a um administrador de condomínio, embora
  sejam operações da **instalação**. São defeitos de autorização, não de backups, e ficam para
  uma tarefa própria.

---

## 9. Testes

| Script | Cobre |
|---|---|
| `scripts/test-backup-estado.js` | os 5 estados, o fluxo local+cloud, a independência dos fornecedores, a retenção configurável e o âmbito da remoção |
| `scripts/test-backup-agenda.js` | a **agenda**: validação dos valores de ambiente, o plano (diário/semanal/mensal, `manual` fora), a **validade das três expressões para o `node-cron` real** (`cron.validate` + `cron.schedule`) e a ligação REAL ao `jobs/scheduler.js` (com `node-cron` substituído por um duplo) — dispara cada tarefa e confirma o tipo chamado |
| `scripts/test-backup-retencao.js` | cenários **A–I e K**: sem cloud, cloud funcional, cloud indisponível, credenciais inválidas, falha local, retenção local, retenção cloud, métricas, eliminação manual, documentos separados |
| `scripts/test-rotas-global-backups.js` | cenário **J**: isolamento administrativo (HTTP real), a página com os valores reais, o **espaço da conta cloud** (medido ou «não disponível») e a validação no servidor |
| `scripts/test-storage-provedores.js` | a **remoção** (`apagarArquivo`) e a **medição de espaço** na Dropbox/OneDrive, com um interceptor do cliente HTTP (sem rede) |

```bash
node scripts/test-backup-estado.js
node scripts/test-backup-agenda.js
node scripts/test-backup-retencao.js
node scripts/test-rotas-global-backups.js
node scripts/test-storage-provedores.js
```

Os testes correm **sem base de dados e sem rede**, com duplos de `../models`,
`../helpers/storage`, `../helpers/config` e `child_process.execFile`. A retenção local escreve num
diretório temporário (`BACKUP_LOCAL_DIR`).
