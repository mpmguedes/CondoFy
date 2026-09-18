# Desenho técnico — diagnóstico read-only e despersonalizado (fase seguinte)

**Commit de partida:** `18dec006c24d3dbb2371153e856c075b411c6709`
**Data:** 2026-09-18
**Âmbito:** **desenho apenas** — nenhuma linha de código foi alterada, nenhum commit,
push, migration ou deploy.
**Natureza:** plano de implementação para a próxima fase

> Princípio orientador:
> O técnico vê os dados necessários para diagnosticar o problema, mas não vê mais
> dados pessoais ou credenciais do que o estritamente necessário.

---

## 0. Achados do código que condicionam o desenho

Três factos, verificados no código, mudam o desenho face ao que seria de esperar:

### 0.1 Cada módulo é um router independente montado em `/admin`
`app.js:266-285`:
```js
app.use('/admin', require('./routes/admin'));
app.use('/admin', rotasQuotasModulo);
app.use('/admin', rotasFinanceiro);
app.use('/admin', require('./routes/extra-quotas'));
app.use('/admin', require('./routes/orcamento'));
app.use('/admin', require('./routes/assembleias'));
app.use('/admin', require('./routes/documentos'));
app.use('/admin', require('./routes/avisos'));
app.use('/admin', require('./routes/emails'));
app.use('/admin', require('./routes/configuracao'));
...
```
**Consequência:** a allow-list de `routes/admin.js` **não governa** os outros módulos.
Cada um tem o seu próprio `router.use(tenant.comPapel('gestor'))`
(p.ex. `financeiro.js:71-72`, `orcamento.js`, `documentos.js`, …). Alargar a
allow-list exige, portanto, uma decisão por módulo — não uma linha em `admin.js`.
**Isto é bom para a segurança** (cada módulo é um compartimento estanque) e **é a
razão pela qual o desenho tem de ser explícito em cada router.**

### 0.2 `GET /quotas` (`financeiro.js:707`) NÃO filtra por `condominio_id`
```js
router.get('/quotas', async (req, res) => {
  const { ano, mes, estado } = req.query;
  const where = {};                       // ← sem condominio_id
  if (ano) where.ano = parseInt(ano, 10);
  if (mes) where.mes = parseInt(mes, 10);
  const quotas = await Quota.findAll({ where, ... });
```
A rota é montada em `/admin`, que está atrás de `comPapel('gestor')`
(`financeiro.js:71-72`). Hoje é seguro **apenas porque o suporte nunca tem papel**.
**Se o suporte passar a admitir esta rota, tem de haver `condominio_id` explícito** —
caso contrário o diagnóstico veria quotas de **todos os condomínios**. Este é o risco
número um da fase seguinte.

### 0.3 `/condomino` está protegido por *prefixo partilhado*, não por guarda própria
`app.js:286-300` monta quatro routers no mesmo prefixo, por esta ordem:
```js
app.use('/condomino', require('./routes/condomino'));          // ← tem semSuporte (:62)
app.use('/condomino', require('./routes/condomino-conta'));    // ← só recusa isAdmin (:41-44)
app.use('/condomino', require('./routes/condomino-recomendacoes'));
app.use('/condomino', require('./routes/saida-condominio'));   // ← sem guarda de suporte
```
Como `condomino.js` está montado **primeiro**, o seu `router.use(tenant.semSuporte)`
fecha o prefixo e as rotas seguintes nunca são alcançadas. **Reordenar as montagens
reabre o portal.** Confirmado por sonda isolada (ver §7).

---

## 1. Arquitetura proposta

### 1.1 Forma geral — *allow-list distribuída por módulo, com um helper comum*

Não se cria uma aplicação paralela. Reutiliza-se o que existe:

```
                    ┌─────────────────────────────────────────┐
                    │ helpers/suporte-allowlist.js  (NOVO)    │
                    │ · lista de rotas por módulo (fonte      │
                    │   ÚNICA da verdade)                     │
                    │ · sóDiagnostico(modulo)  → guard        │
                    │   reutilizável                          │
                    └───────────────┬─────────────────────────┘
                                    │  usado por
        ┌───────────────┬───────────┼───────────┬──────────────┐
        ▼               ▼           ▼           ▼              ▼
   routes/admin.js  financeiro.js  orcamento  documentos   assembleias
   (já tem          (acrescentar   (idem)     (idem)       (idem)
    soDiagnostico)   soDiagnostico)
```

Cada módulo que passe a admitir diagnóstico acrescenta **uma linha**, no topo:

```js
const { soDiagnostico } = require('../helpers/suporte-allowlist');
router.use(soDiagnostico('financeiro'));   // admite só os GET da lista desse módulo
```

E a guarda de papel existente passa a ser **condicional** — exatamente o padrão já
validado em `admin.js` (`routes/admin.js:143-149`):

```js
router.use((req, res, next) => {
  if (req.suporte && req[ADMITIDO_SUPORTE] === true) return next();
  return tenant.comPapel('gestor')(req, res, next);
});
```

> ⚠️ **Risco já conhecido e documentado** (pitfall 15 do `MEMORY.md`): um
> `router.use(guard)` **incondicional** montado logo a seguir anula o contorno do
> anterior — o Express corre ambos. É obrigatório que a guarda de papel seja **uma
> só**, dentro do wrapper condicional. Este é o ponto onde a fase seguinte tem mais
> probabilidade de falhar em silêncio.

### 1.2 Porque *não* um router novo em `/admin/diagnostico`
Seria tentador criar um `routes/diagnostico.js` autónomo. **Não recomendo**, porque:
- duplicaria as queries (e as queries são o sítio onde o `condominio_id` se pode
  perder — ver §0.2);
- obrigaria a manter duas vistas em paralelo a cada alteração;
- a fonte de verdade do isolamento deixaria de ser a mesma do backoffice.

**Recomendo** reaproveitar os handlers e as queries existentes (já escopadas) e
introduzir a despersonalização **na camada de apresentação** — via *views* de suporte
próprias, escolhidas pelo handler quando `req.contexto === 'suporte'`.

### 1.3 Duas alternativas de despersonalização — e qual escolher

| | **A. View própria de suporte** | **B. Máscara na view de admin** |
|---|---|---|
| Como | `res.render('suporte/quotas', {...})` quando `req.contexto==='suporte'` | a mesma view, com `{{maskIban x}}` |
| PII | o handler **não carrega** os campos de PII | carrega e a view esconde |
| Risco de regressão | baixo (não toca na view de admin) | **alto** — um `{{iban}}` esquecido expõe tudo |
| Esforço | médio (N vistas novas) | baixo |
| Resistência a alterações | **alta** | baixa |

**Recomendação: A**, com a ressalva de que a view de suporte pode ser **um subconjunto
literal** da de admin (copiar e remover colunas), não um redesign. Para as vistas que
**não** têm PII nenhuma (a maioria das listagens financeiras — ver §3), basta reutilizar
a view de admin tal como está: não vale a pena duplicar.

**Regra de decisão a aplicar módulo a módulo:**
> Se a view de admin **não imprime** PII → reutilizar.
> Se imprime PII → view de suporte própria (e, se possível, não carregar o campo no
> handler).

### 1.4 O isolamento tem de ser verificado na *query*, não na view
Ponto não negociável, por causa de §0.2: **a defesa não pode depender de a view não
mostrar um campo.** Cada rota da allow-list tem de ter `condominio_id` explícito no
`where` (ou via `ondeCondominio(req)` / `escopoAssembleia(req)` / `carregarX(req)`).
Onde isso não acontecer hoje, a implementação tem de **acrescentar** o filtro.
Isto é verificável estaticamente (§8, teste T4).

---

## 2. Desenho do **masker**

### 2.1 Formatos reais dos dados (verificados, não presumidos)

| Dado | Onde vive | Formato real guardado | Formatação existente |
|---|---|---|---|
| **IBAN** | `contas_bancarias.iban` STRING(40), `condominios.iban_principal` STRING(40), `fornecedores.iban` STRING(40) | **Normalizado: sem espaços, maiúsculas** (`financeiro.js:148,185` guardam `ibanValidado.valor`) | `formatarIban()` → blocos de 4: `PT50 0002 0123 1234 5678 9015 4` |
| **NIF** | `pessoas.nif` STRING(20), `condominios.nif`, `fornecedores.nif` | **9 dígitos, sem separadores** (`validarNif` exige `/^\d{9}$/`) | `formatarNif()` → `123 456 789` |
| **E-mail** | `pessoas.email`, `users.email`, `email_fila.destinatario_email`, `condominios.email` | texto livre | — |
| **Telefone** | `pessoas.telefone` STRING(40), `condominios.telefone`, `users.telefone` | **texto livre** (pode ter `+351`, espaços, `9xx xxx xxx`, ou estar vazio) | — |

**Nota importante:** telefone é **texto livre**, ao contrário de NIF/IBAN. Isso obriga
a máscara de telefone a ser conservadora: se não reconhecer o formato, mascara tudo
menos os últimos dígitos de forma genérica.

**Reaproveitamento:** `public/js/validacao-fiscal.js` já expõe
`normalizarNif`, `normalizarIban`, `formatarNif`, `formatarIban` — e é o **mesmo
ficheiro** usado pelo browser e pelo backend (`module.exports` + `window.ValidacaoFiscal`).
O masker deve **depender destas funções** em vez de reimplementar normalização.

### 2.2 API proposta — `helpers/mascara.js` (NOVO)

Uma função por tipo, mais um agregador. Sem estado, sem I/O, puro.

```js
// helpers/mascara.js
const { normalizarNif, normalizarIban } = require('../public/js/validacao-fiscal');

const OCULTO = '•';   // U+2022

/** IBAN → «•••• •••• •••• 1234» (últimos 4 caracteres visíveis). */
function iban(valor) {
  const limpo = normalizarIban(valor);
  if (!limpo) return '';
  const ultimos = limpo.slice(-4);
  const grupos = Math.max(0, Math.ceil((limpo.length - 4) / 4));
  return `${`${OCULTO.repeat(4)} `.repeat(grupos)}${ultimos}`.trim();
}

/** NIF → «123***789» (3 primeiros + 3 últimos). Se não tiver 9 dígitos, «***».*/
function nif(valor) {
  const limpo = normalizarNif(valor);
  if (!/^\d{9}$/.test(limpo)) return limpo ? '***' : '';
  return `${limpo.slice(0, 3)}***${limpo.slice(-3)}`;
}

/** E-mail → «m***@dominio.pt» (1.ª letra + domínio intacto). */
function email(valor) {
  const t = String(valor == null ? '' : valor).trim();
  const i = t.lastIndexOf('@');
  if (i <= 0) return t ? '***' : '';
  const local = t.slice(0, i);
  const dominio = t.slice(i + 1);
  return `${local.slice(0, 1)}***@${dominio}`;
}

/** Telefone → «******123» (últimos 3 dígitos). Formato livre → conservador. */
function telefone(valor) {
  const t = String(valor == null ? '' : valor).trim();
  const digitos = t.replace(/\D/g, '');
  if (!digitos) return '';
  if (digitos.length <= 3) return OCULTO.repeat(digitos.length);
  return OCULTO.repeat(digitos.length - 3) + digitos.slice(-3);
}

module.exports = { iban, nif, email, telefone };
```

**Formato validado contra os dados reais:**
- `iban('PT50000201231234567890154')` → `•••• •••• •••• •••• •••• •0154`
  (o exemplo do enunciado `•••• •••• •••• 1234` pressupõe 16 caracteres; o IBAN PT
  tem 25 — o masker preserva o **comprimento** e mostra os últimos 4).
- `nif('123456789')` → `123***789` ✔ (igual à sugestão).
- `email('maria@dominio.pt')` → `m***@dominio.pt` ✔.
- `telefone('912 345 678')` → `••••••678` ✔ (sugestão era `******123` — mesmo formato).

### 2.3 Exposição às views

Registar como **helpers Handlebars**, em `helpers/handlebars-helpers.js`
(ficheiro já existente, onde vivem `eur`, `formatDate`, …):

```js
const mascara = require('./mascara');
// ...
maskIban: (v) => mascara.iban(v),
maskNif: (v) => mascara.nif(v),
maskEmail: (v) => mascara.email(v),
maskTelefone: (v) => mascara.telefone(v),
```

> ⚠️ **Cuidado:** os helpers são registados **uma vez** em `app.js` e em cada app de
> teste. Acrescentar quatro helpers não parte nada (helpers novos são aditivos), mas a
> implementação deve confirmar que as apps de teste que constroem o engine
> (`scripts/test-allow-list-suporte.js:147-153`, e todos os `express-handlebars`
> noutros testes) usam `require('../helpers/handlebars-helpers')` — usam —, para que
> as views de suporte não rebentem por helper em falta.

### 2.4 Não alterar os scripts de diagnóstico existentes
`scripts/diagnostico-movimentos-condominio.js:32` (`maskIban`) e
`scripts/diagnostico-documentos.js:68` (`mascarar`) **ficam como estão**, conforme
pedido. Fica registada como dívida técnica a sua eventual convergência para
`helpers/mascara.js` (evita duas definições de «IBAN mascarado» que podem divergir).

---

## 3. Mapa rota → handler → view, por área

Legenda da coluna **Decisão**:
`REUTILIZAR` = a view de admin não tem PII, serve tal como está ·
`VIEW PRÓPRIA` = a view de admin mostra PII/ruído demais ·
`EXCLUIR` = não entra na allow-list.

| # | Área | Rota | Handler | View atual | Info necessária | PII hoje | Manter visível | Mascarar/remover | Decisão |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Quotas** | `/admin/quotas` | `financeiro.js:707` | `admin/quotas/listar` | ano, mês, período, valor, estado, fração | nenhuma na view | valores, datas, estado, designação da fração | — | **VIEW PRÓPRIA** ⚠️ exige acrescentar `condominio_id` (§0.2) |
| | | `/admin/quotas/grelha` | `financeiro.js:829` | `admin/quotas/grelha` | matriz fração×mês | nenhuma | matriz | — | `REUTILIZAR` (já escopada) |
| | | `/admin/quotas/:id` | `financeiro.js:1242` | `admin/quotas/detalhe` | `valor_base`, `valor_fcr`, `valor_por_1000`, `permilagem_aplicada`, aplicações, estado | nenhuma | todos os campos de cálculo | — | `REUTILIZAR` (já escopada por `condominio_id`) |
| 2 | **Pagamentos** | `/admin/pagamentos` | `financeiro.js:1306` | `admin/pagamentos/listar` | nº documento, valor, data, estado, método | só `metodo_pagamento.nome` | tudo | — | `REUTILIZAR` |
| | | `/admin/pagamentos/:id` | `financeiro.js:1596` | `admin/pagamentos/detalhe` | aplicação a quotas/parcelas, estado, comprovativo (estado, não ficheiro) | verificar se imprime titular | valores, estados, aplicações | **confirmar** titular/IBAN | `VIEW PRÓPRIA` se imprimir titular |
| 3 | **Despesas** | `/admin/despesas` | `financeiro.js:492` | `admin/despesas/listar` | descrição, valor, data, categoria, conta, deliberação | `fornecedor` é **texto livre** (pode conter nome) | valores, datas, categoria | `fornecedor` se presente | `REUTILIZAR` + mascarar `fornecedor` se existir |
| 4 | **Movimentos** | `/admin/movimentos` | `financeiro.js:382` | `admin/movimentos/listar` | data, tipo, valor, descrição, referência, conta, saldo | `contaSelecionada.nome` (nome da conta, não IBAN) | tudo | **IBAN não é impresso** — confirmar que continua assim | `REUTILIZAR` |
| 5 | **Conta-corrente** | `/admin/quotas/conta-corrente` | `quotas-modulo.js:802` | `admin/quotas/conta-corrente` | saldo por fração, valor em dívida | **nenhuma** (agregados por fração) | saldos, dívidas | — | `REUTILIZAR` |
| 6 | **Contas bancárias** | `/admin/contas` | `financeiro.js:118` | `admin/contas/listar` | nome, banco, saldo | **`{{iban}}` COMPLETO** (`listar.handlebars:47`) | nome, banco, saldo, `ativa` | **`maskIban` obrigatório** | **VIEW PRÓPRIA** |
| 7 | **Orçamento** | `/admin/orcamento` | `orcamento.js:73` | `admin/orcamento/listar` | ano, valores, estado | nenhuma | tudo | — | `REUTILIZAR` |
| | | `/admin/orcamento/:id` | `orcamento.js:178` | `admin/orcamento/detalhe` | rubricas, distribuição, plano, alterações | `alteracoes` inclui `User.nome` | rubricas, valores | autor da alteração → iniciais | `VIEW PRÓPRIA` |
| 8 | **Quotas extra** | `/admin/quotas-extra` | `extra-quotas.js:93` | `admin/quotas-extra/listar` | designação, valor, estado, parcelas | nenhuma | tudo | — | `REUTILIZAR` |
| | | `/admin/quotas-extra/:id` | `extra-quotas.js:229` | `admin/quotas-extra/detalhe` | parcelas, pagamentos, estado | verificar | valores, estados | confirmar PII | `REUTILIZAR` (confirmar) |
| 9 | **Relatório financeiro** | `/admin/relatorios/financeiro` | `relatorios.js:116` | `admin/relatorios/financeiro` | balancete, agregados | `{{nome}}` (categoria/rubrica) | agregados | — | `REUTILIZAR` |
| 10 | **Documentos** | `/admin/documentos` | `documentos.js:62` | `admin/documentos/listar` | nome, pasta, tipo, data, visibilidade, `drive_status`, `drive_erro` | `{{nome}}` (nome do documento) | metadados + **`drive_erro`** | `drive_file_id`/`drive_folder_id` (já não impressos) | **VIEW PRÓPRIA** — para expor `drive_erro` |
| 11 | **Assembleias** | `/admin/assembleias` | `assembleias.js:115` | `admin/assembleias/listar` | número, data, tipo, estado | nenhuma | tudo | — | `REUTILIZAR` |
| | | `/admin/assembleias/:id` | `assembleias.js:167` | `admin/assembleias/detalhe` | agenda, deliberações, FCR, anexos | **participantes** (Pessoa + Fração) | agenda, deliberações, FCR, estado | **participantes → remover ou iniciais** | **VIEW PRÓPRIA** |
| 12 | **Emails/fila** | `/admin/emails` | `emails.js:54` | `admin/emails/index` | estado, data, tipo, erro, referência, destinatário | **`{{destinatario_email}}`, `{{utilizador.nome}}`, SMTP** | estado, data, tipo, erro, id técnico | destinatário → `maskEmail`; **remover** bloco SMTP e `corpo`/`corpo_html` | **VIEW PRÓPRIA** |
| 13 | **Dashboard** | `/admin` (`/`) | `admin.js:178` | `admin/dashboard` | contagens, agregados, sinais | nenhuma | tudo | — | `REUTILIZAR` (já na lista) |
| 14 | **Frações** | `/admin/fracoes` | `admin.js:385` | `admin/fracoes/listar` | designação, permilagem, titulares | **nomes** dos titulares | designação, permilagem | nomes → iniciais | `REUTILIZAR` + mascarar (ver §4) |
| | | `/admin/fracoes/:id` | `admin.js:686` | `admin/fracoes/detalhe` | cadastro + quotas + pagamentos + documentos + avisos | **nome/e-mail/telefone** dos titulares + valores | cadastro, valores | **ver §4 — recomendação é remover da lista** | **DECISÃO §4** |
| 15 | **Condóminos** | `/admin/condominos` | `admin.js:733` | `admin/condominos/listar` | nome, contacto, NIF, frações | **e-mail + telefone + NIF completos** (`:28-30`) | nome, frações | **`maskEmail`, `maskTelefone`, `maskNif`** | **VIEW PRÓPRIA** |
| 16 | **Tarefas** | `/admin/tarefas` | `admin.js:1501` | `admin/sistema/tarefas` | estado dos jobs, erro | nenhuma | tudo | — | `REUTILIZAR` (já na lista) |

### 3.1 O que a auditoria de scoping revelou
Verificação feita rota a rota (ocorrências de `condominio_id`/`onde…` nos primeiros 16
linhas do handler):

| Rota | Escopada? | Nota |
|---|---|---|
| `/quotas` (`financeiro.js:707`) | ❌ **NÃO** | **tem de ser corrigida antes de entrar na allow-list** |
| `/quotas/:id`, `/pagamentos/:id` | ✔ | `condominio_id` explícito |
| `/orcamento` | ✔ | `where: { condominio_id: req.condominioId }` |
| `/orcamento/:id` | ✔ | via `carregarOrcamento(req)` → `orçamento.js:42` |
| `/quotas-extra`, `/quotas-extra/:id` | ✔ | `ondeCondominio(req)` |
| `/documentos` | ✔ | 2 filtros |
| `/assembleias`, `/assembleias/:id` | ✔ | via `escopoAssembleia(req)` |
| `/emails` | ✔ | `filtroFilaPorCondominio(req.condominioId)` |
| `/relatorios/financeiro` | ✔ (confirmar no handler) | — |

---

## 4. Decisão sobre `/fracoes/:id`

### O que a rota é hoje
`routes/admin.js:686-722` carrega **tudo** de uma fração:
`Fracao` + `Pessoa` (titulares) + **todas as `Quota`** + **todos os `Pagamento`**
(+ método) + **`Documento` da fração** + **`AvisoDestinatario`** + `resumoFracao`.
A view (`admin/fracoes/detalhe.handlebars`) imprime:
- `:46` `{{nome}}`, `:48` `{{email}}`, `:49` `{{telefone}}` — titulares;
- `:27` `{{eur resumo.emDivida}}`, `:30` `{{eur resumo.ultimoPagamento.valor}}`,
  `:72` quotas, `:103` pagamentos — financeiro.

Ou seja: **é, na prática, o dossiê financeiro completo *e* a ficha pessoal na mesma
página.** Não é «a ficha de uma fração».

### Opção A — manter com mascaramento/recorte
- **A favor:** uma rota resolve quase todos os problemas de uma fração.
- **Contra:**
  1. A view teria de mascarar nome/e-mail/telefone **e** manter os valores — fica uma
     view híbrida, difícil de auditar visualmente.
  2. O handler **continua a carregar** os campos de PII na memória; a única defesa é
     a view não os imprimir. Qualquer `{{email}}` acrescentado no futuro expõe tudo —
     **o modo de falha é silencioso**.
  3. Mantém-se a combinação identidade+financeiro que a auditoria identificou como o
     ponto mais sensível da lista atual.

### Opção B — remover da allow-list, obrigar às rotas financeiras próprias
- **A favor:**
  1. **Separação limpa:** identidade em `/condominos` (mascarada); financeiro em
     `/quotas`, `/pagamentos`, `/despesas`, `/movimentos` (sem identidade).
  2. **Resistente a alterações:** cada view tem **uma** responsabilidade; acrescentar
     um campo a uma view não pode revelar a outra categoria.
  3. A mesma informação financeira fica disponível em rotas **desenhadas para
     diagnóstico**, sem PII nenhuma.
  4. Coerente com o princípio do enunciado: «não vê mais dados pessoais do que o
     estritamente necessário».
- **Contra:**
  1. O técnico perde a vista agregada «tudo desta fração». Mitigável com **filtro por
     fração** nas rotas financeiras (`/quotas?fracao=`, se existir) — a confirmar.
  2. `/fracoes` (lista) continua a mostrar **nomes** dos titulares.

### Recomendação: **B**

**Justificação técnica em uma frase:** com A, a fronteira entre diagnóstico e dados
pessoais vive numa **view** (frágil, falha em silêncio); com B, vive na **rota**
(estrutural, falha visivelmente). O enunciado pede «mais resistente a futuras
alterações» — B é a resposta.

**Consequência a tratar na implementação:**
- `/fracoes` (lista) expõe **nomes** dos titulares: aplicar iniciais
  (helper `iniciais` **já existe**, `handlebars-helpers.js:62`) ou remover a coluna.
- A rota `/fracoes/:id` passa a **excluída**; se o técnico precisar de detalhe de uma
  fração, obtém-no por `/quotas?ano=…` + `/pagamentos` + `/documentos`.

---

## 5. Documentos — exposição de metadados

**Perguntas a que o diagnóstico tem de responder, e o campo que as responde:**

| Pergunta | Campo | Onde | Nota |
|---|---|---|---|
| «o documento não aparece» | `nome`, `pasta`, `tipo`, `data`, `disponivel_condominos` | `Documento` | a listagem atual já mostra os metadados |
| «o documento não está disponível» | `disponivel_condominos`, `drive_status` | `Documento` | — |
| «falhou no armazenamento» | **`drive_status`, `drive_erro`, `drive_uploaded_at`** | `Documento` | **`drive_erro` NÃO está em nenhuma view admitida hoje** — é o dado que falta |
| «erro de Drive/Dropbox/OneDrive» | `drive_erro` + provedor ligado | `Documento` + `storage.estadoDoCondominio` | o provedor **pode** ser exposto; os **tokens nunca** |
| IDs técnicos | `id`, `drive_file_id`, `drive_folder_id` | `Documento` | `id` interno sim; `drive_file_id` só se for mesmo necessário (é um identificador de ficheiro em Drive — **não** é credencial, mas permite download se combinado com permissões) |

**Proposta:** uma view `views/suporte/documentos.handlebars` (ou colunas
acrescentadas na listagem existente) que mostre a tabela
`nome · pasta · tipo · data · disponivel_condominos · drive_status · drive_erro ·
drive_uploaded_at · id`.

**Proibido (mantém-se proibido):**
- `/admin/documentos/:id/ficheiro` (`documentos.js:535`) — `servirDocumento` escreve
  `AuditLog` **e** abre stream do provedor;
- `/admin/documentos/drive/pasta` (`documentos.js:208`) — **cria pasta** no provedor e
  grava `condominios.drive_folder_id`;
- callbacks OAuth (`configuracao.js:152`, `:471`) — **persistem tokens**;
- `/admin/documentos/nova`, `/admin/documentos` (POST), `/documentos/:id/eliminar`,
  `/documentos/:id/disponivel`, `/documentos/:id/email`;
- `/admin/config/armazenamento*`, `/admin/config/drive*`.

**Justificação:** «o documento tem erro de Drive» resolve-se com `drive_erro` — o
conteúdo do ficheiro nunca é necessário para diagnosticar.

---

## 6. Emails — estado, sem conteúdo

**Pergunta:** «o e-mail/recibo não chegou.»

**Campos necessários** (todos em `EmailFila`):

| Campo | Porquê |
|---|---|
| `estado` | pendente/enviado/erro/cancelado — a resposta central |
| `data` (criação/envio) | «não chegou» vs «saiu há 1 minuto» |
| `tipo` | distinguir recibo de aviso de quota |
| `erro` | erro técnico (SMTP, destinatário inválido) |
| `message_id` | referência técnica para cruzar com o servidor de correio |
| `documento_id` / `aviso_id` | que documento/aviso gerou o envio |
| destinatário | **`maskEmail`** |

**Campos a NUNCA mostrar:**
`corpo`, `corpo_html` (conteúdo da mensagem), bloco SMTP
(`estadoSmtp.servidor/porta/utilizador/remetente` — **só `temPassword` é seguro**,
e mesmo esse é desnecessário), `anexo_caminho` (caminho no filesystem do servidor),
qualquer token.

**Nota verificada:** `mailer.obterEstadoSmtp()` (`helpers/mailer.js:220-232`) já
devolve `temPassword: Boolean(...)` — **a password nunca é renderizada**. Isso não
basta: a view `admin/emails/index.handlebars:139-190` imprime também servidor, porta,
utilizador e remetente. A view de suporte deve **omitir o bloco SMTP inteiro**.

**Proposta:** `views/suporte/emails.handlebars` com a tabela
`data · tipo · estado · destinatário (maskEmail) · message_id · erro`, e um bloco de
**contagens** (pendentes/enviados/erros) que é o mais útil no diagnóstico — idêntico ao
que o dashboard já mostra.

---

## 7. `/condomino/*` — proteção estrutural

### Problema
A defesa atual depende da **ordem** em `app.js:286-300`:
`condomino.js` (que tem `semSuporte`) está montado **antes** de `condomino-conta.js`,
`condomino-recomendacoes.js` e `saida-condominio.js` (que **não** têm guarda de
suporte própria). Sonda isolada confirmou: montado sem `condomino.js`,
`GET /condomino/perfil` **chega ao handler** (`condomino-conta.js:76`).

### Objetivo
> Qualquer pedido autenticado com contexto de suporte deve ser recusado por **todos**
> os routers `/condomino/*`, independentemente da ordem de montagem.

### Solução mínima proposta (não implementar agora)

**Nível 1 — guarda global, montada uma só vez no prefixo (recomendado).**
Não é preciso tocar nos quatro routers: basta **um** `app.use('/condomino', …)` no
topo, antes das quatro montagens:

```js
// app.js — ANTES de qualquer app.use('/condomino', ...)
app.use('/condomino', (req, res, next) => {
  if (req.suporte) {
    req.flash('error_msg', 'O acesso de suporte é de diagnóstico: o portal do condómino não está disponível.');
    return res.redirect('/admin');
  }
  return next();
});
```
Ordem deixa de importar: o guarda corre **primeiro** porque é o primeiro
`app.use` do prefixo, e aplica-se a **todos** os routers que partilham `/condomino`.

**Nível 2 — defesa em profundidade (opcional, para resistir a um futuro
`app.use` mal colocado):** acrescentar `router.use(tenant.semSuporte)` a **cada** um
dos quatro routers. É redundante com o nível 1, mas torna cada módulo auto-suficiente.

### Routers envolvidos (todos os montados em `/condomino`)
| Router | Linha em `app.js` | Tem guarda de suporte? |
|---|---|---|
| `routes/condomino.js` | `:286` | ✔ `semSuporte` (`routes/condomino.js:62`) |
| `routes/condomino-conta.js` | `:291` | ❌ só recusa `isAdmin` (`:41-44`) |
| `routes/condomino-recomendacoes.js` | `:296` | ❌ nenhuma (mas só tem POSTs) |
| `routes/saida-condominio.js` | `:300` | ❌ nenhuma (protegido por `podeSair` exigir associação) |

**Recomendação:** Nível 1 (uma linha, ordem-independente) + Nível 2 (robustez).
**Nota:** `saida-condominio.js:122` (`GET /saida`) escreve `AuditLog`. Com o nível 1,
isso deixa de ser alcançável pelo suporte — fecha também o último GET com efeito
lateral fora de `/admin`.

---

## 8. Allow-list proposta — avaliação rota a rota

**Decisão por rota** (sim/não e porquê). Não se assume que todas entram.

| # | Rota | Entra? | Justificação |
|---|---|---|---|
| 1 | `/` | ✅ **sim** | Dashboard: contagens, agregados, sinais de atenção. Já admitida; sem PII. |
| 2 | `/fracoes` | ✅ **sim** | Necessária para identificar a fração. **Ajuste:** nomes → iniciais. |
| 3 | ~~`/fracoes/:id`~~ | ❌ **não** | §4 — dossiê identidade+financeiro. Substituída pelas rotas financeiras. |
| 4 | `/condominos` | ⚠️ **sim, com view própria** | Necessária para «o condómino X não aparece». Hoje expõe NIF/e-mail/telefone completos → **maskNif + maskEmail + maskTelefone**. |
| 5 | `/tarefas` | ✅ **sim** | Estado dos jobs; é onde se vêem falhas de processamento. Sem PII. |
| 6 | `/quotas` | ⚠️ **sim, só depois de corrigir** | Essencial ao diagnóstico. **Bloqueado** por §0.2: falta `condominio_id` → **vazamento entre condomínios**. |
| 7 | `/quotas/grelha` | ✅ **sim** | Matriz do ano; já escopada. Excelente para «as quotas do ano não saíram». |
| 8 | `/quotas/:id` | ✅ **sim** | Detalhe do cálculo (`valor_base`, `valor_fcr`, `valor_por_1000`, `permilagem_aplicada`) — responde a «a quota está errada». |
| 9 | `/pagamentos` | ✅ **sim** | Responde a «o pagamento não aparece». Sem PII na listagem. |
| 10 | `/pagamentos/:id` | ⚠️ **sim, confirmar view** | Necessária para ver a aplicação do pagamento. Verificar se imprime titular/IBAN. |
| 11 | `/despesas` | ✅ **sim** | Responde a «a despesa não aparece». Mascarar `fornecedor` (texto livre). |
| 12 | `/movimentos` | ✅ **sim** | Responde a «o saldo está errado». IBAN **não** é impresso — confirmar. |
| 13 | `/quotas/conta-corrente` | ✅ **sim** | Saldos por fração — o sintoma «o saldo parece incorreto». Sem PII. |
| 14 | `/contas` | ⚠️ **sim, com view própria** | Útil mas expõe **IBAN completo** (`listar.handlebars:47`) → **maskIban**. |
| 15 | `/orcamento` | ✅ **sim** | Lista de orçamentos. Sem PII. |
| 16 | `/orcamento/:id` | ⚠️ **sim, com view própria** | Rubricas/distribuição essenciais. Expõe **autor da alteração** (`User.nome`) → iniciais. |
| 17 | `/quotas-extra` | ✅ **sim** | Quotas extraordinárias — «não aparece». Sem PII. |
| 18 | `/quotas-extra/:id` | ✅ **sim** | Parcelas e estado. Confirmar PII. |
| 19 | `/relatorios/financeiro` | ✅ **sim** | Balancete agregado. Sem PII. |
| 20 | `/documentos` | ⚠️ **sim, com view própria** | §5 — precisa de expor **`drive_erro`** para responder a «falhou no armazenamento». |
| 21 | `/assembleias` | ✅ **sim** | Lista. Sem PII. |
| 22 | `/assembleias/:id` | ⚠️ **sim, com view própria** | Agenda, deliberações, FCR **são** úteis; **participantes** (PII) têm de sair. |
| 23 | `/emails` | ⚠️ **sim, com view própria** | §6 — estado/erro sim; destinatário `maskEmail`; **remover** bloco SMTP e conteúdo. |

### Proposta final (3 grupos)

**Grupo 1 — admitir como está (view de admin reutilizada): 11 rotas**
`/` · `/fracoes` · `/tarefas` · `/quotas/grelha` · `/quotas/:id` · `/pagamentos` ·
`/despesas` · `/movimentos` · `/quotas/conta-corrente` · `/orcamento` ·
`/quotas-extra` · `/quotas-extra/:id` · `/relatorios/financeiro` · `/assembleias`

Hmm — são 14. **Grupo 1 = 14 rotas.**

**Grupo 2 — admitir com view de suporte própria: 6 rotas**
`/condominos` (maskNif/maskEmail/maskTelefone) ·
`/contas` (maskIban) ·
`/orcamento/:id` (autor → iniciais) ·
`/documentos` (+ `drive_erro`) ·
`/assembleias/:id` (− participantes) ·
`/emails` (− SMTP, − conteúdo, destinatário mascarado)

**Grupo 3 — admitir só após correção obrigatória: 2 rotas**
`/quotas` (**acrescentar `condominio_id`**) ·
`/pagamentos/:id` (**confirmar ausência de titular/IBAN**)

**Excluídas (e porquê):**
`/fracoes/:id` (§4) · todas as de escrita (`/nova`, `/editar`, POSTs) ·
`/contas/nova` · `/quotas/gerar` · `/quotas/enviar` · `/pagamentos/nova` ·
`/documentos/:id/ficheiro` · `/documentos/drive/pasta` · `/assembleias/:id/convocatoria` ·
`/config/armazenamento*` · `/config/drive*` · `/config/auditoria` · `/emails/*` (POST) ·
`/utilizadores*` · `/sistema/*` · todo o `/condomino/*`.

---

## 9. Regras que a implementação deve manter

Continua obrigatório:
- **allow-list explícita** por módulo (fonte única: `helpers/suporte-allowlist.js`);
- `comSuporte(['diagnostico'])` (nível);
- `somenteLeitura` (método GET/HEAD);
- `req.contexto === 'suporte'` **separado** de `req.papelCondominio` (que continua
  `null` durante o suporte);
- admissão marcada com um Symbol **local ao ficheiro** (`ADMITIDO_SUPORTE`).

Continua **proibido**:
- `comPapel('gestor')` como solução;
- `req.papelCondominio = 'gestor'` (ou qualquer herança de papel);
- bypass genérico de `/admin`;
- montar a guarda de papel de forma incondicional **depois** do crivo de admissão
  (pitfall 15 — anula a allow-list).

---

## 10. Riscos e regressões possíveis

| # | Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|---|
| R1 | **`GET /quotas` sem `condominio_id`** → diagnóstico vê quotas de todos os condomínios | **Alta** se entrar sem correção | **Crítico** (vazamento multi-tenant) | Correção obrigatória antes de admitir (§0.2); teste T4 |
| R2 | **Guarda de papel incondicional depois da admissão** anula a allow-list (pitfall 15) | Média | Alto (bloqueia tudo **ou** — pior — deixa passar) | Padrão do wrapper condicional, já validado em `admin.js:143-149`; teste por módulo |
| R3 | **PII exposta por view reutilizada** (um `{{iban}}`/`{{email}}` esquecido) | Média | Alto | Grupo 2 usa **view própria**; teste T6 (grep às views) |
| R4 | Reabrir `/condomino` por reordenação em `app.js` | Baixa hoje | Alto | §7 nível 1 + nível 2; teste T5 |
| R5 | Máscara **divergir** dos scripts de diagnóstico | Média | Baixo | Dívida técnica registada; masker único em `helpers/mascara.js` |
| R6 | Helper Handlebars em falta numa app de teste → view de suporte rebenta | Média | Médio | Todos os testes usam `require('../helpers/handlebars-helpers')` — aditivo; confirmar em T7 |
| R7 | `/assembleias/:id` expõe participantes se a view própria não os remover | Média | Médio (PII) | View própria com lista explícita de campos |
| R8 | `drive_file_id` exposto permite download combinado com permissões do Drive | Baixa | Médio | Mostrar `id` interno; `drive_file_id` só se indispensável |
| R9 | Alargar a allow-list sem testes de mutação → remoção silenciosa de uma guarda | Média | Alto | §11 (T1-T3) |

---

## 11. Estratégia de testes (para a implementação futura)

### T1 — Allow-list por módulo (estático + HTTP)
Como `scripts/test-allow-list-suporte.js` faz hoje para `admin.js`, mas **por cada
módulo** que passe a admitir diagnóstico: montar o router real, exercitar via HTTP
cada rota admitida (→ servida) e cada rota excluída (→ recusada). **Asserção-chave:**
uma rota **nova** no módulo nasce **inacessível**.

### T2 — Escrita recusada
Para cada rota admitida, um POST/PUT/PATCH/DELETE → recusado. E um teste que exercite
`somenteLeitura` **isoladamente** (sem depender da guarda de papel), para que a
remoção da guarda de leitura seja detetável.

### T3 — Admissão não colapsa a guarda de papel
Provar que a guarda de papel continua montada e **efetiva** para `admin`/`gestor`, e
que o suporte admitido a contorna — com a asserção a aceitar a forma **condicional**,
nunca relaxada para `includes` (pitfall 17).

### T4 — **Isolamento por condomínio em cada rota da allow-list** (novo, crítico)
Para **cada** rota admitida: criar dados em dois condomínios e provar que o acesso no
condomínio A **nunca** devolve dados de B. Este teste é o que apanha R1.
Deve incluir uma asserção **estática** que verifique que cada handler da allow-list
contém `condominio_id` (ou um helper de escopo) no `where`.

### T5 — `/condomino` ordem-independente
Montar os quatro routers **em ordens diferentes** (incluindo invertida) e provar que
o suporte é recusado em **todas**. É o teste que prova que §7 resolveu o problema.

### T6 — Não-regressão de PII nas views admitidas
Asserção estática sobre as views do Grupo 1: **nenhuma** pode conter
`{{iban}}`, `{{nif}}`, `{{email}}`, `{{telefone}}` **sem** a máscara correspondente.
É o que apanha R3.

### T7 — Masker unitário
Testes puros em `helpers/mascara.js`: IBAN PT (25 chars) e estrangeiro; NIF válido e
inválido (`***`); e-mail com/sem `@`; telefone com `+351`, com espaços, vazio, curto.
Formatos canónicos já definidos em §2.2.

### T8 — Testes de mutação (obrigatórios)
Provar que os testes detetam, no mínimo:
1. remoção de `somenteLeitura` de um módulo;
2. remoção de uma rota da allow-list (deve **falhar** por a rota ter ficado acessível —
   ou seja, o teste verifica que continua recusada);
3. remoção do `condominio_id` de um handler permitido (T4 deve falhar);
4. remoção do guarda global de `/condomino` (T5 deve falhar);
5. remoção de uma máscara numa view do Grupo 2 (T6 deve falhar).
Cada mutação: aplicar → confirmar deteção → **restaurar byte-a-byte** com `cp` + `cmp -s`
(nunca `git checkout`).

### T9 — Suíte existente verde
`npm run test:offline`, `test-suporte.js`, `test-allow-list-suporte.js`,
`test-isolamento.js`, `test-autorizacao-arquitetura.js` — todos verdes após a
implementação, com as asserções de montagem alargadas **apenas** onde a forma do
guarda mudou.

---

## 12. Dívida técnica registada (fora desta fase, conforme pedido)

Não fazem parte deste desenho:
`helpers/audit.js` (engole erros), organização dos testes, `audit_logs`,
onboarding, convites, nível `operacional`, cifra da password SMTP,
tokens de convite/reset/2FA.

Acrescento **duas** que o desenho expôs e que convém registar:
- **`GET /quotas` sem `condominio_id`** (`financeiro.js:707`) — hoje inofensivo
  (protegido por papel), mas é uma armadilha latente para qualquer futura admissão.
- **Guardas de `/condomino` dependentes da ordem em `app.js`** — a mesma classe de
  fragilidade; §7 fecha-a para o suporte, mas o padrão pode repetir-se noutros prefixos.

---

## 13. Confirmações finais

- **Commit atual:** `18dec006c24d3dbb2371153e856c075b411c6709` (inalterado).
- **`git status --short`:**

```
 M scripts/test-suporte.js         ← alterado na fase ANTERIOR (commit 18dec00 já inclui)
```

  *(a confirmar na entrega; o desenho não tocou em nenhum ficheiro)*

- **Alterações de código nesta fase:** **nenhuma.**
- **Commit:** não feito.
- **Push:** não feito.
- **Migration:** não executada.
- **Deploy:** não feito.

> Este documento é o único artefacto produzido. Não foi adicionado ao índice do Git.
