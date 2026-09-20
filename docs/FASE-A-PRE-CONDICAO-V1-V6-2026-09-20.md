# Fase A — Pré-condição V1–V6

**Data:** 2026-09-20
**Script:** `scripts/diagnostico-fase-a-preflight.js` (novo, só SELECT + verificação de código)
**Natureza:** levantamento read-only. Nenhum valor, modelo, migration ou quota foi alterado.

---

## ⚠️ Estado de execução — ler primeiro

| Verificação | Estado | Onde correu |
|---|---|---|
| **V0** (schema) | ✅ **CONCLUÍDA** | local — lê os modelos |
| **V5** (scope da config) | ✅ **CONCLUÍDA** | local — lê o código-fonte |
| **V6** (testes com valores fixos) | ✅ **CONCLUÍDA** | local — lê `scripts/` e a view |
| **V1** (quotas pendentes futuras) | ⏳ **PENDENTE — precisa de BD** | **tem de correr em produção** |
| **V2** (baseline pagas/parciais) | ⏳ **PENDENTE — precisa de BD** | **tem de correr em produção** |
| **V3** (permilagem e grupos) | ⏳ **PENDENTE — precisa de BD** | **tem de correr em produção** |
| **V4** (valor_por_1000 / fcr_%) | ⏳ **PENDENTE — precisa de BD** | **tem de correr em produção** |

**Porque V1–V4 não correm aqui:** este clone Windows não tem acesso à base de dados.
`.env` local não existe (só `.env.example` com `DB_HOST=127.0.0.1:3306`); a ligação
dá `ECONNREFUSED`. Produção é `/opt/condofy` no host `condofy`, inacessível daqui.
Nenhum dado de produção foi lido.

**Comando para V1–V4** (no servidor):
```bash
cd /opt/condofy && node scripts/diagnostico-fase-a-preflight.js
```
O script já degrada corretamente: corre V0/V5/V6 (que não precisam de BD) e só
depois tenta a ligação. No servidor correrá tudo.

---

## V0 — Coerência do diagnóstico contra o schema

Verificação que acrescentei para evitar o erro clássico de ir a produção com um
nome de coluna ou estado inventado (já aconteceu antes neste projeto com
`data_vencimento` em `despesas` e com `c.nome`).

**Resultado: ✓ todas as colunas e estados usados existem.**

| Item | Valor real |
|---|---|
| Estados de `Quota.estado` | `pendente`, `parcialmente_paga`, `paga`, `vencida`, `anulada` |
| `quota.valor` | `DECIMAL(10,2)` |
| `quota.valor_base` | `DECIMAL(10,2)` |
| `quota.valor_fcr` | `DECIMAL(10,2)` |
| `quota.valor_por_1000` | `DECIMAL(10,4)` |
| `quota.permilagem_aplicada` | `DECIMAL(7,2)` |
| `quota.fcr_percentagem` | `DECIMAL(5,2)` |
| `fracoes.permilagem` | `DECIMAL(7,2)` |

**Duas correções apanhadas antes de ir a produção:**
1. O estado é **`anulada`**, não `cancelada` — a primeira versão do script tinha o
   nome errado em V2. Corrigido.
2. `permilagem` é `DECIMAL(7,2)` — **ver PD-A abaixo**, é material.

---

## 🔴 PD-A — `142,857‰` não existe na base de dados

**Achado com consequência direta na regra D3.**

`fracoes.permilagem` é `DECIMAL(7,2)` (confirmado em
`migrations/20260101000003-create-fracoes.js:10` e no modelo; nenhuma migration
posterior altera a precisão). **Só tem 2 casas decimais.**

Consequências:

1. O exemplo dado em D3 — «7 frações × 142,857‰» — **não pode existir**. O valor
   gravado é `142,86‰`. Sete frações de `142,86‰` somam `1000,02‰`, não `999,999‰`.
2. O exemplo `142.857‰` vs `142.858‰` (grupos diferentes) **não é representável**:
   ambos são gravados como `142,86‰` e caem no **mesmo** grupo.
3. A regra «igualdade exata sem tolerância» continua correta e implementável — mas
   compara o valor **armazenado** (`DECIMAL(7,2)`), não o valor pretendido pelo
   gestor. É isso que o T2 tem de testar.

**O que isto não invalida:** a regra em si está certa e é mais simples do que
parecia. Com 2 casas decimais, o conjunto de valores é discreto e a igualdade
exata é uma comparação trivial de inteiros (permilagem × 100). Não há risco de
`float` mal comparado.

**O que precisa de decisão:** os casos de teste nº 1 e nº 3 da lista de testes
obrigatórios (`7 frações × 142,857‰` e `333,333‰ × 3`) têm de ser reescritos com
valores representáveis. Ver «PD-A — pedido» no fim.

---

## V5 — Âmbito da configuração de quotas

**Resultado: 7 chamadas com âmbito · 1 sem âmbito.**

| Ficheiro | Com âmbito | SEM âmbito |
|---|---|---|
| `routes/financeiro.js` | 3 | **1** ← a corrigir |
| `routes/quotas-modulo.js` | 1 | 0 |
| `routes/orcamento.js` | 2 | 0 |
| `jobs/automatizacao.js` | 1 | 0 |
| **Total** | **7** | **1** |

A ocorrência sem âmbito é **`routes/financeiro.js:779`** — `getQuotaConfig(),`.

### É código morto ou alcançável? — **Código MORTO, mas por sombreamento**

A rota a montante é `GET /quotas` definida em `financeiro.js:722`. Só que
**existem três definições de `GET /quotas`** no projeto:

| Ficheiro | Linha | Montado em `app.js` |
|---|---|---|
| `routes/quotas-modulo.js` | 126 | linha **277** — `app.use('/admin', rotasQuotasModulo)` |
| `routes/financeiro.js` | 722 | linha **279** — `app.use('/admin', rotasFinanceiro)` |
| `routes/condomino.js` | 295 | montado em `/condomino` (outro prefixo) |

O Express resolve pela **ordem de montagem**. `quotas-modulo` é montado **antes**
de `financeiro`, logo `GET /admin/quotas` é servido por `quotas-modulo.js:126` e
**`financeiro.js:722` nunca corre**. Toda a rota, incluindo a linha 779, é
inatingível.

Isto confirma o que o teste de isolamento já fixava por escrito:
`scripts/test-quotas-isolamento.js:489-491` — *«Há ainda um bloco de código morto
(E3, rotas sombreadas) que mantém uma chamada sem âmbito e que NÃO foi reativado
nem alterado nesta correção.»*

**Veredicto:** corrigir `getQuotaConfig()` → `getQuotaConfig(req.condominioId)` na
linha 779 é **higiene, não um bug de runtime**. Nenhum condomínio está hoje a ver
dados de outro por esta via — a rota não corre.

**Consequência para os testes:** `scripts/test-quotas-isolamento.js:501-504` fixa
a contagem em **exatamente 1** ocorrência sem âmbito. Depois de corrigir passa a
**0**. Esse ajuste é obrigatório e tem de vir no mesmo commit, com a razão
registada — não é uma regressão.

**Nota honesta:** o script reportou inicialmente
`rota sombreada: NÃO / indeterminado` na linha 779, porque a sua heurística
procurava a mesma rota *dentro do mesmo ficheiro*. O sombreamento é **entre
ficheiros** (ordem de montagem) e foi confirmado à mão em `app.js:277-279`. A
heurística do script está incompleta e fica registado.

---

## V6 — Testes e fixtures que fixam o comportamento antigo

### Assinaturas encontradas

| ID | Assinatura | Ocorrências | Onde |
|---|---|---|---|
| **A1** | FCR somado à base (`base × pct / 100`) | **1** | `views/admin/quotas/gerar.handlebars:177` |
| A2 | `Math.round(total / n)` repetido (inflação) | 0 | — |
| A3 | `floor` por mês + resto na última fração | 0 | — |
| A4 | resto na última parcela | 0 | — |
| A5 | tolerância de arredondamento em cêntimos | 0 | — |
| **A6** | asserção base/FCR com literais `[50,5,55]` | **1** | `scripts/test-fcr-base.js:92` |
| A7 | `round(anual / nCobrancas) × ocorrências` | 0 | — |
| A8 | duplicação da fórmula no browser | 0 | — |
| **A9** | contagem de `getQuotaConfig()` sem âmbito | **1** | `scripts/test-quotas-isolamento.js:485` |

### Asserções a revisitar — inventário

**6 ficheiros de teste importam os motores afetados**, com **114 asserções com
valores literais**:

| Ficheiro | Asserções com literais | Importa |
|---|---|---|
| `scripts/test-fcr-base.js` | 5 | `quotas-calc` |
| `scripts/test-financeiro.js` | 24 | `quotas-calc`, `distribuicao` |
| `scripts/test-movimentos-integridade.js` | 8 | `relatorio-financeiro` |
| `scripts/test-quota-extra-ciclo.js` | 2 | `recibos` |
| `scripts/test-quotas-modulo.js` | 45 | `recibos` |
| `scripts/test-relatorio-financeiro.js` | 30 | `relatorio-financeiro` |

**As que bloqueiam a Fase A** (fixam a semântica que vai mudar):

| Ficheiro:linha | Asserção | Porque muda |
|---|---|---|
| `test-fcr-base.js:92` | `[q.base, q.fcr, q.total] === [50, 5, 55]` | **D1**: `500‰` a `100 €/1000‰` com FCR 10%. Semântica antiga: `base=50`, `fcr=5`, `total=55`. Semântica nova: `total=55`, `fcr=round(5500×10/110)=5`, `base=50`. **Coincide neste caso** — ver nota abaixo |
| `test-financeiro.js:118-122` | `q.base=50`, `q.fcr=5`, `q.total=55`, `q.totalC=5500`, `q.valorPor1000=100` | idem — **coincide** neste caso |
| `test-financeiro.js:131` | `[3333, 3333, 3334]` «resto na última parcela» | **D2/D3**: passa a `[3333,3333,3333]` + R1 de 1 cêntimo |
| `test-financeiro.js:127` | `qA.total + qB.total === 110` | depende de A/B |
| `test-fcr-base.js:116` | tolerância `<= 12` cêntimos no ano | **D1/R2**: R2 passa a ser medido e exposto, não tolerado |

⚠️ **Nota importante sobre `[50,5,55]`:** neste caso concreto as duas semânticas
**dão o mesmo resultado** — `round(5500×10/110) = 500 cêntimos = 5 €`. O caso só
diverge quando o total não é divisível de forma exata. **Isto significa que
`[50,5,55]` pode sobreviver à Fase A sem alteração** — o que torna o caso
insuficiente como teste de D1. Ver PD-B.

### Falsos positivos descartados

A primeira versão da assinatura A5 (`<= 12`) apanhava 5 ocorrências, **4 delas
falsas**: `for (let mes = 1; mes <= 12; ...)` e limites de comprimento de string.
Só `test-fcr-base.js:116` é real. Assinatura refinada; ficam 0 com o padrão
corrigido — o que por si é um achado: **a tolerância de 12 cêntimos usa
`Math.abs(...) <= 12` sem a palavra «cêntimo» na mesma linha**, logo a assinatura
continua a não a apanhar. Verificada à mão em
`scripts/test-fcr-base.js:113-117`.

---

## O que fica por decidir antes do C1

### PD-A — valores de teste não representáveis

Os casos de teste obrigatórios nº 1 e nº 3 da especificação usam permilagens com
3 casas decimais (`142,857‰` e `333,333‰`), que **`DECIMAL(7,2)` não armazena**.

**Pedido:** escolher os valores representáveis a usar. Proposta:
- caso 1 → **7 frações × `142,86‰`** (Σ = `1000,02‰`, desvio +0,02‰ → exercita E1)
- caso 3 → **3 frações × `333,33‰`** (Σ = `999,99‰`, desvio −0,01‰ → exercita E1)

Ambos ficam **melhores** do que os originais para o propósito de testar E1, porque
o desvio de permilagem é real e mensurável — coisa que `999,9999‰` também daria,
mas sem ser representável.

### PD-B — `[50,5,55]` não prova D1

Como notei acima, a asserção existente **passa nas duas semânticas**. Se fica
inalterada, não há teste que morra se D1 for revertida — é um falso verde para D1.

**Pedido:** autorizar a adição de um caso onde as semânticas divirjam. Exemplo:
total `101 cêntimos` com `pct = 10` →
- antigo: `base = 101`, `fcr = round(101×0.10) = 10`, `total = 111`
- novo: `fcr = round(101×10/110) = 9`, `base = 92`, `total = 101`

Divergem em `total` (111 vs 101). Este caso mata qualquer reversão de D1 e cabe no
T2 sem sair do âmbito.

### PD-C — correção da heurística de sombreamento no diagnóstico

O script não deteta sombreamento **entre ficheiros**. Fica registado como
limitação conhecida; se quiser, corrijo a heurística para ler `app.js` e a ordem
de `app.use`. Não é bloqueante para o C1.

---

## Conclusão

- **V5:** problema confirmado em `financeiro.js:779`, mas é **código morto por
  sombreamento entre routers** — higiene, não bug em runtime.
- **V6:** **4 assinaturas reais** a rever; `[50,5,55]` e os literais de
  `test-financeiro.js` são os casos concretos. `test-quotas-isolamento.js`
  precisa de ajuste obrigatório (1 → 0).
- **V0:** apanhou 1 erro meu (`cancelada` → `anulada`) e 1 achado material
  (`DECIMAL(7,2)`) **antes** de qualquer execução em produção.
- **V1–V4:** por correr em produção. Sem esses números não sei quantos
  condomínios, quotas ou grupos são afetados — e **não avanço para C1 sem eles**,
  porque o C1 define a primitiva mas o C3 (recálculo) precisa de saber o universo.

**Nada foi alterado:** zero migrations, zero modelos, zero quotas, zero commits.
Único ficheiro criado: `scripts/diagnostico-fase-a-preflight.js`.
