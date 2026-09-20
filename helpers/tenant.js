// ─────────────────────────────────────────────────────────────────────
// Multi-condomínio — associações, condomínio ativo e papéis.
// O condomínio ativo vem sempre da SESSÃO e é validado contra a associação
// utilizador ↔ condomínio (nunca se confia num id enviado pelo browser).
// Papéis por condomínio: admin > gestor > leitura.
// ─────────────────────────────────────────────────────────────────────
const { UserCondominio, Condominio, User } = require('../models');
// Acesso de suporte — terceiro contexto. Importado aqui porque
// `comCondominioAtivo` é o ponto único onde o contexto de condomínio nasce e
// tem de resolver as duas vias (associação real OU acesso de suporte).
const suporte = require('./suporte');

// ── Privilégio GLOBAL ──────────────────────────────────────────────
// A administração global (GesCondu) é decidida EXCLUSIVAMENTE por
// `users.role_global`. `users.role` é legado e nunca decide nada aqui.
function eSuperAdmin(utilizador) {
  return Boolean(utilizador && utilizador.role_global === 'super_admin');
}

function ativo(req) {
  return req && req.session && req.session.condominio_ativo_id ? Number(req.session.condominio_ativo_id) : null;
}

// Associação ATIVA do utilizador ao condomínio (null quando não existe).
//
// Exige DUAS condições, e é deliberado que venham juntas:
//   1. a associação está ativa (`utilizador_condominios.estado = 'ativo'`);
//   2. o CONDOMÍNIO está ativo (`condominios.estado = 'ativo'`).
//
// A condição (2) faltava, e isso tornava a desativação de um condomínio
// puramente cosmética: a lista de escolha escondia-o (`listarCondominios`
// filtra o estado), mas quem JÁ estava dentro continuava a trabalhar — porque
// este `findOne` só olhava para o estado da associação. O resultado é que
// desativar um condomínio não cortava nada a ninguém que nele estivesse.
//
// Com a condição (2), a desativação passa a valer para toda a gente, incluindo
// sessões já abertas, sem depender de destruir sessões: a verificação é feita a
// CADA pedido, a partir do estado em BD. Nota importante sobre o isolamento:
// isto só afeta a sessão cujo `condominio_ativo_id` aponta para este
// condomínio. Um utilizador com associação a A e a B continua a trabalhar em B
// — a recusa é por PAR (utilizador, condomínio), nunca por utilizador.
async function associacaoAtiva(utilizadorId, condominioId) {
  if (!utilizadorId || !condominioId) return null;
  return UserCondominio.findOne({
    where: { utilizador_id: utilizadorId, condominio_id: condominioId, estado: 'ativo' },
    include: [{ model: Condominio, as: 'condominio', where: { estado: 'ativo' }, required: true }],
  });
}

// Condomínios (ativos) do utilizador, com o papel da associação.
async function listarCondominios(utilizadorId) {
  if (!utilizadorId) return [];
  const linhas = await UserCondominio.findAll({
    where: { utilizador_id: utilizadorId, estado: 'ativo' },
    include: [{ model: Condominio, as: 'condominio', where: { estado: 'ativo' }, required: true }],
    order: [['id', 'ASC']],
  });
  return linhas.map((l) => ({
    id: l.condominio.id,
    designacao: l.condominio.designacao,
    morada: l.condominio.morada,
    codigo_postal: l.condominio.codigo_postal,
    localidade: l.condominio.localidade,
    role: l.role,
  }));
}

// Define o condomínio ativo na sessão — apenas se a associação for válida.
//
// Um Super Admin NÃO entra aqui: o acesso de suporte é um mecanismo próprio
// (`helpers/suporte.js`), explícito, temporário e auditado. Antes, este ramo
// aceitava qualquer condomínio ativo para um super_admin e gravava o ativo na
// sessão sem associação nenhuma — um bypass permanente de `req.condominioId`.
//
// Depende de `associacaoAtiva`, que agora exige também `condominios.estado =
// 'ativo'`. Logo um condomínio desativado não pode ser ESCOLHIDO — fechar a
// porta de entrada além de fechar o contexto é o que impede o ciclo
// «desativa → entro outra vez».
async function entrarCondominio(req, condominioId) {
  const utilizador = req.user;
  if (!utilizador) return false;
  const associacao = await associacaoAtiva(utilizador.id, condominioId);
  if (!associacao) return false;
  req.session.condominio_ativo_id = associacao.condominio_id;
  return true;
}

// Papel do utilizador no condomínio ativo (null se sem acesso).
//
// IMPORTANTE — as três noções são distintas e não se substituem:
//   1. privilégio GLOBAL  → `users.role_global` (eSuperAdmin);
//   2. papel NO CONDOMÍNIO → `utilizador_condominios.role` (admin/gestor/leitura);
//   3. acesso de SUPORTE   → concessão temporária, num eixo próprio
//                            (`req.suporte`), que NÃO produz papel de condomínio.
//
// O ponto 3 é deliberado: um acesso de suporte nunca devolve 'admin' nem
// 'gestor'. Se devolvesse, o super admin voltaria a herdar o backoffice inteiro
// por via indireta — exatamente o que se está a eliminar. Quem precisa de
// distinguir suporte lê `req.suporte`, não o papel.
async function papelNoAtivo(req) {
  const id = ativo(req);
  if (!id) return null;
  const associacao = await associacaoAtiva(req.user && req.user.id, id);
  if (associacao) return associacao.role; // papel REAL da associação (precedência)
  return null;
}

// Papel EFETIVO a apresentar na interface para o contexto atual.
// Devolve `{ global, modoSuporte, papel }`:
//  - `global`      → administrador global (menu de administração global);
//  - `modoSuporte` → mantido por compatibilidade de assinatura, mas SEMPRE
//                    `false`: o acesso de suporte vive em `req.suporte` e não
//                    confere papel de condomínio;
//  - `papel`       → papel no condomínio ativo (associação real), quando existe.
// Nunca lê `users.role`: a UI não pode continuar a depender do legado.
async function contextoAdministrativo(req) {
  const global = eSuperAdmin(req.user);
  const associacao = req.user ? await associacaoAtiva(req.user.id, ativo(req)) : null;
  return {
    global,
    modoSuporte: false,
    papel: associacao ? associacao.role : null,
  };
}

// Permissões por papel (leitura só consulta; gestor escreve; admin tudo).
const PAPEIS = { admin: 30, gestor: 20, leitura: 10 };
function podeEscrever(papel) {
  return (PAPEIS[papel] || 0) >= 20;
}
function papelMaiorOuIgual(papel, minimo) {
  return (PAPEIS[papel] || 0) >= (PAPEIS[minimo] || 99);
}

async function eAdminCondominio(req) {
  const papel = await papelNoAtivo(req);
  return papel === 'admin';
}

// ── Middlewares de isolamento por condomínio ativo ─────────────────
// Valida que o utilizador tem contexto válido para o condomínio ativo
// e expõe req.condominioId + req.papelCondominio.
//
// Há DUAS vias legítimas, e só duas:
//   (1) ASSOCIAÇÃO REAL em `utilizador_condominios` (admin/gestor/leitura);
//   (2) ACESSO DE SUPORTE vigente (`req.suporte`), concedido por um Super Admin
//       com motivo e prazo — ver `helpers/suporte.js`.
//
// Na via (2) `req.papelCondominio` fica deliberadamente a `null`. É o ponto
// essencial: sem papel, `comPapel('gestor')` e `apenasAdmin` recusam por
// construção, pelo que o suporte NÃO herda o backoffice. O que o suporte pode
// fazer é decidido por guardas próprias (`comSuporte`), não pelo papel.
//
// O ramo antigo `if (eSuperAdmin) { req.condominioId = id;
// req.papelCondominio = 'admin'; }` (que dava `condominioId` e papel de admin a
// qualquer super_admin sem associação) foi REMOVIDO.
function comCondominioAtivo(req, res, next) {
  return (async () => {
    if (!req.isAuthenticated()) {
      req.flash('error_msg', 'Inicie sessão para continuar.');
      return res.redirect('/login');
    }
    const id = ativo(req);
    if (!id) {
      req.flash('error_msg', 'Selecione um condomínio para continuar.');
      return res.redirect('/condominios');
    }

    // (1) Associação real — a via normal, com o papel REAL.
    const associacao = await associacaoAtiva(req.user.id, id);
    if (associacao) {
      req.contexto = 'condominio';
      req.suporte = null;
      req.condominioId = id;
      req.papelCondominio = associacao.role; // admin | gestor | leitura
      return next();
    }

    // (2) Sem associação ATIVA: distinguir «condomínio desativado» de «sem
    //     acesso». A diferença importa para o utilizador (a mensagem) e para o
    //     operador (um condomínio desativado tem de ser explicado, não
    //     parecer um problema de permissões).
    //
    //     Aqui `associacaoAtiva` já falhou, pelo que a associação pode existir
    //     mas estar inativa, ou o condomínio estar desativado. Só se o
    //     condomínio não estiver ativo é que a mensagem muda.
    const condominio = await Condominio.findByPk(id, { attributes: ['id', 'estado'] });
    if (condominio && condominio.estado !== 'ativo') {
      // Cortar o contexto, para não ficar a repetir a mesma tentativa em cada
      // pedido. A SESSÃO em si permanece válida: o utilizador continua
      // autenticado e continua a poder escolher outro condomínio.
      delete req.session.condominio_ativo_id;
      req.flash('error_msg', 'Este condomínio está desativado.');
      return res.redirect('/condominios');
    }

    // (3) Sem associação: a única via é um acesso de suporte vigente.
    const acesso = await suporte.vigente(req, id);
    if (acesso) {
      req.contexto = 'suporte';
      req.suporte = suporte.paraContexto(acesso);
      req.condominioId = acesso.condominio_id; // âmbito vem do REGISTO, não do browser
      req.papelCondominio = null; // ← NUNCA 'admin' nem 'gestor'
      return next();
    }

    // (4) Nada válido.
    delete req.session.condominio_ativo_id;
    req.flash('error_msg', 'Não tem acesso a este condomínio.');
    return res.redirect('/condominios');
  })();
}

// Permite apenas papéis ≥ mínimo.
// O papel vem de `req.papelCondominio`, definido por `comCondominioAtivo`.
//
// Um acesso de suporte tem `req.papelCondominio === null`, pelo que TODAS as
// guardas deste tipo recusam durante o suporte — é essa a garantia de que o
// suporte não herda privilégios de admin/gestor. As rotas que o suporte pode
// usar levam `comSuporte(...)` em vez de `comPapel(...)`.
function comPapel(minimo) {
  return (req, res, next) => {
    const papel = req.papelCondominio || null;
    if (!papel || !papelMaiorOuIgual(papel, minimo)) {
      req.flash('error_msg', 'Não tem permissões para esta ação.');
      return res.redirect('/');
    }
    return next();
  };
}

// ── Guardas do acesso de suporte ──────────────────────────────────
// Aplicadas rota a rota às rotas que o suporte PODE usar. A allow-list de
// módulos vive nas rotas (explícita). `niveis` restringe ainda por nível.
function comSuporte(niveis = null) {
  return (req, res, next) => {
    if (!req.suporte) {
      req.flash('error_msg', 'Esta ação é feita em contexto de suporte.');
      return res.redirect('/');
    }
    if (niveis && !niveis.includes(req.suporte.nivel)) {
      req.flash('error_msg', 'O nível deste acesso de suporte não permite esta ação.');
      return res.redirect('/');
    }
    return next();
  };
}

// Negação explícita: rotas que o suporte NUNCA pode usar.
// Hoje é redundante com `comPaper` (o suporte não tem papel), mas é intencional:
// documenta a decisão na própria rota e sobrevive a uma futura alteração do
// papel durante o suporte.
function semSuporte(req, res, next) {
  if (req.suporte) {
    req.flash('error_msg', 'Esta área não está disponível em modo de suporte.');
    return res.redirect('/');
  }
  return next();
}

// Negação do suporte numa guarda de APP (montada antes de qualquer router).
//
// `semSuporte` só é útil DENTRO de um router: `req.suporte` é criado por
// `comCondominioAtivo`, que cada router monta no seu próprio âmbito. Uma guarda
// global (em `app.js`, sobre `/condomino`) corre ANTES de qualquer router, pelo
// que `req.suporte` ainda não existe — e `semSuporte` deixaria passar.
//
// Esta guarda lê a marca da SESSÃO (`suporte_ativo_id`, a única coisa que a
// sessão de suporte guarda) — que está disponível antes de qualquer router. É
// deliberadamente conservadora: se houver QUALQUER marca de suporte na sessão,
// a área é negada e o pedido vai para `/admin`, onde `comCondominioAtivo`
// revalida o acesso (e o recusa se já não estiver vigente). Não substitui
// `semSuporte`; é a primeira linha, com `semSuporte` como defesa em profundidade
// dentro de cada router.
function bloqueioSuporteNaSessao(req, res, next) {
  const temMarcaDeSuporte = Boolean(req.session && req.session[suporte.CHAVE_SESSAO]);
  if (temMarcaDeSuporte) {
    req.flash('error_msg', 'A área do condómino não está disponível em modo de suporte.');
    return res.redirect(DESTINO_PAINEL);
  }
  return next();
}

// Leitura apenas: o nível `diagnostico` é read-only POR MÉTODO (não por
// enumerar rotas — uma allow-list de rotas envelhece e esquece-se).
function somenteLeitura(req, res, next) {
  if (req.suporte && req.method !== 'GET' && req.method !== 'HEAD') {
    req.flash('error_msg', 'O acesso de diagnóstico é só de leitura.');
    return res.redirect(req.get('referer') || '/');
  }
  return next();
}

// ── Auditoria da consulta de suporte (ACHADO-02) ───────────────────
// Ponte fina para `suporte.registarConsulta`. Existe para que o guard da
// allow-list possa auditar a consulta SEM carregar modelos no topo de
// `suporte-allowlist.js` — os testes offline substituem `/models` por stubs no
// `require.cache`, e um `require('../models')` no topo desse ficheiro guardaria
// a referência real antes da injeção (`suporte.js` já usa `require` diferido
// precisamente por isso; aqui reutiliza-se essa disciplina em vez de a violar).
//
// Falha SEMPRE em silêncio: se faltar contexto (sem `req.suporte`), não se
// registra nada; se a gravação falhar, `registarConsulta` engole o erro.
function auditarConsulta(req) {
  if (!req || !req.suporte) return false;
  return suporte.registarConsulta({
    acessoId: req.suporte.id,
    condominioId: req.suporte.condominioId,
    rota: req.path,
  });
}

// Destinos canónicos do contexto autenticado.
const DESTINO_PAINEL = '/admin'; // backoffice do condomínio (admin e gestor)
const DESTINO_GLOBAL = '/admin/global'; // administração global (super admin)
const DESTINO_PORTAL = '/condomino'; // área do condómino

// ── Destino inicial (pós-login / entrada na raiz) ──────────────────
// Decisão ÚNICA do contexto e do destino. Todas as entradas (`GET /`, depois
// do login, depois de escolher condomínio) passam por aqui — não existe
// lógica paralela em `routes/index.js`.
//
// Regras (por ordem):
//   1. super admin sem condomínio ativo      → painel de administração global;
//   2. super admin COM condomínio ativo      → só há contexto se a associação
//      for real. Sem associação, o ativo NÃO conta: um super admin não ganha
//      contexto de condomínio por ter um id na sessão. O acesso de suporte é
//      resolvido em `comCondominioAtivo` (via `req.suporte`), não aqui.
//   3. sem condomínio ativo válido           → "Os meus condomínios";
//   4. papel no condomínio ativo admin/gestor → painel do condomínio;
//   5. qualquer outro papel                   → área do condómino.
//
// O papel vem SEMPRE do condomínio ativo (associação real) e NUNCA de
// `users.role`. Um super admin sem associação vai para o painel GLOBAL — nunca
// para o painel de um condomínio, que é o que o antigo «modo suporte» fazia.
function destinoInicial({ meus = [], ativo = null, user = null } = {}) {
  const ids = (meus || []).map((c) => Number(c && c.id));
  const ativoValido = ativo != null && ids.includes(Number(ativo));
  const escolhido = ativoValido ? meus.find((c) => Number(c.id) === Number(ativo)) : null;
  const global = eSuperAdmin(user);

  // 1. Administrador global sem associação ao condomínio ativo: vai para a sua
  //    área. O acesso de suporte é um mecanismo separado, iniciado por ele.
  //
  // `limparAtivo` segue o mesmo critério que o ramo 3: um id na sessão que NÃO
  // corresponde a nenhuma associação é lixo de contexto e tem de sair. Um Super
  // Admin com um id órfão na sessão é precisamente o caso que gerava o destino
  // errado — manter o id só alimentaria o problema no pedido seguinte.
  if (global && !escolhido) {
    return { redirecionar: DESTINO_GLOBAL, limparAtivo: Boolean(ativo), modoSuporte: false };
  }
  // 3. Sem condomínio escolhido: escolha explícita (mesmo com um só).
  if (!escolhido) {
    return { redirecionar: '/condominios', limparAtivo: Boolean(ativo), modoSuporte: false };
  }
  // 4/5. Papel do condomínio ATIVO decide entre painel e portal.
  const papel = escolhido.role;
  return {
    redirecionar: papel === 'admin' || papel === 'gestor' ? DESTINO_PAINEL : DESTINO_PORTAL,
    limparAtivo: false,
    modoSuporte: false,
  };
}

// true quando o registo pertence ao condomínio ativo (proteção IDOR).
function pertenceAoAtivo(condominioIdRegisto, req) {
  return Number(condominioIdRegisto) === Number(req.condominioId || ativo(req));
}

module.exports = {
  eSuperAdmin,
  ativo,
  associacaoAtiva,
  listarCondominios,
  entrarCondominio,
  papelNoAtivo,
  contextoAdministrativo,
  destinoInicial,
  DESTINO_PAINEL,
  DESTINO_GLOBAL,
  DESTINO_PORTAL,
  podeEscrever,
  papelMaiorOuIgual,
  eAdminCondominio,
  comCondominioAtivo,
  comPapel,
  comSuporte,
  semSuporte,
  bloqueioSuporteNaSessao,
  somenteLeitura,
  auditarConsulta,
  pertenceAoAtivo,
  PAPEIS,
  UserCondominio,
  User,
  Condominio,
};
