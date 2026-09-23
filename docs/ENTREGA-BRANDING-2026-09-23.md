# Entrega — Frente BRANDING (2026-09-23)

**Identidade visual normalizada para o wordmark final `ges|condu`. O símbolo isolado «G» desapareceu
da aplicação, incluindo do favicon.**

Pré-condição cumprida: a frente só foi executada **depois** da auditoria **BRAND-01** (inventário
read-only de logos/favicon, registado em `.workbuddy-ai/memory/2026-09-23.md`).

**Não houve `git commit` nem `git push`.** Este documento é para revisão antes de publicar.

---

## 1. ASSET PRINCIPAL — decisão e fundamento

A auditoria BRAND-01 confirmou o `gescondu_logo_final.svg` como **tecnicamente adequado**
(`viewBox="0 0 554.46 201.3"`, 2 908 B, 8 `path` com as letras convertidas em curvas, 0 `<text>`,
sem `<script>`/`<foreignObject>`/`onload`/referências externas, e **provado servido** por
`express.static` com `Content-Type: image/svg+xml` e bytes iguais aos do disco). Portanto **foi usado
o SVG**, como o brief manda.

| | |
|---|---|
| **Ficheiro** | `public/img/gescondu_logo_final.svg` |
| **Tamanho** | 2 905 B · sha256 `16c5a6ad35363ed99cc6ed840b02a547b57ca46a2192f9beaf046f85e10e9803` |
| **Origem** | cópia do `gescondu_logo_final.svg` da **raiz** |
| **Única alteração** | `<title>Ativo 5logo</title>` → `<title>GesCondu</title>` |

A alteração do `<title>` corrige o **nome acessível errado** («Ativo 5logo» era o nome de trabalho do
ficheiro de arte). Preferi **substituí-lo por «GesCondu»** em vez de o remover: removido, o SVG aberto
diretamente no browser fica sem nome; substituído, fica com o nome certo. Prova de que nada mais mudou:
`original.replace('<title>Ativo 5logo</title>', '<title>GesCondu</title>') === cópia` → `true`.

⛔ **Não foi usado o antigo `gescondu_logo.svg`** — é arte de impressão A4 retrato
(`viewBox="0 0 595.3 841.9"`), com margens enormes; inutilizável em UI.

### O `og:image` fica em PNG — deliberado

`helpers/home-publica.js:240` **continua a apontar para `/img/gescondu_logo.png`**. Os crawlers das
redes sociais **não renderizam SVG**; trocar ali o formato partiria a pré-visualização de partilha.
É a **única** referência de produto que mantém o PNG, e mantém-no por razão técnica, não por inércia.

---

## 2. O «G» DESAPARECEU — sítio a sítio

| Contexto | Antes | Agora |
|---|---|---|
| Entrada (`auth/login`) | `/img/gescondu_logo.png` | `gescondu_logo_final.svg` |
| 2FA (`auth/2fa-entrar`, `2fa-totp`, `2fa-ativar`) | idem | idem |
| Recuperação / redefinição / convite | idem | idem |
| Seletor de condomínio (`condominios/meus`) | idem | idem |
| **Sidebar** (`layouts/main.handlebars:57`) | idem | idem |
| Homepage: cabeçalho e rodapé | idem | idem |
| Páginas legais (`partials/_pagina-legal`) | idem | idem |
| **Favicon** (os dois layouts) | o **«G»** | wordmark `ges\|condu` sobre azul |
| Portal do condómino | — | **não usa logo de produto** (confirmado na auditoria) |
| Páginas administrativas | — | usam a **casca** `layouts/main` ⇒ herdaram o sidebar novo |

**Sidebar:** já usava o wordmark desde `0a606ca`; **nunca usou `gescondu-marca.png`** no estado atual
(`grep` = 0 referências em produto). A condição do brief («deixar de usar a `gescondu-marca.png` se
este representar o G antigo») está, por isso, **satisfeita por já não haver referência nenhuma** — o
ficheiro mantém-se no repositório como legado, sem uso.

---

## 3. FAVICON — o «G» saiu

| | |
|---|---|
| **Ficheiro** | `public/img/favicon.png` · 64×64 · RGBA |
| **Antes** | sha `ba4c31026b72904ef8b951d1f4e2d03c43c7d9cd78da4bf2cb79c616c28250d2` (6 176 B) — o «G» |
| **Agora** | sha `d66311c7d73208d334cf05bba54dbcafd2608f0ab23c354c787769bbc2a1f493` (2 186 B) |
| **Composição** | wordmark `ges\|condu` centrado sobre **tile azul `#06213F`** |
| **Cache-busting** | `/img/favicon.png?v=20260923a` nos **dois** layouts (`main` e `blank`) |

O `#06213F` é o **azul da aplicação canónico**: é o `theme-color` (`routes/publicas.js:122`,
`helpers/home-publica.js:241,263`), **asserido por teste** em `scripts/test-paginas-publicas.js`
(`<meta name="theme-color" content="#06213F" />`). Não inventei uma cor.

A variante é uma **adaptação do logo final** — não um símbolo novo: é a própria arte do wordmark
(blocos ciano `#21b7d7` e verde `#71b55e` com as letras a branco) redimensionada em **alfa
pré-multiplicado** (sem halo claro) e composta sobre o tile. Receita reproduzível em
`.verify/branding-logo/favicon-final.py` (Pillow, sem numpy). O ficheiro original da raiz
(`favicon.png`, o «G» em 1664×928) **não foi alterado**; o favicon antigo ficou guardado como
evidência em `.verify/branding-logo/favicon-ANTES-G.png`.

### ⛔ Limitação medida — legibilidade a 16×16 (não escondida)

O wordmark é **horizontal (2,75:1)**. Num quadrado de 64 px fica com ~20 px de altura, com as letras a
~9 px; **a 16×16 é ilegível** — lê-se como «quadrado azul com uma faixa colorida». **É geometria, não
gosto:** nenhum enquadramento do wordmark *inteiro* num quadrado resolve isto, porque a largura é
2,75× a altura.

**Implementei a leitura literal do brief** (fundo azul + identidade `ges|condu` + sem o G) e **deixo a
decisão em aberto**. Se se quiser um favicon legível a 16 px, a alternativa é uma **variante técnica**
que o brief autoriza — p. ex. os **dois blocos ciano/verde sem as letras** (que é uma adaptação do
logo final, não um símbolo novo). **Não decidi isso por conta própria.**

Prova visual: `.verify/branding-logo/legibilidade.png` (16/32/64 lado a lado, antigo vs novo) e
`.verify/branding-logo/comparacao-antigo-vs-novo.png`.

---

## 4. O QUE **NÃO** FOI TOCADO

Layout, dimensões estruturais, espaçamentos, cores da aplicação, conteúdo, comportamento,
autenticação, 2FA e regras de negócio: **intocados**. O diff é de **1 linha por vista**.

- **Ficheiros de outra frente preservados integralmente.** `views/partials/_pagina-legal.handlebars` é
  **partilhado** com a frente EPD/DPO (que mexe em `legal.emFalta*`, linhas ~70-82): li
  `git diff -- <ficheiro>` antes, editei **só a linha 53** (o logo) e confirmei que as alterações dela
  continuam lá (`grep -c emFaltaObrigatorios` = **2**). `routes/publicas.js`,
  `scripts/test-paginas-publicas.js` e `views/publicas/politica-privacidade.handlebars` têm **zero**
  referências a logo/favicon — não lhes toquei.
- **Legados preservados, não apagados:** `gescondu-logo-ativo.png`, `gescondu-marca.png`,
  `gescondu-logo-refinado-claro.png` (ainda é *fixture* em `scripts/test-pdf-documentos.js:275`).
  `gescondu_logo.png` mantém-se **só** para o `og:image`.
- **Nada de `git add .` / `-A` / `clean` / `reset --hard` / `checkout .` / `restore .` / `rm`.** Só
  `Edit` cirúrgico; nenhum ficheiro reescrito.

---

## 5. VERIFICAÇÃO

### 5.1 Pesquisa do «G» e dos logos antigos (depois das alterações)

```
grep -rn "gescondu_logo\.png" views/ helpers/ scripts/ app.js
  → helpers/home-publica.js:240   (og:image — INTENCIONAL, tem de ficar PNG)

grep -rn "gescondu-marca\|gescondu-logo-ativo\|gescondu_logo\.svg\|logo_gescondu\|GesCondu\.svg" \
     views/ helpers/ routes/ jobs/ models/ scripts/
  → nenhuma referência em código de produto
```

As vistas pedem **exatamente 2** ficheiros `/img/`: o logo final e o favicon. Ambos existem.

### 5.2 Harness próprio — 37/37, `EXIT 0`

`.verify/branding-logo/verificar-branding-final.js` (10 grupos): asset em `public/img` e `<title>`
errado ausente; **12** vistas com o asset final e **nenhuma** com o antigo; sidebar com o mesmo logo e
sem `gescondu-marca`; nenhum asset de marca antigo em código de produto; favicon **mudado vs `HEAD`** e
`?v=` nos dois layouts; `og:image` ainda `.png`; atributos da homepage == viewBox; **nenhuma imagem
quebrada**; legados preservados; **SVG e favicon servidos por HTTP** (`200`, `image/svg+xml` /
`image/png`, bytes == disco).

Substitui o `verificar-logo-principal.js`, que codificava a decisão anterior («favicon intocável») e
**falha de propósito** agora — foi essa falha que provou que a asserção morde.

### 5.3 Provas por mutação — 3/3 detetadas

| Mutação | Suíte que tem de falhar | Resultado |
|---|---|---|
| Repor `/img/gescondu_logo.png` numa vista de autenticação | `test-fluxo-login.js` | **EXIT 1 — detetada** |
| Idem | `verificar-branding-final.js` | **EXIT 1 — detetada** |
| Reverter o `?v=` do favicon para `20260921a` | `verificar-branding-final.js` | **EXIT 1 — detetada** |

Todas repostas **byte a byte** e conferidas por `sha256` antes/depois.

### 5.4 Testes — 13 verdes (`EXIT 0`)

`check-templates` · `test-vistas` · `test-fluxo-login` · `test-homepage` · `test-tipografia` ·
`test-contraste` · `test-vistas-suporte` · `test-mascara-vistas` · `test-paginas-publicas` ·
`test-modal-confirmar` · `test-tips-vistas` · `test-configuracoes` · `test-area-condomino`

**Testes acoplados atualizados na mesma mudança:** `scripts/test-fluxo-login.js` l.256 (regex de
`casca()`) e l.776 — passaram a exigir `gescondu_logo_final.svg`.

### 5.5 Captura em browser real (msedge + playwright)

Páginas geradas a partir dos **layouts, parciais e helpers reais** (`gerar.mjs`), servidas por HTTP com
o **CSS real**, e medidas no `page.evaluate`:

| Alvo | Logo | `carregado` | Caixa | Notas |
|---|---|---|---|---|
| Sidebar **expandido** | `gescondu_logo_final.svg` | `true` | **107×39** no rail de 244 px | `objectFit:contain` |
| Sidebar **recolhido** | idem | `true` | **67×39** no rail de 68 px | medido após 1400 ms (> transição de 200 ms) |
| Homepage cabeçalho | idem | `true` | 121×44 | `atributos 554x201` |
| Homepage rodapé | idem | `true` | 105×38 | idem |
| Entrada / 2FA / legais | idem | `true` | — | — |

**Erros de página: nenhum. Overflow horizontal: nenhum.** Inspecionei os PNG resultantes com os meus
próprios olhos (não só o DOM) — sidebar e entrada mostram o wordmark limpo sobre o navy, sem o «G».
Antes/depois em `C:\tmp\a9-branding\shots\` vs `shots-novo\`.

### 5.6 Git

- `git diff --check` → **limpo**.
- `git status --short` → ver §6.
- `git diff` revisto linha a linha (§4).

---

## 6. IMPACTO E ESTADO

**Impacto nos dados: nenhum.** Não há migrações, nem BD, nem dados persistidos afetados. É só
apresentação. Os *paths* das vistas mudaram; o conteúdo dos ficheiros legados não.

**`git diff --stat` da frente (15 alterados + 1 novo):**

| Ficheiro | +/− | Nota |
|---|---|---|
| `public/img/favicon.png` | bin 6 176 → 2 186 B | o «G» → `ges\|condu` sobre azul |
| `public/img/gescondu_logo_final.svg` | **novo** | asset principal (2 905 B) |
| `views/layouts/main.handlebars` | 5/5 | sidebar (logo + comentário) + favicon `?v=` |
| `views/layouts/blank.handlebars` | 1/1 | favicon `?v=` |
| `views/partials/_home-cabecalho.handlebars` | 1/1 | logo + `554×201` |
| `views/partials/_home-rodape.handlebars` | 1/1 | logo + `554×201` |
| `views/partials/_pagina-legal.handlebars` | 3/3 | **1 linha minha** (as outras 2 são da frente EPD/DPO) |
| `views/auth/*.handlebars` (7) | 1/1 cada | logo |
| `views/condominios/meus.handlebars` | 1/1 | logo |
| `scripts/test-fluxo-login.js` | 2/2 | asserções acopladas |

**Fora desta frente (não tocado):** `routes/publicas.js`, `scripts/test-paginas-publicas.js`,
`views/publicas/politica-privacidade.handlebars` (frente EPD/DPO).

**Commit real: nenhum.** `HEAD` = `0a606ca`; `origin/main` = `34bd5d3` ⇒ **1 commit por publicar**
(anterior a esta frente). O trabalho desta frente fica **no working tree**.

---

## 7. PARA O DETENTOR DO ROADMAP (não editado)

O `docs/ROADMAP.md` é de outro detentor (só editável com commit+push) — **não lhe toquei**. Precisa de:

1. **§6 — a regra «o favicon é o único asset de marca intocável» está REVOGADA.** O favicon passou a
   `ges|condu` sobre `#06213F`, com `?v=20260923a`.
2. **Logo principal** passa de `public/img/gescondu_logo.png` para
   `public/img/gescondu_logo_final.svg` (12 vistas); o PNG fica **só** para o `og:image`.
3. **Registar a limitação aberta:** legibilidade do favicon a 16×16 (variante técnica por decidir).
4. O `README.md:1` referencia `public/img/logo_gescondu.png` — **14.ª referência**, fora do âmbito
   desta frente (é documental). Fica registada, não corrigida.
