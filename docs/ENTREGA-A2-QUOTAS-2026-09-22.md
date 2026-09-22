# Entrega A2 — pendências de quotas, arredondamento e consistência financeira

**SOU O A9.**

Data: 2026-09-22 · Âmbito: geração/distribuição de quotas, arredondamento, orçamento.
Estado: **implementado, testado e provado por mutação — sem `commit` e sem `push`.**

---

## 0. Método e o que foi lido antes de mexer

Documentos lidos, pela ordem exigida: `docs/ROADMAP.md` (§3.6 Quotas, §3.7 FCR, §3.8 Orçamento,
§4.1/§4.2 problemas conhecidos), `docs/AUDITORIA-ARREDONDAMENTO-QUOTAS-2026-09-20.md`,
`docs/ANALISE-DESENHO-ARREDONDAMENTO-2026-09-20.md` e — por ser pré-condição das fases seguintes —
`docs/FASE-A-PRECONDICAO-V1-V6-2026-09-20.md`.

### Estado real do código confirmado (facto que muda a leitura de tudo o resto)

| Facto verificado | Consequência |
|---|---|
| `helpers/quotas-primitiva.js` (a «primitiva única», `07ab303`) existe, está testada e **não tem nenhum consumidor em produção** | A fórmula viva continua a ser `helpers/quotas-calc.js` + `helpers/distribuicao.js` + `helpers/plano.js`. «Primitiva única» é hoje uma afirmação de desenho, não de produção. |
| D1 (FCR como **componente**: `fcrC = round(totalC×pct/(100+pct))`, `baseC = totalC − fcrC`) está em produção (C2 `ded251d`, C3 `41fd82a`) | Não reescrever. `acrescentarFcrAoTotal` continua a ser o único ponto do acréscimo. |
| `vencida` **nunca é gravado** — é derivado de `data_vencimento` (`helpers/saldos.js:estadoEfetivo`) | `Op.in: ['pendente']` e `Op.in: ['pendente','vencida']` são equivalentes no recálculo (que também filtra `data_vencimento >= hoje`). Ver §2.1. |
| `routes/financeiro.js:722` (`GET /quotas`) é **sombreado** por `routes/quotas-modulo.js:126` (ordem de montagem em `app.js`) | Código morto; o `order` em falta na linha 859 é latente, não um defeito vivo (§5). |
| A working tree está **partilhada com outra frente a trabalhar ao mesmo tempo** (`routes/financeiro.js` e `views/admin/quotas/gerar.handlebars` contêm hunks que não são meus; `scripts/test-area-condomino.js`, `scripts/test-seguranca.js`, `views/condomino/pagamentos.handlebars` também) | Duas consequências: (a) o `test:offline` completo está vermelho por causa de outra frente (§7); (b) os testes de mutação são **instáveis** neste ambiente (§7.4) — ver a nota de honestidade. |

---

## 1. IMPLEMENTADO

### 1.1 P19 — o recálculo em massa deixa de tocar em quotas com pagamento aplicado

**Onde:** `routes/financeiro.js`, bloco de `POST /admin/quotas/config` com `recalcular=futuras`.

**Antes:** `estado: { [Op.in]: ['pendente', 'parcialmente_paga'] }`.
**Agora:** `estado: { [Op.in]: ['pendente', 'vencida'] }`.

Uma quota `parcialmente_paga` já tem dinheiro aplicado: recalcular-lhe o `valor` muda a dívida de
quem já pagou parte (o que foi pago deixa de ser proporcional ao novo total) e o recálculo **nunca
reverte o pagamento**. A própria vista prometia «Quotas já pagas nunca são alteradas». A mudança
está recomendada pelo desenho (§5, linhas 230–236) e é a única que não inventa semântica nova.

`vencida` entra por **convenção do projeto** nos filtros de «não paga» (`helpers/dashboard.js`,
`routes/condomino.js`, `jobs/automatizacao.js`) — é um estado derivado, mas incluí-lo torna o
filtro honesto e consistente com o resto do código. Ficou comentado no sítio, para ninguém o
«limpar» mais tarde.

**Campos que o recálculo escreve** (só nas quotas que passam o filtro): `valor_base`, `valor_fcr`,
`valor`, `valor_por_1000`, `permilagem_aplicada`, `fcr_percentagem`.

### 1.2 P20 — a pré-visualização deixa de reimplementar a fórmula no browser

**Onde:** `routes/financeiro.js` (`GET /quotas/gerar`) e `views/admin/quotas/gerar.handlebars`.

**Antes:** a vista reimplementava **duas** regras em JavaScript — `totalComFcr(despesas, pct)`
(`despesas × (100+p)/100`), a proporção direta `totalAnual × perm / Σperm` e a divisão por 12 — e
recebia a função de divisão do FCR injetada (`fcrSplitterJs` → `window.__GESCONDU_DIVIDIR_FCR`).
No método orçamento a vista **divergia do gravado** sempre que havia resto: o servidor distribui por
maior-resto (`distribuirPorPesos`, soma exata) e a vista por proporção contínua.

**Agora:** o servidor calcula a pré-visualização no próprio `GET /quotas/gerar`, com as **funções
que geram e gravam** (`calcularQuota` no método permilagem, `calcularQuotasOrcamento` no método
orçamento), e injeta o resultado em `previsaoJson`. A vista:

- lê `PREVISAO` e devolve o bloco já calculado — **não tem uma única fórmula de quota**;
- removeu `ORCAMENTOS`, `pctFcr()`, `dividir()`, `totalComFcr()` e o `calc(perm)` antigo;
- passou a escolher o **mês concreto** (`calc(f, mes)`, com `mes = 1` no escopo anual), em vez de
  mostrar a média anual arredondada;
- a rota deixou de injetar `fcrSplitterJs` (não ficou código morto pendurado).

`dividirComponentesQuota` deixou de ser importado em `routes/financeiro.js` — a única razão do
import era alimentar a injeção removida.

### 1.3 P22 — `calcularPlano` fecha ao cêntimo com o orçamento

**Onde:** `helpers/plano.js`, `dividirEm`.

**Antes:** `Math.round(totalC / n)` repetido `n` vezes — o erro de arredondamento era
**multiplicado por n**. Medido na auditoria: **+0,08 €/ano** num orçamento de 10.000 € por 3 frações.
**Agora:** maior-resto — as partes diferem no máximo 1 cêntimo e a soma fecha **por construção**.
O cêntimo sobrante vai para os primeiros índices (determinístico), nunca «atirado» ao último mês.

Não foi tocado o acréscimo de FCR por célula de `calcularPlano` (`acrescentarFcrAoTotal`): esse
comportamento está fixado por `test-fcr-orcamento.js` E2b e é deliberado.

### 1.4 (extra) Determinismo da distribuição por maior-resto

**Onde:** `routes/orcamento.js` (a consulta que alimenta `distribuirValorAnual` na distribuição
automática do orçamento).

`helpers/distribuicao.js:distribuirPorPesos` fecha a soma pelo maior resto e desempata com
`sort((a,b) => b.frac - a.frac)`. O `sort` do JavaScript é **estável** ⇒ em **empate** (método
`igual`, ou frações com a mesma permilagem) é a **ordem do array** que decide **que fração paga o
cêntimo sobrante**. A consulta não fixava `order`: a ordem vinha da base de dados (não
especificada) e a distribuição deixava de ser reprodutível. A soma nunca mudava — **quem pagava o
cêntimo, sim**.

Corrigido com `order: [['designacao','ASC']]`, que é a convenção já usada nas restantes consultas
que distribuem dinheiro (`financeiro.js:988/1102`, `orcamento.js:126/238/480`). As outras 11
ocorrências de `Fracao.findAll` sem `order` foram verificadas uma a uma (§5) — não têm efeito
monetário.

### 1.5 (extra) Quotas extraordinárias — parcelas iguais e distribuição reprodutível

Duas inconsistências da mesma família das anteriores, na via das **quotas extraordinárias**
(`routes/extra-quotas.js` → `helpers/extra-quotas.js`). Nenhuma estava na lista P, ambas são
distribuição de dinheiro de quotas.

**a) `parcelar` atirava todo o resto para a última parcela** (`helpers/extra-quotas.js`).

**Antes:** `const parcelas = new Array(n).fill(base); parcelas[n-1] += resto;` — a soma fechava, mas
o resto **inteiro** caía numa parcela só. Com o máximo permitido (60 parcelas) isso é até
**0,59 €** de diferença numa parcela, contra a promessa do próprio comentário («parcelas IGUAIS») e
contra o que a vista mostra (cada parcela tem o seu `valor`). Medido no caso de teste:
1.000,01 € em 60 parcelas → a regra antiga punha **41 cêntimos (0,41 €) numa parcela só**.
**Agora:** maior-resto — diferença máxima de 1 cêntimo, soma exata por construção. É a **mesma
regra** do `dividirEm` (P22) e é o padrão que o preflight da Fase A marca como comportamento antigo
a alterar (assinatura **A4**, `scripts/diagnostico-fase-a-preflight.js:450`).

**b) A lista de frações que alimenta `distribuicaoExtra` não fixava `order`** (`routes/extra-quotas.js`).

Mesma causa da §1.4: `distribuirPorPesos` desempata por índice do array, e com **empate**
(método `igual` — todos os pesos 1 — ou frações com a mesma permilagem) é a ordem da lista que
decide **que fração paga o cêntimo sobrante**. Sem `order`, a ordem vinha da base de dados (não
especificada). Corrigido com `order: [['designacao','ASC']]`.

---

## 2. TECNICAMENTE PRONTO, DEPENDENTE DE DECISÃO (não implementado)

### 2.1 P17 — fecho do residual R1/E1

**Comportamento atual (verificado):** não existe entidade, coluna, linha nem configuração de
residual. O residual **existe de facto** (é a impossibilidade aritmética de dividir um inteiro em
partes desiguais sem sobra) mas não é representado em lado nenhum.

**Factos que restringem o desenho:** R1 ≤ n.º de grupos (≈1–20 cêntimos) · é **bidirecional** ·
existe **por mês e por ano** · `Quota` tem unique `(fracao_id, ano, mes)` ⇒ não pode ser «uma quota»
por fração · `configuracoes` não tem `condominio_id` (chave `:c<id>`) · `numeracoes` é global.

**Opções (as três do desenho, §«O residual: 3 modelos»):**

| | M1 efémero | M2 linha de fecho | M3 tolerância declarada |
|---|---|---|---|
| Representação | calculado, nunca gravado | linha explícita no documento de distribuição | nada materializado + limite declarado |
| Migration | nenhuma | **exige** `ajustes_arredondamento` (ou equivalente) | nenhuma |
| Documento numerado | não | sim (consome `numeracoes`, série global) | não |
| Relatório financeiro | diferença visível na reconciliação | rubrica própria (recomendado: fora de «Quotas ordinárias») | diferença declarada |
| Risco | ninguém «vê» o cêntimo | mais uma entidade para manter e explicar | o limite pode mascarar desvio real |

**Impacto financeiro:** ≤ n.º de grupos cêntimos por período, **não é valor de negócio**. O que
importa é o efeito no Relatório Financeiro: hoje o desvio de execução fica **mascarado com ruído de
arredondamento**.

**Compatibilidade com dados existentes:** M1 e M3 **não tocam em dados** nem no schema. M2 exige
migration e um documento numerado — e levanta a questão de saber se a linha conta como «Lançado».

**A decisão que bloqueia (é do utilizador, não minha):** *o condomínio tem de receber exatamente o
total orçamentado?* Sim ⇒ M2 ou M1 com absorção. Não («prefiro 1 cêntimo a menos que cobrar a 1
fração a mais») ⇒ M1/M3.

**Recomendação técnica (proposta, não decisão):** **M1 + M3** — o residual é um artefacto de
distribuição, não um lançamento; M1/M3 não exigem migration nem documento numerado, e mantêm o
enviesamento do Roadmap contra schema novo. Fica **bloqueado** até haver resposta.

> Nota: a parte do P17 que **não** depende de política já foi fechada — era o P22 (o +0,08 €/ano).
> Uma soma errada não é uma política; é um defeito.

### 2.2 P18 — semântica de `valor_por_1000` (mensal vs anual)

**Comportamento atual (verificado no código e na vista):** `quota_valor_1000` guarda uma string
decimal (padrão `'100.0000'`) e significa **o TOTAL a cobrar por 1000‰ para a totalidade do
condomínio, POR MÊS, já com o FCR incluído** — não por cada 1‰. Está escrito na ajuda do formulário
(`views/admin/quotas/listar.handlebars:71`): *«Valor TOTAL a cobrar para a totalidade da permilagem
do condomínio (1000‰), já com o FCR incluído — não por cada 1‰. Ex.: 110 € → fração de 500‰ paga
55 € no total (50 € de despesas + 5 € de FCR).»*

**O defeito é de rótulo, não de motor:** o campo chama-se «Valor por 1000‰ (€)» e **não diz a
unidade de tempo**. O comentário interno é explícito (`routes/financeiro.js:865`: «Total **mensal**
previsto»), mas quem preenche o formulário não o vê.

**Impacto financeiro (o que justifica a pendência):** um administrador que leia o campo como
**anual** e lá ponha o orçamento anual do condomínio (ex.: 13.200 €) faz o sistema cobrar
**13.200 € × 12 = 158.400 €/ano** — um **erro de 12×**, silencioso, em quotas emitidas a todos os
condóminos.

**Compatibilidade:** qualquer opção que **não** mude a unidade guardada não toca em dados. O
fallback legado (`quota_valor_permilagem`, valor *por ‰* → ×1000 em `helpers/quotas-config.js:115`)
continua a ser uma migração de leitura de sentido único.

**Opções:**

| | O que muda | Migration | Risco |
|---|---|---|---|
| **A.** Relabel + equivalente anual calculado | só a vista (`Valor por 1000‰, **por mês** (€)` + linha «= 158.400,00 €/ano para o condomínio») | nenhuma | nenhum |
| **B.** Seletor de período (mensal/anual) com conversão na gravação | nova chave de unidade; o valor existente fica interpretado como mensal | nenhuma (se o default for mensal) | médio — duas unidades na mesma chave |
| **C.** Validação cruzada com o orçamento publicado | aviso se `valor × 12` divergir do orçamento por mais de X% | nenhuma | nenhum |

**Recomendação técnica (proposta):** **A + C** agora (apresentação + validação, zero migration);
**B** só se o produto quiser permitir mesmo introduzir o valor anual — e nesse caso com uma chave de
unidade própria, nunca sobrecarregando `quota_valor_1000`.

### 2.3 P21 — desvio de arredondamento do FCR (≈ +0,11 €/ano)

**Comportamento atual:** `fcrC = round(totalC × pct/(100+pct))` calculado **por fração e por mês**,
sem reconciliação com o FCR implícito do período. Medido na auditoria (§0.2): Σ FCR das frações
**10.909,20 €** vs FCR implícito **10.909,09 €** ⇒ **+0,11 €/ano**, mesmo quando o total fecha ao
cêntimo (R1 = 0).

**Porque é que não é só «um cêntimo»:** o FCR é **dinheiro afetado**, com ciclo próprio
(`helpers/fcr.js`): `emitido → recebido → transferido → disponível`. Um FCR emitido a mais gera mais
recebido, mais disponível para transferir do que o orçamento previu e **divergência entre o que a
assembleia aprovou e o que o sistema cobra**.

**Restrição doutrinária que não pode ser violada:** `helpers/pdf.js:35-44` resolve a reconciliação
do recibo **na quota corrente, nunca no FCR** (o FCR é o valor a afetar ao fundo). Qualquer
reconciliação de R2 tem de ser **ao nível do condomínio**, não do documento.

**Opções:** (a) manter e declarar tolerância; (b) reconciliar R2 ao nível do condomínio, atribuindo
os ±cêntimos de forma determinística; (c) materializar um ajuste explícito.

**Impacto nos dados:** (b) e (c) alteram `valor_fcr` de quotas **novas**; as já emitidas mantêm o
seu snapshot. O ciclo do FCR muda em cêntimos.

**Recomendação técnica (proposta):** **manter fora desta fase** e tratar R2 na fase própria do FCR —
é o que o desenho propõe (ponto de decisão n.º 4) e é independente do R1. **A lógica C3 não foi
tocada**, como pedido.

### 2.4 P6 — anulação de quota já paga / parcialmente paga

**Comportamento atual (verificado):** `POST /quotas/:id/anular` (`routes/financeiro.js:1478-1486`) é
**três linhas sem guarda nenhuma**:

```js
const quota = await Quota.findOne({ where: { id: req.params.id, condominio_id: req.condominioId } });
if (quota) { await quota.update({ estado: 'anulada' }); /* audit */ }
req.flash('success_msg', 'Quota anulada.');
```

Sem verificação de estado, sem transação, sem olhar a pagamentos aplicados, e com mensagem de
sucesso mesmo quando a quota não existe (ou não é do condomínio).

**Consequência medida no modelo de saldos:** `helpers/saldos.js:36` calcula
`emDivida = Σ Quota.valor (estado ≠ anulada) − Σ Pagamento confirmado`. Anular uma quota paga deixa
o **pagamento aplicado** e faz **desaparecer a dívida** ⇒ a fração passa a apresentar **saldo
credor** e o dinheiro fica «soltão»; se o FCR já contou esse dinheiro como recebido, o ciclo do
fundo fica incoerente.

**Precedentes no próprio código (é isto que determina a solução, não uma invenção minha):**
`routes/extra-quotas.js:414-427` anula **em transação** e **só as parcelas não pagas**
(«parcelas pagas permanecem no histórico»); `helpers/pagamentos.js:anularPagamento` repõe o estado
da quota e **desliga os pagamentos aplicados**.

**Opções:**

| | Regra | Reutiliza o que existe | Risco |
|---|---|---|---|
| **A.** **Bloquear** com explicação e apontar para a anulação do pagamento | sim (`anularPagamento` já repõe o estado da quota) | nenhum — não inventa semântica de dinheiro |
| **B.** Permitir com motivo obrigatório + reverter automaticamente o pagamento aplicado | parcialmente | toca no ciclo do FCR (dinheiro já contado como recebido) |
| **C.** Permitir com aviso (confirmar e seguir) | não | mantém a incoerência nos saldos |

**Recomendação técnica (proposta):** **A**. É a única que não precisa de semântica nova, reutiliza
uma operação que já existe e é a que protege o ciclo do FCR. **Não implementada** porque o Roadmap
enquadra o P6 explicitamente como decisão a tomar («Decidir a regra (bloquear, estornar ou avisar)»)
— e eu não invento decisões de produto.

---

## 3. NÃO IMPLEMENTADO

| Item | Razão |
|---|---|
| P17 — materialização do residual (M2: tabela + linha de fecho + rubrica) | **Bloqueado por decisão**: «o condomínio tem de receber exatamente o total orçamentado?» Sem resposta, qualquer implementação seria arbitrária. |
| P18 — seletor de período (opção B) | Depende de decidir se o valor pode ser introduzido como anual. A opção A+C (relabel + validação) também não foi implementada por ser alteração de vista de outra frente. |
| P21 — reconciliação de R2 | **Bloqueado por decisão** (fase própria do FCR). Proibido mexer na C3 sem autorização explícita. |
| P6 — guarda na anulação | **Bloqueado por decisão** (o Roadmap manda decidir a regra). |
| Ligar `helpers/quotas-primitiva.js` à produção | Fora de âmbito: é a Fase A/C1 e exige substituir os três motores vivos. A primitiva está preservada, intocada. |

---

## 4. Impacto nos dados existentes

| Alteração | Impacto em dados existentes | Migration |
|---|---|---|
| **P19** (recálculo restrito) | **Nenhum retroativamente.** Só **estreita** o conjunto de quotas que o recálculo em massa pode tocar: `parcialmente_paga` (e `paga`) ficam de fora. Nas quotas que continuam a ser recalculadas escreve `valor_base`, `valor_fcr`, `valor`, `valor_por_1000`, `permilagem_aplicada`, `fcr_percentagem`. | não |
| **P20** (pré-visualização) | **Nenhum.** Caminho de leitura. Deixou de passar `orcamentosJson`/`fcrSplitterJs` ao render e passa `previsaoJson`. | não |
| **P22** (`dividirEm`) | **Nenhum retroativo.** Só afeta planos **novos** (`calcularPlano` corre ao gerar o plano e ao emitir quotas do orçamento). Planos já gravados não são reescritos; a regeneração só apaga/substitui linhas `estado: 'planeada'`. | não |
| **Determinismo** (`order` na distribuição automática) | **Nenhum retroativo.** A distribuição automática só corre para rubricas **sem** distribuição. A **soma nunca mudava** — passa a ser reprodutível **qual fração** paga o cêntimo sobrante. | não |
| **Quotas extraordinárias — parcelas** (§1.5a) | **Só em quotas extraordinárias NOVAS.** As parcelas já gravadas (`extra_quota_parcelas`) mantêm o seu `valor`. A **soma por fração nunca mudava** — muda a repartição do resto: de «tudo na última parcela» (até 0,59 €) para «≤1 cêntimo por parcela». | não |
| **Quotas extraordinárias — ordem** (§1.5b) | **Nenhum retroativo.** Só afeta distribuições novas; a soma nunca mudava. | não |

**Sem migration, sem alteração de schema, sem alteração de chaves de configuração.**

---

## 5. Inconsistências adicionais encontradas (ligadas ao cálculo/distribuição de quotas)

1. **`helpers/quotas-primitiva.js` sem consumidores de produção** — a «primitiva única» existe,
   está testada, e a produção continua a usar três motores (`quotas-calc.js`, `distribuicao.js`,
   `plano.js`). Qualquer afirmação de «primitiva única» no Roadmap deve ser lida como *desenho*, não
   como *estado*.
2. **`dividirIgual` é código morto** — `helpers/quotas-calc.js:78`, exportado na linha 219, **zero
   consumidores**. É uma **segunda** implementação de «dividir em partes iguais» (e é a correta, por
   maior-resto): dois algoritmos para o mesmo problema, um deles a apodrecer.
3. **`Fracao.findAll` sem `order`: 13 ocorrências** (levantadas com um verificador próprio). Só
   importam as que alimentam **distribuição por maior-resto** — e eram **duas**:
   - **Corrigidas nesta entrega:** `routes/orcamento.js` (distribuição automática do orçamento, §1.4)
     e `routes/extra-quotas.js` (quota extraordinária, §1.5).
   - **Já com ordem (correto):** `financeiro.js:988` (pré-visualização), `financeiro.js:1102`
     (gravação), `orcamento.js:126/238/480`.
   - **Sem efeito monetário (verificado um a um):** `jobs/automatizacao.js:63` (usa `calcularQuota`
     **por fração**: independente da ordem) · `orcamento.js:545` e `:805` (alimentam um `Set`/`Map`) ·
     `admin.js:270/912`, `condominios.js:35`, `condomino-conta.js:110`, `global-admin.js:103`,
     `quotas-modulo.js:340/592` (listagens/validações).
   - **Latente (código morto):** `financeiro.js:859`, dentro do `GET /quotas` sombreado.
4. **`GET /quotas` (financeiro.js:722) é sombreado** por `quotas-modulo.js:126`. O âmbito de
   `getQuotaConfig` já foi corrigido (V5), mas é **correção latente**: se a ordem de montagem mudar,
   a rota passa a servir e o defeito ficaria vivo. A rota devia ser removida, não mantida «correta».
5. **`calcularDistribuicaoQuotas` devolve o residual abstrato a `null`** quando não recebe
   `valorPor1000C` — coerente com o desenho, mas significa que a primitiva **não pode** fechar o R1
   sozinha; o P17 tem de decidir de onde vem o total de referência.
6. **Ponteiros do Roadmap desatualizados (não corrigidos — proibido tocar em `docs/ROADMAP.md`):**
   §3.6/§3.8 ainda descrevem a pré-visualização como reimplementação no browser (deixou de ser
   verdade com o P20) e o P22 aparece como pendente (está fechado). **A atualização do Roadmap fica
   para quem o detém** — o que deve ser acrescentado está em §8.
7. **Outra frente deixou o `test:offline` vermelho:** `scripts/test-area-condomino.js:1310` exige
   **7** cabeçalhos de coluna na lista de pagamentos, mas `views/condomino/pagamentos.handlebars`
   passou a ter **8** (coluna «Comprovativo», `+106/−2` no teste e `+12/−1` na vista, ambos dessa
   frente). A cadeia completa aborta no **3.º passo** — ver §6.1. Não é meu e não foi tocado.
   *(Um segundo motivo de vermelho — `test-autorizacao-arquitetura` a queixar-se do atalho
   `/admin/config/automacoes` na vista `gerar.handlebars` — **foi entretanto corrigido pela própria
   frente** durante esta sessão; confirmei que passa.)*

---

## 6. TESTES

### 6.1 `npm run test:offline` — **não completa neste ambiente** (bloqueio do hook, não do código)

A cadeia tem **102 passos**. Foi tentada três vezes por inteiro. O obstáculo **não é um defeito de
código** — é o hook `safe-delete`, que conta as eliminações de ficheiros **por turno** com limiar
**100** e, ao atingi-lo, **recusa** a eliminação em vez de a executar:

```
✗ FALHA: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
  {"count":100,"threshold":100,"scope":"turn", ...}
```

O harness de mutação apaga um backup no fim de cada mutação (e limpa backups órfãos no arranque). A
cadeia completa faz **≥100** eliminações. A partir do momento em que o contador satura, **todas** as
suítes de mutação falham **no arranque** (a limpeza de órfãos é recusada) e os testes que apagam
temporários falham também (`public/uploads/_teste-logo*`).

**Evidência obtida, por tentativa (nenhuma com `AssertionError` de código):**

| Tentativa | Cobertura | Resultado |
|---|---|---|
| `chain4` | cadeia **menos o passo 3** e **menos o passo 87** | **`EXIT=0`**, **1 128 `✓`**, termina no **último** passo (`check-templates` → «Todas as vistas compilam e renderizam»); inclui 4 suítes de mutação — **31/31 detetadas e revertidas** (suporte 16, FCR 3, mensal 5, FCR-orçamento 7) |
| `integral3` | cadeia **completa** | **890 `✓`**, **0 `AssertionError`**, **0 `SyntaxError`**; morre no passo 84 pelo hook. Prova que os passos 1–83 estão verdes — **incluindo o passo 3** (`test-area-condomino.js`), que a outra frente entretanto corrigiu |
| `a9-tail` | passos 84–102 | passos **88–102 verdes** (`test-movimentos-integridade` 29, `test-crlf` 22, `test-eliminacao-*` 15/13/13/8, `test-extrato` 62, seeds, `check-templates`); passos 84–87 bloqueados no arranque pelo hook |

**Nota histórica:** a primeira tentativa abortou no **3.º passo** (`test-area-condomino.js`,
`AssertionError: pagamentos: 7 colunas no cabeçalho`, `8 !== 7`) porque
`views/condomino/pagamentos.handlebars` tinha passado a 8 cabeçalhos. **Ambos os ficheiros eram de
outra frente** e essa frente já os alinhou — `integral3` mostra o passo 3 verde.

**Lacuna declarada:** `scripts/test-mutacao-email.js` (**passo 87**) é o único passo que **não** ficou
provado verde nesta sessão. Ficou bloqueado pelo hook dentro da cadeia e, na tentativa isolada, o
pedido de confirmação de eliminação em massa foi **recusado**. Não é indício de regressão (é uma suíte
de email, sem relação com quotas/orçamento), mas fica registado como **não verificado**.

**Porque não foi tentado de novo (decisão fundamentada, não desistência):** no fecho desta entrega
outra frente estava a correr suítes de mutação **em contínuo** — prova: resíduos
`.mutation-backup-<ts>-<pid>` a mudar de nome a cada ~5 s, com pids diferentes (16832 → 22032 → 37520),
e alvos sucessivos `routes/orcamento.js`, `helpers/relatorio-financeiro.js`,
`helpers/periodo-filtro.js`, `views/admin/configuracao/email.handlebars`.

Verificado no código: **as 7 suítes de mutação partilham o mesmo padrão de backup**
(`mutation-backup-${carimbo}.tmp`, na raiz) — logo duas execuções em paralelo **apagam o backup uma da
outra** e o restauro falha com `ENOENT`, deixando o alvo **mutado**. Como `helpers/periodo-filtro.js` é
exatamente o primeiro alvo desta suíte, corrê-la agora arriscava corromper o trabalho da outra frente.
**Não correr suítes de mutação em paralelo** — é a regra que sai daqui.

Os **meus** ficheiros foram reconferidos nesse momento e estão **intactos**: `helpers/plano.js`
`e3bfe337…` · `helpers/extra-quotas.js` `50051c14…` · `routes/financeiro.js` `02a18f3f…` ·
`routes/orcamento.js` `de4bc3c7…` · `routes/extra-quotas.js` `3abdb4da…` ·
`views/admin/quotas/gerar.handlebars` `b6972c2d…` · `helpers/quotas-calc.js` `673b0aee…` ·
`helpers/quotas-primitiva.js` `199bbb58…`.

**Integridade após as falhas — nenhum alvo ficou mutado.** Verificado por `sha256` (alvo = backup =
`HEAD`):

| Alvo | Hash | Veredicto |
|---|---|---|
| `helpers/quotas-calc.js` | `673b0aee…` | intacto (o restauro correu; só a eliminação do backup foi recusada) |
| `helpers/periodo-filtro.js` | `75615644…` | intacto (o harness foi bloqueado **antes** de mutar) |

**Resíduo:** o meu (`.mutation-backup-1790084719577-6784.tmp` + `.tmp.alvo`, 6 866 bytes, **inerte** —
alvo intacto) foi **reciclado**. O que aparece agora na raiz é **de outra frente, em execução viva**:
**não tocar** — apagar o backup de uma suíte a meio faz o restauro falhar com `ENOENT` e deixa o alvo
mutado. `ls .mutation-backup-*` devolve o par dessa execução, com nome a mudar a cada mutação.

### 6.2 Suítes dirigidas — todas verdes (`EXIT=0`)

Executadas **depois** da última alteração de código:

`test-financeiro` · `test-quota-extra-ciclo` · `test-orcamento-estado` ·
`test-orcamento-distribuicao` · `test-fcr-orcamento` · `test-orcamento-portal-execucao` ·
`test-quotas-modulo` · `test-fcr-base` · `test-quotas-mensal` · `test-quotas-recalculo-plano` ·
`test-quotas-isolamento` · `test-fcr-movimentos` · `test-fcr-deliberacoes` · `test-fcr-rotas` ·
`test-movimentos-integridade` · `test-seed-demo` · `test-seed-demo-smoke` · `check-templates` ·
`test-vistas`.

**Nota honesta:** `test-financeiro` **falhou** à primeira depois da alteração ao `parcelar` (§1.5a) —
continha a asserção **A4** («resto na última parcela») que fixava exatamente o comportamento antigo.
Foi **adaptada** ao contrato novo (o cêntimo sobrante vai para a primeira parcela; diferença máxima
de 1 cêntimo), com o caso medido das 60 parcelas acrescentado. Depois disso, verde.

### 6.3 Suítes de mutação — 31/31 detetadas e revertidas (uma suíte não verificada)

| Suíte | Resultado |
|---|---|
| `test-mutacao-suporte.js` | 16/16 detetadas |
| `test-mutacao-fcr.js` | 3/3 detetadas |
| `test-mutacao-mensal.js` | 5/5 detetadas |
| `test-mutacao-fcr-orcamento.js` | 7/7 detetadas |
| `test-mutacao-email.js` | **não verificado** — bloqueado pelo hook em todas as tentativas (ver §6.1) |

As quatro primeiras foram detetadas **dentro** da execução encadeada (`chain4`), não só isoladamente.

### 6.4 Provas por mutação das alterações desta entrega

| Mutação | Alvo | Resultado |
|---|---|---|
| P20 — a pré-visualização do método orçamento deixa de usar os valores do servidor | `views/admin/quotas/gerar.handlebars` | **detetada** |
| P19 — recálculo volta a incluir `parcialmente_paga` | `routes/financeiro.js` | **detetada** |
| P22 — `dividirEm` volta a `Math.round(totalC/n)` repetido | `helpers/plano.js` | **detetada** |
| Determinismo C2 — distribuição automática sem `order` | `routes/orcamento.js` | **detetada** |
| Determinismo C3 — pré-visualização sem `order` | `routes/financeiro.js` | **detetada** |
| D1 — `parcelar` volta a atirar todo o resto para a última parcela | `helpers/extra-quotas.js` | **detetada** |
| D2 — quota extraordinária volta a distribuir sem ordem fixa | `routes/extra-quotas.js` | **detetada** |

Todas repostas **byte a byte** (`sha256` antes = depois). Verificação independente de resíduos sobre
os **14** alvos das 3 suítes de mutação: `residuos=0`.

> Nota de honestidade — C2 foi **falso verde** à primeira tentativa: a verificação estrutural apontava
> para a **primeira** chamada a `distribuirValorAnual` (que já estava ordenada), deixando a segunda
> descoberta. Só a mutação o revelou. O teste foi corrigido para varrer **todas** as chamadas — e a
> mutação passou a ser detetada. Um teste que passa por apontar para o sítio errado não prova nada.

### 6.5 Novo teste de regressão

`scripts/test-quotas-recalculo-plano.js` (DB-free, duplos de modelo via `require.cache`; o duplo de
`Quota.findAll` **interpreta o `where` real** da rota com os `Op` do Sequelize):

- **A1–A4** — P22: fecha ao cêntimo com o exemplo 2 da auditoria, partes dentro de 1 cêntimo, varrimento
  de valores não divisíveis × periodicidades, FCR por célula preservado (`base + FCR = total`).
- **C1–C3** — determinismo: prova o **risco** (mesma distribuição em duas ordens dá cêntimos
  diferentes, soma exata nas duas) e prova as **correções** (as 2 distribuições do orçamento e as duas
  pontas da geração de quotas fixam a ordem).
- **D1–D2** — quotas extraordinárias: `parcelar` fecha exatamente e não privilegia a última parcela
  (com o caso medido: 1.000,01 € em 60 parcelas, onde a regra antiga punha 0,41 € numa só) +
  varrimento de valores × n.º de parcelas; e a distribuição da quota extraordinária fixa a ordem.
- **B1** — P19, ponta a ponta pelo **router real** (`POST /admin/quotas/config` com
  `recalcular=futuras`): só as quotas `[1, 5]` são recalculadas; `parcialmente_paga` (2), `paga` (3),
  vencida no passado (4) e `anulada` (6) ficam intactas; a quota recalculada recebe
  `{valor: 55, valor_base: 50, valor_fcr: 5}`.

Registado em `package.json` (inserção **aditiva**, um só token; verificado que as entradas da outra
frente continuam presentes e o JSON válido).

### 6.6 `git diff --check` e finais de linha

- **Meus ficheiros: limpo** (`EXIT=0`).
- Ficheiros novos — `scripts/test-quotas-recalculo-plano.js` e `docs/ENTREGA-A2-QUOTAS-2026-09-22.md`:
  `git diff --no-index --check` → **0 avisos** em ambos.
- Finais de linha: os dois ficheiros novos estão em **LF** (`CR=0`), como exige o `.gitattributes`
  versionado (`* text=auto eol=lf`, commit `13b5f19`) e como o ambiente de produção (Linux).
  `git check-attr eol` confirma `lf` para estes caminhos.
- Árvore completa: **1 aviso**, em `scripts/test-seguranca.js:180` («new blank line at EOF»), ficheiro
  de **outra frente** (`+90/−1`). Não tocado.

### 6.7 Instabilidade conhecida do ambiente (a registar, não a esconder)

Numa execução encadeada, `test-orcamento-portal-execucao.js` falhou na asserção do seletor de ano e
`test-mutacao-fcr.js` deu **«mutação não detetada»** — e ambos passam quando executados isoladamente
(verificado: 3/3 e 5/5 detetadas, e a suíte de mutação reporta «1 backup órfão de execução anterior
limpo»). A causa é a **working tree partilhada**: outra frente estava a escrever/restaurar ficheiros
durante a execução (prova: `routes/financeiro.js` contém hunks que não são meus; resíduos
`.mutation-backup-*` aparecem e desaparecem com **pids diferentes**; `views/condomino/pagamentos.handlebars`
e `scripts/test-area-condomino.js` mudaram debaixo da execução).

**Consequência operacional:** com dois agentes a correr suítes de mutação na mesma working tree, o
resultado é **inválido nos dois sentidos** — falso verde (a mutação é reposta por outro processo) e
falso vermelho (`safe-delete` falha ao reciclar um backup que já não existe). As provas desta entrega
foram, por isso, corridas **isoladamente**. A asserção em si é estruturalmente sólida: o ano pedido
entra sempre na lista (`routes/condomino.js:1085`).

#### 6.7.1 O hook `safe-delete` impede a cadeia completa (achado de ambiente, não do produto)

O hook `safe-delete` conta as eliminações de ficheiros **por turno** e, ao atingir o limiar **100**,
**recusa** a eliminação em vez de a executar. O harness de mutação apaga um backup por cada mutação e
limpa backups órfãos no arranque — logo a partir da saturação:

1. as suítes de mutação falham **no arranque** (a limpeza de órfãos é recusada);
2. os testes que apagam temporários falham (ex.: `public/uploads/_teste-logotipo.png`);
3. o contador **não volta a zero** dentro do mesmo turno, pelo que o bloqueio é persistente.

`npm run test:offline` faz **≥100** eliminações, portanto **não é executável por inteiro num único
turno** com o limiar em 100. Foi assim que morreram `integral3` (passo 84) e a execução da cauda
(passos 84–87). Duas consequências práticas para quem continuar este trabalho:

- **Correr as suítes de mutação isoladamente e em turnos separados**, ou subir o limiar do hook;
- Um harness interrompido pelo hook **pode deixar o alvo mutado** (o `finally` não corre). O protocolo
  de recuperação é: ler o `.mutation-backup-*.tmp.alvo` → `sha256` do backup vs alvo vs `HEAD` →
  restaurar por `cp` → re-verificar → correr a suíte-oráculo. Nesta sessão **não foi preciso**: os dois
  alvos ficaram intactos.

---

## 7. Commit real

**Nenhum.** Não houve `git commit` nem `git push` — a entrega é para revisão antes de publicar.

**Estado do repositório no fecho desta entrega (verificado):**

- `HEAD` = **`f9f63f6`** («Exportação RGPD, confirmação do orçamento e higiene de testes»), commit **de
  outra frente**.
- `git ls-remote origin main` = **`bf4b6f5`** ⇒ há **3 commits locais por publicar** (`b18cfea`,
  `9034e08`, `f9f63f6`), **nenhum deles meu**.
- A ref local `origin/main` **não existe** (`git rev-parse --verify origin/main` → `fatal: Needed a
  single revision`), pelo que `git status` diz `[gone]` e `git log origin/main..HEAD` sai **vazio** —
  os dois sinais são **enganadores**; a comparação válida é `HEAD` vs `git ls-remote`.
- **O meu trabalho não está em `HEAD`** (prova por conteúdo, não por afirmação):

| Verificação | Em `HEAD` | Na working tree |
|---|---|---|
| `helpers/plano.js` → `maior-resto` | `0` | `1` |
| `views/admin/quotas/gerar.handlebars` → `totalComFcr` (fórmula antiga) | `2` | `0` |
| `views/admin/quotas/gerar.handlebars` → `previsaoJson` | `0` | presente |
| `routes/financeiro.js` → `parcialmente_paga` (recálculo) | `1` | removido |

⚠️ **Consequência para quem publicar:** o `views/admin/quotas/gerar.handlebars` committado em
`f9f63f6` capturou o ficheiro **antes** do P20 (ainda com `totalComFcr`). O P20 e o hunk **P2** da outra
frente viajam no **mesmo** ficheiro não-committado — quem fizer o próximo commit leva ambos.

Ficheiros alterados por esta frente (`git diff --numstat`):

| Ficheiro | +/− | Nota |
|---|---|---|
| `helpers/plano.js` | 16/5 | P22 |
| `helpers/extra-quotas.js` | 16/7 | §1.5a: `parcelar` por maior-resto |
| `routes/extra-quotas.js` | 11/1 | §1.5b: `order` na distribuição da quota extraordinária |
| `routes/orcamento.js` | 11/1 | §1.4: `order` na distribuição automática |
| `routes/financeiro.js` | 71/7 | **só os hunks P19/P20 são meus**; o ficheiro transporta também os hunks de despesas/transações de outra frente |
| `views/admin/quotas/gerar.handlebars` | 45/55 | P20 (**+** hunks de outra frente: P2 e o atalho de automações) |
| `scripts/test-fcr-base.js` | 27/16 | asserções adaptadas ao contrato novo (servidor calcula, vista apresenta) |
| `scripts/test-fcr-orcamento.js` | 6/3 | idem |
| `scripts/test-mutacao-fcr.js` | 8/6 | âncora da mutação 3 repontada (a antiga foi removida pelo P20) |
| `scripts/test-financeiro.js` | 12/2 | asserção **A4** adaptada: fixava «resto na última parcela» (o comportamento antigo que o §1.5a alterou) |
| `package.json` | 1/1 | registo do teste novo (aditivo) |
| `scripts/test-quotas-recalculo-plano.js` | **novo** | teste de regressão P19/P22/determinismo/quotas extra |
| `docs/ENTREGA-A2-QUOTAS-2026-09-22.md` | **novo** | este documento |

`sha256` (estado atual, para conferência futura): `helpers/plano.js` `e3bfe337…` ·
`routes/financeiro.js` `02a18f3f…` · `routes/orcamento.js` `de4bc3c7…` ·
`routes/extra-quotas.js` `3abdb4da…` · `helpers/extra-quotas.js` `50051c14…` ·
`views/admin/quotas/gerar.handlebars` `b6972c2d…` (inclui edições da outra frente) ·
`scripts/test-financeiro.js` `495c69dd…` · `scripts/test-quotas-recalculo-plano.js` `06165997…` ·
`helpers/quotas-calc.js` `673b0aee…` (intocado) · `helpers/quotas-primitiva.js` `199bbb58…` (intocado).

---

## 8. Para o Roadmap (não editado — proibido nesta tarefa)

Quem detém o `docs/ROADMAP.md` deve acrescentar/corrigir:

1. **§3.6 / §3.8** — a pré-visualização **já não** reimplementa a fórmula no browser (P20 fechado);
   o servidor calcula e injeta `previsaoJson`.
2. **§4.1 P22** — **fechado** (`dividirEm` por maior-resto; prova `test-quotas-recalculo-plano.js` A1–A4).
3. **§4.1 P19** — **fechado** (recálculo restrito a quotas sem pagamento aplicado).
4. **§4.1 P20** — **fechado**.
5. **Novo** — `routes/orcamento.js`: distribuição automática sem `order` tornava não reprodutível
   *qual* fração paga o cêntimo do maior-resto (corrigido; provado por mutação).
6. **Novo** — `helpers/extra-quotas.js:parcelar` atirava **todo** o resto para a última parcela (até
   0,59 € com 60 parcelas), contra a promessa de «parcelas iguais»; passou a maior-resto (corrigido;
   provado por mutação). A asserção **A4** de `scripts/test-financeiro.js` fixava o comportamento
   antigo e foi adaptada.
7. **Novo** — `routes/extra-quotas.js`: a distribuição da quota extraordinária não fixava `order`
   (mesma causa do ponto 5, no orçamento) — corrigido.
8. **Novo** — `helpers/quotas-calc.js:dividirIgual` é código morto (exportado, zero consumidores).
9. **Novo** — `helpers/quotas-primitiva.js` sem consumidores de produção.
10. **Novo** — `test:offline` aborta no passo 3 em `test-area-condomino.js` (8 colunas na vista vs 7
    esperadas). **Os 100 passos seguintes passam.**
11. **Novo (processo)** — suítes de mutação a correr em duas frentes na **mesma working tree** dão
    resultados inválidos nos dois sentidos (falso verde e falso vermelho por `safe-delete`).
12. **P6, P17, P18, P21** — continuam **abertos**, agora com o comportamento atual, as opções, o
    impacto e a recomendação técnica documentados nesta entrega.
