# Auditoria — Email/SMTP, comunicações agendadas e execução de jobs

**Data:** 2026-09-22 · **Âmbito:** P2, P29, P50, P51, P52 (correções) e P30, P35 (levantamento).
**Estado:** working tree, **sem commit e sem push**. `docs/ROADMAP.md` **não foi tocado** (instrução explícita).

---

## 1. Correções

### P50 — o `select` do TLS e o booleano em `obterEstadoSmtp()`

**Defeito.** O `<select name="tls">` tinha `<option value="true" selected>` **fixo** e
`obterEstadoSmtp()` só expunha a string `seguranca` — não o booleano. Guardar o formulário, mesmo só
para mudar a password, enviava `tls=true` e **sobrepunha** um `smtp_tls='false'` guardado: o admin
religava o TLS sem intenção.

**Correção (lado produtor e lado consumidor).**

- `helpers/mailer.js` — `obterEstadoSmtp()` passa a expor `tls` **booleano**
  (`const tls = cfg.tls === 'true'`), e `seguranca` deriva dele (`SSL/TLS (465)` se a porta for 465,
  `STARTTLS (587)` caso contrário, `Sem TLS` se `tls` for falso). A password continua a **nunca** ser
  exposta (só `temPassword`).
- `views/admin/configuracao/email.handlebars` — `selected` **condicional** nas duas opções
  (`{{#if estadoSmtp.tls}}` / `{{#unless estadoSmtp.tls}}`).

**Prova.** `scripts/test-smtp-estado.js` (novo) exercita o **mailer real** com um duplo de
`Configuracao` — o `test-configuracoes.js` substituía o produtor por um stub, pelo que **nada**
garantia que o campo fosse devolvido. Cobre: `typeof tls === 'boolean'` nos dois estados, coerência
etiqueta↔booleano, password nunca exposta, prioridade BD sobre `.env`, degradação com a BD em baixo.
`scripts/test-configuracoes.js` ganhou o §4.0, que lê o **bloco do `<select>`** e assere a opção
`selected` (`['true']` e, com `tls:false`, `['false']`). Mutações 4 e 5 do harness detetadas.

### P51 — o atalho de período assinalado

**Defeito.** O atalho ativo era **derivado** do intervalo efetivo. Os intervalos **colidem**: até ao
dia 7, «Este mês» e «Últimos 7 dias» dão o mesmo intervalo; no dia 30, «Este mês» e «Últimos 30
dias». Nesses dias a página assinalava «Este mês» mesmo quando o utilizador tinha carregado noutro
botão. A consulta era **idêntica** — o defeito era só de apresentação, mas o botão pressionado não
era o botão assinalado.

**Correção.** `helpers/periodo-filtro.js` (`resolverPeriodo`) passa a **preferir o `periodo`
pedido** quando é um atalho calculado válido; a derivação por intervalo fica como **recurso** para
quando não há parâmetro (entrada inicial) ou o valor é inválido/`personalizado`.

**Prova.** `scripts/test-periodo-filtro.js` §9 mede a colisão (dia 7 e dia 30) e assere que cada
botão fica assinalado, e que a derivação se mantém sem parâmetro. Mutação 1 detetada.

### P2 — o interruptor «Envio automático ativo» permanentemente `disabled`

**Defeito.** `views/admin/quotas/gerar.handlebars` tinha
`<input type="checkbox" disabled name="envio_automatico">`. Provado **morto** nas três pontas:
o browser **nunca o submete** (está `disabled`), o servidor **nunca o lê**
(`POST /quotas/gerar` decide por `enviar_email` **ou** `automacaoAtiva('quotas','automatico')` —
`routes/financeiro.js`), e nenhum teste nem vista o referenciava. Ficava a parecer um controlo
avariado.

**Correção.** Substituído por um **indicador de leitura** (badge `Ativo`/`Inativo` + texto
explicativo + atalho para onde a automação é realmente configurada).

**Regressão introduzida por esta correção — detetada e corrigida no mesmo trabalho.**
O atalho `href="/admin/config/automacoes"` é uma rota **admin-only**, e a vista é alcançável ao
`gestor`: `scripts/test-autorizacao-arquitetura.js` ficou **vermelho**
(`views/admin/quotas/gerar.handlebars → /admin/config/automacoes`). Corrigido com o idioma do
projeto — `{{#if (ne condominioAtivo.role 'gestor')}}` (mesmo padrão de
`views/admin/dashboard.handlebars`) — mantendo o **estado** visível aos dois papéis. Teste de novo
verde (90 verificações).

### P29 — avisos programados não eram despachados

**Defeito.** O calendário mostrava avisos `programado`, mas **não havia job** que os disparasse por
`data_programada`: só saíam com envio manual.

**Correção — motor único, sem duplicar automação.**

- `helpers/avisos-envio.js` (**novo**) — o motor de enfileiramento de avisos, **extraído** de
  `POST /avisos/:id/enviar` para que a rota e o job o partilhem. `routes/avisos.js` passou a
  delegar (19+/103−): não existe uma segunda implementação.
- `jobs/avisos-programados.js` (**novo**) — seleciona `tipo='programado'` com
  `data_programada <= hoje` (aritmética **relativa**, não `= hoje`, para uma paragem não perder um
  evento para sempre), restrito aos condomínios ativos (`condominiosAtivos()`, o âmbito deriva dos
  **dados** — um job não tem `req`).
- `jobs/scheduler.js` — registo `30 8 * * *`.

**Idempotência.** A condição (`data_programada <= hoje`) continua verdadeira depois de correr, pelo
que a idempotência **não pode** vir da consulta — vem da **deduplicação**. Daí dois critérios
distintos, ambos preservados:

| Via | Estados que bloqueiam reenvio | Razão |
| --- | --- | --- |
| Manual (`POST /avisos/:id/enviar`) | `pendente`, `a_enviar`, `enviado` | o admin pode reenviar **de propósito** depois de `erro`/`cancelado` |
| Automática (job) | `pendente`, `a_enviar`, `enviado`, `erro`, `cancelado` | um aviso cancelado não é ressuscitado; um que falhou não entra em ciclo diário |

**Fronteiras preservadas.** Isolamento `condominio_id` (o motor tranca-se aos destinatários do
próprio aviso e revalida `Number(doc.condominio_id) === cid` antes de anexar — guarda de IDOR);
preferência de notificação `avisos:email` (gate só da via automática); links relativos são
**omitidos** quando não há `APP_URL` (nunca um link inútil no email); a fila existente e a **regra de
3 tentativas** não foram tocadas.

**Prova.** `scripts/test-avisos-programados.js` (**novo**, 13 verificações): Parte A com duplo que
imita a BD (aplica `where`/`order`/`limit`) — disparo, data futura não dispara, idempotência em duas
passagens, `erro`/`cancelado`/`a_enviar`, critério manual vs automático, isolamento por condomínio
ativo, gate da preferência, IDOR no anexo, política de links absolutos, destinatários sem email,
aviso inválido, só `tipo='programado'`; Parte B corre a **rota real** em HTTP e prova que delega no
motor com `ESTADOS_EM_CURSO`, `baseUrl` do pedido e isolamento por `req.condominioId`. Mutações 6 e 7
detetadas.

### P52 — `test-mutacao-email.js` reproduzível

**Criado:** `scripts/test-mutacao-email.js` — **12 mutações**, todas em ficheiros desta frente
(`helpers/periodo-filtro.js` ×3, `helpers/mailer.js`, `views/admin/configuracao/email.handlebars`,
`jobs/avisos-programados.js`, `routes/avisos.js`, e `jobs/automatizacao.js` ×5 — as 8–12, acrescentadas
com a correção da §4). No molde do projeto: backup integral +
`sha256` antes/depois, reposição em `finally`, varrimento de órfãos no arranjo, e
`PASSOU`/`FALHOU`/`INTERROMPIDO` distintos (SIGTERM **não** conta como deteção).

**Pré-condição estrutural:** cada mutação **assere que a âncora ocorre exatamente 1×** antes de a
aplicar — é a lição do P52 tornada invariante:
`assert.strictEqual(ocorrencias, 1, …)`.

**Prova.** 12/12 detetadas e revertidas por sha256, `exit 0`, sem resíduo. O harness está **ligado à
cadeia `test:offline`** (logo após `test-mutacao-fcr-orcamento.js`), pelo que passa a correr em cada
execução completa. ⛔ **Mas não pode correr na mesma cadeia do resto num só turno:** o hook
`safe-delete` esgota o orçamento de eliminações e mata o processo (ver §3 e §4.4). Corre **isolado**.
✅ **Estado atual:** o harness foi re-corrido **depois** da correção do varrimento (§4.4), com os dois
formatos de resíduo plantados: **12/12 detetadas**, `exit 0`, com o varrimento a repor o alvo mutado e
a limpar os órfãos. O **12/12 vale para a versão atual** do ficheiro.

---

## 2. Decisões pendentes (levantamento feito, **nada decidido nem implementado**)

### P30 — SMTP global vs por condomínio

**Estado atual, verificado no código:**

- `models/Configuracao.js` é **chave-valor global**: `chave STRING(120) UNIQUE` + `valor TEXT`.
  **Não tem `condominio_id`.**
- Todas as chaves SMTP vivem lá (`smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`, `smtp_tls`,
  `smtp_from`, `smtp_from_name`) e são lidas com `where: { chave: { [Op.like]: 'smtp_%' } }` —
  leitura **global**, sem filtro de inquilino.
- O `condominioId` **só** contextualiza o **nome do remetente**
  (`sendMail` → `obterNomeRemetente` → `nomeDoCondominioParaRemetente`), com a precedência
  `displayName` → `smtp_from_name` → nome do condomínio → `"GesCondu"`. **Host, porta, utilizador e
  password são partilhados por todos os condomínios.**

**O que já existe a favor de uma via por condomínio (é menos trabalho do que parece):**

- **Precedente idiomático:** `helpers/quotas-config.js` tem
  `chaveDoCondominio(chave, id) → \`${chave}:c${id}\`` e `lerComPrecedencia(chave, id)`, que devolve
  `undefined` quando não existe nem no âmbito do condomínio nem global — exatamente a semântica
  necessária. O armazenamento já usa este esquema (`:c<id>` com recurso à plataforma, E1/E2).
- **A fila já transporta o inquilino:** `models/EmailFila.js` tem `condominio_id`, e
  `helpers/email-fila.js` resolve o remetente a partir do `condominio_id` **persistido** na fila
  (fonte de verdade), com recurso à entidade relacionada. Ou seja, o worker de envio já sabe de que
  condomínio é cada email.

**Opções:**

| # | Opção | Custo | Efeito |
| --- | --- | --- | --- |
| (a) | **Manter global** e documentar | 0 | Todos partilham credenciais e **reputação** do mesmo remetente; um condomínio não pode usar o seu fornecedor/domínio |
| (b) | **Por condomínio com recurso à plataforma** (`smtp_pass:c<id>` … `:plataforma`) | Médio: seletor de âmbito na UI de configuração; `mailer` resolve por `condominioId`; **multiplica segredos em repouso** | Cada condomínio pode ter o seu SMTP; quem não configurar continua na plataforma |
| (c) | **Híbrido mínimo:** só `smtp_from`/`smtp_from_name` por condomínio | Baixo | Resolve a identidade do remetente (já quase resolvido pelo nome); não resolve credenciais |

**Proposta (a decidir pelo utilizador):** **(a) agora, (b) quando um condomínio concreto o pedir.**
Razões: (i) não há pedido registado; (ii) (b) multiplica segredos em repouso precisamente na semana
em que a cifra da password SMTP acabou de entrar; (iii) (b) exige que **todos** os caminhos de
enfileiramento carreguem o inquilino e que a UI de configuração ganhe âmbito — trabalho real, não
cosmético. Se a decisão for (b), o desenho deve reutilizar `chaveDoCondominio`/`lerComPrecedencia` e
o `condominio_id` já persistido na fila, em vez de inventar um segundo mecanismo.

### P35 — fila de tarefas em memória

**Estado atual, verificado no código:**

- `helpers/background-jobs.js`: `handlers`/`tarefas` (`Map`) + `fila` (array), consumidor
  **sequencial único** com flag de reentrância, teto `MAX_TAREFAS_RETIDAS = 200` (a evicção só
  remove tarefas **já terminadas**).
- **Sem persistência:** um restart perde a fila e o histórico. O erro de uma tarefa é apanhado e
  registado (`estado: 'erro'`), mas **não há retry** (ao contrário da `email_fila`, que tem a regra
  de 3 tentativas).
- **Um produtor e um consumidor:** `routes/financeiro.js` → `enqueue('quotas_pos_processamento', …)`;
  `app.js` → `registar('quotas_pos_processamento', processarPosGeracaoQuotas)`.

**O que se perde num restart (medido, não suposto):** o handler **já é idempotente** e o trabalho
durável vai para a BD/ficheiros — a fase Drive é guardada por
`Documento.count({ entidade_tipo:'Quota', entidade_id, drive_status:'guardado' })`, e a fase de
email entra na `email_fila` (durável, 3 tentativas). O handler recusa correr sem `condominioId`
(nunca adivinha o inquilino). **Exposição real:** se o processo morrer antes de o handler começar, as
cópias Drive e/ou os enfileiramentos de email desse lote **não acontecem** — e **não há
re-disparo automático** (regenerar o mesmo mês encontra `criadas === 0` e não volta a enfileirar).

**Proposta (sem infraestrutura externa):**

1. **Manter a fila em memória** — um produtor, trabalho idempotente, janela de perda pequena.
2. **Tornar o trabalho re-disparável**, que é o que falta: uma via explícita (rota ou job de
   recuperação) que volte a enfileirar `quotas_pos_processamento` para um (ano, mês, condomínio)
   cujo trabalho ficou por fazer — a idempotência já existente torna a repetição segura.
3. **Não** introduzir Bull/Redis/fila externa: seria infraestrutura nova para um único produtor
   cujo trabalho já é idempotente e cuja perda é recuperável.
4. Documentar a limitação (este documento).

---

## 3. Limitações de ambiente e coordenação

- **`npm run test:offline` (sem filtro) → `exit 1`**, parando no **passo 51** (`test-eventos.js:256`,
  «não há migration posterior a esta»), causado pela migration
  `migrations/20260101000079-segredos-em-repouso.js` **de outra frente** (P13), que não alinhou a
  guarda do teste. **Não é desta frente** — e enfraquecer a guarda para obter verde seria reescrever
  um teste alheio.
- **`scripts/test-titularidades.js` vermelho** por outra frente (P37/exportação — aspas/CRLF do CSV);
  `helpers/exportacao-dados.js`, `helpers/money.js` e o próprio teste estão em edição.
- **Cadeia filtrada (101 passos = 103 − as 2 suites acima): NÃO chega ao fim — morre no passo 82 por
  causa do hook, não do código.** Corrida com `set -e` (a primeira tentativa, sem `set -e`, devolvia
  `exit 0` por o código de saída ser o do `echo` final — **prova inválida**, descartada). Com `set -e`:
  **passos 1–81 verdes**, e no **passo 82/101** (`scripts/test-mutacao-suporte.js`, harness de outra
  frente) o processo é morto com
  `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":100,"threshold":100,"scope":"turn"}`.
  É o **perigo P53** já registado: o hook `safe-delete` conta **eliminações por turno, cumulativamente**
  (limiar 100) e uma cadeia longa que inclua os harnesses de mutação (cada um apaga dezenas de
  `.mutation-backup-*`) esgota o orçamento a meio.
- **Nada ficou mutado por causa disso — verificado, não assumido.** O backup órfão dizia o alvo
  (`helpers/suporte-allowlist.js`); o alvo é **byte-idêntico** ao backup
  (`sha256 597838ec…`) e **não aparece em `git status`** ⇒ o `finally` do harness repôs o ficheiro
  antes de o `unlinkSync` ser recusado. Os `.mutation-backup-*` órfãos foram reciclados.
- **Consequência metodológica:** os harnesses de mutação **não podem** correr dentro de uma cadeia
  longa no mesmo turno. São provados **isolados** (cada um no seu turno). A cadeia filtrada prova o
  resto (inclui `test-vistas.js` e `check-templates.js` — todas as vistas compilam e renderizam — e o
  novo `test-lembretes-automaticos.js` no passo 39).
- **Os 5 harnesses da cadeia foram corridos isolados nesta sessão — TODOS verdes.** Não se herda a
  prova de outra frente; correu-se cada um:

  | Harness | Mutações | Resultado |
  | --- | --- | --- |
  | `test-mutacao-suporte.js` | 16 | **16/16** detetadas, `exit 0` |
  | `test-mutacao-email.js` | 12 | **12/12** detetadas, `exit 0` |
  | `test-mutacao-fcr-orcamento.js` | 7 | **7/7** detetadas, `exit 0` |
  | `test-mutacao-mensal.js` | 5 | **5/5** detetadas, `exit 0` |
  | `test-mutacao-fcr.js` | 3 | **3/3** detetadas, `exit 0` |
  | **Total** | **43** | **43/43**, todas repostas por sha256 |

  Alvos de outras frentes conferidos depois: `helpers/suporte-allowlist.js` = `597838ec…` (inalterado),
  sem `.mutation-backup-*` residual, `git diff --check` limpo.
- **O limite é ESTRUTURAL, não dos harnesses — medido.** Corrida seguinte: cadeia filtrada **sem
  nenhum** `test-mutacao-*` (96 passos, `set -e`). Resultado: **886 `✓`**, **zero falhas de código**,
  e morte no **passo 86/96** (`test-pdf-documentos.js`) com
  `[safe-delete][SAFE_DELETE_BULK_REJECTED] {"count":100,"threshold":100,"scope":"turn"}`. Ou seja: as
  ~96 suítes **sozinhas** já somam ≥100 eliminações num turno. **`test:offline` não é executável por
  inteiro num só turno, com ou sem harnesses** — é a limitação do hook, não do código.
  **Passos 1–85 verdes nessa corrida**; os **86–96 não foram exercidos aí** (`test-pdf-documentos`,
  `test-movimentos-integridade`, `test-crlf-fim-de-linha`, os quatro `test-eliminacao-*` — que são
  justamente os que mais apagam — `test-extrato`, `test-seed-demo`, `test-seed-demo-smoke`,
  `check-templates`).
- **O segmento em falta foi corrido no turno seguinte — e passou.** Os **passos 86–96** (11 suítes,
  `set -e`, orçamento de eliminações fresco): **`exit 0`**, **170 `✓`**, **zero falhas**, todas as 11
  chegaram ao fim (`check-templates.js` incluído). ⇒ **Os 96 passos não-harness estão provados**
  (886 ✓ + 170 ✓), obtidos em **dois segmentos de turnos diferentes**. É esta a forma de provar a
  cadeia completa neste ambiente: **por segmentos**, não numa só corrida.
- **P53 — duas facetas distintas, ambas medidas nesta sessão.**
  **(a) O bloqueio de 44 min NÃO se reproduziu:** um `unlinkSync` controlado regressou em **1782 ms** e
  o harness de email (então 7 mutações) terminou em ~6 min na 1.ª execução e em **35 s** na repetição,
  ambas `exit 0` e com os alvos conferidos por sha256 antes e depois. Não se inventa sucesso: regista-se
  que **não reproduziu**, e o problema continua **aberto** (um bloqueio intermitente não fica resolvido
  por não aparecer uma vez).
  **(b) O guard de eliminações em lote MANIFESTOU-se, e é determinístico:** na cadeia filtrada, o
  `SAFE_DELETE_BULK_CONFIRM_REQUIRED` (`count:100`) matou o processo no passo 82 (ver acima). Não é
  intermitente — é aritmética: 100 eliminações por turno, e os harnesses de mutação gastam a maior
  parte. **Regra operacional: um harness de mutação por turno, isolado.**
- **Working tree partilhada por várias frentes.** As minhas edições coexistem com hunks alheios em
  `helpers/mailer.js` (cifra da password SMTP), `jobs/scheduler.js` (agenda de backups),
  `views/admin/quotas/gerar.handlebars` (refactor da pré-visualização, P20) e `package.json`.
  Cada um destes ficheiros **arrasta trabalho alheio se for commitado inteiro**.
- **`package.json` é UMA linha física**, partilhada por várias frentes (13 entradas acrescentadas
  desde `HEAD`, 10 delas alheias). `scripts/test-smtp-estado.js`, `scripts/test-avisos-programados.js`,
  `scripts/test-lembretes-automaticos.js` **e `scripts/test-mutacao-email.js`** estão lá — o harness foi
  ligado à cadeia logo após `test-mutacao-fcr-orcamento.js`, com **snapshot + verificação** (JSON
  válido, **103 passos**, **0 entradas perdidas**, minhas ou alheias). A linha continua a ser o ponto
  frágil do P48: qualquer frente que a reescreva a partir de uma leitura velha apaga entradas.
- **Auditoria das âncoras de mutação:** **49/49** âncoras com o número de ocorrências esperado (as
  minhas — **12** no harness de email — mais as de `-fcr`, `-mensal`, `-fcr-orcamento`, `-suporte`,
  `-exportacao`). Numa passagem
  intermédia uma âncora apareceu a 0× — **artefacto**, não defeito: a âncora em falta **mudou** entre
  passagens e havia `.mutation-backup-*.tmp` em voo (outra frente a mutar o mesmo ficheiro). Fica
  registado para não ser lido como regressão. **5 mutações de `test-mutacao-despesa-transacao.js`**
  (frente alheia) não são verificáveis pelo parser — reportadas em «Não verificadas», não escondidas.

---

## 4. Detetado nesta revisão e **corrigido** (aprovado pelo utilizador)

Ao rever as automações de comunicação (como pedido), o job `jobs/automatizacao.js`
(`enviarLembretesAutomaticos`) revelou **dois problemas**. Ambos estavam fora das pendências
enumeradas e o segundo é decisão de produto — por isso foram **apresentados ao utilizador antes de
qualquer alteração**, que decidiu: *«Corrigir já só este job»* e *«Janela relativa com marcador de
envio»*. Foram corrigidos **só neste job** (ver a nota de âmbito em 4.1) e ficaram provados por
mutação.

### 4.1 `toISOString()` deslocava o dia em fusos a leste de UTC — defeito **sazonal** — CORRIGIDO

Antes:

```js
const lembreteISO = dLembrete.toISOString().slice(0, 10);   // recuava o dia
const atrasoISO = dAtraso.toISOString().slice(0, 10);
```

`dLembrete`/`dAtraso` são **meia-noite locais**; `toISOString()` converte para UTC e **recuava o dia**
sempre que o fuso é positivo. Medido nesta máquina (`Europe/Lisbon`, offset −60 min), com
`lembrete_dias = 5` e `atraso_dias = 3`:

| | dia pretendido | `toISOString().slice(0,10)` (antes) | `toDateInput(...)` (agora) |
| --- | --- | --- | --- |
| lembrete | 2026-09-27 | **2026-09-26** | 2026-09-27 |
| atraso | 2026-09-19 | **2026-09-18** | 2026-09-19 |

Em horário de verão os «dias configuráveis» valiam **um dia a menos**; em horário de inverno (UTC+0)
estava certo — o defeito **aparecia e desaparecia com a mudança da hora**.

**Correção:** o cálculo passou a usar o helper correto do projeto, `helpers/dates.js` → `toDateInput`
(componentes **locais**), o mesmo idioma de `helpers/titularidades.js:39`:

```js
const hojeISO = toDateInput(hoje);
const fimLembrete = toDateInput(somarDias(hoje, diasLembrete));
const fimAtraso = toDateInput(somarDias(hoje, -diasAtraso));
const inicioAtraso = toDateInput(somarDias(hoje, -diasAtraso - DIAS_RECUPERACAO));
```

⚠️ **Âmbito deliberadamente limitado a este job.** `toISOString().slice(0,10)` continua em ~20 sítios
(`routes/condomino.js`, `routes/financeiro.js`, `routes/extra-quotas.js`, `helpers/recibos.js`,
`helpers/extrato.js`, `jobs/backup.js`…), **quase todos em ficheiros de outras frentes** — e o
utilizador decidiu não os tocar. Fica registado como **dívida sistémica**: a aplicação tem, por agora,
duas convenções, e este job é a correta. Corrigir o resto é item próprio, com inventário e um teste
que **morda por fuso** (`TZ=Europe/Lisbon`).

### 4.2 A consulta exigia o dia **exato** ⇒ uma paragem perdia a coorte para sempre — CORRIGIDO

Antes:

```js
data_vencimento: { [Op.in]: [lembreteISO, atrasoISO] },   // só o dia exato
```

Se o job não corresse num dia (paragem, deploy, reinício), as quotas cujo vencimento caía nesse dia
**nunca** recebiam lembrete nem aviso de atraso — o anti-padrão que o projeto proíbe («nunca `= hoje`,
usar aritmética relativa»).

**Correção (janela relativa com marcador de envio):** a consulta passou a uma janela **relativa e
limitada**, e a idempotência deixou de depender da consulta (que fica verdadeira depois de correr) e
passou a depender de **deduplicação** por marcador na `email_fila`:

```js
[Op.or]: [
  { data_vencimento: { [Op.between]: [hojeISO, fimLembrete] } },          // lembrete: hoje … +N
  { data_vencimento: { [Op.between]: [inicioAtraso, fimAtraso] } },       // atraso: −(M+7) … −M
],
```

e, por quota candidata, um único lookup em lote (nunca por quota) que salta quem já tem registo:

```js
const jaDespachado = new Set();   // `${entidade_id}:${assunto}`
const registos = await EmailFila.findAll({ where: {
  entidade_tipo: 'Quota', entidade_id: { [Op.in]: ids },
  assunto: { [Op.in]: [ASSUNTO_LEMBRETE, ASSUNTO_ATRASO] },
  estado: { [Op.in]: ESTADOS_JA_DESPACHADOS },   // pendente|a_enviar|enviado|erro|cancelado
}, attributes: ['entidade_id', 'assunto'] });
```

O limiar `vencimento < hojeISO` decide lembrete vs atraso (o assunto é **também** a chave do
marcador, para que um lembrete e um aviso de atraso da mesma quota não se mascarem). O resultado passa
a ser `{ enviados, alvos, repetidos }`.

⚠️ **A janela tem de ser LIMITADA** (`DIAS_RECUPERACAO = 7`): sem limite inferior, a primeira
execução depois desta alteração varreria **todas** as quotas antigas em atraso e dispararia um aviso
por cada uma. Recupera-se **a semana perdida, não o histórico** — verbatim do comentário no código.

### 4.3 Provas acrescentadas nesta correção

- **`scripts/test-lembretes-automaticos.js`** (novo, **11 verificações**, verde): corre com
  `process.env.TZ = 'Europe/Lisbon'` como primeira instrução e **assere o fuso**
  (`getTimezoneOffset() === -60`), para que o defeito de 4.1 seja observável mesmo numa máquina UTC.
  O duplo de `findAll` **honra o `where`** e **rebenta** se encontrar um operador que não modela
  (`if (simbolos.length !== tratados.length) throw`). Cobre: fronteiras da janela local, prova de que
  o valor antigo (`hoje+4`) fica **excluído**, inclusão/exclusão de limites, lembrete vs atraso,
  isolamento por `condominio_id`, marcador a bloquear `enviado`/`erro`/`cancelado`/`a_enviar`, consulta
  do marcador limitada às candidatas, assunto = chave do marcador, e ausência de consulta ao marcador
  quando não há candidatas.
- **`scripts/test-mutacao-email.js`** estendido de 7 para **12 mutações** (todas em ficheiros desta
  frente), incluindo as novas 8–12: `fimLembrete` via `toISOString()`, `hojeISO` via `toISOString()`,
  `inicioAtraso` sem o `−DIAS_RECUPERACAO`, o `if (false)` no lugar da verificação do marcador, e um
  assunto de atraso diferente da chave do marcador. **12/12 detetadas e revertidas por sha256.**
- **`scripts/test-quotas-isolamento.js`** adaptado (o duplo passou a fornecer `EmailFila.findAll`)
  para continuar verde com a consulta nova.

### 4.4 Lacuna encontrada no harness de mutação — **CORRIGIDA e PROVADA**

O varrimento de arranque (`varrerBackupsOrfaos`) filtrava só `^\.mutation-backup-\d+-\d+\.tmp$` — o
backup de **conteúdo**. Um `.alvo` **sozinho** (o processo morre entre os dois `unlink` do `finally`,
depois de o alvo já estar reposto e verificado por sha256) **nunca** era varrido e acumulava-se na
árvore. É **inofensivo** — quando existe `.alvo` sem `.tmp`, o alvo já foi reposto — mas é lixo que fica.

Foi exatamente o que se observou: um `.alvo` órfão de `views/admin/configuracao/email.handlebars`
(cujo conteúdo, confirmado por `sha256 416aea5d…`, estava **intacto**).

**Correção aplicada** em `scripts/test-mutacao-email.js`, em duas partes:
1. **Passagem 2 do varrimento** — apaga `.alvo` sozinho (sem `.tmp` correspondente). Seguro por
   construção: `.alvo` sem `.tmp` implica que o alvo já foi reposto.
2. **Ordem dos `unlink` invertida** — passa a apagar o `.tmp` **antes** do `.alvo`. Se o processo morrer
   entre os dois, sobra um `.alvo` sozinho (que a passagem 2 limpa) em vez de um `.tmp` sem `.alvo`
   (impossível de repor — perde-se a correspondência com o alvo — e conservado para sempre).

✅ **PROVADO por execução.** Plantei os dois formatos de resíduo — (a) um par completo
(`.mutation-backup-1111111111111-1.tmp` + `.alvo`) com o alvo `a9-alvo-teste.tmp` deliberadamente
**mutado** para `MUTADO`, e (b) um `.alvo` **sozinho** (`…2222222222222-2.tmp.alvo`) — e corri o
harness **isolado**. Resultado (`exit 0`):

```
· alvo órfão REPOSTO a partir do backup: a9-alvo-teste.tmp
· «.alvo» órfão (alvo já reposto) removido: .mutation-backup-2222222222222-2.tmp.alvo
…
✓ Testes de mutação de Email/SMTP, comunicações e lembretes passaram (12 mutações, …)
```

Verificações independentes: o alvo voltou a **`ORIGINAL`**; os **3** `.mutation-backup-*` plantados
**desapareceram** (limpos pelo próprio varrimento); `git diff --check` limpo; os 4 ficheiros-âncora com
hash inalterado. Os ficheiros do teste foram reciclados.

> Nota: a **primeira** tentativa desta prova foi **recusada pelo guard de eliminações**
> (`SAFE_DELETE_BULK_CONFIRM_REQUIRED`), e a eliminação foi negada — daí o registo de «pendente» numa
> versão anterior deste documento. Na tentativa seguinte, com orçamento disponível, passou.

## 5. Commit

**Nada foi commitado e nada foi publicado** (instrução: *«NÃO faças push»*). O código fica pronto e
congelado à espera da coordenação de publicação.

Ficheiros desta frente:

- **Modificados:** `helpers/mailer.js` *(partilhado)*, `helpers/periodo-filtro.js`,
  `routes/avisos.js`, `jobs/scheduler.js` *(partilhado)*, `jobs/automatizacao.js`,
  `views/admin/configuracao/email.handlebars`, `views/admin/quotas/gerar.handlebars` *(partilhado)*,
  `scripts/test-configuracoes.js`, `scripts/test-periodo-filtro.js`, `scripts/test-quotas-isolamento.js`,
  `scripts/test-mutacao-email.js`, `package.json` *(partilhado)*.
- **Novos:** `helpers/avisos-envio.js`, `jobs/avisos-programados.js`, `scripts/test-smtp-estado.js`,
  `scripts/test-avisos-programados.js`, `scripts/test-lembretes-automaticos.js`.
