// ─────────────────────────────────────────────────────────────────────
// ALLOW-LIST do acesso de SUPORTE (nível `diagnostico`).
//
// ── Porque existe este módulo ──────────────────────────────────────
// A superfície de suporte é um CONJUNTO FECHADO de rotas de LEITURA. Antes
// desta extração a lista vivia dentro de `routes/admin.js`, o que tinha duas
// consequências erradas:
//
//   1. só governava `admin.js` — e cada módulo de `/admin` é um ROUTER
//      SEPARADO, montado em `app.js` com a sua própria guarda de papel. Uma
//      rota de `financeiro.js` ou `documentos.js` ficava INALCANÇÁVEL ao
//      suporte por acidente, não por decisão;
//   2. não era possível provar, num só sítio, o que o suporte pode ler.
//
// Aqui a allow-list passa a ser a fonte ÚNICA: um mapa de módulos → caminhos,
// consumido por todos os routers através de `soDiagnostico(modulo)`.
//
// ── O que esta allow-list NÃO é ────────────────────────────────────
// NÃO é um bypass de `/admin`. `soDiagnostico` não promove ninguém a `gestor`
// nem a `admin`: apenas deixa passar o pedido de suporte quando — e só quando —
// as quatro condições abaixo são verdadeiras ao mesmo tempo. Fora disso, o
// pedido segue para a guarda de papel do router, que o recusa por construção
// (durante o suporte `req.papelCondominio === null`).
//
// ── As quatro condições de admissão ────────────────────────────────
//   (1) CONTEXTO  — `req.suporte` presente (pedido de suporte, não de condomínio);
//   (2) NÍVEL     — `req.suporte.nivel === 'diagnostico'` (`tenant.comSuporte`);
//   (3) CAMINHO   — na lista EXPLÍCITA do módulo (nunca por prefixo);
//   (4) MÉTODO    — GET/HEAD apenas (`tenant.somenteLeitura`).
//
// As condições (1) e (2) já foram validadas a montante — `comCondominioAtivo`
// só cria `req.suporte` a partir de um acesso VIGENTE, o que implica sessão
// validada, `session_id` vinculado, âmbito conferido e prazo não expirado
// (ver `helpers/suporte.js`). Revalidar o nível aqui é defesa em profundidade:
// um acesso de nível diferente não passa, mesmo que alguém monte o guard.
//
// ── Invariantes que este módulo ajuda a preservar ──────────────────
//   · `req.contexto === 'suporte'`;
//   · `req.papelCondominio === null` (nunca `gestor` nem `admin`);
//   · sessão de suporte validada, vinculada e não expirada;
//   · nível `diagnostico`.
// ─────────────────────────────────────────────────────────────────────
const tenant = require('./tenant');

// ── Marca de admissão ──────────────────────────────────────────────
// Um Symbol GLOBAL (registado) e não um `Symbol()` local: a marca tem de ser a
// MESMA em todos os routers que admitem suporte. Com um Symbol local por
// ficheiro, um guard montado num router não reconheceria a admissão feita
// noutro — e a allow-list falharia de forma silenciosa em cadeia (o pedido
// admitido seria recusado pela guarda de papel do router seguinte).
//
// Só este módulo a escreve; ninguém a pode forjar a partir de um pedido HTTP,
// porque um Symbol não é serializável nem aparece em `req.body`/`req.query`.
const ADMITIDO_SUPORTE = Symbol.for('condofy.suporte.diagnostico.admitido');

// Níveis que podem ver a allow-list. Espelha `helpers/suporte.js`
// (`NIVEIS_CONCEDIVEIS`): nesta fase só `diagnostico`. `operacional` existe no
// ENUM do modelo para evolução futura, mas não é concedível nem admitido aqui.
const NIVEIS_ADMITIDOS = ['diagnostico'];

// ── O router de cada módulo ────────────────────────────────────────
// Mapa MÓDULO → ficheiro do router, e a RAZÃO de ele viver AQUI e não nos
// testes: sem isto havia TRÊS cópias manuais desta lista (em
// `test-allow-list-suporte.js`, `test-t4-suporte-isolamento.js` e
// `verificar-readonly-admitidos.js`) que nada obrigava a concordar com a
// `LISTA`. Um módulo novo entrava na lista e ficava ADMITIDO ao suporte sem
// nunca ser exercitado por HTTP nem verificado quanto a efeitos laterais — um
// falso verde. Provado: injetar um módulo na `LISTA` não fazia falhar nada.
//
// Regra: um módulo com entrada na `LISTA` TEM de declarar aqui o seu router, e
// o ficheiro TEM de existir. Os verificadores derivam deste mapa (ver
// `routerDo`/`ROUTERS`), pelo que acrescentar um módulo novo obriga a
// acrescentar o router — e a falha é imediata se não o fizer.
const ROUTERS = {
  admin: 'routes/admin.js',
  financeiro: 'routes/financeiro.js',
  'quotas-modulo': 'routes/quotas-modulo.js',
  'extra-quotas': 'routes/extra-quotas.js',
  orcamento: 'routes/orcamento.js',
  assembleias: 'routes/assembleias.js',
  documentos: 'routes/documentos.js',
  emails: 'routes/emails.js',
  relatorios: 'routes/relatorios.js',
};

// ── A lista ────────────────────────────────────────────────────────
// Cada chave é um MÓDULO (o router onde a admissão é montada); cada valor, a
// lista de caminhos admitidos NESSE router (relativos ao próprio router).
//
// `padrao` casa o CAMINHO COMPLETO (âncora `^…$`), nunca por prefixo: uma rota
// nova que partilhe o início do caminho (`/quotas/gerar` face a `/quotas`)
// continua fora da lista, por omissão. É esta a propriedade que faz uma rota
// nova nascer INACESSÍVEL ao suporte.
//
// Decisão de desenho por rota, com o motivo:
//   · `/fracoes/:id` foi DELIBERADAMENTE EXCLUÍDO — é a ficha da fração, que
//     junta identidade, contactos, quotas, pagamentos, documentos e avisos
//     numa só página. Separação estrutural é mais fiável do que tentar mascarar
//     uma vista que mistura identidade e finanças; a rota continua disponível
//     a admin/gestor.
//   · `/fracoes/nova`, `/condominos/nova`, `/utilizadores`, `/configuracao`,
//     `/suporte`, `/tarefas`-equivalentes de escrita: fora (escrita/administração).
//   · Rotas cujo GET tem EFEITO LATERAL (cria pasta, emite documento, guarda
//     tokens OAuth) ficam fora: a allow-list é de leitura, não de caminhos.
const LISTA = {
  // Backoffice comum — ver `routes/admin.js`. O suporte lê o cadastro
  // (frações e condóminos, SEM a ficha individual da fração) e o painel.
  admin: [
    { padrao: /^\/$/, rotulo: '/' }, // painel do condomínio
    { padrao: /^\/fracoes$/, rotulo: '/fracoes' }, // lista de frações
    { padrao: /^\/condominos$/, rotulo: '/condominos' }, // lista de condóminos
    { padrao: /^\/tarefas$/, rotulo: '/tarefas' }, // estado dos jobs
  ],

  // Financeiro — ver `routes/financeiro.js`. Diagnóstico de quotas,
  // pagamentos, despesas, movimentos e contas. `/quotas` exige scoping
  // explícito na consulta (foi corrigido: `where` sem `condominio_id`
  // devolveria dados de todos os condomínios).
  financeiro: [
    { padrao: /^\/quotas$/, rotulo: '/quotas' },
    { padrao: /^\/quotas\/\d+$/, rotulo: '/quotas/:id' },
    { padrao: /^\/quotas\/grelha$/, rotulo: '/quotas/grelha' },
    { padrao: /^\/pagamentos$/, rotulo: '/pagamentos' },
    { padrao: /^\/pagamentos\/\d+$/, rotulo: '/pagamentos/:id' },
    { padrao: /^\/despesas$/, rotulo: '/despesas' },
    { padrao: /^\/movimentos$/, rotulo: '/movimentos' },
    { padrao: /^\/contas$/, rotulo: '/contas' },
  ],

  // Módulo de quotas (conta-corrente). Ver `routes/quotas-modulo.js`.
  //
  // ⚠️ `/quotas` e `/quotas/grelha` têm handlers em DOIS routers: este e
  // `financeiro.js`. A montagem em `app.js` põe `quotas-modulo` ANTES de
  // `financeiro`, por isso é AQUI que o pedido HTTP é servido. A rota tem de
  // constar das DUAS listas para que o suporte seja admitido independentemente
  // de qual dos routers a serve — se a ordem de montagem mudar, a admissão não
  // se perde. (A duplicação de rotas é anterior a esta fase; não foi alterada.)
  'quotas-modulo': [
    { padrao: /^\/quotas$/, rotulo: '/quotas' },
    { padrao: /^\/quotas\/grelha$/, rotulo: '/quotas/grelha' },
    { padrao: /^\/quotas\/conta-corrente$/, rotulo: '/quotas/conta-corrente' },
  ],

  // Quotas extra. Ver `routes/extra-quotas.js`.
  'extra-quotas': [
    { padrao: /^\/quotas-extra$/, rotulo: '/quotas-extra' },
    { padrao: /^\/quotas-extra\/\d+$/, rotulo: '/quotas-extra/:id' },
  ],

  // Orçamento. Ver `routes/orcamento.js`. O detalhe tem a vista de suporte
  // porque imprime o NOME do autor de cada alteração (reduzido a iniciais).
  orcamento: [
    { padrao: /^\/orcamento$/, rotulo: '/orcamento' },
    { padrao: /^\/orcamento\/\d+$/, rotulo: '/orcamento/:id' },
  ],

  // Assembleias. Ver `routes/assembleias.js`. O detalhe tem vista de suporte
  // porque lista participantes (fração + nome da pessoa). A convocatória fica
  // FORA: o GET tem efeitos laterais.
  assembleias: [
    { padrao: /^\/assembleias$/, rotulo: '/assembleias' },
    { padrao: /^\/assembleias\/\d+$/, rotulo: '/assembleias/:id' },
  ],

  // Documentos. Ver `routes/documentos.js`. Só METADADOS da biblioteca — o
  // `drive_erro` é o dado central deste diagnóstico («porque é que o documento
  // não abre?») e hoje não aparece em nenhuma vista. O ficheiro, o stream, a
  // criação de pastas e os callbacks OAuth ficam todos fora.
  documentos: [{ padrao: /^\/documentos$/, rotulo: '/documentos' }],

  // ── Central de emails — EXCEÇÃO DELIBERADA (ler antes de alterar) ──
  // Ver `routes/emails.js`. Só estado/erro/`message_id` e destinatário
  // mascarado; nem corpo, nem anexos, nem o bloco SMTP (servidor/porta/
  // utilizador/password seriam segredos de infraestrutura).
  //
  // ⚠️ ASSIMETRIA CONHECIDA, MANTIDA POR DECISÃO: `/emails` é o ÚNICO módulo
  // admitido cujo router exige o papel `admin` do condomínio (os outros oito
  // exigem `gestor` — ver o `comPapelOuSuporteAdmitido(...)` de cada router).
  // Na navegação, a Central de Emails está escondida ao gestor
  // (`views/layouts/main.handlebars`, `{{#if (ne condominioAtivo.role 'gestor')}}`).
  // Logo, neste módulo, o nível `diagnostico` alcança algo que um GESTOR do
  // próprio condomínio não alcança.
  //
  // Porque é que isto se mantém, e não é uma inversão de hierarquia:
  //
  //   1. O acesso existe para DIAGNOSTICAR a fila de envio — responder a «o
  //      email não saiu? foi enviado? qual o erro?». É o estado da fila que o
  //      diagnostica, e é isso que a rota serve.
  //   2. NÃO confere as capacidades normais de administração de Emails: o
  //      suporte não reenvia, não cancela, não configura SMTP nem testa o
  //      envio — a allow-list é de LEITURA (GET/HEAD, `somenteLeitura`) e as
  //      rotas de escrita (`/emails/smtp`, `/emails/teste`, …) ficam fora.
  //   3. A vista de diagnóstico é deliberadamente MINIMIZADA
  //      (`views/admin/emails/index-suporte.handlebars`): sem corpo, sem
  //      anexos, sem configuração SMTP, e com o destinatário mascarado
  //      (`maskEmail`). Não há aqui mais PII do que nas outras vistas de suporte.
  //   4. O requisito `admin` do condomínio NÃO foi alterado — baixá-lo para
  //      `gestor` só para acomodar o suporte seria relaxar uma autorização
  //      existente, o que é expressamente proibido. A hierarquia normal do
  //      GesCondu mantém-se intacta.
  //
  // Isto é uma EXCEÇÃO DE DIAGNÓSTICO, não uma alteração da hierarquia de
  // permissões: distingue-se **privilégio de utilização** (que continua
  // reservado ao `admin` do condomínio, com todas as capacidades) de **acesso
  // de diagnóstico** (leitura minimizada do estado da fila).
  //
  // Alternativa considerada e rejeitada: criar um nível de suporte `operacional`
  // só para esta assimetria. Rejeitada por aumentar a complexidade do modelo de
  // autorização sem necessidade concreta demonstrada. Ver a auditoria §9 e o
  // `docs/DESENHO-SUPORTE-DIAGNOSTICO.md` §3 (linha do módulo Emails/fila).
  //
  // Um teste que fixe esta decisão NÃO deve afirmar que o mínimo é `gestor`
  // (seria falso para `emails`); deve afirmar que a exceção é CONSCIENTE —
  // ver `test-allow-list-suporte.js` (asserção `EXCECOES_ADMIN`).
  emails: [{ padrao: /^\/emails$/, rotulo: '/emails' }],

  // Relatórios. Ver `routes/relatorios.js`. A vista já não imprime IBAN —
  // mostra nome/banco/tipo/saldo de cada conta. O PDF fica FORA (gera ficheiro).
  relatorios: [{ padrao: /^\/relatorios\/financeiro$/, rotulo: '/relatorios/financeiro' }],
};

// ── Consulta da lista ──────────────────────────────────────────────
// `true` quando o caminho consta da lista do módulo. Comparação por PADRÃO
// completo (âncora), nunca por prefixo.
function caminhoAdmitido(modulo, caminho) {
  const entradas = LISTA[modulo];
  if (!entradas) return false;
  return entradas.some((e) => e.padrao.test(caminho));
}

// `true` quando o caminho consta da lista de ALGUM módulo.
//
// Porque é que isto é preciso, e não um alargamento da superfície:
//
// TODOS os routers de `/admin` são montados no MESMO prefixo (`app.use('/admin',
// …)`), em sequência. O `routes/admin.js` é o PRIMEIRO e monta a guarda de papel
// como `router.use(...)` — logo ela corre para TODOS os caminhos sob `/admin`,
// incluindo os que são servidos por routers montados DEPOIS dele
// (`quotas-modulo`, `financeiro`, `documentos`, …).
//
// Se a admissão do módulo `admin` só conhecesse a lista de `admin`, um pedido de
// suporte a `/admin/quotas` seria recusado pelo router `admin` (não tem papel e
// não está na lista de `admin`) ANTES de chegar ao router que o serve — e a
// admissão de `financeiro`/`quotas-modulo` seria código morto.
//
// A `LISTA` continua a ser o CONJUNTO FECHADO: isto não admite nada que não
// esteja já numa das suas entradas — só evita que a guarda de papel do router
// que corre PRIMEIRO estrangule a admissão de um router que corre DEPOIS. A
// admissão efetiva (caminho + nível + método + marca) continua a ser feita, no
// seu âmbito, pelo guard de cada módulo; e a marca `ADMITIDO_SUPORTE` viaja com
// o pedido, pelo que a guarda condicional do router seguinte também a respeita.
function caminhoAdmitidoEmAlgumModulo(caminho) {
  return MODULOS.some((m) => caminhoAdmitido(m, caminho));
}

// Todos os caminhos admitidos de um módulo (rótulos), para testes e para
// documentação. Não expõe nada que já não esteja no código.
function caminhosDo(modulo) {
  return (LISTA[modulo] || []).map((e) => e.rotulo);
}

// Módulos conhecidos (para provar que um módulo novo precisa de entrada própria).
const MODULOS = Object.keys(LISTA);

// ── Coerência LISTA ↔ ROUTERS ──────────────────────────────────────
// Uma lista fechada só é fechada se cada módulo tiver router declarado e o
// ficheiro existir. Estas duas funções são a única porta para essa verificação,
// para que os testes não voltem a escrever a sua própria cópia da lista.
//
// `routerDo` devolve o ficheiro do router de um módulo, ou `null` se o módulo
// não o declarar. Não lança: quem chama decide como falhar.
function routerDo(modulo) {
  return Object.prototype.hasOwnProperty.call(ROUTERS, modulo) ? ROUTERS[modulo] : null;
}

// Módulos da `LISTA` que NÃO declaram router (ou cujo ficheiro não existe).
//
// É uma verificação de ESTRUTURA, não de disco: recebe a função que diz se um
// ficheiro existe, para poder ser exercitada sem sistema de ficheiros (testes
// DB-free e provas de mutação) — o mesmo princípio do resto do projeto.
//
// Devolve `{ semRouter: [...], ficheiroInexistente: [...] }`, ambos vazios
// quando a lista está coerente.
function incoerencias(existeFicheiro) {
  const existe = typeof existeFicheiro === 'function' ? existeFicheiro : () => true;
  const semRouter = [];
  const ficheiroInexistente = [];
  for (const modulo of MODULOS) {
    const ficheiro = routerDo(modulo);
    if (!ficheiro) { semRouter.push(modulo); continue; }
    if (!existe(ficheiro)) ficheiroInexistente.push({ modulo, ficheiro });
  }
  // Também ao contrário: um router declarado para um módulo que não existe na
  // `LISTA` é código morto/erro de escrita e tem de ser visível.
  const routersOrfaos = Object.keys(ROUTERS).filter((m) => !Object.prototype.hasOwnProperty.call(LISTA, m));
  return { semRouter, ficheiroInexistente, routersOrfaos };
}

// `true` quando o pedido é um acesso de suporte ao nível admitido.
function eSuporteDiagnostico(req) {
  return Boolean(req && req.suporte && NIVEIS_ADMITIDOS.includes(req.suporte.nivel));
}

// ── Fábrica do guard de admissão ───────────────────────────────────
// Devolve o `router.use` que cada router de `/admin` monta ANTES da sua guarda
// de papel. O `modulo` é o nome na `LISTA` — e é OBRIGATÓRIO: um router que
// monte `soDiagnostico()` sem módulo não admite nada (falha fechada), para que
// um esquecimento nunca resulte numa superfície aberta.
//
// O guard é CONDICIONAL: para um pedido que não é de suporte segue logo
// (`next()`), e a guarda de papel do router decide como sempre. Só um pedido
// de suporte admitido é MARCADO — e é essa marca que a guarda de papel do
// router consulta para o deixar passar.
function soDiagnostico(modulo) {
  const entradaValida = Boolean(modulo) && Object.prototype.hasOwnProperty.call(LISTA, modulo);

  // O router `admin` é o PRIMEIRO a ser montado sob `/admin` e a sua guarda de
  // papel é `router.use` — corre para todos os caminhos, incluindo os servidos
  // por routers posteriores. Por isso a admissão de `admin` tem de aceitar
  // qualquer caminho da `LISTA` (de qualquer módulo), senão estrangula a
  // admissão dos routers que vêm a seguir. Ver
  // `caminhoAdmitidoEmAlgumModulo`. Para os restantes módulos, o âmbito é o seu.
  const admitir = modulo === 'admin'
    ? (caminho) => caminhoAdmitidoEmAlgumModulo(caminho)
    : (caminho) => caminhoAdmitido(modulo, caminho);

  return function guardDiagnostico(req, res, next) {
    // Não é suporte (ou não é nível diagnóstico): não é com este guard. A
    // guarda de papel do router decide, como sempre.
    if (!eSuporteDiagnostico(req)) return next();
    if (!entradaValida) return next(); // módulo não declarado ⇒ nada admitido

    // (3) CAMINHO — fora da lista: NÃO admite. O pedido segue para a guarda de
    // papel, que o recusa (o suporte não tem papel).
    if (!admitir(req.path)) return next();

    // (2) NÍVEL — `comSuporte` revalida o nível e confirma que há mesmo
    // contexto de suporte (defesa em profundidade face a `eSuporteDiagnostico`).
    return tenant.comSuporte(NIVEIS_ADMITIDOS)(req, res, (err) => {
      if (err) return next(err);
      // (4) MÉTODO — a allow-list é de LEITURA. Um POST/PUT/PATCH/DELETE sobre
      // um caminho da lista é recusado aqui e nunca chega ao handler de escrita
      // homónimo. Sem isto, a lista seria de caminhos, não de operações.
      return tenant.somenteLeitura(req, res, (err2) => {
        if (err2) return next(err2);
        req[ADMITIDO_SUPORTE] = true;
        return next();
      });
    });
  };
}

// ── Guarda de papel CONDICIONAL (o par obrigatório do guard acima) ─
// Devolve o `router.use` que substitui o `router.use(tenant.comPapel('gestor'))`
// incondicional. A guarda de papel em si não muda — é o MESMO mínimo, aplicado
// pelo MESMO guard, aos MESMOS pedidos (todos os que não são suporte admitido).
//
// ⛔ Porque é que tem de ser condicional: o Express corre TODOS os
// `router.use` montados, em ordem. Se depois da admissão houver um
// `router.use(tenant.comPapel('gestor'))` incondicional, esse guard corre
// também, não reconhece a marca e RECUSA o pedido que a admissão acabou de
// deixar passar — a allow-list deixaria de funcionar por completo (era o que
// acontecia antes: 302 para `/` em todas as rotas admitidas).
function comPapelOuSuporteAdmitido(minimo = 'gestor') {
  return function guardPapel(req, res, next) {
    if (req && req.suporte && req[ADMITIDO_SUPORTE] === true) return next();
    return tenant.comPapel(minimo)(req, res, next);
  };
}

module.exports = {
  ADMITIDO_SUPORTE,
  NIVEIS_ADMITIDOS,
  LISTA,
  ROUTERS,
  MODULOS,
  routerDo,
  incoerencias,
  caminhoAdmitido,
  caminhoAdmitidoEmAlgumModulo,
  caminhosDo,
  eSuporteDiagnostico,
  soDiagnostico,
  comPapelOuSuporteAdmitido,
};
