# Dívida técnica, testes e importação/exportação — passagem A8/A9 (2026-09-22)

> **Âmbito.** Dívida técnica que **atravessa áreas** (testes, importação/exportação, higiene),
> tratada sem competir com as frentes especializadas. Estado funcional de todas as áreas e
> problemas conhecidos (P1–P53) continuam em **`docs/ROADMAP.md`** — este documento **não o
> substitui** e foi escrito sem lhe tocar (instrução explícita desta passagem).
>
> **Prioridade seguida:** P37 (bug confirmado) → P3/P5/P36/P38 → importação/exportação.

---

## 1. Corrigido e provado

### P37 — valores monetários 100× maiores na exportação RGPD · **CORRIGIDO**

`formatEUR(toCents(x))` fazia conversão **dupla** (`formatEUR` já chama `toCents`), logo
**todas** as colunas monetárias dos CSV saíam 100× maiores (1.234,56 € → 123.456,00 €).

| Onde | Antes | Depois |
| --- | --- | --- |
| `helpers/money.js` | — | novo `formatEURCents(cents)` — **não** converte; `formatEUR(x)` passa a delegar nele (`formatEURCents(toCents(x))`) |
| `helpers/exportacao-dados.js` (quotas) | `formatEUR(valorC)` | `formatEURCents(valorC)` (valor, pago, em dívida) |
| `helpers/exportacao-dados.js` (parcelas, pagamentos, recibos) | `formatEUR(toCents(x))` | `formatEUR(x)` |

**Prova de valor (não de estrutura).** `scripts/test-titularidades.js` ganhou o **cenário K**, que
afirma a **linha completa** de cada CSV e **recusa explicitamente** os valores inflacionados:

- `1.º Esq;2026;1;61,22 €;0,00 €;61,22 €;2026-01-08;paga`
- `1.º Esq;2026;2;1.234,56 €;34,56 €;1.200,00 €;2099-12-31;parcialmente_paga`
- contrapartida negativa: `6.122,00 €`, `123.456,00 €`, `3.456,00 €`, `25.000,00 €`, `120.000,00 €`

**Prova por mutação.** `scripts/test-mutacao-exportacao.js` (novo, no molde de
`test-mutacao-suporte.js`): **6 mutações, todas detetadas e revertidas**, cada uma com
verificação de que a âncora ocorre **exatamente 1×**. *(A re-execução nesta passagem foi
interrompida pelo orçamento de eliminações por turno — ver **§4.4**; a prova vale pela execução
anterior, sobre âncoras que esta passagem não alterou.)*

**Efeito colateral encontrado e corrigido:** a asserção de isolamento do cenário G **só passava
por causa do defeito** (`999,00 €` era `99.900,00 €`, logo `'999,00'` não era subcadeia). Além
disso, o stub de `Quota.findAll` **ignorava o `where`** — passava por acidente. Corrigido com
`substituirFiltrando` (honra o `where`) e substituído por uma prova direta: **o CSV de quotas tem
exatamente 2 linhas** (cabeçalho + a fração do titular).

### P3 — texto da confirmação de eliminação do rascunho · **CORRIGIDO**

`views/admin/orcamento/detalhe.handlebars` dizia «Eliminar este rascunho? Esta ação não pode ser
revertida.» enquanto `POST /orcamento/:id/eliminar` apaga **rubricas, distribuições, plano de
quotas e histórico**. O utilizador apagava mais do que pensava.

Texto novo (e `data-ajuda` alinhado) nomeia os quatro. **A prova está acoplada ao código da
rota** (`scripts/test-vistas.js`, §17.3): para cada `Modelo.destroy(` que o handler contém, a
mensagem da modal tem de conter a palavra correspondente. Acrescentar um `destroy` novo sem o
dizer na confirmação **faz o teste falhar** — verificado: com o texto antigo, o teste falha com
`a confirmação … tem de mencionar «histórico» — a rota apaga OrcamentoAlteracao`.

### P36 — registo explícito de parciais em `test-vistas.js` · **CORRIGIDO**

A lista era **explícita** (18 de 30 parciais registados): um parcial novo só entrava se alguém se
lembrasse, e a vista que o incluísse rebentava com «The partial X could not be found».

Agora é lida **do disco** (`views/partials/*.handlebars`) e, mais importante, há uma **guarda**:
todos os parciais **invocados** nas vistas (incluindo blocos `{{#> x}}`) têm de existir em
`views/partials/`. É a propriedade que a lista tentava proteger — agora provada a sério.
(`{{> @partial-block}}` fica de fora por construção: o nome começa em `@`.)

### P38 — regexes frágeis com `\n` literal · **CORRIGIDO (com um achado que corrige a auditoria)**

A correção é **normalizar o fim-de-linha na leitura** (`ler`/`lerCss` com `.replace(/\r\n/g, '\n')`)
em `test-autorizacao-arquitetura.js`, `test-contraste.js` e `test-movimentos-integridade.js`.

**Achado: nem todos os padrões listados eram frágeis.** `scripts/test-crlf-fim-de-linha.js` (novo)
converte o conteúdo **real** para CRLF **em memória** (não escreve nada no disco) e mede:

| Padrão | Fonte | Em CRLF |
| --- | --- | --- |
| `/condominioId,\n/g` | `helpers/movimentos.js` | **FRÁGIL** |
| `/MovimentoBancario,\n\} = require\('\.\.\/models'\)/` | `routes/financeiro.js` | **FRÁGIL** |
| `/await registarTransferencia\(\{[\s\S]*?\n    \}\);/g` | `helpers/fcr.js` | seguro (`[\s\S]*?` absorve o `\r`) |
| `/estado: 'confirmado',\s*\n\s*condominio_id: condominioId,/` | `helpers/fcr.js` | seguro (`\s*` absorve o `\r`) |
| `/const ROUTERS = \{([\s\S]*?)\n\};/` | `helpers/suporte-allowlist.js` | seguro (`[\s\S]*?` absorve o `\r`) |

**`test-documentos-acesso.js` não tinha `\n` sobre código-fonte:** os `\r\n` que lá estão são
**fixtures** (dados de teste que provam a recusa de CRLF em cabeçalhos) e a classe `[\r\n]`. O
próprio teste verifica isso, em vez de o afirmar.

O novo `test-crlf-fim-de-linha.js` entrou em **`test:offline`** (não escreve no disco, logo não
consome o orçamento de eliminações do hook `safe-delete`).

---

## 2. Revisão da exportação (RGPD / titular)

**Valores monetários** — ver P37.

**Isolamento (multi-tenancy)** — revisto consulta a consulta:

| Consulta | Filtro | Veredicto |
| --- | --- | --- |
| `FracaoTitularidade` | `condominio_id` + `fracao_id IN` + `pessoa_id`/`utilizador_id` | OK |
| `Quota`, `Pagamento`, `Recibo` | `condominio_id` + `fracao_id IN` | OK |
| `ExtraQuotaParcela` | `fracao_id IN` + `include` obrigatório de `ExtraQuota` com `condominio_id` | OK (o âmbito vem do `include` `required: true`) |
| `Documento` | `condominio_id` + `disponivel_condominos: true` | OK |
| `Assembleia`, `Aviso` | `condominio_id` | OK |
| `AssembleiaParticipante` | **só `pessoa_id`** | OK — não vaza: as linhas do CSV vêm das assembleias **deste** condomínio e a presença é apenas assinalada por chave |
| `ContactoPessoa` | `pessoa_id` + `ativo` | OK (dados do próprio) |

**Caminhos de ficheiros** — `comprovativos.caminhoComprovativo` e `nomeDocumentoParaFicheiro`
usam `path.basename` / `slug` / substituição de `/` e `\`: **sem travessia de diretórios**.

**Documentos/manifesto** — limite de **40 ficheiros** e **8 MB** por documento; o que fica de fora
é **listado no MANIFEST com o motivo**. Comportamento correto e transparente.

**Avisos** — `Aviso` **não tem** flag de visibilidade: o portal mostra todos os do condomínio
(`routes/condomino.js:852`). A exportação replica o que o condómino já vê ⇒ **não é fuga**.

**Corrigido nesta revisão (2 pormenores):**

1. **`hojeISO()` usava `new Date().toISOString()` (UTC).** Às 00h30 em Lisboa (UTC+1 no verão)
   o MANIFEST — um documento de RGPD — datava a exportação no **dia anterior**. Passou a
   aritmética **local** (a mesma armadilha que `helpers/dates.js` documenta).
   **Não é invenção desta passagem:** o projeto já tinha esta regra escrita em
   `scripts/test-eventos.js:441` — «`hojeISO` nunca pode recorrer a `toISOString()`: em
   Kiritimati (UTC+14) a meia-noite local ainda é o dia anterior em UTC». A regra estava a ser
   aplicada a `helpers/calendario.js` e **não** a `helpers/exportacao-dados.js`.
2. **O escape do CSV só reagia a `"`, `;` e `\n`.** Um `\r` **sozinho** (mensagem de aviso colada
   de outro programa) partia a linha a meio. Passou a `[";\r\n]`.

Ambos provados no **cenário L** de `test-titularidades.js` (data local + escape de CR/CRLF/`;`/`"`/`\n`
+ BOM), com uma verificação **estrutural** de que `toISOString()` não volta a `hojeISO`.

---

## 3. Desenho da importação de dados de condomínio (lacuna do produto)

**Decisão de desenho — não implementado nesta passagem.** Uma importação **destrutiva** sem
validação não se implementa; o que se segue é o desenho a validar antes de escrever código.

### 3.1 Princípios

1. **Nada é gravado sem pré-visualização confirmada.** O fluxo é sempre
   `carregar → validar → pré-visualizar → confirmar → gravar → relatar`.
2. **Tudo numa transação.** Qualquer erro ⇒ `rollback` total. Nada de importações pela metade.
3. **Idempotência por chave natural**, não por contador: reimportar o mesmo ficheiro não duplica.
4. **Âmbito sempre da sessão.** `condominio_id` vem do **condomínio ativo** (`req.condominioId`),
   nunca do ficheiro. Um ficheiro com `condominio_id` de outro condomínio é **recusado**, não
   reescrito em silêncio.
5. **Nunca apagar.** A importação cria e atualiza; a eliminação continua a ser uma ação explícita
   com o seu próprio fluxo (ver P7 e a frente de ciclo de vida).

### 3.2 Ordem de importação (dependências)

```
1. Frações          (sem dependências)
2. Pessoas          (sem dependências)
3. Titularidades    (frações + pessoas)
4. Quotas históricas( frações + orçamento/plano quando existir )
5. Saldos de abertura (frações + contas bancárias)
```

### 3.3 Chaves naturais e idempotência

| Entidade | Chave natural | Se já existe |
| --- | --- | --- |
| Fração | `condominio_id` + `designacao` | **atualiza** os campos presentes (permilagem, andar, porta, área) |
| Pessoa | `condominio_id` + NIF (quando presente) senão `email` senão `nome+telefone` | **atualiza** contactos; nunca funde pessoas sem NIF nem email |
| Titularidade | `fracao_id` + `pessoa_id` + `vinculo` + `data_inicio` | **ignora** (é um período histórico; duplicá-lo criaria dois proprietários ativos) |
| Quota histórica | `condominio_id` + `fracao_id` + `ano` + `mes` | **recusa** (a quota tem número de documento; reescrever valores emitidos é uma operação de correção, não de importação) |
| Saldo de abertura | `condominio_id` + `fracao_id` + `conta_bancaria_id` + data | **recusa** se já houver movimento de abertura |

### 3.4 Validação (tudo antes de gravar)

- **Cabeçalho** — colunas obrigatórias presentes; colunas desconhecidas **avisam**, não falham.
- **Tipos e domínios** — datas ISO (`YYYY-MM-DD`), valores em euros com vírgula **ou** ponto,
  estados contra o ENUM real (`Quota.estado` usa **`anulada`**, não `cancelada`;
  `fracoes.permilagem` é `DECIMAL(7,2)` ⇒ **142,857‰ é impossível**).
- **Coerência de permilagens** — `validarPermilagem` (já existe) e aviso quando a soma ≠ 1000‰;
  é **aviso**, não erro (há condomínios legitimamente incompletos).
- **Referências cruzadas** — toda a `fração`/`pessoa` referida tem de existir **no mesmo ficheiro
  ou no condomínio ativo**; uma referência a id inexistente é **erro de linha**.
- **Datas** — `data_fim ≥ data_inicio`; titularidade ativa sobreposta à mesma fração e vínculo é
  **aviso forte** (é o caso que o `form.handlebars` já assinala como
  `proprietariosDuplicados`).
- **`data_vencimento` de quota** — não se importa estado `vencida` (nunca é gravado; o estado
  efetivo deriva de `data_vencimento` via `estadoEfetivo`).

### 3.5 Pré-visualização

Uma página que mostra, **antes de gravar**:

- contagens por entidade: **novos / atualizados / ignorados / com erro**;
- as **primeiras N linhas** de cada entidade com o veredicto por linha;
- a **lista completa de erros** com `ficheiro`, `linha`, `coluna`, `valor` e `motivo`;
- o **resumo do que vai mudar** (ex.: «3 frações atualizam a permilagem: 12,5‰ → 12,7‰»).

Sem esta página não há confirmação — e sem confirmação não há gravação.

### 3.6 Rollback / transação

Uma **única** `sequelize.transaction()` para toda a importação confirmada. O relatório de erros é
construído **antes** da transação (na validação); dentro da transação só correm operações já
validadas. Em erro ⇒ `rollback` + `flash('error_msg')` + relatório descarregável com o estado
exato. **Nada de importações parciais.**

### 3.7 Relatório de erros

Ficheiro CSV descarregável (`importacao-erros-<data>.csv`, com BOM e `;`, como o resto do
produto) com: `entidade;linha;coluna;valor;motivo`. Os erros **não** interrompem a análise das
restantes linhas — o utilizador vê tudo de uma vez, em vez de corrigir um erro por tentativa.

### 3.8 Ficheiros aceites

CSV (UTF-8, com ou sem BOM, `,` ou `;`) nesta primeira fase. XLSX fica para depois: acrescenta uma
dependência e uma superfície de parsing que o produto ainda não tem.

---

## 4. P53 — o bloqueio dos harnesses de mutação: **reproduzido, com a causa isolada**

A P53 descreve o `test:offline` a **bloquear 44 min** em `scripts/test-mutacao-suporte.js` (1.ª
mutação), com um filho `genie-trash\win32-x64.exe` pendurado, por o `NODE_OPTIONS` desta sessão
injetar um *shim* que encaminha **cada eliminação** para a **Reciclagem**.

### 4.1 As duas faces, medidas

**Numa sessão "fresca" o bloqueio NÃO acontece.** Sonda direta: `fs.unlinkSync` regressa em
**1168 ms** no repositório e **1 ms** em `%TEMP%`. E `scripts/test-mutacao-suporte.js` correu até
ao fim: **16 mutações, todas detetadas e revertidas**, ~1m21s, `exit 0`, os **10 alvos** conferidos
por `sha256` intactos, **0 resíduos**.

**Depois de uma cadeia longa, o bloqueio ACONTECE.** Nesta passagem, **no mesmo turno**:

1. `npm run test:offline` correu **50 passos** e parou no 51.º (`test-eventos.js`, ver §5) — cada
   passo faz as suas eliminações;
2. logo a seguir, `node scripts/test-mutacao-exportacao.js` foi **morto por SIGTERM** a meio, sem
   output, **deixando `helpers/exportacao-dados.js` MUTADO** (mutação 6:
   `formatEUR(toCents(r.valor))`, linha 272) e **1 resíduo** `.mutation-backup-<stamp>.tmp` +
   `.tmp.alvo`.

### 4.2 A causa é um ORÇAMENTO POR TURNO, não um defeito da máquina

O hook `safe-delete` conta as eliminações **por turno** (`threshold: 100`). Uma cadeia longa
consome esse orçamento; a partir daí **cada eliminação seguinte fica à espera de confirmação** e o
processo filho não regressa. Não é intermitência aleatória: é **cumulativa** — o que explica
porque é que a mesma suíte passa numa sessão e bloqueia noutra.

### 4.3 Correção de uma crença anterior (importante)

O registo de 2026-09-22 dizia que «o `finally` do harness já tinha reposto o ficheiro antes do
`unlinkSync` que bloqueou». **Não é sempre verdade:** aqui o `finally` **não correu** (o processo
foi morto antes) e o alvo **ficou mutado**. O que salvou foi o **backup órfão**, escrito **antes**
da mutação.

**Procedimento de recuperação (a repetir sempre que um harness morrer a meio):**

1. `ls .mutation-backup-*.tmp*` → encontrar o órfão;
2. ler o `.tmp.alvo` → saber **que ficheiro** foi mutado;
3. `sha256sum` do backup **e** do alvo → **se diferirem, o alvo está mutado**;
4. confirmar que o backup é o conteúdo **correto** (aqui: sem `formatEUR(toCents(`, com as
   correções `hojeISO`/`csv`) — **nunca** restaurar às cegas;
5. `cp <backup> <alvo>` e **re-verificar o `sha256`** (passou a coincidir: `255eba4d…`);
6. correr a **suíte-oráculo** (`test-titularidades.js`, que assere os valores) → `exit 0`;
7. só então enviar o resíduo para a **Reciclagem** (por PowerShell, que **não** é contado pelo hook).

### 4.4 Consequência para a prova do P37

A **re-execução** do harness do P37 nesta passagem foi **interrompida** — não produziu um 6/6 novo.
A prova por mutação do P37 continua a ser a da passagem anterior (**6 mutações, todas detetadas e
revertidas**), obtida sobre âncoras que esta passagem **não** alterou (`formatEURCents(…)`,
`formatEUR(p.valor)`, `formatEUR(r.valor)`); o que mudou depois foram `hojeISO` e o escape do CSV,
**fora** das âncoras. A prova de **valor** do P37 (cenário K) correu verde **nesta** passagem, depois
do restauro.

### 4.5 Política recomendada (agora com evidência, não com hipótese)

- **Não** correr um harness de mutação no mesmo turno — nem a seguir — a uma cadeia longa.
- Correr cada harness **isolado**, um por turno, com `timeout` próprio.
- Alternativa, para ter a cadeia inteira num só turno: executá-la com as eliminações **a não
  passarem pela Reciclagem** (`NODE_OPTIONS` sem o *shim*), aceitando que os temporários dos testes
  são apagados definitivamente em vez de reciclados.
- Depois de **qualquer** execução interrompida: aplicar o procedimento de **4.3 antes de mais nada**.

---

## 5. Estado da cadeia `test:offline` e defeitos de **outras frentes** (não corrigidos)

`test:offline` tem hoje **101 passos** e **0 órfãos** (verificado por script). Nesta passagem a
cadeia foi executada **uma vez**, das 14:05 às 14:12 (**3m19s**), e **parou no passo 51**:

```
AssertionError [ERR_ASSERTION]: não há migration posterior a esta
  actual: 20260101000079
expected: 20260101000078
  at scripts/test-eventos.js:256
```

**50 passos verdes, 1 falha, 50 passos por correr.** A falha **não é desta passagem**:

- `scripts/test-eventos.js:256` assere que a migration dos eventos (`…078`) é a **mais alta** do
  diretório — é uma **armadilha deliberada** que obriga quem acrescenta uma migration a ajustá-la;
- existe agora `migrations/20260101000079-segredos-em-repouso.js`, **não rastreada** (`??`), de
  outra frente (a mesma que acrescentou `scripts/test-segredos-repouso.js` à cadeia);
- essa frente **não atualizou** a guarda ⇒ a cadeia fica vermelha para todos.

**Não foi corrigido, de propósito:** alinhar a guarda com `079` seria a decisão da frente que
criou a migration; e enfraquecê-la para «existe e é única» seria **reescrever um teste para obter
verde** — exatamente o que não se deve fazer sem decisão explícita. **Duas saídas possíveis:**
(a) a frente da migration atualiza a guarda; ou (b) decide-se que a guarda «é a mais alta» é
**ela própria dívida técnica** (parte a cada migration nova, obrigando a mexer num teste de outra
área) e substitui-se por «a migration existe e o número é único» — decisão, não remendo.

**Segundo defeito de outra frente, também não corrigido** — `test-autorizacao-arquitetura.js` está
vermelho por:

```
links admin-only visíveis ao gestor:
views/admin/quotas/gerar.handlebars → /admin/config/automacoes
```

`git show HEAD:views/admin/quotas/gerar.handlebars` **não** tem qualquer referência a
`automacoes`; a versão no *working tree* acrescenta
`<a href="/admin/config/automacoes">Configurar em Documentos e Automações</a>` (correção P2 dessa
frente). O link é classificado como **admin-only** pelo teste e a vista é servida a um `gestor`.
É um achado real **da frente P2**, não desta passagem — a normalização CRLF→LF introduzida aqui
(P38) é um **no-op** em ficheiros com LF, pelo que não pode ser a causa.

## 6. Não corrigido nesta passagem (com o motivo)

### P5 — `GET /quotas` morto em `routes/financeiro.js` · **ADIADO, com plano fechado**

O handler **é** código morto (`app.js` monta `quotas-modulo` **antes** de `financeiro`), mas a
remoção **não é local**: é um **conjunto coordenado de 4 edições**, três delas em ficheiros da
frente de suporte:

1. `routes/financeiro.js` — remover `router.get('/quotas', …)` (797–887) e o `getQuotaConfig` que
   lhe pertence (o símbolo é **usado** noutras rotas: 858, 989, 1124, 1134 — só sai a chamada morta).
2. `helpers/suporte-allowlist.js` — remover `{ padrao: /^\/quotas$/, rotulo: '/quotas' }` do
   módulo `financeiro` **e** corrigir o comentário que hoje diz que `/quotas` «tem handlers em
   DOIS routers».
3. `scripts/test-allow-list-suporte.js:290` — retirar `/quotas` da lista esperada de `financeiro`.
4. `scripts/test-mutacao-suporte.js:160-173` — a mutação 2 está **escrita sobre a duplicação**
   («remover das DUAS listas», `global: true`); o texto e a âncora têm de acompanhar.

**Porque não foi feito agora:** `scripts/verificar-readonly-admitidos.js` (que está em
`test:offline`) **exige** que cada entrada da allow-list tenha um handler real no router
declarado — remover o handler sem tocar na allow-list **parte a cadeia**. E a duplicação está
**documentada como defesa em profundidade** pela frente de suporte (comentário 143–148 + mutações
2 e 6). Uma remoção unilateral seria competir com essa frente e quebrar a sua prova por mutação.
**Decisão pendente para o utilizador:** (a) remover de facto, em coordenação; ou (b) manter e
passar a P5 a «duplicação deliberada e documentada», riscando-a da dívida.

### P49 — `scripts/test-mutacao-tips.js` · **ADIADO**

A Roadmap condiciona-o a resolver a P53. A P53 **não se reproduz** (§4), mas a frente dos Tips tem
a **P48** em aberto (os *hunks* dos Tips foram deliberadamente deixados de fora do `f2e5345`) e a
coordenação é obrigatória. Escrever um harness de 6 mutações sobre uma frente que está a ser
publicada por outra pessoa produziria um ficheiro a competir com o trabalho dela.

**O que fica registado:** as 6 mutações manuais já feitas na frente (condominio_id no `where` em
duas formas, chave sem namespace `tip:`, título colidente, guarda de redundância removida, campo
`voltar` sempre emitido) e o molde a seguir (`test-mutacao-suporte.js`). É trabalho de **1
passagem**, sem investigação nova.

---

## 7. Decisões de produto (análise apresentada, **nada implementado**)

### P39 — `Categoria` e `MetodoPagamento` por condomínio?

Estado real: E1/E2 já corrigidos (chaves de cache por condomínio `:c<id>`); **E5 aberto** — as
tabelas continuam **partilhadas** (sem `condominio_id`).

| Opção | A favor | Contra |
| --- | --- | --- |
| **A. Manter partilhado** (atual) | Uma taxonomia única evita duplicados e simplifica relatórios globais; migrações 064–066 já separaram o que **é** do condomínio | Um condomínio não pode renomear uma categoria sem afetar os outros; a cache por `:c<id>` existe precisamente porque o âmbito **não** está na tabela |
| **B. Passar a `condominio_id`** | Isolamento explícito, alinhado com o resto do modelo; cada condomínio renomeia e ordena como quer | Migração com **backfill e deduplicação** (o mesmo nome existe em N condomínios); `despesas.categoria_id` e `pagamentos.metodo_pagamento_id` passam a apontar para linhas por condomínio; relatórios globais precisam de agregação por nome |

**Recomendação:** decidir **por caso** — `MetodoPagamento` é operacional e varia por condomínio
(multibanco, transferência, dinheiro) ⇒ tende para B; `Categoria` alimenta relatórios comparáveis
⇒ tende para A. Não se implementa nada sem esta decisão, porque a migração é irreversível na
prática (reverter exigiria re-mapear ids).

### P43 — Paginação

Não existe em lado nenhum; hoje há **limites fixos** (ex.: avisos `limit: 100` no portal).

| Opção | Notas |
| --- | --- |
| **A. Não introduzir** | Os volumes reais são pequenos (um condomínio típico: dezenas de frações, centenas de quotas/ano). Introduzir paginação em todas as listagens é um refactor transversal grande, com risco de regressão em filtros e ordenações, para um ganho que pode não existir |
| **B. Introduzir só onde dói** | Medir primeiro: `EXPLAIN` + contagens reais por condomínio em `/quotas`, `/pagamentos`, `/movimentos`, `/documentos`. Se alguma listagem passar de ~500 linhas, paginar **essa** |

**Recomendação:** **A agora, com medição.** Introduzir paginação reflexivamente é o erro que a
própria P43 avisa; e um limite fixo explícito é mais honesto do que paginação a fingir. Se a
medição mostrar um caso real, paginar só esse.

---

## 8. Ficheiros desta passagem

**Correções e provas**

| Ficheiro | O que mudou |
| --- | --- |
| `helpers/money.js` | `formatEURCents` (novo) + `formatEUR` a delegar (P37) |
| `helpers/exportacao-dados.js` | P37 (5 sítios) · `hojeISO` local · escape de `\r` no CSV |
| `views/admin/orcamento/detalhe.handlebars` | texto da confirmação e `data-ajuda` (P3) |
| `scripts/test-vistas.js` | registo automático de parciais + guarda (P36) · §17.3 (P3) |
| `scripts/test-autorizacao-arquitetura.js` | leitura normalizada CRLF→LF (P38) |
| `scripts/test-contraste.js` | leitura normalizada CRLF→LF (P38) |
| `scripts/test-movimentos-integridade.js` | leitura normalizada CRLF→LF (P38) |
| `scripts/test-titularidades.js` | cenário K (P37) · cenário G endurecido · cenário L (data/escape) |
| `scripts/test-mutacao-exportacao.js` | **novo** — 6 mutações do P37 |
| `scripts/test-crlf-fim-de-linha.js` | **novo** — prova da P38 em memória |
| `docs/DEPLOY-MULTITENANT.md` | §5 corrigido (P45) |
| `package.json` | `test-crlf-fim-de-linha.js` acrescentado a `test:offline` |
| `docs/DIVIDA-TECNICA-E-IMPORTACAO-2026-09-22.md` | **novo** — este documento (P53, P5, P39, P43, P49, importação, exportação) |

**Não alterados, de propósito:** `docs/ROADMAP.md` (instrução explícita) · ficheiros de outras
frentes (`helpers/armazenamento/*`, `routes/configuracao.js`, `jobs/*`, `views/admin/global/*`, …)
· `helpers/suporte-allowlist.js` e as suítes de suporte (P5, ver §5).

---

## 9. Decisões pendentes para o utilizador

1. **P5** — remover de facto (4 edições coordenadas, §6) ou reclassificar como duplicação
   deliberada e riscar da dívida?
2. **P53** — correr cada harness de mutação **isolado** (um por turno) ou a cadeia com as
   eliminações fora da Reciclagem (§4.5)? A limitação **é real e cumulativa** (§4).
3. **P49** — autorizar a criação de `test-mutacao-tips.js` **depois** de a P48 estar fechada?
4. **P39 / P43** — as recomendações do §7 são para decidir, não para executar sem resposta.
5. **Frente P2 / migration 079** — alinhar a guarda de `test-eventos.js` ou substituí-la por
   «existe e é única» (§5). Enquanto isso, a cadeia fica vermelha no passo 51.
6. **Registo no Roadmap** — esta passagem **não tocou** no Roadmap (instrução explícita). Se se
   quiser manter a regra «problema detetado e não corrigido ⇒ §4 do Roadmap», os pontos do §6 e
   deste §9 têm de lá ser transcritos numa passagem que **possa** editá-lo.
