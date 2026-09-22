# Tips contextuais do backoffice — arquitetura

> **Resumo:** existe **um só motor** de Tips contextuais (`helpers/tips.js`). Um Tip é
> **orientação**, não alarme: só aparece quando a situação que descreve **existe mesmo**, é
> **dispensável**, e a dispensa vive na tabela **já existente** `recomendacao_estados` — **sem
> coluna nova e sem migração**. O isolamento é por **conta** e por **condomínio**, com o
> condomínio codificado na própria chave (`tip:<id>@c<condominioId>`).
>
> Este documento descreve o motor, o catálogo, as condições, a dispensa, o isolamento, as áreas,
> as prioridades, a relação com backups e os **limites deliberados**.

---

## 1. O que é um Tip (e o que não é)

| | Sinais (`helpers/dashboard.js`) | **Tips (`helpers/tips.js`)** |
|---|---|---|
| Natureza | Factos operacionais que exigem decisão **hoje** | **Orientação** que explica e ajuda a compreender |
| Exemplo | «há 3 quotas em atraso» | «a soma das permilagens não fecha 1000‰» |
| Um zero | É um sinal | **Não** é um Tip |
| Efeito | Alerta | Convite a agir, com uma ação concreta |

Um Tip **não** substitui um sinal, **não** é um alerta e **não** bloqueia nada. A sua função é
explicar uma situação real e apontar o caminho para a resolver.

---

## 2. Motor único

```
helpers/tips.js                     ← O MOTOR (decisão pura + dispensa)
├── helpers/tips/registo-administracao.js   ← registo do domínio ADMINISTRAÇÃO
└── helpers/tips/contexto.js                ← ponte dados-reais → motor (sem queries próprias)

helpers/recomendacoes.js            ← motor do PORTAL (recomendações da conta)
└── reutilizado por `tips.js` para a JANELA DE DISPENSA (uma só implementação)
```

- **Um só motor.** Não existe — nem deve passar a existir — um segundo motor de Tips. Quem quiser
  acrescentar um Tip junta **uma entrada a um registo**; o âmbito, as áreas, a prioridade, a
  condição, a dispensa e a apresentação já funcionam.
- **Dois registos, um motor.** O `REGISTO` vive em `helpers/tips.js` (condomínio: frações, contas,
  assembleias, armazenamento) e é **acrescentado** pelo registo de `helpers/tips/registo-administracao.js`
  (administração: backups e armazenamento). O motor lê os dois como uma lista só.
- **Uma só tabela de dispensa.** Portal e backoffice partilham `recomendacao_estados`.
- **Uma só implementação de janela.** `estaDispensada`/`proximaApresentacao` vêm de
  `helpers/recomendacoes.js` — não há uma segunda aritmética de datas.
- **Decisão pura.** `elegiveis`/`escolher` não falam com a base de dados. As **únicas** funções que
  tocam no modelo são `carregarDispensas` e `registarDispensa`.

---

## 3. Como um Tip é decidido

Um Tip só é apresentado quando **todas** as condições se verificam (por esta ordem, em `elegiveis`):

1. **Existe condomínio válido.** Sem `ctx.condominioId` válido não se apresenta nada — os Tips são
   por condomínio e sem âmbito não há chave de dispensa.
2. **O âmbito é o pedido.** Se a página indicar `ctx.ambito`, o Tip tem de pertencer a esse âmbito
   (`condominio` ou `instalacao`). Sem pedido, não se filtra (comportamento anterior à generalização).
3. **A área é adequada.** Se o Tip declarar `areas` e a página indicar `ctx.area`, têm de coincidir.
4. **O público é suficiente.** Um Tip cujo destino exige `admin` não se mostra a um `gestor` (levaria
   a um 302). Espelha `helpers/tenant.js: PAPEIS`.
5. **A condição é verdadeira.** A `condicao(ctx)` devolve dados (mensagem) ou `null`. **O estado real
   manda**: um zero não é um Tip, e um Tip cuja situação desapareceu deixa de ser elegível mesmo que
   tenha sido dispensado antes.
6. **Não foi dispensado.** Se o utilizador o dispensou e o intervalo ainda não terminou, não aparece.

E, por fim, **não se repete**: o motor escolhe até `LIMITE_APRESENTACAO` (3) Tips, por prioridade
decrescente e, em empate, pela ordem do registo (apresentação **determinística**).

---

## 4. Catálogo

14 Tips. `areas` vazio significa que o Tip não declara páginas próprias (ver §7).

### Condomínio (`helpers/tips.js`)

| id | tipo | público | prio | ação | condição (resumo) |
|---|---|---|---|---|---|
| `permilagem_incompleta` | risco | gestor | 100 | Rever frações | há frações e a soma das permilagens ≠ 1000‰ |
| `fracoes_por_definir` | conclusao | gestor | 80 | Criar frações | existem 0 frações |
| `fracoes_sem_titular` | conclusao | gestor | 80 | Ver frações | há frações sem titular associado |
| `contas_por_definir` | conclusao | gestor | 80 | Criar conta | não existe nenhuma conta bancária |
| `conta_fundo_reserva_em_falta` | conclusao | gestor | 80 | Gerir contas | há contas mas nenhuma marcada como fundo de reserva |
| `assembleias_sem_ata` | conclusao | gestor | 80 | Ver assembleias | há assembleias realizadas sem ata registada |
| `backup_sem_copia_externa` | compreensao | admin | 50 | Escolher destino | há ligações de armazenamento mas nenhum destino de backup |

### Administração (`helpers/tips/registo-administracao.js`)

| id | tipo | público | prio | ação | condição (resumo) |
|---|---|---|---|---|---|
| `backup_ultimo_falhou` | aviso | admin | 95 | Ver backups | o último backup terminou em erro |
| `backup_desatualizado` | aviso | admin | 88 | Ver backups | último backup há mais de 7 dias |
| `backup_destino_sem_ligacao` | aviso | admin | 85 | Ligar conta | há destino escolhido mas a ligação não está utilizável |
| `backup_cloud_nao_criada` | aviso | admin | 80 | Ver backups | há destino local mas nunca se criou cópia cloud |
| `backup_servico_ligado_sem_uso` | descoberta | admin | 60 | Mudar destino | há serviços ligados que não servem de destino |
| `armazenamento_documentos_e_backups` | compreensao | admin | 25 | Ver as duas secções | documento e backup são coisas distintas (intervalo 90 dias) |
| `armazenamento_estrutura_por_provedor` | descoberta | admin | 22 | Ver pastas | cada provedor tem a sua estrutura de pastas (intervalo 90 dias) |

### Dois candidatos retirados (deliberadamente)

- **`backup_retencao_no_minimo`** — o único destino para ajustar a retenção é `/global/armazenamento`,
  que exige **Super Admin**. O motor só conhece papéis de condomínio (`admin`/`gestor`) e **não
  consegue distinguir** um Super Admin; apresentá-lo seria um **beco sem saída**.
- **`backup_sem_destino_cloud`** — redundante com `backup_sem_copia_externa`, que já cobre «há
  serviços ligados mas nenhum destino de backup». Dois Tips para a mesma situação seria ruído.

---

## 5. Condições contextuais — dados reais, nada inventado

Cada condição lê **um dado que já existe**. Não há contadores de «novidade» que o sistema não saiba
responder, nem nomes de serviços fabricados.

**Backups e armazenamento** — o contexto vem de dados **já carregados pela página**
(`helpers/tips/contexto.js: contextoDeArmazenamento`), a partir de:

- `helpers/backup-estado.js: interpretar` → `estado` (`sem_historico`, `em_curso`, `erro`, `local`,
  `local_com_cloud`, `local_copia_cloud_falhada`), `temLocal` e a data do último backup;
- a fachada de armazenamento (`storage.estadoDoCondominio(cid)`) → `provedores[]`, `plataforma[]`,
  `temLigacoes`, e `backup.destino`/`backup.usavel`.

Regras de segurança dos dados, no `contextoDeArmazenamento`:

- copia **apenas** os campos necessários (`nome`, `ligado`, `ligadoPlataforma`, `estado`,
  `temLocal`, `destino`, `usavel`, `diasDesde`) — **nunca** contas, tokens ou segredos;
- copia o booleano `usavel` **já calculado** pela fachada. **Nunca** chama
  `ligacoes.ligacaoParaBackup()`, que pode resolver para a ligação de **outro** condomínio;
- **não inventa** dados ausentes: um campo em falta é um campo em falta, e a condição trata isso
  como «não sei» (não apresenta), nunca como «está bem» nem como «está mal».

**Não duplicação** — as condições são escritas para não gerarem dois Tips equivalentes:
`backup_desatualizado` **não** se aplica quando o estado é `erro` ou `local_copia_cloud_falhada`
(esses são `backup_ultimo_falhou`/`backup_cloud_nao_criada`), e `backup_cloud_nao_criada` só aparece
quando já existe destino local.

---

## 6. Dispensa — a tabela que já existe

A dispensa usa **exclusivamente** a tabela `recomendacao_estados` (migração `20260101000073`), com
as colunas `user_id`, `recomendacao` (STRING(60)), `dispensada_em`, `dispensada_ate`,
`intervalo_dias` e o índice único **`(user_id, recomendacao)`**.

> **⛔ A tabela NÃO tem `condominio_id` — e não deve passar a ter.** Foi uma decisão da migração: uma
> recomendação do portal é da **conta**, não de um condomínio concreto. Um `where` sobre uma coluna
> inexistente rebenta com `ER_BAD_FIELD_ERROR` na base de dados real.

**Como o âmbito cabe na chave existente.** O condomínio é codificado **dentro** da chave:

```
tip:<id>@c<condominioId>      ex.: tip:backup_sem_copia_externa@c12
```

A chave cabe em `STRING(60)` e usa o índice único existente. Sem condomínio válido, `chaveDeDispensa`
devolve `null` e **nada é dispensado** (e `elegiveis` não apresenta nada).

**Isolamento, pelas duas dimensões:**

| Dimensão | Garantia |
|---|---|
| **Conta** | `carregarDispensas`/`registarDispensa` filtram **sempre** por `user_id`. A dispensa de A não serve B. |
| **Condomínio** | O condomínio vive **na chave**. Dispensar no condomínio A **não** esconde o mesmo Tip no B. |
| **Motores** | Cada motor valida o identificador contra o **seu** registo: um id do portal (`2fa_ativo`) nunca é aceite pelo motor dos Tips, e vice-versa. |

**Janela.** Por omissão 30 dias (`DIAS_REAPRESENTACAO_PADRAO`); dois Tips informativos usam 90 dias.
Passado o intervalo, o Tip **volta a poder aparecer** — mas só se a situação continuar a existir.

---

## 7. Âmbito e áreas — porque um Tip não aparece em todo o lado

Dois eixos **independentes**:

- **`ambito`** — *a que se refere*: `condominio` (frações, contas, atas) ou `instalacao` (backups,
  armazenamento). O motor filtra quando a página pede (`ctx.ambito`).
- **`area` / `areas`** — *em que páginas pode aparecer*. É o mecanismo **anti-spam**: o mesmo Tip não
  aparece indiscriminadamente em todas as páginas. O motor filtra quando a página indica `ctx.area`.

Pontos de integração atuais:

| Página | `ctx.area` | `ctx.ambito` |
|---|---|---|
| Painel (`routes/admin.js`) | `inicio` | `[condominio, instalacao]` |
| Armazenamento (`routes/configuracao.js`) | `armazenamento` | `[condominio, instalacao]` |

Quando um Tip **não** declara `areas`, não é filtrado por área — mas continua a estar limitado pelo
**dado** que a sua condição exige. É o caso de `backup_sem_copia_externa`: só a página de
armazenamento fornece `ctx.backup`, pelo que a condição devolve `null` em qualquer outro sítio.

---

## 8. Prioridades

Número **maior = apresentado primeiro**. A prioridade vem do **tipo**, e uma definição pode
sobrepor-lhe uma `prioridade` própria quando o tipo não chega para ordenar (é o caso dos Tips de
backups, ordenados entre si).

| tipo | rótulo na interface | prioridade |
|---|---|---|
| `risco` | Atenção ao cálculo | 100 |
| `aviso` | Atenção | 90 |
| `conclusao` | Por completar | 80 |
| `compreensao` | Vale a pena saber | 50 |
| `descoberta` | Funcionalidade pouco óbvia | 30 |

`risco` (conteúdo do condomínio) e `aviso` (operação) são **distintos de propósito**: o rótulo de
`risco` fala de cálculo e seria falso para um backup.

**Limite de apresentação:** 3. Os restantes ficam **elegíveis** e aparecem à medida que os primeiros
forem resolvidos ou dispensados — um Tip é orientação, não um manual.

---

## 9. Relação com backups e armazenamento

O motor **só lê** o estado de backups e armazenamento. Não altera nada.

**Não é tocado por este motor:** a execução de backups, a retenção, os `backup_logs`, os provedores
e a autorização do Super Admin. A arquitetura de backups (A6/A6.1) mantém-se intacta; ver
`docs/BACKUPS.md`.

---

## 10. Apresentação

A UI é separada do motor (o motor decide, a UI mostra):

- `views/partials/_tips.handlebars` — o cartão, com o formulário de dispensa;
- `public/js/tips.js` — o comportamento do lado do cliente;
- zona `.gc-tip-*` em `public/css/styles.css`;
- `tips: { apresentar, total, outras, limite, voltar }` é o contrato passado às vistas.

**A ação de cada Tip é FIXA e vem do registo do servidor**, nunca do browser: um identificador
manipulado não pode originar um destino arbitrário. O caminho de regresso (`voltar`) é validado
contra uma **lista fechada** em `routes/admin-tips.js` — nunca é seguido sem validação nem usado
para construir um URL.

---

## 11. Testes

| Ficheiro | O que cobre |
|---|---|
| `scripts/test-tips.js` | O motor e a apresentação (parcial renderizado com os helpers **reais** da aplicação — sem isso o parcial falharia com «Missing helper» e seria um falso negativo do harness). Trava também o campo de regresso: `voltar` só é transportado quando a página o indica. |
| `scripts/test-tips-vistas.js` | As vistas que apresentam Tips. |
| `scripts/test-tips-isolamento.js` | Isolamento por conta/condomínio, ausência de `condominio_id`, prioridade, áreas, âmbito, condições de backup, contexto incompleto, não-duplicação, **não-colisão Portal ↔ Administração** numa tabela de dispensa partilhada com memória, e **varredura exaustiva** de 17 280 combinações de contexto (os pares redundantes nunca coocorrem; os títulos são únicos; sem contexto de backup nada se inventa). |
| `scripts/test-rotas-tips.js` | A **rota HTTP** de dispensa: âmbito da sessão, id manipulado, papel, `voltar` validado, destino do servidor. |
| `scripts/test-motor-recomendacoes.js` | O motor do portal (dispensa partilhada). |
| `scripts/test-rotas-recomendacoes.js` | As rotas do portal. |

Todos correm **sem base de dados**, com duplos de modelos via `require.cache`.

---

## 12. Limites deliberados

- **Sem migração.** Não há coluna nova nem tabela nova. O âmbito vive na chave.
- **Sem inventar factos.** Sem dado, não há Tip — nunca um Tip a partir de uma suposição.
- **Sem becos sem saída.** Um Tip cujo destino exige um papel que o motor não consegue confirmar não
  é apresentado.
- **Sem dois motores.** Generalizações que exigissem um segundo motor, uma segunda prioridade ou uma
  segunda tabela foram **recusadas**; a evolução faz-se no motor único.
- **Sem redes de segurança falsas.** O motor não trata «campo ausente» como «está bem»: trata-o como
  «não sei» e não apresenta.
