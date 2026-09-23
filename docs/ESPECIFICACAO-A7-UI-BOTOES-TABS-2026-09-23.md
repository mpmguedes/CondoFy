# ESPECIFICAÇÃO A7 — UNIFORMIZAÇÃO DE BOTÕES, TABS E ÁREAS DE AÇÃO

**Projeto:** GesCondu (Node/Express + Sequelize + Handlebars)
**Autor:** A7 · **Data:** 2026-09-23
**Estado:** ⏳ **PARA APROVAÇÃO** — nada implementado. Sem `git add`, `commit`, `push` ou `deploy`.
**Revisão 2 (2026-09-23):** acrescentada a secção **C.10** («botões cinzentos») e as dívidas **F23–F26**,
na sequência da verificação pedida pelo utilizador sobre texto cinzento com contraste insuficiente.
**Base:** auditoria transversal read-only de 2026-09-23 (botões, tabs, áreas de ação).
**Âmbito de ficheiros na implementação futura:** `public/css/styles.css`, `public/css/home.css`,
`views/partials/_quotas-tabs.handlebars`, `views/partials/_assembleias-tabs.handlebars`,
`views/partials/_config-tabs.handlebars`, `views/partials/_condomino-quotas-tabs.handlebars`,
`views/admin/fracoes/detalhe.handlebars` e os templates com classes a migrar.
⛔ **Fora de âmbito:** alterações EPD/DPO, branding/`og:image`/favicon, motor de quotas/orçamento,
`.workbuddy-ai/`.

> **Regra transversal de leitura:** todo o tamanho em `px` de **tipografia** deve ser multiplicado por
> `var(--font-scale)` (`1` / `1.08` / `1.16`, em `html[data-font]`). Alturas, paddings, raios e tamanhos
> de alvo tátil ficam em `px` fixo — **exceto** onde já hoje são escalados. Esta especificação marca cada
> caso com `[fixo]` ou `[×scale]`.

---

## A. Tokens e medidas

### A.1 Alturas canónicas

| Token proposto | Valor | Uso | Notas |
|---|---|---|---|
| `--ctl-h-sm` | **32px** | Botões em linhas de tabela e em `card-header` densos | Substitui o `.btn-sm` (hoje 22.4px) |
| `--ctl-h` | **36px** | **Botão canónico** — `.btn` em qualquer contexto | Decisão aprovada |
| `--ctl-h-lg` | **44px** | Botões grandes (homepage, CTAs, formulários longos) | Substitui `.hp-btn-grande` (44.2px) |
| `--ctl-h-touch` | **48px** | Portal do condómino, alvos táteis e barra inferior móvel | Mantém `.portal-btn` (48px) |
| `--icon-btn-size` | **40px** | Icon-button normal | Decisão aprovada |
| `--icon-btn-size-touch` | **44px** | Icon-button em `max-width: 767.98px` | Decisão aprovada |

**Alturas efetivas a eliminar:** 22.4px (`.btn-sm`), 27.6px (`.btn`), 32.8px (`.btn-lg`), 36px
(`.quick-action`), 40px (`.icon-btn`), 44.2px (`.hp-btn-grande`), 48px (`.portal-btn`) ⇒ passam a ser
**quatro** alturas semânticas (32 / 36 / 44 / 48) mais os dois tamanhos de icon-button (40 / 44).

### A.2 Padding

| Contexto | Vertical | Horizontal |
|---|---|---|
| `.btn` (36px) | `8px` | `16px` (`--sp-4`) |
| `.btn-sm` (32px) | `6px` | `12px` (`--sp-3`) |
| `.btn-lg` (44px) | `11px` | `20px` |
| `.btn` icon-only | `0` (centralizado por flex) | `0` |
| `.icon-btn` | `0` | `0` |

Raio de proporção a preservar: **padding-horizontal ≥ 2× padding-vertical**. Hoje `.btn-sm` tem
`3px 9px` (**3×**) e raio **16px** — combinação desproporcionada que esta spec corrige.

### A.3 Border-radius

| Elemento | Valor | Token |
|---|---|---|
| Botões (`.btn*`, `.quick-action`, `.portal-btn`) | **8px** | `var(--radius-sm)` |
| Tab (todas as famílias) | **8px 8px 0 0** | `var(--radius-sm) var(--radius-sm) 0 0` |
| Icon-button (bolinha) | **50%** | — |
| Exceção — botões grandes da homepage | **8px** | `var(--radius-sm)` |

**Eliminar:** `20px` (`.btn` @`styles.css:424`), `7px` (`.btn` @`:989`), `16px` (`.btn-sm` @`:440`),
`10px` (`.quick-action` @`:918`, `.portal-btn` @`:1109`), `0` (`.nav-tabs`).
**Manter:** **8px** como único raio de botão. **≫ Nota de linguagem Material Design:** 8px é
deliberadamente menos «pílula» do que os 20px atuais, para alinhar botões e tabs no mesmo raio e
manter a leitura sóbria do GesCondu.

### A.4 Tamanhos de ícone

| Contexto | Tamanho | Implementação |
|---|---|---|
| Ícone dentro de `.btn` | **18px** `[×scale]` | `.btn .material-symbols-outlined { font-size: calc(18px * var(--font-scale)); }` |
| Ícone dentro de `.btn-lg` | **20px** `[×scale]` | — |
| Ícone dentro de `.icon-btn` | **20px** `[×scale]` | Mantém a regra global `:206` |
| Ícone dentro de `.quick-action` | **18px** `[×scale]` | Já é o valor atual |
| Ícone de tab | **18px** `[×scale]` | Hoje 1.05rem ≈ 16.8px |
| Ícone de `.btn-sm` | **16px** `[×scale]` | Passa a ser **regra**, não `style=` inline |

⛔ **Proibido:** `style="font-size:…"` inline em ícones. As **18 ocorrências** de
`style="font-size:1rem"` (16px) e as variantes `1.05rem`/`1.1rem`/`1.25rem` passam a classes.

### A.5 Gaps

| Contexto | Valor |
|---|---|
| Entre botões numa toolbar | **8px** (`--sp-2`) |
| Entre ícone e texto **dentro** do botão | **6px** (ou `me-1` = 4px, a uniformizar para 6px) |
| Entre tab e tab | **2px** (mantém o valor atual) |
| Entre o ícone e a borda no icon-only | `0` (flex centrado) |

**Decisão:** o ritmo de toolbar é **8px**. O `gap: 6px` do `.quick-actions` converge para 8px —
**exceto** no ícone-dentro-do-botão, onde 6px se mantém.

### A.6 Breakpoints (só os que esta spec usa)

| Breakpoint | Efeito |
|---|---|
| `max-width: 767.98px` | Icon-button **44×44**; `.btn` mantém 36px mas com padding horizontal 14px; toolbars quebram linha |
| `max-width: 575.98px` | Toolbars em coluna quando > 2 ações; `.quick-action` padding 8px 12px (mantém) |
| `min-width: 768px` | Icon-button **40×40**; comportamento de rato |

⛔ **Correção de defeito:** hoje o override de 48px de altura em telemóvel
(`styles.css:1177`) aplica-se **só** a `.quotas-tab`. Passa a aplicar-se a **todas** as famílias de tabs
(unificadas) e o alvo tátil de 44px passa a aplicar-se também a `.icon-btn` de forma consistente.

---

## B. Componentes

Contrato comum a todos (a definir **uma só vez** em `.btn`):
`display: inline-flex; align-items: center; justify-content: center; gap: 6px;`
`height: var(--ctl-h); padding: 8px 16px; border-radius: var(--radius-sm);`
`font-size: calc(13px * var(--font-scale)); font-weight: 500; border: 1px solid transparent;`
`text-decoration: none; cursor: pointer; transition: background-color .15s ease, border-color .15s ease, color .15s ease, box-shadow .15s ease;`

### B.1 `.btn-primary`
- **Fundo** `var(--c-primary)` · **Borda** `var(--c-primary)` · **Texto/ícone** `var(--c-on-primary)`
- `box-shadow: var(--elev-1)` (mantém a elevação atual — é a assinatura visual da ação primária)
- Ação que **cria, guarda, emite, gera, aprova, envia**. Máximo **1 por área de ação**.
- ⛔ Nunca usar para ação destrutiva.

### B.2 `.btn-outline-primary`
- **Fundo** `var(--c-surface)` · **Borda** `var(--c-border-strong)` · **Texto** `var(--c-primary)`
- Ação secundária **de natureza positiva/alinhada com o primário** (ex.: «Enviar por email» ao lado de
  «Gerar quotas», «Editar» ao lado de «Guardar»).
- **Regra de convergência:** adota `border-color: var(--c-border-strong)` (o valor do bloco Bootstrap
  `:2104`), eliminando o `var(--c-border)` do bloco «Marca» `:435`.

### B.3 `.btn-outline-secondary`
- **Fundo** `var(--c-surface)` · **Borda** `var(--c-border-strong)` · **Texto** `var(--c-text)`
- Ação **neutra**: voltar, cancelar, filtrar, ver detalhe, grelha, exportar.
- **Mudança aprovada:** o texto passa de `var(--c-text-muted)` para **`var(--c-text)`** — aumenta o
  contraste do rótulo e distingue-o visualmente do estado desabilitado.
- É o **segundo botão mais usado** (195 ocorrências) — a migração é puramente de CSS, sem tocar em templates.

### B.4 `.btn-outline-danger` (e `.btn-danger` sólido)
- **Fundo** `var(--c-surface)` · **Borda** `var(--c-border-strong)` · **Texto/ícone** `var(--c-error)`
- `.btn-danger` **sólido** existe com **5 usos** — mantém-se, com texto `var(--c-on-primary)`.
- **Regra:** a geometria é **igual** à dos restantes botões (36px/8px). A semântica é a **cor**, não a
  forma. ⛔ Ações destrutivas (anular, rejeitar, remover) **nunca** se tornam `.btn-primary` azul.
- Usado **47×** em `outline` — a migração é só de CSS.

### B.5 `.btn-success`
- **Fundo** `var(--c-success)` · **Texto** `var(--c-on-accent)`
- ⚠️ **Alerta medido:** `--c-on-accent` no tema claro é `var(--c-navy-950)` = `#06213F` — ou seja, o texto
  do botão «sucesso» é **navy escuro sobre verde**, **não branco**. Contraste medido: **7.24:1** ✓ AA.
  **Isto é intencional e mantém-se.** Não «corrigir» para branco (baixaria para 2.4:1 e reprovaria).
- **7 usos** — todos semanticamente justificados (validar, aprovar, confirmar). **Não expandir.**

### B.6 `.icon-btn` (a «bolinha»)
- **40×40** `[fixo]` · `border-radius: 50%` · fundo `transparent`
- Ícone **20px** `[×scale]` · cor `var(--nav-text-muted)`
- **Não eliminar** — mantém-se onde o contexto torna a ação evidente (fechar, editar, menu, voltar).
- Contraste: no estado normal herda `--nav-text-muted` (`#B5D0E0` sobre superfície escura da topbar);
  a variante destrutiva usa `var(--c-error)`.
- ⛔ **Unificação:** hoje há dois sistemas — `.icon-btn` (fora do `.btn`) e `.btn.btn-sm.px-1` com ícone.
  A spec define **quando** usar cada um (ver secção E).

### B.7 Tabs
- **Altura** 40px `[fixo]` · `padding: 10px 14px` · `gap: 6px` · **raio** `8px 8px 0 0`
- Ícone **18px** `[×scale]`
- Inativo: fundo `transparent`, texto `var(--c-text-muted)`
- Ativo: **fundo `var(--c-primary)`, texto `var(--c-on-primary)`** — mudança aprovada
- Uma **única** linguagem, quatro nomes de classe a convergir (ver secção D).

### B.8 Botões grandes (`.btn-lg`, homepage)
- **44px** · `padding: 11px 20px` · raio **8px** · ícone **20px**
- `.hp-btn-grande` (homepage) passa a ser um **alias declarativo** de `.btn-lg` com a mesma geometria —
  deixa de ter raio 8px por acidente e passa a tê-lo por contrato.
- `.btn-grande` (**classe fantasma, 6 usos sem definição**) → **remover do markup** ou definir como alias
  de `.btn-lg`. Recomendação: **remover do markup** (é ruído).

### B.9 Ações rápidas (`.quick-action`)
- **32px** ou **36px** conforme densidade · raio **8px** · `font-weight: 400` (mantém-se — é um atalho,
  não uma ação primária)
- Fundo `var(--c-primary-light)`, texto `var(--c-primary)`
- **Mudança:** raio de 10px → **8px**; altura de 36px → **alinhada ao token** (`--ctl-h` ou `--ctl-h-sm`).
- Distinção deliberada face ao `.btn`: mais leve, sem elevação. **Preservar essa diferença** — não é
  inconsistência, é hierarquia.

### B.10 Botões em toolbars
- Container: `d-flex flex-wrap align-items-center gap-2` (**8px**) — já é o padrão dominante (84 usos)
- **Ordem visual obrigatória (esquerda → direita):** `[Secundário/neutro] [Secundário/positivo] [Primário]`
- Em `max-width: 575.98px`, com mais de 2 ações: `flex-wrap` já resolve; não forçar coluna.
- **1 primário por toolbar.** Se houver 2, um deles passa a `outline-primary`.

### B.11 Botões em cabeçalhos de card/página
- `.page-heading` → ações à direita, `gap: 8px`, sem botões primários duplicados
- `.card-header` → ações em `btn-sm` (32px) quando o header é denso; `btn` (36px) caso contrário
- ⛔ Os **88** `card-header` com `bg-white` (classe Bootstrap) **não** são alvo desta especificação —
  ficam como estão; apenas os botões dentro deles seguem a geometria canónica.

---

## C. Estados

Contrato por componente. `[ƒ]` = derivado do token de cor (nunca cor nova).

### C.1 `.btn-primary`
| Estado | Especificação |
|---|---|
| normal | `background: var(--c-primary)`, `color: var(--c-on-primary)`, `box-shadow: var(--elev-1)` |
| hover | `background: var(--c-primary-dark)` `[ƒ]`, `box-shadow: var(--elev-2)` |
| active | `background: var(--c-primary-dark)` + `transform: translateY(1px)` |
| **focus-visible** | `outline: 2px solid var(--c-focus-ring)`, `outline-offset: 2px` — **ver C.9 e a correção crítica** |
| disabled | `background: var(--c-primary)`, `color: var(--c-on-primary)`, `opacity: .55`, `cursor: not-allowed` |

### C.2 `.btn-outline-primary`
| Estado | Especificação |
|---|---|
| normal | `background: var(--c-surface)`, `border: 1px solid var(--c-border-strong)`, `color: var(--c-primary)` |
| hover | `background: var(--c-primary-light)` `[ƒ]`, `border-color: var(--c-primary)`, `color: var(--c-primary)` |
| active | `background: var(--c-primary-light)`, `border-color: var(--c-primary-dark)` |
| focus-visible | `outline: 2px solid var(--c-primary)`, `outline-offset: 2px` |
| disabled | `opacity: .55`, `cursor: not-allowed`, fundo inalterado |

### C.3 `.btn-outline-secondary`
| Estado | Especificação |
|---|---|
| normal | `background: var(--c-surface)`, `border: 1px solid var(--c-border-strong)`, `color: var(--c-text)` |
| hover | `background: var(--c-surface-2)`, `border-color: var(--c-border-strong)`, `color: var(--c-text)` |
| active | `background: var(--c-surface-2)`, `border-color: var(--c-primary)` |
| focus-visible | `outline: 2px solid var(--c-primary)`, `outline-offset: 2px` |
| disabled | `opacity: .55`, `cursor: not-allowed` |

### C.4 `.btn-outline-danger` / `.btn-danger`
| Estado | Especificação |
|---|---|
| normal | `color: var(--c-error)`, `border-color: var(--c-border-strong)`, `background: var(--c-surface)` |
| hover | `background: var(--c-error-bg)` `[ƒ]`, `border-color: var(--c-error)`, `color: var(--c-error)` |
| active | `background: var(--c-error-bg)`, `border-color: var(--c-error)` |
| focus-visible | `outline: 2px solid var(--c-error)`, `outline-offset: 2px` |
| disabled | `opacity: .55`, `cursor: not-allowed` |
| `.btn-danger` sólido | fundo `var(--c-error)`, texto `var(--c-on-primary)`; hover `filter: brightness(.94)` → **substituir por token** `--c-error-dark` (a criar) por ser tematizável |

### C.5 `.btn-success`
| Estado | Especificação |
|---|---|
| normal | `background: var(--c-success)`, `color: var(--c-on-accent)`, `border-color: var(--c-success)` |
| hover | `background: var(--c-success)`, `filter: brightness(.94)` → **tokenizar** |
| focus-visible | `outline: 2px solid var(--c-primary)`, `outline-offset: 2px` |
| disabled | `opacity: .55`, `cursor: not-allowed` |

⚠️ O `filter: brightness(.94)` atual **não é tematizável** e comporta-se de forma diferente em fundos
claros e escuros. **Dívida registada** (secção F).

### C.6 `.icon-btn`
| Estado | Especificação |
|---|---|
| normal | `background: transparent`, `color: var(--nav-text-muted)`, 40×40, raio 50% |
| hover | `background: var(--nav-hover)`, `color: var(--nav-text)` |
| active | `background: var(--nav-surface-strong)` |
| focus-visible | `outline: 2px solid var(--nav-focus)`, `outline-offset: 2px` |
| disabled | `opacity: .5`, `cursor: not-allowed` |
| destrutivo | `color: var(--c-error)`; hover `background: var(--c-error-bg)` |
| **mobile** | `44×44`, ícone 24px `[×scale]`, `flex: 0 0 auto` |

### C.7 Tabs
| Estado | Especificação |
|---|---|
| normal (inativo) | `color: var(--c-text-muted)`, `background: transparent`, `border-bottom: 2px solid transparent` |
| hover (inativo) | `color: var(--c-text)`, `background: var(--c-surface-2)` |
| **ativo** | `background: var(--c-primary)`, `color: var(--c-on-primary)`, sem sublinhado de 2px |
| focus-visible | `outline: 2px solid var(--c-primary)`, `outline-offset: -2px` (para dentro, não cortar o sublinhado) |
| disabled | `opacity: .45`, `cursor: not-allowed`, `pointer-events: none` |

⚠️ **Nota de desenho:** ao passar o ativo de «texto azul + sublinhado» para «fundo azul sólido», o
`border-bottom: 2px solid var(--c-primary)` do ativo **deixa de fazer sentido** (a borda seria azul sobre
azul) e é **removido** do estado ativo, mantendo-se a linha de base do container.

### C.8 Estados transversais
- **Nunca** usar `:focus` sem `:focus-visible` para o anel visível (evita anel em clique de rato).
- Todos os botões devem ter `cursor: pointer` no normal e `not-allowed` no disabled.
- Ações desabilitadas **não** devem usar `pointer-events: none` sozinho (perde-se o `title` do motivo);
  usar `cursor: not-allowed` + `aria-disabled="true"`.

### C.9 ⛔ CORREÇÃO CRÍTICA DE ACESSIBILIDADE — anel de foco invisível

**Defeito novo, medido nesta especificação.** O anel de foco global é hoje:

```css
:focus-visible { outline: 2px solid var(--c-primary); outline-offset: 2px; }   /* styles.css:646-649 */
```

Como `--c-primary` **é a própria cor de fundo** do botão primário, o anel tem contraste:

| Contexto | Contraste do anel | WCAG 2.2 SC 1.4.11 (≥ 3:1) |
|---|---|---|
| Claro — anel `#075B9B` sobre `.btn-primary` `#075B9B` | **1.00:1** | ❌ **INVISÍVEL** |
| Claro — anel `#075B9B` sobre hover `#064B82` | **1.27:1** | ❌ **INVISÍVEL** |
| Escuro — anel `#00D0F8` sobre `.btn-primary` `#00D0F8` | **1.00:1** | ❌ **INVISÍVEL** |
| Claro — anel `#075B9B` sobre fundo de página `#F5F9FC` | 6.62:1 | ✓ |
| Escuro — anel `#00D0F8` sobre fundo de página `#06213F` | 8.77:1 | ✓ |

⇒ Quem navega por teclado **não vê onde está** quando o foco cai num botão primário, **nos dois temas**.

**Remédio — APROVADO e IMPLEMENTADO (2026-09-23), com uma CORREÇÃO ao diagnóstico acima.**

⛔ **A referência do diagnóstico estava errada.** O anel é desenhado **fora da caixa** do botão
(`outline-offset: 2px`): os 2px ocupam a faixa imediatamente exterior à borda, logo assentam na
**superfície onde o botão está**, e **não** na cor de fundo do próprio botão. Comparar o anel com o
`background` do botão (daí o «1.00:1») mede uma sobreposição que não existe no ecrã. Medido com a
referência correta (a superfície):

| Contexto real | Antes: anel `--c-primary` | Depois: anel `--c-focus-ring` |
|---|---|---|
| Claro — página `--c-bg` | 6.66:1 ✓ | **15.29:1** ✓ |
| Claro — cartão `--c-surface` | 7.05:1 ✓ | **16.19:1** ✓ |
| Escuro — página `--c-bg` | 8.77:1 ✓ | **15.64:1** ✓ |
| Escuro — cartão `--c-surface` | 7.39:1 ✓ | **13.18:1** ✓ |

⇒ O defeito **real** de foco **não** estava nos botões sólidos sobre superfícies claras/escuras (esses
já cumpriam): estava nos controlos assentes em **superfícies navy**, onde o anel `#075B9B` (tema claro)
cai sobre `#0B2E56` — **≈1.3:1, invisível**. Casos medidos: `.icon-btn` (as «bolinhas» do topbar) e
`.btn-outline-light` (botão «Entrar» do rodapé/topbar).

**Correções implementadas:**

| Controlo | Anel | Contraste medido |
|---|---|---|
| `.btn` (superfície da aplicação) | `outline-color: var(--c-focus-ring)` | 13.18:1 – 16.19:1 nos dois temas |
| `.icon-btn` (topbar navy) | `outline: 2px solid var(--nav-focus)` | 8.33 / 9.88 / 10.88:1 (3 paragens do gradiente) |
| `.btn-outline-light` (topbar/rodapé) | `outline-color: var(--nav-focus)` | idem |

| Tema | `--c-focus-ring` final | vs página | vs cartão |
|---|---|---|---|
| claro | `#06213F` | 15.29:1 | 16.19:1 |
| escuro | `#F6FCFF` | 15.64:1 | 13.18:1 |

⛔ **Variante REJEITADA por medição — e revertida.** Chegou a ser implementado um anel «invertido»
(branco no tema claro) **por variante de botão** (`.btn-primary`, `.btn-success`, `.btn-danger`). A
medição mostrou que era **pior** e foi removida: o anel branco, desenhado fora do botão, cai sobre a
página branca (**1.05:1** — invisível) e sobre o `.btn-success` verde dava **2.24:1** (reprova o 3:1).
A regra correta é **pela superfície onde o botão assenta**, não pela variante do botão — e com
`outline-offset: 0` (que a variante usava) o anel cola-se ao botão e lê-se como um botão mais pequeno,
não como indicador de foco.

⛔ **O `--c-focus` existente (`#00A8D6`) NÃO serve** para substituir o anel em botões sólidos: medido,
**2.54:1** contra o botão primário. Mantém-se **sem alterar o valor**; o anel novo é `--c-focus-ring`.

**Regra final:** o anel de foco contrasta **≥ 3:1 com a superfície onde o botão assenta**; em superfícies
navy usa-se `--nav-focus`. Nunca se escolhe o anel pela variante do botão.

### C.10 ⛔ «BOTÕES CINZENTOS» — investigação pedida pelo utilizador (2026-09-23)

**Pergunta:** há botões com texto cinzento quase ilegível. São `disabled` ou ações ativas?
**Resposta: são `disabled` — não há nenhuma ação ativa com contraste insuficiente. Mas o estado
`disabled` está ele próprio mal construído, e é isso que se vê.**

#### C.10.1 Quais são os botões cinzentos

| Família | Cor do texto | Onde aparece |
|---|---|---|
| `.btn-outline-secondary` (**195 usos**) | `var(--c-text-muted)` = `#567086` claro / `#B5D0E0` escuro | 2.º botão mais usado da app (Voltar, Grelha, Cancelar, Filtrar) |
| `.btn-outline-primary`, `.btn-outline-danger` | não são cinzentos (azul / vermelho) | — |
| `.icon-btn` | `--nav-text-muted` `#B5D0E0` | topbar/sidebar |
| `.mes-btn:disabled`, `.mes-btn.sem-valor` | `#567086` a 55% | calendário |

**O cinzento legítimo é só um:** `.btn-outline-secondary`. É o único que usa `--c-text-muted`.

#### C.10.2 São `disabled` ou ações ativas? — **MEDIDO**

- **Nenhum** botão usa `text-muted`, `text-secondary` ou `style="opacity:…"` para *parecer* desativado
  (busca em `views/**`: **0** ocorrências de `class="…btn…[text-muted|text-secondary]"`).
- As **31** ocorrências de `disabled` no markup são todas **condicionais legítimas**
  (`{{#unless driveLigado}}disabled{{/unless}}`, `{{#unless estadoSmtp.configurado}}`, `{{#unless contasFcr}}`).
- ⇒ **Não existe o defeito «ação ativa a parecer desativada».** O requisito «nunca fazer um botão ativo
  parecer desativado» **está hoje cumprido**.

#### C.10.3 Que regra dá a cor, e qual é o contraste

Cor: `styles.css:2106` → `.btn-outline-secondary { color: var(--c-text-muted); }` (`:437` também, perdedora).

| Estado | Cor efetiva | Contraste | Veredicto |
|---|---|---|---|
| **ATIVO** claro, sobre `--c-surface` `#FFFFFF` | `#567086` | **5.18:1** | ✓ PASSA AA |
| ATIVO claro, sobre `--c-bg` `#F5F9FC` | `#567086` | **4.89:1** | ✓ PASSA AA |
| ATIVO escuro, sobre `--c-surface` `#0B2E56` | `#B5D0E0` | **8.49:1** | ✓ PASSA AA |

⇒ **O cinzento do estado ativo é legível e cumpre AA nos dois temas.** Não é o problema.

#### C.10.4 O defeito real: a `opacity` do `disabled` **dilui** em vez de atenuar

**12 das 13 famílias de botões não têm regra `:disabled` própria** (só `.btn-primary` tem, em
`styles.css:2101`). As restantes dependem do Bootstrap 5.3.3 (CDN, `layouts/main.handlebars:38`), cuja
regra é `opacity: var(--bs-btn-disabled-opacity)` = **`0.65`** — confirmado na folha oficial.

A `opacity` aplica-se ao **elemento inteiro**: o texto **e** o fundo são compostos com o que está por
baixo, aproximando-se um do outro. O contraste **cai** em vez de se manter legível:

| Botão desativado (tema claro) | Texto efetivo | Fundo efetivo | Contraste | Veredicto |
|---|---|---|---|---|
| `.btn-outline-secondary` (opacity .65) | `#9EAEBB` | `#FCFDFE` | **2.24:1** | ❌ **REPROVA** |
| `.btn-primary` (opacity **.55** própria) | `#FFFFFF` | `#72A2C7` | **2.72:1** | ❌ **REPROVA** |
| `.btn-primary` se usasse os .65 do Bootstrap | `#FFFFFF` | `#5A92BD` | 3.34:1 | ⚠️ só texto grande |

**Tema escuro — assimetria:** o mesmo `.btn-outline-secondary` desativado dá **4.54:1** e **passa**.
⇒ O comportamento **difere entre temas** sem razão semântica: defeito em si.

**Consequência de desenho («a hierarquia invertida»):** um botão **ativo** cinzento lê-se a **5.18:1** e
um botão **desativado** a **2.24:1** — mas o requisito diz que o desativado é que *pode* ser atenuado.
Hoje o desativado fica **abaixo** do ativo, tornando o texto do desativado **mais difícil de ler do que
qualquer botão clicável**, que é exatamente o oposto do pretendido.

#### C.10.5 Regra proposta (para as Fases 1–3)

Substituir a `opacity` global por **tokens de estado desativado explícitos** — atenuação **sem** diluir:

```css
/* a criar em :root e [data-theme="dark"] */
--c-disabled-bg:     /* superfície neutra, distinta do normal */
--c-disabled-text:   /* cinzento >= 4.5:1 sobre --c-disabled-bg */
--c-disabled-border: /* borda neutra */

.btn:disabled, .btn.disabled {
  opacity: 1;                    /* NAO diluir o elemento inteiro */
  background: var(--c-disabled-bg);
  color: var(--c-disabled-text);
  border-color: var(--c-disabled-border);
  cursor: not-allowed;
  box-shadow: none;
}
```

**Objetivos mensuráveis (a verificar na implementação):**
1. `.btn-outline-secondary` **ativo** mantém ≥ 4.5:1 (hoje 5.18:1 ✓ e passa a `--c-text` com 14.42:1).
2. **todo** o botão `disabled` com contraste **≥ 4.5:1** nos **dois** temas — simétrico.
3. Desativado visualmente **distinto** do ativo (fundo neutro), mas **legível**.
4. Remover o `opacity: .55` de `styles.css:2101` (a diluição mais agressiva encontrada).

⚠️ **Nota:** `disabled` **não é** um requisito WCAG de contraste (a SC 1.4.3 isenta elementos inativos),
mas o utilizador fixou a regra de produto «ação ativa → legível; `disabled` → pode ser atenuado, nunca
ilegível». Esta spec adota **≥ 4.5:1 também no desativado**, para eliminar a inversão de hierarquia.

**Nota adicional (fora do âmbito «cinzento», mas encontrada ao medir):** `.btn-outline-danger` **ativo**
dá **4.22:1** sobre branco — passa como texto grande, **falha** o AA de texto normal (≥ 4.5:1). É um
achado marginal (o rótulo é 13px, não é texto grande) e fica registado na secção F.

---

## D. Convergência das tabs existentes

### D.1 Situação medida

| Família | Localização CSS | Usada em | Métricas hoje |
|---|---|---|---|
| `.quotas-tab` | `styles.css:1696-1718` | **9 vistas** (`_quotas-tabs`) + **3** (`_condomino-quotas-tabs`) | padding 8/14, raio 8px 8px 0 0, ícone 1.05rem |
| `.assembleias-tab` | `styles.css:1885-1907` | **5 vistas** | **byte-idêntico** ao anterior |
| `.config-tab` | `styles.css:1916-1938` | **5 vistas** | **byte-idêntico** aos anteriores |
| `.nav-tabs .nav-link` | `styles.css:559-569` | **1 vista** (`fracoes/detalhe.handlebars:15-21`) | padding 8/**16**, raio **0**, **sem ícone** |

**Prova da duplicação:** `diff` dos três blocos após normalizar o nome da classe = **saída limpa**.

### D.2 Como devem convergir

**Decisão: consolidar num único bloco de CSS com seletores agrupados, sem renomear classes.**

```css
/* UMA definição; quatro nomes preservados por compatibilidade de templates */
.quotas-tabs, .assembleias-tabs, .config-tabs { /* container */ }
:is(.quotas-tab, .assembleias-tab, .config-tab) { /* item — contrato único */ }
:is(.quotas-tab, .assembleias-tab, .config-tab).active { /* estado ativo único */ }
```

| Família | Ação | Porquê |
|---|---|---|
| `.quotas-tab` | **Manter o nome**, absorver no bloco único | 12 vistas dependem dele; renomear seria churn |
| `.assembleias-tab` | **Manter o nome**, absorver no bloco único | 5 vistas; zero benefício em renomear |
| `.config-tab` | **Manter o nome**, absorver no bloco único | 5 vistas; já tem o comentário «mesma linguagem das tabs de Quotas» |
| `.nav-tabs .nav-link` | **SUBSTITUIR** por `.fracoes-tabs`/`.fracoes-tab` alinhado, **ou** migrar o markup de `fracoes/detalhe` para uma parcial comum | Elimina o 4.º sistema; passa a ter ícone e o raio correto |
| `.nav-pills` | **Nada a fazer** — **0 usos** | Não existe |

### D.3 Estado ativo — a mudança aprovada

| | Hoje | Depois |
|---|---|---|
| Cor do texto | `var(--c-primary)` | `var(--c-on-primary)` |
| Fundo | `var(--c-surface)` | `var(--c-primary)` |
| Borda inferior | `2px solid var(--c-primary)` | **removida** |
| Borda superior/laterais | `1px solid var(--c-border)` | **removida** |

⇒ A tab ativa passa a ser **visualmente idêntica** a um `.btn-primary`, criando a linguagem comum pedida.
No tema escuro resulta automaticamente: fundo `#00D0F8`, texto `#06213F`, contraste **8.77:1** ✓.

### D.4 Divergências a eliminar por família

| Propriedade | `.quotas-tab`/`.assembleias-tab`/`.config-tab` | `.nav-tabs` | Resultado |
|---|---|---|---|
| `padding` | `8px 14px` | `8px 16px` | **10px 14px** |
| `border-radius` | `8px 8px 0 0` | `0` | **8px 8px 0 0** |
| ícone | 1.05rem | ausente | **18px `[×scale]`, obrigatório** |
| altura móvel | **só** `.quotas-tab` tem 48px (`:1177`) | nenhuma | **todas** com alvo tátil |

---

## E. Icon-only — critérios de classificação

### E.1 Números medidos

- **54** `<button>` com conteúdo exclusivamente `<span class="material-symbols-outlined">`
- **+ 34** botões icon-only que usam `<a>` ou já a classe `.icon-btn` ⇒ total auditado ≈ **88**
- Rotulagem atual dos 54:

| Situação | Nº | Veredicto |
|---|---|---|
| `aria-label` **e** `title` | 16 | ✓ correto |
| só `aria-label` | 2 | ⚠️ aceitável, sem tooltip para rato |
| **só `title`** | **31** | ⚠️ nome acessível existe, mas fraco/inconsistente |
| só `data-ajuda` (tooltip própria) | 41 | ❌ **NÃO é nome acessível** (ver E.3) |
| **nenhuma rotulagem** | **2** | ❌ **DEFEITO CONFIRMADO** |

### E.2 Critérios de classificação (novos)

**C1 — Icon-only circular (`.icon-btn`, 40/44px) — MANTER quando:**
- a ação é **universalmente reconhecível pelo ícone** e o contexto a desambigua;
- exemplos concretos encontrados: fechar (`close`), mais opções (`more_vert`), voltar
  (`arrow_back`), navegação de calendário, alternar tema, sino de avisos;
- ficheiros: `views/partials/_tema-toggle.handlebars`, `views/layouts/main.handlebars:299`,
  `views/admin/documentos/recibos.handlebars:31` (`more_vert`).

**C2 — Passar a texto + ícone — QUANDO:**
- a ação é **destrutiva** ou **irreversível** (anular, rejeitar, remover) e o ícone sozinho pode ser
  confundido com o seu oposto;
- **casos concretos a converter:** `views/admin/quotas/comprovativos.handlebars:75` (`close` = rejeitar
  comprovativo) e `views/admin/quotas/recibos.handlebars:122` (`block` = anular recibo). Ambos são
  destrutivos, ambos usam `px-1` avulso, ambos competem visualmente com os botões vizinhos.
- **regra prática:** se o utilizador perde dinheiro ou dados por engano, **não** é icon-only.

**C3 — Obrigatoriamente com `aria-label` + `title` (tooltip) — QUANDO:**
- **todo** o icon-only, sem exceção. Hoje: **2 casos com zero rotulagem** e **41 casos em que
  `data-ajuda` é a única informação** — ambos insuficientes.
- **defeitos concretos a corrigir:**
  - `views/admin/global/condominios.handlebars:18` — `<button class="btn btn-primary" type="submit">`
    com ícone `add` e **zero texto, zero `aria-label`, zero `title`**. Um `<button type=submit>` primário
    invisível para leitores de ecrã. **Severidade alta.**
  - `views/admin/documentos/recibos.handlebars:31` — botão de dropdown `more_vert` sem rótulo.

**C4 — Tratamento semântico (cor) — QUANDO:**
- a ação **destrói ou rejeita**: usa `var(--c-error)` ou `var(--c-error-bg)`;
- exemplos: `btn-outline-danger` nos 3 icon-only de `quotas/*`; um `icon-btn` destrutivo na topbar.

### E.3 ⛔ Causa raiz do problema de acessibilidade (medida)

O sistema de tooltips (`public/js/app.js:298-355`) **nunca define `aria-label`**. Em dispositivos com
rato, `data-ajuda` só cria um balão visual (Bootstrap tooltip); em **tátil**, aplica um `title` nativo
como fallback (`titleFallback`, `app.js:315-319`) e **apenas** se o botão for «só ícone»
(`soIcone`, `app.js:308-311`).

⇒ **Consequência:** os **41** botões com apenas `data-ajuda` dependem de um `title` que só é injetado em
tátil e **nunca** produzem um nome acessível fiável. **Regra da spec:** `data-ajuda` é **complemento**,
nunca **substituto** de `aria-label`.

---

## F. Dívidas técnicas — decisão por item

| # | Item | Localização | Decisão | Porquê |
|---|---|---|---|---|
| F1 | `.btn` definido **2×** (`padding`/`radius`/`fs` divergentes) | `styles.css:423-432` **e** `:989` | **CONSOLIDAR** — uma só definição com a geometria da secção A | A regra de `:424` (`radius: 20px`) é **anulada** pela de `:989` (`7px`); duas fontes de verdade para a mesma classe |
| F2 | `.btn-sm` definido **2×** | `styles.css:440` (`radius: 16px`) **e** `:991` | **CONSOLIDAR** → `--ctl-h-sm` (32px), raio **8px** | Hoje: raio 16px com padding vertical 3px = desproporção visível |
| F3 | `.btn-lg` definido **1×** mas sem `border-radius` próprio | `styles.css:990` | **CONSOLIDAR** → `--ctl-h-lg` (44px), raio 8px | Herda o raio de `.btn` por acidente |
| F4 | `.btn-primary` definido **2×** | `:433-434` **e** `:2097-2101` | **CONSOLIDAR** | O `:disabled` só existe na 2.ª; o repouso é igual |
| F5 | `.btn-outline-primary` definido **2×**, com **bordas diferentes** | `:435-436` (`--c-border`) **e** `:2104-2105` (`--c-border-strong`) | **CONSOLIDAR** no valor de `:2104` | Mesma classe, cores de borda diferentes conforme a cascata |
| F6 | `.btn-outline-secondary` definido **2×** | `:437` **e** `:2106-2107` | **CONSOLIDAR** no bloco `:2106-2107` + `color: var(--c-text)` | A 1.ª não tem hover; a 2.ª vence |
| F7 | `.btn-outline-danger` definido **2×** | `:438-439` **e** `:2108-2109` | **CONSOLIDAR** | Idênticas no repouso; `:focus` só na 2.ª |
| F8 | **3 sistemas de tabs** idênticos | `:1696-1718`, `:1885-1907`, `:1916-1938` | **CONSOLIDAR** em bloco único com seletores agrupados; **manter os 3 nomes** | 46 linhas duplicadas; renomear tocaria 22 vistas sem benefício |
| F9 | Bootstrap `.nav-tabs` | `:559-569` + `views/admin/fracoes/detalhe.handlebars:15-21` | **SUBSTITUIR** pela linguagem única | 4.º sistema divergente (raio 0, padding 16, sem ícone) |
| F10 | `.btn-grande` usada mas **sem definição** | `views/publicas/home.handlebars:45,994`, `views/publicas/pedir-acesso.handlebars:59,63` (**6 usos**) | **REMOVER do markup** | Código morto: a classe não existe em CSS nenhum |
| F11 | `.hp-btn-grande` | `public/css/home.css:111` (`padding .72/1.35rem`, `radius --radius-sm`, `fs 1rem`) | **MANTER como alias de `.btn-lg`**, com a mesma geometria | Só a homepage; formalizar em vez de duplicar |
| F12 | `.portal-btn` | `styles.css:1104-1112` (min-height 48, raio 10, fw 600) | **MANTER** (alvo tátil do portal), **raio 10→8px** | 48px é justificado no telemóvel; o raio não |
| F13 | `.quick-action` | `:540-547`, `:914-924`, `:1011-1017` (**3 definições**) | **CONSOLIDAR** numa só; raio 10→**8px**; manter `fw: 400` | 3 definições do mesmo seletor; a diferença de peso face ao `.btn` é **hierarquia intencional** |
| F14 | `.page-heading` definido **4×** | `:535-537`, `:943-945`, `:2186-2187`, `:2211` | **CONSOLIDAR** numa só + variantes por media query | `margin-bottom` efetivo é 14px, não `--sp-5` (24px) — divergência silenciosa |
| F15 | `.card-header` definido **3×** | `:413`, `:961`, `:2124` | **CONSOLIDAR** | Mesma classe, 3 fontes de verdade |
| F16 | Tamanhos de ícone **inline** | **18×** `style="font-size:1rem"` + `1.05rem`/`1.1rem`/`1.25rem`; ex.: `views/admin/quotas/comprovativos.handlebars:75,78`, `views/admin/condominos/form.handlebars:37,67` | **SUBSTITUIR por classe** (`.btn .material-symbols-outlined`, `.btn-sm …`, `.icon-btn …`) | 16px inline vs 20px global; impede tematização e escala de fonte |
| F17 | `aria-current` em falta | `_quotas-tabs.handlebars`, `_assembleias-tabs.handlebars` (**sem**) vs `_config-tabs.handlebars`, `_condomino-quotas-tabs.handlebars` (**com**) | **ACRESCENTAR** `aria-current="page"` nas 2 que faltam | Mesmo componente, informação diferente para leitores de ecrã |
| F18 | `aria-hidden` em falta nos ícones de tab | `_quotas-tabs.handlebars:6,9,12,15,18` (**sem**) vs as outras 3 (**com**) | **ACRESCENTAR** `aria-hidden="true"` | Leitor de ecrã lê «grid_view Quotas» em vez de «Quotas» |
| F19 | `filter: brightness(.94)` como hover | `:2103` (`.btn-success`) | **SUBSTITUIR** por token `--c-success-dark` (a criar) | `filter` não é tematizável e comporta-se mal em fundos escuros |
| F20 | Hover por `filter` no `.btn-danger` sólido | (`:2102` herda ausência de hover dedicado) | **TOKENIZAR** | idem F19 |
| F21 | `px-1` como padding avulso em botões | **14 ocorrências** (ex.: `quotas/comprovativos.handlebars:75`, `condominos/form.handlebars:37`) | **SUBSTITUIR por `.btn-icon-square`** (botão quadrado de 32px com raio 8px) | `px-1` só mexe no eixo X, deixando o eixo Y do `.btn-sm` — assimetria |
| F22 | Duplicação de utilitários Bootstrap (`bg-white`, `text-end`) | 88× `card-header bg-white` | **NÃO TOCAR nesta fase** | Fora do âmbito de botões/tabs; risco de regressão em massa |
| **F23** | **12 de 13 famílias de botões sem regra `:disabled` própria** | `.btn-outline-*`, `.btn-success`, `.btn-danger`, `.portal-btn`, `.quick-action` — **0 regras** cada (só `.btn-primary` tem, `:2101`) | **SUBSTITUIR** por um bloco `.btn:disabled` único com **tokens** `--c-disabled-{bg,text,border}` e **`opacity: 1`** | Herdam `opacity: .65` do Bootstrap 5.3.3 (CDN) ⇒ diluem texto **e** fundo ⇒ **2.24:1** no claro. Ver C.10 |
| **F24** | `opacity: .55` no `.btn-primary:disabled` | `styles.css:2101` | **REMOVER** (passa a usar os tokens de F23) | É a diluição mais agressiva: **2.72:1** no claro. Topa todos os outros `disabled` |
| **F25** | Atenuação do `disabled` assimétrica entre temas | Bootstrap `opacity .65` aplicado cegamente | **SUBSTITUIR** por tokens por tema | Claro **2.24:1** (reprova) vs escuro **4.54:1** (passa) — sem razão semântica |
| **F26** | `.btn-outline-danger` **ativo** a 4.22:1 sobre branco | `styles.css:2108` (`var(--c-error)` `#D8475C`) | **MANTER a cor, registar** — decisão do utilizador | 4.22:1 falha o AA de **texto normal** (≥4.5:1); o rótulo é 13px, logo não é «texto grande». Não é o problema dos «cinzentos», mas é um achado marginal medido |

| **F27** | `.mes-btn:disabled` atenua com `opacity: 0.55` | `styles.css:1838` (calendário de meses) | **CORRIGIR** — aplicar os tokens `--c-disabled-{bg,text,border}` | Mesma doença do F24 (dilui texto **e** fundo um contra o outro). **NÃO corrigido nesta fase**: família fora do âmbito `.btn` |
| **F28** | `.quick-action` definido **3×** | `:603`, `:989`, `:1083` | **CONSOLIDAR** — mas **preservado** nesta fase | 3 fontes de verdade para o mesmo seletor; o vencedor da cascata é `:1083` (min-height 36, raio 8, padding 6/12) |
| **F29** | Botões sobre faixas escuras da homepage ficam sem anel visível | `.hp-cta-final`, `.hp-sec-dark` — `views/publicas/home.handlebars:994,998` | **ACRESCENTAR** `.hp-cta-final .btn:focus-visible, .hp-sec-dark .btn:focus-visible { outline-color: var(--nav-focus) }` | O anel do tema claro (`#06213F`) desaparece sobre a faixa navy. **NÃO corrigido**: a homepage está explicitamente fora do âmbito desta fase |
| **F30** | 3 ícones decorativos sem `aria-hidden` no seletor de condomínio | `views/partials/_condominio-seletor.handlebars:4` (2) e `:14` (1) | **MANTER** — decisão técnica justificada | O «texto» destes controlos vem **só** de `{{…}}` (o nome do condomínio): se o partial não produzir nada, esconder o ícone deixaria o controlo **sem nome nenhum**. Risco maior que o benefício |
| **F31** | `aria-current="page"` em falta nas tabs de quotas e assembleias | `_quotas-tabs.handlebars`, `_assembleias-tabs.handlebars` | **ACRESCENTAR na frente de tabs** (é o F17) | Os ícones das tabs **já** levam `aria-hidden` (F18, feito nesta fase); o **estado ativo** fica para a frente de tabs, que tem revisão visual própria |

### F.23 Resumo das ações

- **REMOVER:** 2 (`F10`, `F24`) — `F24` **feito** nesta fase
- **SUBSTITUIR:** 8 (`F9`, `F16`, `F19`, `F20`, `F21`, `F23`, `F25` + o `--c-focus-ring` novo) —
  `F23` e `F25` **feitos** nesta fase
- **CONSOLIDAR:** 9 (`F1`–`F8`, `F13`–`F15`) — `F1`–`F7` **feitos** nesta fase (`F8`/`F13`/`F14`/`F15`
  ficam para as fases seguintes: são de tabs e de outros componentes)
- **ACRESCENTAR:** 2 (`F17`, `F18`) — `F18` **feito** nesta fase (`aria-hidden` nos ícones das tabs);
  `F17` fica para a frente de tabs
- **MANTER:** 4 (`F11`, `F12`, `F22`, `F26`) — confirmados intactos nesta fase
- **NÃO TOCAR:** `--c-focus` **sem alterar o valor**; o anel novo é `--c-focus-ring` (secção C.9)
- **NOVAS (medidas nesta fase):** `F27`–`F31`

### F.24 Estado por fase (implementação de 2026-09-23)

| Fase | Estado | Nota |
|---|---|---|
| 1 — Infraestrutura (tokens) | **FEITO** | `--c-focus-ring`, `--c-disabled-{bg,text,border}`, `--ctl-h*` |
| 2 — Consolidação invisível (`F1`–`F7`) | **FEITO** | Um bloco único; **exatamente 1 definição global** por seletor |
| 3 — Acessibilidade (foco + `disabled`) | **FEITO** | Anel por superfície; `disabled` por cor, com `opacity: 1` |
| 4 — Geometria canónica | **PARCIAL** | Contrato **declarado e fixado por teste**; **NÃO aplicado** aos componentes (é a mudança que se vê — exige revisão visual própria) |
| 5 — Tabs | **NÃO INICIADA** | Deliberadamente fora desta fase |
| 6 — Icon-only e markup | **PARCIAL** | `aria-label` em **96** controlos e `aria-hidden` em **265** ícones; converter os 2 destrutivos para texto+ícone e tirar os `style=` inline ficam pendentes (`F16`, `F21`) |

---

---

## G. Plano de implementação proposto (por fases, para aprovação faseada)

| Fase | Conteúdo | Risco visual | Ficheiros |
|---|---|---|---|
| **1. Infraestrutura** | Tokens novos em `:root` e `[data-theme="dark"]` (`--ctl-h*`, `--icon-btn-size*`, `--c-focus-ring`, `--c-success-dark`, **`--c-disabled-{bg,text,border}`**). Nenhum seletor alterado | **Zero** — não muda um pixel | `styles.css` |
| **2. Consolidação invisível** | Eliminar as definições perdedoras (`:424`, `:440`→agrupado, `:989`/`:991`, `.page-heading` ×4, `.card-header` ×3, `.quick-action` ×3, tabs ×3) | **Baixo** — o resultado calculado mantém-se, exceto onde a spec manda mudar | `styles.css` |
| **3. Correção crítica de acessibilidade** | `--c-focus-ring` com contraste ≥3:1 sobre botões sólidos; **bloco `.btn:disabled` único com `opacity: 1` e tokens** (substitui a diluição do Bootstrap e o `.55` do `.btn-primary`); `aria-current` nas 2 parciais; `aria-hidden` nos ícones | **Zero visual no ativo**; o `disabled` passa a ser legível (mudança visível e deliberada) | `styles.css`, 3 parciais |
| **4. Geometria canónica** | Alturas 32/36/44/48, raio 8px, paddings, ícones 18/20px | **Médio** — é a mudança que se vê | `styles.css` |
| **5. Tabs** | Estado ativo com fundo `--c-primary`; convergir `.nav-tabs` | **Médio-alto** — muda a cara de 22 vistas | `styles.css`, `fracoes/detalhe.handlebars` |
| **6. Icon-only e markup** | `aria-label`/`title` nos 54+; converter os 2 destrutivos para texto+ícone; remover `btn-grande`; tirar os 18 `style=` inline | **Baixo-médio** | ~20 templates |

**Prova exigida em cada fase:** `test:offline` + `git diff --check` + uma verificação de contraste
executável (o mesmo cálculo WCAG usado nesta spec) + screenshot local em tema claro e escuro.

---

## ESPECIFICAÇÃO A7 — PRONTA PARA APROVAÇÃO

1. **Altura canónica de botão: 36px.** Quatro alturas semânticas apenas: **32** (denso/tabela),
   **36** (padrão), **44** (grande/homepage), **48** (tátil/portal).
2. **Raio de botão único: 8px** (`var(--radius-sm)`). Eliminar 20px, 7px, 16px e 10px.
3. **Tabs com o mesmo raio** (`8px 8px 0 0`) e a **mesma altura** (40px) em todas as famílias.
4. **Padding de botão: `8px 16px`** (36px) / `6px 12px` (32px) / `11px 20px` (44px). Regra: o padding
   horizontal é **≥ 2×** o vertical.
5. **Ícones: 18px** dentro de `.btn`, **20px** em `.btn-lg` e `.icon-btn`, **16px** em `.btn-sm` —
   sempre `calc(Npx * var(--font-scale))`, **nunca `style=` inline**.
6. **Gap de toolbar: 8px.** O gap ícone-texto dentro do botão é 6px. A toolbar nunca tem dois primários.
7. **Icon-buttons mantêm-se circulares** («bolinhas» preservadas): **40×40** normal, **44×44** em
   `max-width: 767.98px`, raio 50%, ícone 20px.
8. **Cores sempre por token.** Botão primário: fundo `--c-primary`, texto `--c-on-primary` — **sem branco
   hardcoded**, porque no tema escuro `--c-on-primary` é `#06213F` (contraste 8.77:1 ✓).
9. **Contrastes atuais estão corretos e não se mexem:** primário claro 7.05:1, escuro 8.77:1,
   sucesso 7.24:1 (texto navy sobre verde é **intencional**).
10. ⛔ **Correção crítica:** o anel de foco global é `1.00:1` sobre o botão primário — **invisível nos dois
    temas**. Criar `--c-focus-ring` com contraste **≥ 3:1** contra o fundo do próprio botão sólido.
11. **Tabs convergem** para uma linguagem única: ativa com **fundo `--c-primary` + texto `--c-on-primary`**;
    inativa neutra. As **3 famílias idênticas** consolidam-se num bloco com **os nomes preservados**;
    o `.nav-tabs` (4.º sistema, 1 vista) é **substituído**.
12. **Ações destrutivas mantêm o vermelho semântico e a geometria dos restantes** — nunca passam a
    primário azul. Ações universais (fechar, editar, anexar, menu, voltar) podem ser icon-only.
13. **Ação destrutiva ou irreversível nunca é icon-only** — passa a texto + ícone
    (`quotas/comprovativos.handlebars:75` e `quotas/recibos.handlebars:122` são os casos a converter).
14. **`data-ajuda` é complemento, nunca nome acessível** (`app.js` só injeta `title` em tátil). Todo o
    icon-only exige **`aria-label` + `title`**. Hoje: **2 sem rotulagem nenhuma** e **41 dependentes só de
    `data-ajuda`**. Acrescentar `aria-current="page"` a `_quotas-tabs` e `_assembleias-tabs`, e
    `aria-hidden="true"` aos ícones de `_quotas-tabs`.
15. ⛔ **Nenhuma ação ativa é cinzenta-a-parecer-desativada** — verificado: **0** botões usam
    `text-muted`/`opacity` para simular desativação; os **31** `disabled` são condicionais legítimas.
    O cinzento do `.btn-outline-secondary` **ativo** é **5.18:1** (claro) e **8.49:1** (escuro) ✓.
16. ⛔ **O `disabled` é que está mal feito:** herda `opacity: .65` do Bootstrap (e **`.55`** no
    `.btn-primary`), o que **dilui texto e fundo um contra o outro** ⇒ **2.24:1** e **2.72:1** no tema
    claro (**reprovam**). Substituir por um bloco `.btn:disabled` único com **`opacity: 1`** e tokens
    `--c-disabled-{bg,text,border}`, garantindo **≥ 4.5:1 nos dois temas**.
17. **Consolidar 9 dívidas, substituir 8, remover 2, acrescentar 2 — sem tocar nos utilitários Bootstrap
    nem nas classes de vistas partilhadas.** A implementação é faseada (6 fases), a Fase 1 sem qualquer
    impacto visual, e a Fase 5 (tabs) é a única que exige revisão visual alargada.

---

---

## H. Registo de implementação — Fases 1/2/3/4 (2026-09-23)

Implementado o que as Fases 1/2/3/3B/4 desta especificação definem. **A Fase 5 (tabs) não foi tocada**,
por decisão explícita de âmbito.

### H.1 Tokens novos

| Token | Claro | Escuro | Uso |
|---|---|---|---|
| `--c-focus-ring` | `#06213F` | `#F6FCFF` | anel de foco dos `.btn` sobre a superfície da aplicação |
| `--c-disabled-bg` | `#E8EFF5` | `#2E5F8C` | fundo do estado desativado |
| `--c-disabled-text` | `#4E687D` | `#EAF4FB` | texto do estado desativado |
| `--c-disabled-border` | `#D7E4ED` | `#3D7198` | contorno do estado desativado |
| `--ctl-h-sm` / `--ctl-h` / `--ctl-h-lg` / `--ctl-h-touch` | `32px` / `36px` / `44px` / `48px` | idem | **contrato declarado, ainda NÃO aplicado** aos componentes (Fase 4) |

### H.2 Medições (WCAG 2.1, fórmula oficial)

| Medição | Claro | Escuro | Limiar |
|---|---|---|---|
| `disabled`: `--c-disabled-text` sobre `--c-disabled-bg` | **5.03:1** ✓ | **6.01:1** ✓ | ≥ 4.5:1 |
| `disabled`: passo de luminância fundo↔ativo (distinguibilidade) | **0.145** ✓ | **0.080** ✓ | ≥ 0.05 |
| `disabled` **antes** (`opacity: .65` do Bootstrap) | 2.62:1 ❌ | 4.48:1 | — |
| `.btn-primary:disabled` **antes** (`opacity: .55`) | 3.27:1 ❌ | 3.05:1 ❌ | — |
| Anel de foco sobre a página | **15.29:1** ✓ | **15.64:1** ✓ | ≥ 3:1 |
| Anel de foco sobre o cartão | **16.19:1** ✓ | **13.18:1** ✓ | ≥ 3:1 |
| Anel da navegação (topbar) sobre as 3 paragens | **8.33 / 9.88 / 10.88:1** ✓ | idem | ≥ 3:1 |
| `.btn-outline-secondary` **ativo** (não regride) | **5.18:1** ✓ | **8.49:1** ✓ | ≥ 4.5:1 |
| `.btn-primary` **ativo** (não regride) | **7.05:1** ✓ | **8.77:1** ✓ | ≥ 4.5:1 |
| `.btn-outline-danger` **ativo** — dívida `F26` | 4.22:1 ⚠️ | 5.50:1 ✓ | ≥ 4.5:1 (fora do âmbito) |

Nota: as medições do `disabled` «antes» (2.62:1 / 3.27:1) são as desta implementação; a auditoria inicial
registou 2.24:1 / 2.72:1 com uma composição ligeiramente diferente (a contabilizar a borda). Qualquer das
leituras está muito abaixo de 4.5:1 — a conclusão não muda.

### H.2b Medição no browser (o que a análise estática NÃO via)

Ler o CSS não chegou. Foi preciso **renderizar** a folha num browser real (Microsoft Edge via Playwright,
com o Bootstrap 5.3.3 do CDN carregado **antes** da folha do produto, tal como na aplicação) para apanhar
dois defeitos que a leitura do ficheiro não mostrava:

1. ⛔ **O anel de foco dos botões não era desenhado.** O Bootstrap 5.3 define
   `.btn:focus-visible { outline: 0 }` com a **mesma especificidade** (0,2,0) da regra do produto e é
   carregado **antes** — logo vencia a regra global de `:focus-visible` (0,1,0). A primeira versão desta
   correção declarava apenas `outline-color`, e o valor computado era
   `outline-width: 0px; outline-style: none`: **a declaração era decorativa** e o teste estrutural que só
   olhava para a cor era um **falso verde**. Corrigido com o **atalho completo** (`outline: 2px solid …`),
   que ganha nas três sub-propriedades. Medido depois: `outline-width: 2px; outline-style: solid;
   outline-offset: 2px`, com `#06213F` (claro) e `#F6FCFF` (escuro) sobre o botão primário, e `#3BDCFB`
   nas «bolinhas». O teste passou a exigir o atalho completo, e o harness tem uma mutação que repõe
   exatamente este defeito.
2. ⛔ **O estado desativado do tema escuro era indistinguível do ativo.** `--c-disabled-bg: #12395E`
   dava um passo de luminância de apenas **0.012** face à superfície ativa (`#0B2E56`) — o tema claro
   tem **0.145**. Texto legível, mas impossível de distinguir de um botão ativo. Ajustado por medição
   para `#2E5F8C` / `#EAF4FB`: passo **0.080** e texto a **6.01:1**.

Valores computados no browser (o que o utilizador vê de facto):

| Elemento | `opacity` | `cursor` | `border-radius` | Caixa |
|---|---|---|---|---|
| `.btn:disabled` (os dois temas) | **1** ✓ | **not-allowed** ✓ | 7px | 33px de altura |
| `.icon-btn` (a «bolinha») | 1 | pointer | **50%** ✓ | **40×40** ✓ |
| `.btn-primary` ativo | 1 | pointer | 7px | 83×33 |

Sem overflow horizontal (`scrollWidth > clientWidth` = **false**). Nota: a altura efetiva do botão é
**33px** e não os 36px do contrato — confirma que a **Fase 4 não foi aplicada** (é a mudança que se vê).

Capturas em `C:\tmp\a7-prova\` (tema claro e escuro, botão primário focado e «bolinha» focada) —
artefactos **fora do repositório**, zero resíduo no `git status`.

### H.3 Prova

- `scripts/test-botoes-a11y.js` — **novo**: fixa o contrato único, o estado desativado, o anel de foco,
  os contratos de tamanho e o nome acessível dos controlos. **PASSA**.
- `scripts/test-mutacao-botoes.js` — **novo**: **11 mutações**, todas **detetadas pela razão certa**, com
  restauro byte a byte conferido por sha256. **PASSA**.
- `scripts/test-contraste.js` (82 combinações), `scripts/test-tipografia.js`, `scripts/test-vistas.js` e
  `scripts/check-templates.js` — **PASSAM**. `git diff --check` — limpo.

### H.4 Âmbito NÃO tocado (confirmado)

Tabs (`.quotas-tab`, `.assembleias-tab`, `.config-tab`, `.nav-tabs`), `.btn-outline-danger` ativo, cores
semânticas de sucesso/erro, homepage, páginas legais, EPD/DPO, OneDrive e branding: **intocados**.
Precisões de honestidade sobre os limites:

- Nas **tabs** acrescentou-se **apenas** `aria-hidden="true"` aos ícones (`F18`, em `_quotas-tabs` e
  `_assembleias-tabs`) — nenhuma regra CSS, nenhum estado ativo e nenhuma estrutura visual foram alterados.
- Em `views/admin/fracoes/detalhe.handlebars` tocaram-se **só** os botões «Editar»/«Voltar» do cabeçalho
  (ícones decorativos); **as tabs `.nav-tabs` dessa vista ficaram intactas**.
- `public/css/home.css` e `views/publicas/home.handlebars` **não foram tocados** (`F29` fica registado).
- Os 4 ficheiros do EPD/DPO (`routes/publicas.js`, `scripts/test-paginas-publicas.js`,
  `views/publicas/politica-privacidade.handlebars`, `views/partials/_pagina-legal.handlebars`) mantêm
  **exatamente** as alterações que já tinham: `git diff` desses ficheiros tem **0** ocorrências de
  `aria-label`/`aria-hidden` acrescentadas por esta frente.

### H.5 Pendências propostas (não executadas)

1. Integrar `test-botoes-a11y.js` na cadeia `test:offline` — mexe em `package.json` e na contagem de
   passos documentada no `docs/ROADMAP.md` (que **só o A9** edita e exige publicação).
2. Registar `F27`–`F31` na §4 do `docs/ROADMAP.md`.
3. Fases 4 (aplicação da geometria), 5 (tabs) e o resto da 6 (`F16`, `F21`) — com revisão visual própria.
Sem `git add`, `commit`, `push` ou `deploy`. Nada tocado em EPD/DPO nem em `.workbuddy-ai/`.
