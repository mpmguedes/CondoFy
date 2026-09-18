# Auditoria GesCondu

Fotografia do estado atual do repositório. **Nenhum ficheiro, migration ou
código foi alterado, criado ou corrigido.** Nenhum commit, push ou deploy.

Data: 17 de Setembro de 2026

---

## A. Estado do Git

| Item | Valor |
| --- | --- |
| Branch atual | `main` |
| HEAD local | `da6d672` — *Ligar despesas a deliberacoes do FCR* |
| `/opt/condofy` (produção) | fora do alcance desta máquina — verificado o clone local |
| `git ls-remote origin main` | `da6d6729554a33bc1f4cb84f229dce065cad4e8e` |
| Estado face ao origin | **sincronizado** — HEAD local == `refs/heads/main` remoto |
| Alterações tracked | **nenhuma** (`git status --short` sem linhas `M`/`A`/`D`) |
| Untracked | 15 ficheiros de imagem/logo + `docs/documentos/` + `docs/mobile/` + `.workbuddy-ai/` |
| `git diff --stat` | vazio |
| `git diff --check` | vazio |

Últimos 5 commits:

```
da6d672  Ligar despesas a deliberacoes do FCR
6f4e447  Corrigir rotas de transferencia do FCR
c01d9d6  Implementar deliberacoes e utilizacao do FCR
d4d9614  Implementar transferencias do FCR
d728896  Discriminar FCR nos avisos e recibos
```

**Nota técnica (não é problema do repositório):** `git status -sb` mostra
`[gone]` no tracking e `git rev-parse origin/main` falha com *ambiguous
argument*, apesar de `git ls-remote` confirmar o ref remoto. A causa é um
artefacto do ambiente Git desta máquina: `.git/refs/remotes/origin/main` não
existe como ficheiro, embora o reflog (`.git/logs/refs/remotes/origin/main`)
registe a atualização. O repositório está saudável — 458 ficheiros
versionados, ref local `refs/heads/main` correto. **A sincronização real está
confirmada por `git ls-remote`.**

Os untracked são exatamente os logos/docs que não pertencem a tarefas de
código e continuam fora de qualquer `git add`.

---

## B. Funcionalidades concluídas

| Área | Estado | Evidência |
| --- | --- | --- |
| Autenticação e utilizadores | CONCLUÍDO | `routes/auth.js` (23 rotas): login, logout, recuperação, convite, 2FA, reativação de acesso |
| Multitenancy / condomínios | CONCLUÍDO | `helpers/tenant.js` (sessão validada, papéis admin/gestor/leitura, `pertenceAoAtivo`); `routes/condominios.js`; `routes/global-admin.js` (13 rotas) |
| Estrutura / frações / pessoas | CONCLUÍDO | `routes/admin.js` (frações, condóminos, titularidades, contactos); `models/FracaoTitularidade.js`; `helpers/titularidades.js`; migração 72 |
| Quotas | CONCLUÍDO | `routes/quotas-modulo.js` + `routes/financeiro.js`; `helpers/quotas-calc.js`; `helpers/quotas-config.js`; grelha mapa, conta-corrente, recibos |
| Quotas Extra | CONCLUÍDO | `routes/extra-quotas.js` (11 rotas); `models/ExtraQuota.js` + `ExtraQuotaParcela.js`; `helpers/extra-quota-estado.js`; migrações 67-70 |
| Recibos | CONCLUÍDO | `helpers/recibos.js`; `Recibo` + `ReciboQuota` + `ReciboExtraParcela`; emissão, anulação, PDF, envio |
| Pagamentos | CONCLUÍDO | `Pagamento` + `PagamentoQuota`; pagamentos parciais; comprovativos com validação/rejeição |
| Contas bancárias | CONCLUÍDO | `routes/financeiro.js` (CRUD, saldo por movimentos); `helpers/saldos.js` |
| Orçamento | CONCLUÍDO | `routes/orcamento.js` (20 rotas): rubricas, distribuição, plano, emissão, histórico, estados; migrações 41-56 |
| Despesas | CONCLUÍDO | `routes/financeiro.js`; `models/Despesa.js`; sincronização com movimento bancário |
| Fornecedores | CONCLUÍDO | `routes/fornecedores.js` (16 rotas): CRUD, detalhe, pagamentos, comprovativos, envio |
| Pagamentos a fornecedores | CONCLUÍDO | `models/PagamentoFornecedor.js`; estados + comprovativo + email |
| Saldos de fornecedores | CONCLUÍDO | `models/FornecedorSaldo.js` (`saldo_inicial`/`saldo_transitado`); migração 71 |
| Fundo de Reserva / FCR | CONCLUÍDO | `helpers/fcr.js` (emissão, transferência, recebido, resumo); `views/admin/contas/transferir-fcr.handlebars`; 4 suites de teste |
| Deliberações FCR | CONCLUÍDO | `helpers/fcr-deliberacoes.js`; `agenda_items.deliberacao_estado/valor_aprovado/deliberacao_nota`; migração 74 |
| Assembleias | CONCLUÍDO | `routes/assembleias.js` (19 rotas): ordem de trabalhos, anexos, participantes, convocatória PDF, ata PDF, Drive |
| Documentos | CONCLUÍDO | `routes/documentos.js` (11 rotas); pastas, biblioteca, recibos por ano, emails, acesso por link temporário assinado |
| Google Drive | CONCLUÍDO | `helpers/drive.js` + `helpers/armazenamento/provedores/google-drive.js` |
| Backups | CONCLUÍDO | `jobs/backup.js` (mysqldump + zip + retenção por tipo); `BackupLog`; agendado + manual |
| Email / SMTP / fila | CONCLUÍDO | `routes/emails.js`; `helpers/mailer.js`, `email-fila.js`, `email-templates.js`; `models/EmailFila.js`; cron 5 min |
| Avisos / comunicações | CONCLUÍDO | `routes/avisos.js`; `helpers/avisos.js`; `Aviso` + `AvisoDestinatario` |
| Portal do condómino | CONCLUÍDO | `routes/condomino.js` (14 rotas): quotas, pagamentos, recibos, assembleias, avisos, calendário, documentos, orçamento, situação financeira |
| Relatórios financeiros | CONCLUÍDO | `routes/relatorios.js`; `helpers/relatorio-financeiro.js`; balancete com PDF |
| Configuração do condomínio | CONCLUÍDO | `routes/configuracao.js` (20 rotas); identidade, armazenamento, automações, auditoria |
| Automações | CONCLUÍDO | `helpers/automacoes.js` (matriz tipo × canal); `jobs/scheduler.js` (4 tarefas cron); `jobs/automatizacao.js` |
| Auditoria / logs | CONCLUÍDO | `helpers/audit.js`; `models/AuditLog.js`; `views/admin/configuracao/auditoria.handlebars`; `routes/global-admin.js` |
| Segurança / 2FA / TOTP | CONCLUÍDO | `helpers/doisfatores.js`; `helpers/seguranca.js`; `helpers/sessao.js`; testes `test-2fa`, `test-seguranca`, `test-sessao` |
| OneDrive | CONCLUÍDO | `helpers/armazenamento/provedores/onedrive.js` (901 linhas) — implementação própria, não é o Drive |
| Dropbox | CONCLUÍDO | `helpers/armazenamento/provedores/dropbox.js` (819 linhas) |

---

## C. Funcionalidades parciais

| Área | O que existe | O que falta |
| --- | --- | --- |
| Calendário (admin) | Rota placeholder (`routes/placeholders.js`); calendário real **só no portal do condómino** (`routes/condomino.js:728`) | Vista de calendário para o gestor. O menu lateral mostra "Calendário" ao admin, mas a página é um placeholder com sugestão genérica |
| Votações / quórum | `AgendaItem.sujeito_votacao`; deliberação registada manualmente; texto de quórum nas convocatórias (`helpers/convocatoria.js`, `helpers/pdf-convocatoria.js`) | Votação eletrónica, cálculo de quórum, contagem de votos. Assumido explicitamente como fora do âmbito (`routes/assembleias.js:317`) |
| Importação de dados | Apenas entrada em bloco de valores transitados (`routes/quotas-modulo.js:324`, textarea `name="importar"`, formato `Designação;valor` por linha) | Toda a importação de entidades (frações, pessoas, quotas históricas, saldos). Ver secção F |
| Exportação de dados | Exportação pessoal do titular (ZIP + manifesto) em `helpers/exportacao-dados.js` (402 linhas), acionada pela saída do condomínio (`routes/saida-condominio.js:149`) e por download de documentos | Exportação administrativa do condomínio inteiro (backup lógico utilizável), exportação para migração de software |
| Movimentos bancários (UI) | Cálculo de saldos, criação/edição por despesa/pagamento/transferência; `helpers/movimentos.js`, `helpers/saldos.js` | **Extrato visível na interface.** Não existe nenhuma rota nem vista que liste movimentos de uma conta. `views/admin/contas/listar.handlebars` mostra apenas Nome/Banco/IBAN/Tipo/Saldo/Estado — sem detalhe por conta e sem listagem de movimentos |
| Transferir administração | Mencionado e explicitamente marcado como não implementado em `routes/saida-condominio.js:7` | Fluxo de entrega da administração a outra pessoa |
| Categorias / métodos de pagamento | Modelos + rotas (`routes/financeiro.js:337-367`) | Sem `condominio_id` — são partilhados por todos os condomínios (ver secção E) |
| Configuração de quotas | `helpers/quotas-config.js`, grelha, geração | Sem `condominio_id` — a configuração de quota é **global à instalação** (ver secção E) |

---

## D. Funcionalidades por fazer

| Área | Estado atual | Objetivo necessário |
| --- | --- | --- |
| Amenidades | Só placeholder (`routes/placeholders.js` — `amenidades`) | Reserva de espaços comuns (salão, piscina, ginásio) com calendário e regras |
| Tickets / serviços | Só placeholder (`tickets`) | Registo de ocorrências/manutenção com estado e responsável |
| Seguros | Só placeholder (`seguros`) | Apólices, seguradora, vigência, prémios, sinistros |
| Votações | Só placeholder (`votacoes`); deliberação manual | Votação por ponto da ordem de trabalhos, quórum e contagem |
| Calendário (gestor) | Só placeholder (`calendario`) | Vista agregada de eventos do condomínio para a administração |
| Importação de dados | Inexistente (exceto valores transitados) | Ver secção F |
| Exportação administrativa | Inexistente | Ver secção F |
| Transferir administração | Inexistente | Entrega do papel de administrador a outro utilizador |
| Extrato de conta bancária | Inexistente na UI | Listagem de movimentos por conta, com filtros e conciliação |

---

## E. Problemas/inconsistências encontrados

Só problemas concretamente verificados no código.

### E1. `Configuracao` não tem `condominio_id` — configuração de quota é global

**Verificado.** `models/Configuracao.js` tem apenas `chave` (unique) e `valor`.
`helpers/quotas-config.js` usa chaves fixas `quota_valor_1000` e
`quota_fcr_percentagem`, sem qualquer sufixo de condomínio.

- `getQuotaConfig()` (`helpers/quotas-config.js:36`) **não recebe `condominioId`**.
- `setQuotaConfig` (`:56`) escreve as mesmas duas chaves.
- Consumidores: `routes/financeiro.js` (626, 739, 823, 833),
  `routes/orcamento.js` (115, 215), `routes/quotas-modulo.js` (123),
  `jobs/automatizacao.js` (20).

**Consequência:** alterar o valor por 1000‰ ou a % do FCR num condomínio altera
a configuração de todos os condomínios da instalação. Numa instalação
multi-condomínio (que é o modelo declarado do produto — existe
`sistema/global-admin`, `UserCondominio` e papéis por condomínio), isto é uma
falha de isolamento.

**Contraste:** as configurações de armazenamento **já são** por condomínio —
`helpers/armazenamento/ligacoes.js:52-57` usa `storage:principal:c<id>`,
`storage:tokens:<provedor>:c<id>`, `storage:raiz:<provedor>:c<id>`. O padrão de
prefixo por condomínio existe no projeto; a quota e o FCR não o usam.

### E2. `jobs/automatizacao.js` opera sobre **todos** os condomínios

**Verificado.** O ficheiro tem 124 linhas e não contém uma única ocorrência de
`condominioId` em contexto de filtro (só em `condominioId: q.condominio_id` na
linha 116, ao enfileirar o email).

- `gerarQuotasAutomaticas()` (linha 24):
  `Fracao.findAll({ where: { estado: 'ativo' } })` — **sem `condominio_id`**.
  Gera quotas do mês para as frações de todos os condomínios, usando a
  configuração de quota global (E1).
- `enviarLembretesAutomaticos()` (linha 91):
  `resolverDestinatarios({ modo: 'fracoes', fracoes: [q.fracao_id] })` — **sem o
  segundo argumento `condominioId`**.

`helpers/avisos.js:11` define `resolverDestinatarios(selecao, condominioId)` e
aplica `escopoPessoa` só quando `condominioId` é passado (`:16-18`). Sem ele, o
escopo por condomínio é desligado.

**Consequência:** o cron diário das 05:00 gera quotas em todos os condomínios e
o das 08:15 pode resolver contactos fora do condomínio da quota. As rotas
interativas passam sempre `req.condominioId` — a inconsistência está confinada
ao job.

### E3. Quatro rotas em `routes/financeiro.js` são inalcançáveis (código morto)

**Verificado por ordem de montagem.** `app.js` monta `quotas-modulo` (linha 200)
antes de `financeiro` (linha 203), ambos em `/admin`. O Express resolve pela
primeira rota que casa.

| Rota | `quotas-modulo.js` (vence) | `financeiro.js` (nunca corre) |
| --- | --- | --- |
| `GET /admin/quotas` | `:116` — mapa de quotas (isolado) | `:584` — código morto |
| `GET /admin/quotas/grelha` | `:1130` — redirect | `:706` — código morto |
| `GET /admin/pagamentos` | `:1128` — redirect | `:1183` — código morto |
| `GET /admin/pagamentos/enviar-recibos` | `:1129` — redirect | `:1420` — código morto |

O bloco morto em `financeiro.js:584` é o mais relevante: consulta
`Quota.findAll({ where })` sem `condominio_id` (`:588-590`) e
`Fracao.findAll({ where: { estado: 'ativo' } })` sem `condominio_id` (`:627`).
**Não é explorável** porque nunca é alcançado — mas é um risco latente: se a
ordem de montagem em `app.js` for alguma vez invertida, passa a servir dados
cruzados entre condomínios.

Vistas que ficam órfãs por arrasto: `views/admin/quotas/listar.handlebars`
(só referenciada em `financeiro.js:639`) e `views/admin/quotas/grelha.handlebars`
(só em `financeiro.js:727`).

### E4. Vistas órfãs (3, além das afetadas por E3)

| Vista | Observação |
| --- | --- |
| `views/admin/orcamento/index.handlebars` | Nenhuma rota a referencia; `routes/orcamento.js` renderiza `listar`, `form`, `detalhe`, `distribuicao`, `plano`, `emitir`, `historico`. A rota `/admin/orcamento` (`:104`) usa `admin/orcamento/listar` |
| `views/condomino/situacao.handlebars` | Substituída por `condomino/situacao-financeira.handlebars`; `routes/condomino.js:1004` faz `/situacao` → `paginaSituacaoFinanceira` |
| `views/admin/condominos/contactos.handlebars` | A rota (`routes/admin.js:1282`) faz redirect para `/editar#contactos`; a vista mantém-se por compatibilidade, como o próprio comentário indica |

(`views/error.handlebars` e os `partials/*` **não** são órfãos — são usados por
`app.js:240/248` e por inclusão em `{{> partial}}`.)

### E5. `Categoria` e `MetodoPagamento` sem `condominio_id`

**Verificado.** `models/Categoria.js` e `models/MetodoPagamento.js` não têm
`condominio_id`. São listas partilhadas por todos os condomínios
(`routes/financeiro.js:339`, `:393`). Ao contrário de E1/E2, isto pode ser
intencional (tabelas de referência), mas não está documentado como decisão —
e uma categoria "Obras do Bloco A" de um condomínio fica visível no outro.

### E6. `test-drive.js` fora da suite `test:offline`

**Verificado.** Existem 49 scripts `test-*.js`; 48 estão em `package.json`. O
único excluído é `scripts/test-drive.js` (`grep -c` devolve 0). Provavelmente
por exigir rede/credenciais reais, mas não há nota a explicá-lo.

### E7. `sincronizarMovimentoDespesa` não aceita `transaction`

**Verificado.** `helpers/movimentos.js:125-157` recebe `(despesa, userId,
transaction)` mas as duas escritas fazem `await movimento.update(...)`,
`await criarMovimento(...)` **sem propagar `transaction`** (`:130-138` e
`:142-152` passam-na; `:155` — o `update({ estado: 'anulado' })` na anulação —
**não** passa). A criação da despesa e o movimento não são atómicos. Fora do
âmbito estrito da 2H.4, mas é uma fragilidade de consistência já existente.

### Sem problemas encontrados (verificado, não presumido)

- **Modelos vs migrations:** 44 tabelas criadas em migrations, 44 `tableName`
  nos modelos — correspondência exata, sem divergência em nenhum sentido.
- **Rotas vs vistas:** as 101 vistas referenciadas por `res.render` existem
  todas em `views/`.
- **Menus:** todos os links do sidebar resolvem. Os placeholders
  (`votacoes`, `calendario`, `amenidades`, `tickets`, `seguros`) estão
  registados em `routes/placeholders.js` e montados após `relatorios.js`
  (`app.js:216-217`), pelo que não são apanhados por outra rota.
- **`helpers/storage.js` é uma fachada** — nenhuma rota fala diretamente com
  um provedor.

---

## F. Importação/exportação

### F1. Importação

**Estado: praticamente inexistente.**

A única importação no produto é a entrada em bloco de valores transitados:

- `routes/quotas-modulo.js:324-334` — campo `importar` (textarea,
  `views/admin/quotas/mapa.handlebars:157-158`), formato `Designação;valor` por
  linha, dentro do modal "Valores transitados".
- Apenas aceita dois campos por linha e casa por designação de fração.
- Testado em `scripts/test-quotas-modulo.js:373` (campos inválidos ignorados).

Não existe, em lado nenhum:

- upload de ficheiro (CSV/Excel) para importação — `multer` é usado só para
  logótipos (`configuracao.js:48`), anexos de assembleia (`assembleias.js:33`),
  documentos (`documentos.js:34`) e comprovativos (`fornecedores.js:43`);
- importação de frações, pessoas, titularidades, quotas históricas, pagamentos,
  despesas ou saldos de fornecedores;
- pré-visualização, mapa de colunas, validação por linha, relatório de erros ou
  correção antes de gravar;
- preservação de relações entre entidades na importação (porque não existe
  importação de entidades).

**Confirmado pela própria documentação:** `docs/PLANO.md:33-36` declara que não
há migração automática e que *"scripts de importação podem ser adicionados se
necessário"* — ou seja, está identificado como trabalho por fazer, não como
funcionalidade existente.

### F2. Exportação

**Estado: existe, mas com outro objetivo — é exportação do titular (RGPD), não
exportação do condomínio.**

`helpers/exportacao-dados.js` (402 linhas) constrói um ZIP com manifesto,
acionado por:

- `routes/saida-condominio.js:149` (`POST /saida/exportar`) — "Descarregar a
  minha informação", no fluxo de saída do condomínio;
- download de documentos disponibilizados (`routes/relatorios.js:156` gera PDF;
  documentos servidos por rota autenticada e por link temporário).

**Conteúdo do ZIP** (7 módulos, todos em CSV UTF-8 com BOM e `;`):

| Módulo | Conteúdo |
| --- | --- |
| `MANIFEST.txt` | O que entra, o que não entra e porquê, notas legais |
| `Dados pessoais/` | Identificação, contactos do próprio |
| `Fracoes/` | `fracoes.csv`, `titularidades.csv` (histórico com períodos) |
| `Quotas/` | `quotas.csv` — valor, pago, em dívida, vencimento, estado |
| `Pagamentos/` | Pagamentos das suas frações + comprovativos |
| `Recibos/` | Recibos das suas frações |
| `Assembleias/` | Assembleias e a sua presença |
| `Comunicacoes/` | Comunicações gerais do condomínio |
| `Documentos/` | Documentos disponibilizados, organizados por pasta |

**Pontos fortes verificados:**
- Filtro por titularidade real — exclui dados de terceiros, comprovativos de
  outras frações e comunicações internas.
- Manifesto explícito do que ficou de fora (limites:
  `MAX_FICHEIROS_DOCUMENTOS = 40`, `MAX_BYTES_DOCUMENTO = 8 MB`).
- Não apaga nada; o histórico contabilístico do condomínio permanece.
- Sem `condominio_id` no escopo → todas as leituras são filtradas por
  `condominioId` recebido.
- Testado em `scripts/test-titularidades.js:311-396` (casos: normal, vazio,
  titular antigo).

**O que falta para servir migração de software:**
- Não existe exportação **do condomínio** (só do titular). Um administrador não
  consegue extrair frações + pessoas + titularidades + quotas + pagamentos +
  despesas + movimentos do seu condomínio.
- Não existe exportação de **entidades-mestre** (frações, pessoas, categorias,
  fornecedores) em formato reimportável.
- Não existe exportação de **movimentos bancários** nem de **despesas**.
- Não há formato com chaves estáveis que permita reconstruir relações
  (a exportação atual é orientada a leitura humana, não a reimportação).
- Não há importação complementar — exportar não resolve a barreira à entrada.

### F3. Síntese

A exportação do titular está **completa e bem construída** para o seu fim
(RGPD e transparência). A importação — que é a peça central para reduzir a
barreira à mudança de outro software, como o briefing indica — **não existe**.
Sem importação, um condomínio que queira mudar para o GesCondu tem de inserir
frações, pessoas, titularidades, quotas históricas e saldos à mão.

---

## G. Núcleo necessário para o produto

### Essencial

Necessário para o fluxo principal de gestão do condomínio.

1. **Isolamento por condomínio da configuração de quota e FCR** (E1, E2) —
   pré-requisito de correção numa instalação multi-condomínio.
2. **Extrato de conta bancária na interface** — consulta dos movimentos que já
   existem na base de dados mas não são visíveis (verificado: nenhuma rota ou
   vista os mostra).
3. **Importação de dados** — frações, pessoas, titularidades, quotas históricas
   e saldos. É o que permite adotar o produto num condomínio já em gestão.
4. **Exportação do condomínio** (administrativa) — a contrapartida da
   importação e a garantia de não ficar preso ao software.
5. **Votações e quórum** — as deliberações FCR dependem de aprovação em
   assembleia; hoje o resultado é registado à mão sem base de cálculo.

### Importante

Aumentam bastante a utilidade, mas não bloqueiam o núcleo.

6. Calendário do gestor (hoje só existe no portal do condómino).
7. Relatórios além do financeiro (por fração, por ano, situação de dívida).
8. Tickets / serviços e Amenidades (as duas lacunas de gestão operacional).
9. Seguros (apólices e vigências — obrigação frequente da administração).
10. Transferir administração (entrega do papel a outra pessoa).

### Secundário

Úteis, podem esperar.

11. Consolidação de `Categoria` / `MetodoPagamento` por condomínio (E5), se a
    partilha não for uma decisão de produto assumida.
12. Limpeza do código morto em `routes/financeiro.js` e das vistas órfãs
    (E3, E4).
13. Inclusão de `test-drive.js` na suite ou nota a explicar a exclusão (E6).
14. Propagação de `transaction` em `sincronizarMovimentoDespesa` (E7).

---

## H. Próximos passos sugeridos

Sequência lógica. **Nenhuma tarefa foi escolhida nem iniciada.**

**Fase 1 — Correção estrutural (antes de acrescentar funcionalidades)**
Os problemas E1 e E2 tocam em dados financeiros e devem ser resolvidos antes de
qualquer nova área, para não se acumular trabalho sobre uma base inconsistente.
Inclui decidir explicitamente se `Categoria`/`MetodoPagamento` passam a ser por
condomínio (E5). Depende de uma decisão sobre migração de configurações
existentes — a configuração atual é uma só, e passará a ser uma por condomínio;
é preciso definir qual o valor a replicar.

**Fase 2 — Visibilidade do que já existe**
Extrato de conta bancária. O cálculo já está feito (`helpers/movimentos.js`,
`helpers/saldos.js`); falta expor. Baixo risco, valor imediato para o
administrador, e permite validar o motor financeiro com dados reais.

**Fase 3 — Importação e exportação**
É a área que o briefing identifica como central e a maior lacuna verificada.
Ordem sugerida dentro da fase:
1. definir o formato de troca (entidades, chaves, relações);
2. exportação do condomínio nesse formato (mais simples: os dados já existem);
3. importação com pré-visualização, validação por linha e relatório de erros;
4. correção assistida antes de gravar.

**Fase 4 — Assembleias e votações**
Votação por ponto, quórum e contagem. Liga-se às deliberações FCR já
implementadas, que hoje dependem de registo manual.

**Fase 5 — Gestão operacional**
Tickets/serviços, Amenidades, Seguros e Calendário do gestor — as quatro áreas
que hoje são placeholders.

**Fase 6 — Limpeza técnica**
Código morto e vistas órfãs (E3, E4), `test-drive.js` (E6),
`transaction` em `sincronizarMovimentoDespesa` (E7). Sem impacto funcional;
pode ser feito a par das fases anteriores, desde que em alterações isoladas.

---

## Verificação de testes

`npm run test:offline` executado nesta sessão: **exit 0**, 57 grupos de teste
passaram, 0 falhas (48 scripts `test-*.js` + `check-templates.js`).
`node scripts/preflight.js` → migrações carregam e exportam `up`/`down`
corretamente; a migração 75 é a última da pasta.
