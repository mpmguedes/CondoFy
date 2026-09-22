# Propostas — pendências que exigem decisão

> **Documento de PROPOSTAS. Nada aqui está implementado.**
> Levantamento verificado **no código** em 2026-09-21 (não a partir do Roadmap).
> A decisão é do A9; as opções estão ordenadas por recomendação.
>
> Âmbito: apenas os pontos que a frente de autenticação/autorização/segurança
> transversal não podia fechar sozinha, por dependerem de uma decisão de produto
> ou por alterarem dados financeiros existentes.

---

## 1. P39 — `Categoria` e `MetodoPagamento` partilhados entre condomínios

> No pedido original este ponto vinha numerado como «P40»; no Roadmap é **P39**
> («Isolamento de configuração vs partilha de `Categoria`/`MetodoPagamento`»,
> §3.2, origem E5 de `docs/AUDITORIA-2026-09-17.md`). O P40 do Roadmap é outro
> assunto (allow-list de suporte).

### 1.1 Estado verificado no código

| Facto | Evidência |
|---|---|
| `categorias` **não tem** `condominio_id` | `models/Categoria.js`; migração `20260101000007` |
| `metodos_pagamento` **não tem** `condominio_id` | `models/MetodoPagamento.js`; migração `20260101000008` |
| `nome` **não é único** em nenhuma das duas | migrações `...007` / `...008`: nenhum índice |
| Um **gestor de condomínio** cria e altera categorias | `routes/financeiro.js:475-495` (`GET/POST /categorias`, `POST /categorias/:id`), sob `comPapel('gestor')` (`financeiro.js:83`) |
| Não existe CRUD de métodos de pagamento | nenhum `MetodoPagamento.create/update/destroy` em `routes/` — só seed/migração |
| O tipo `'documento'` **é** válido | migração `20260101000059` alarga o ENUM (o modelo está coerente) |
| Relatórios agregam **pelo NOME** da categoria | `routes/admin.js:252-265` (`porCategoria[nome]`) |

`categoria_id` é referenciado por `Despesa`, `MovimentoBancario`, `OrcamentoItem`,
`OrcamentoRubrica` e `DocumentoCategoria`; `metodo_pagamento_id` por `Pagamento`.
**Os dados financeiros estão isolados por condomínio — o DICIONÁRIO é que é
partilhado.**

### 1.2 Consequências reais (porque isto é um problema)

1. **Mutação entre condomínios.** O gestor do condomínio A renomeia ou desativa
   uma categoria que o condomínio B usa. Não é uma hipótese teórica: é o
   comportamento de `POST /categorias/:id`.
2. **Categoria desativada noutro lado.** `where: { ativo: true }` esconde-a dos
   formulários (`financeiro.js:547,659,1512`), mas os lançamentos históricos do
   condomínio B continuam a apontar para ela — fica «invisível mas referenciada».
3. **Fuga de informação entre condomínios.** Um nome escrito no condomínio A
   (por exemplo o nome de um fornecedor) passa a constar da lista de todos.
4. **Integridade dos relatórios.** Como se agrega pelo **nome**: renomear
   **parte** a série histórica em duas, e duas categorias com o mesmo nome
   **somam-se** silenciosamente. Sem unicidade de `nome`, isto é possível hoje.

### 1.3 Opções

**Opção A+ — o dicionário passa a ser da PLATAFORMA (recomendada como passo imediato).**
Manter as tabelas como estão (globais) e mudar **quem pode mexer nelas**: o CRUD
de categorias sai do papel de condomínio (`gestor`) e passa a exigir o
**Super Admin**. As categorias continuam a ser escolhidas livremente em cada
condomínio (a leitura não muda).
- **A favor:** fecha as consequências 1–3 com uma alteração pequena e reversível;
  zero migração; zero risco para os dados financeiros; coerente com o facto de o
  dicionário já ser, na prática, da instalação.
- **Contra:** não dá vocabulário próprio a cada condomínio (consequência 4
  permanece); obriga a que a criação de uma categoria nova deixe de acontecer
  «a meio» do trabalho do gestor.

**Opção B — `condominio_id` + unicidade `(condominio_id, nome)`.**
Dicionário por condomínio, como o resto do modelo.
- **A favor:** resolve tudo, incluindo o vocabulário próprio; elimina a
  ambiguidade dos relatórios por nome (unicidade).
- **Contra:** **migração de dados com risco real** — é preciso duplicar cada
  categoria por condomínio e **remapear** `categoria_id` em cinco tabelas
  (`despesas`, `movimentos_bancarios`, `orcamento_itens`, `orcamento_rubricas`,
  `documento_categorias`) a partir do `condominio_id` de cada linha, mais decidir
  o destino das linhas sem condomínio. Toca dados financeiros já validados.

**Opção C — catálogo base global + ativação/renomeação por condomínio.**
Tabela de sobreposição (`categoria_condominio`) com `ativa`/`nome_local`.
- **A favor:** preserva todos os `categoria_id` existentes (nenhum remapeamento).
- **Contra:** dois níveis de vocabulário para explicar na interface; o nome
  partilhado continua visível; mais complexidade do que o problema justifica
  neste momento.

### 1.4 Recomendação

**Opção A+ agora, Opção B como objetivo.** A+ fecha o risco de mutação e de fuga
entre condomínios (o que é um problema de isolamento) sem tocar em dados
financeiros; B fica para uma frente própria, com migração desenhada e testada.

### 1.5 Decisão necessária

1. A+ ou B (ou C)?
2. Se A+: a criação de categorias deixa de existir para o gestor, ou passa a
   existir um pedido de categoria que o Super Admin aprova?

---

## 2. P42 — Bloqueio por conta (lockout) no início de sessão

### 2.1 Estado verificado no código

`helpers/seguranca.js` tem **apenas** `createLimiter({ rotulo, max, janelaMs })`,
um contador em memória por **`ip:rotulo`**. `routes/auth.js:18-41` usa-o em quatro
pontos: `login` (10/10 min), `recuperar` (5/15 min), `redefinir` (10/1 h) e
`2fa` (8/15 min). **Não existe contador por conta** — um ataque distribuído por
vários IPs contra o mesmo email não é travado por este mecanismo.

### 2.2 O que um lockout acrescenta — e o que custa

Acrescenta: trava a força bruta distribuída contra uma conta concreta.
Custa, e é aqui que está a decisão:

1. **Negação de serviço por bloqueio.** Quem souber o email de alguém pode
   bloquear-lhe a conta com tentativas falhadas de propósito. O ataque passa a
   ser «impedir o acesso» em vez de «adivinhar a password».
2. **Falsos positivos.** IP partilhado (escritório, NAT) + erros legítimos.
3. **Saída do bloqueio.** Temporário (auto-desbloqueia) ou até intervenção?
   Sem caminho de saída, um bloqueio é um incidente de suporte.
4. **Onde guardar.** Em memória (como o rate limiting atual) perde-se ao
   reiniciar e não serve multi-processo; em BD exige coluna nova (migração).
5. **Interação com o 2FA.** Uma conta bloqueada antes do 2FA não chega a pedir o
   segundo fator — e um atacante que já tenha a password usa isso para negar o
   acesso.

### 2.3 Opções

**Opção 1 — Lockout progressivo por conta, temporário, em memória (recomendada).**
Contador por email (além do de IP): a partir de N falhas, um atraso crescente
(ex.: 1 s, 2 s, 4 s, … com teto), reposto no primeiro início de sessão bem
sucedido. **Não** bloqueia a conta: **abranda** as tentativas.
- **A favor:** mata a força bruta distribuída sem criar o vetor de DoS (uma conta
  nunca fica inacessível ao dono legítimo); não exige migração; reaproveita o
  módulo existente; o utilizador legítimo quase não nota (1 s).
- **Contra:** não trava definitivamente; um atraso máximo mal escolhido ainda
  permite tentativas lentas.

**Opção 2 — Bloqueio por conta com auto-desbloqueio (ex.: 15 min) + aviso por email.**
- **A favor:** trava mesmo; o aviso por email dá visibilidade ao titular.
- **Contra:** é exatamente o vetor de DoS do ponto 1; exige decidir N, duração e
  o texto do email; em memória, o bloqueio desaparece com um reinício.

**Opção 3 — Manter só o rate limiting por IP.**
- **A favor:** zero risco novo.
- **Contra:** deixa em aberto o cenário que motivou P42.

### 2.4 Recomendação

**Opção 1.** É a única que melhora a resistência sem introduzir o vetor de
negação de serviço, e não depende de nenhuma decisão de política difícil
(não há «contas bloqueadas» para explicar ao utilizador nem para desbloquear à
mão). Se o A9 quiser um bloqueio efetivo, então a Opção 2 exige decidir os
parâmetros do ponto 2.2 antes de escrever código.

### 2.5 Decisão necessária

1. Opção 1, 2 ou 3?
2. Se 2: quantas falhas, durante quanto tempo, e o desbloqueio é automático ou
   exige intervenção de um administrador?

---

## 3. P15 — vista de contactos «órfã»

**Não é um defeito.** Verificado no código:

- `routes/admin.js:1654-1660` — `GET /admin/condominos/:id/contactos`
  **redireciona** para `/admin/condominos/:id/editar#contactos`, com comentário a
  explicar que a página se mantém por compatibilidade;
- os contactos são geridos na própria ficha de edição
  (`sincronizarContactosPessoa`, `routes/admin.js:975,1069`);
- `views/admin/condominos/contactos.handlebars` existe mas **nenhuma rota a
  renderiza**; os formulários que contém apontam para rotas que já não existem
  (`/admin/condominos/contactos/:id/principal`, `.../eliminar`).

**Recomendação:** manter (é inofensiva e preserva a compatibilidade do URL) ou
apagar a vista como limpeza. Apagar é seguro — nenhum teste a compila
(`scripts/test-vistas.js` compila vistas explicitamente e não a inclui) — mas
**não** foi feito nesta frente por ser ficheiro de outra área.

**Decisão necessária:** manter ou apagar `views/admin/condominos/contactos.handlebars`?

---

## 4. Fora de âmbito (deliberadamente)

- **Ensinar o motor de tips a distinguir Super Admin (P34).** Não é necessário:
  o registo não tem nenhum CTA que exija Super Admin, e o Super Admin é um papel
  de **plataforma** — não de condomínio. Passou a haver um teste que fixa esta
  decisão (`scripts/test-tips.js`, bloco P34).
- **Alterar o mecanismo de allow-list de suporte.** Intocado.
- **Qualquer alteração a quotas, FCR, saldos ou numeração.** Intocados.
