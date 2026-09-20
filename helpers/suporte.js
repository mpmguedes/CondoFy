// ─────────────────────────────────────────────────────────────────────
// Acesso de suporte — TERCEIRO CONTEXTO da autorização.
//
// Distinto de:
//   GLOBAL      `users.role_global === 'super_admin'`  → administra a plataforma
//   CONDOMÍNIO  `utilizador_condominios.role`          → admin | gestor | leitura
//   PORTAL      titularidade da fração                 → área do condómino
//
// INVARIANTE CENTRAL: um acesso de suporte NUNCA produz
// `req.papelCondominio = 'admin'` nem `'gestor'`. Não é um papel de condomínio
// — é uma concessão com âmbito e prazo. Quem materializa o contexto
// (`comCondominioAtivo`) deixa `req.papelCondominio` a `null` durante o suporte,
// pelo que TODAS as guardas existentes (`comPapel('gestor')`,
// `apenasAdmin = comPapel('admin')`) recusam por construção.
//
// A BD é a fonte de verdade: a sessão guarda apenas `suporte_ativo_id` e o
// estado é revalidado em cada pedido (`vigente`). A expiração é ABSOLUTA — a
// atividade do utilizador nunca a estende (ao contrário do idle da sessão).
// ─────────────────────────────────────────────────────────────────────
// Os modelos são lidos em DIFERIDO (`modelos()`), não no topo do módulo.
//
// Motivo: `helpers/tenant.js` importa este módulo, e o tenant é carregado por
// testes SEM base de dados que substituem `/models` por stubs através do
// `require.cache`. Um `require('../models')` no topo guardaria a referência
// antes da substituição — a injeção deixaria de funcionar.
function modelos() {
  return require('../models');
}
const AcessoSuporte = () => modelos().AcessoSuporte;
const UserCondominio = () => modelos().UserCondominio;

// A auditoria é lida em DIFERIDO pela mesma razão que os modelos: `helpers/
// audit.js` faz `require('../models')` no topo, pelo que um `require('./audit')`
// no topo deste ficheiro (importado por `tenant.js`) capturaria a referência aos
// modelos ANTES da substituição por stubs nos testes sem base de dados.
function registarAuditoria(evento) {
  try {
    return Promise.resolve(require('./audit').audit(evento)).catch(() => {});
  } catch (err) {
    // A auditoria nunca pode derrubar a autorização.
    return Promise.resolve();
  }
}

// ── Auditoria da CONSULTA (ACHADO-02) ─────────────────────────────
// Regista que um acesso de suporte CONSULTOU uma rota admitida. É auditoria de
// telemetria, não de autorização: corre DEPOIS da admissão e nunca a influencia
// (o valor devolvido não é lido por nenhum guard).
//
// Porque é que isto não vive num handler: a allow-list fecha 24 caminhos em 9
// routers. Registar em cada handler seriam 24 sítios para esquecer, e um módulo
// novo só ficaria auditado por acidente. O único ponto por onde TODOS os
// pedidos admitidos passam é o guard `soDiagnostico` — é lá que se chama isto.
//
// ── SEM AGREGAÇÃO (decisão de arquitetura) ────────────────────────
// Regista CADA consulta admitida. Houve uma primeira versão que agregava por
// (acesso, rota) com um conjunto em memória; foi recusada e removida. As razões
// ficam escritas para que não se reintroduza:
//
//   1. Deduplicar exige saber o que já está gravado, e a única fonte de verdade
//      é o `AuditLog`. Consultá-lo por consulta implicaria um `findOne` sem
//      índice (a tabela só tem a PK) e uma comparação textual sobre `detalhes`
//      (TEXT) — a mesma fragilidade de um `LIKE`, apenas disfarçada — ou então
//      carregar todos os eventos para memória.
//   2. A doutrina do projeto (migration `20260101000073`) é explícita:
//      «`audit_logs` é um registo de eventos (append-only, para auditoria), NÃO
//      um estado atual». Deduplicar por consulta usaria o log como estado.
//   3. Estado em memória não serve uma funcionalidade de auditoria: um restart,
//      um deploy ou N processos produzem falsos negativos SILENCIOSOS — e um
//      evento em falta é indistinguível de «não houve consulta». Numa auditoria
//      de segurança, perder um evento é pior do que repetir um.
//
// O argumento que decidiu: NÃO HÁ PROBLEMA DE VOLUME. O teto é o tamanho da
// allow-list — 24 caminhos admitidos — e o registo só é escrito quando alguém
// abre DELIBERADAMENTE um acesso de suporte, que é um evento raro. É ordens de
// magnitude menos do que `inicio_sessao` ou `abrir_documento`, que já correm em
// utilização normal. A agregação pouparia linhas que não fazem falta.
//
// Efeito secundário benéfico: a contagem de eventos por acesso passa a ser uma
// MEDIDA REAL da utilização do suporte, em vez de uma aproximação volátil.

// Registra UMA consulta admitida. Fire-and-forget e tolerante a falhas: nunca
// lança e nunca é aguardado no caminho do pedido (`registarAuditoria` engole
// qualquer erro), para que a telemetria jamais derrube a página.
//
// Devolve `true` quando o evento foi submetido e `false` quando não havia dados
// suficientes. O valor é apenas informativo — nenhum guard o lê.
function registarConsulta({ acessoId, condominioId, rota } = {}) {
  const id = Number(acessoId);
  // Sem acesso identificado ou sem rota não há consulta a registar. Falha
  // fechada no sentido conservador: NÃO se inventa um evento com campos nulos
  // (uma entrada sem `acesso_suporte_id` não serve a ninguém e polui o log).
  if (!Number.isFinite(id) || id <= 0) return false;
  if (typeof rota !== 'string' || rota === '') return false;

  // Só o ENVELOPE mínimo, com exatamente três campos. Nunca a query string
  // (`rota` já é `req.path`, que não a tem), nunca dados da página: nem nomes,
  // nem emails, nem NIF/IBAN, nem valores, nem ids de linha consultados, nem
  // urls de ficheiro, nem tokens, nem corpo de emails.
  registarAuditoria({
    userId: null,
    acao: 'suporte_consulta',
    entidade: 'Condominio',
    entidadeId: condominioId,
    detalhes: {
      acesso_suporte_id: id,
      condominio_id: condominioId,
      rota,
    },
  });

  return true;
}

// Associação do operador (quem pediu o acesso) — carregada nas listagens para o
// administrador saber a QUEM está a autorizar. Só nome e email: o objetivo é
// identificar, não expor o perfil.
const operador = () => ({
  model: modelos().User,
  as: 'operador',
  attributes: ['id', 'nome', 'email'],
});

// Durações permitidas (minutos). Lista fechada: o browser não escolhe o prazo,
// escolhe uma destas opções — nunca se aceita um valor arbitrário do pedido.
const DURACOES_MINUTOS = [15, 30, 60, 120, 240, 480];
const DURACAO_PADRAO = 60;

// Níveis concedíveis NESTA fase. `operacional` existe no modelo e no ENUM para
// evolução futura, mas não pode ser concedido — a restrição é no backend, não
// apenas na interface.
const NIVEIS_CONCEDIVEIS = ['diagnostico'];
const NIVEL_PADRAO = 'diagnostico';
const nivelConcedivel = (nivel) => NIVEIS_CONCEDIVEIS.includes(nivel);

// Estados terminais: o acesso já não autoriza nada.
const ESTADOS_TERMINAIS = ['expirado', 'terminado', 'revogado'];
const eEstadoTerminal = (estado) => ESTADOS_TERMINAIS.includes(estado);

// ── Origem do término ──────────────────────────────────────────────
// Distingue, na AUDITORIA, quatro fins distintos que partilham o mesmo estado
// `terminado`/`expirado`. Sem esta distinção, «terminado» não diria se o acesso
// acabou por ação do próprio operador, pelo fim da sessão (logout/inatividade)
// ou pela desativação da conta — três situações operacionais diferentes.
const ORIGEM = {
  OPERADOR: 'operador', // término explícito pelo operador de suporte
  LOGOUT: 'logout', // sessão encerrada pelo próprio utilizador
  INATIVIDADE: 'inatividade', // sessão encerrada por inatividade
  CONTA_DESATIVADA: 'conta_desativada', // conta deixou de estar utilizável
};

const CHAVE_SESSAO = 'suporte_ativo_id';

// ── Identificador do acesso guardado na sessão ─────────────────────
// A sessão guarda SÓ o id: tudo o resto (âmbito, nível, prazo, estado) é lido
// da BD em cada pedido. Um id manipulado no browser não concede nada — a
// revalidação verifica também `utilizador_id`, pelo que não serve de nada
// apontar para um acesso de outro operador.
function idNaSessao(req) {
  const id = req && req.session ? req.session[CHAVE_SESSAO] : null;
  return id ? Number(id) : null;
}

function limparSessao(req) {
  if (req && req.session) delete req.session[CHAVE_SESSAO];
}

// Normaliza um acesso para o eixo `req.suporte`. Note-se que NÃO devolve papel
// nenhum: o chamador não pode derivar privilégio de condomínio daqui.
function paraContexto(acesso) {
  if (!acesso) return null;
  return {
    id: acesso.id,
    condominioId: Number(acesso.condominio_id),
    nivel: acesso.nivel,
    motivo: acesso.motivo,
    expiraEm: acesso.expira_em,
  };
}

// ── Revalidação (o coração do isolamento) ─────────────────────────
// Devolve o acesso VIGENTE do utilizador para o condomínio ativo, ou null.
// Corre em cada pedido que precise de contexto de condomínio, pelo que a
// expiração e a revogação têm efeito IMEDIATO — sem depender de cron, job ou
// temporizador.
//
// Regras:
//   · só um `super_admin` tem acesso de suporte (deriva do eixo GLOBAL);
//   · o acesso tem de ser do PRÓPRIO utilizador (contra roubo de id);
//   · o acesso tem de estar VINCULADO à SESSÃO para que foi iniciado/autorizado
//     (`session_id` === req.sessionID) — um id sozinho não serve de prova;
//   · o condomínio é OBRIGATÓRIO e tem de coincidir com o do acesso (âmbito fixo);
//   · `pendente_autorizacao` NÃO autoriza nada (não há ativação automática);
//   · `agora >= expira_em` ⇒ expira, audita e deixa de autorizar, no mesmo pedido.
//
// `condominioId` é OBRIGATÓRIO e é validado no início: não existe caminho em que
// um chamador peça «qualquer condomínio» e receba um acesso sem filtro de âmbito.
async function vigente(req, condominioId) {
  const utilizador = req && req.user;
  if (!utilizador) return null;
  // Âmbito obrigatório: sem um condomínio explícito não há autorização de âmbito.
  const alvo = Number(condominioId);
  if (!Number.isFinite(alvo) || alvo <= 0) return null;
  const id = idNaSessao(req);
  if (!id) return null;

  const acesso = await AcessoSuporte().findOne({
    where: { id, utilizador_id: utilizador.id },
  });
  if (!acesso) {
    limparSessao(req);
    return null;
  }

  // Vinculação à SESSÃO. O acesso só vale na sessão para que foi aberto: um
  // `acesso_suporte_id` obtido por outra via (outro browser, outra conta com a
  // mesma sessão replicada, um id adivinhado) não autoriza nada. Compara-se o
  // `session_id` gravado no arranque/autorização com o `req.sessionID` atual.
  //
  // Sessões sem id (`req.sessionID` ausente) e acessos antigos sem `session_id`
  // gravado são recusados — falha fechada, nunca «sem prova = passa».
  const sessaoAtual = req.sessionID ? String(req.sessionID) : null;
  const sessaoAcesso = acesso.session_id ? String(acesso.session_id) : null;
  if (!sessaoAtual || !sessaoAcesso || sessaoAcesso !== sessaoAtual) {
    limparSessao(req);
    return null;
  }

  // Âmbito: o acesso vale para UM condomínio. Se o alvo não coincidir com o do
  // acesso, não autoriza (impede trocar de condomínio reutilizando o acesso).
  if (Number(acesso.condominio_id) !== alvo) {
    return null;
  }

  // Estado terminal: nunca autoriza.
  if (eEstadoTerminal(acesso.estado)) {
    limparSessao(req);
    return null;
  }

  // Pedido ainda à espera do administrador do condomínio: não autoriza.
  // Não existe ativação automática — só `autorizar()` o promove.
  if (acesso.estado === 'pendente_autorizacao') {
    return null;
  }

  // Expiração ABSOLUTA: não renovável por atividade. Ao detetar, formaliza o
  // estado, AUDITA e deixa de autorizar já — a decisão não espera por nenhum job.
  //
  // A comparação é `>=`: no instante exato `agora === expira_em` o acesso já
  // está fora do prazo (o prazo é «até expira_em», não inclusive).
  if (!acesso.expira_em || new Date(acesso.expira_em).getTime() <= Date.now()) {
    await marcarExpirado(acesso, utilizador);
    limparSessao(req);
    return null;
  }

  return acesso;
}

// Formaliza a expiração e AUDITA-A, sem duplicar eventos.
//
// A expiração é LAZY (on-demand, dentro de `vigente`) por decisão de desenho:
// não há cron para isto, e nada depende de um. Como vários pedidos podem chegar
// depois do prazo, a transição só pode acontecer UMA vez — a guarda é o próprio
// estado: quem primeiro vir `ativo` passa-o a `expirado` (o `update` devolve
// quantas linhas mudou); os pedidos seguintes já o encontram `expirado` e não
// voltam a auditar.
async function marcarExpirado(acesso, utilizador) {
  if (eEstadoTerminal(acesso.estado)) return false; // já formalizado — não repete
  const [n] = await AcessoSuporte()
    .update(
      { estado: 'expirado', terminado_em: new Date() },
      { where: { id: acesso.id, estado: 'ativo' } } // só transita a partir de ativo
    )
    .catch(() => [0]);
  // `n === 0` significa que outro pedido já tratou da transição: não se audita
  // duas vezes o mesmo fim de acesso.
  if (Number(n) !== 1) return false;

  await registarAuditoria({
    userId: utilizador && utilizador.id ? utilizador.id : null,
    acao: 'suporte_expirado',
    entidade: 'Condominio',
    entidadeId: acesso.condominio_id,
    detalhes: {
      acesso_suporte_id: acesso.id,
      condominio_id: acesso.condominio_id,
      nivel: acesso.nivel,
      motivo: acesso.motivo,
      expira_em: acesso.expira_em,
      origem: 'expiracao',
    },
  });
  return true;
}

// ── Administrador ativo do condomínio (para o fluxo híbrido) ──────
// Existe admin ativo? Decide entre `pendente_autorizacao` (exige autorização
// explícita) e início imediato (não há ninguém a quem pedir).
async function temAdminAtivo(condominioId) {
  const n = await UserCondominio().count({
    where: { condominio_id: condominioId, role: 'admin', estado: 'ativo' },
  });
  return n > 0;
}

// ── Criar um acesso ──────────────────────────────────────────────
// `nivel`: só `diagnostico` nesta fase (o backend recusa o resto, mesmo que o
// pedido traga `operacional`).
// `duracaoMinutos`: tem de constar da lista fechada (nunca um valor arbitrário).
async function iniciar({ req, condominioId, motivo, nivel, duracaoMinutos } = {}) {
  const texto = String(motivo || '').trim();
  if (!texto) return { ok: false, erro: 'motivo_obrigatorio' };

  const nivelPedido = nivel || NIVEL_PADRAO;
  if (!nivelConcedivel(nivelPedido)) return { ok: false, erro: 'nivel_nao_concedivel' };

  const minutos = Number(duracaoMinutos);
  if (!DURACOES_MINUTOS.includes(minutos)) return { ok: false, erro: 'duracao_invalida' };

  const agora = new Date();
  const expira = new Date(agora.getTime() + minutos * 60 * 1000);

  // Fluxo híbrido (opção D): com admin ativo no condomínio, o acesso fica
  // `pendente_autorizacao` e só `autorizar()` o promove. Sem admin ativo, pode
  // arrancar diretamente — mas sempre com motivo e prazo, e integralmente
  // auditado.
  const exigeAutorizacao = await temAdminAtivo(condominioId);
  const estado = exigeAutorizacao ? 'pendente_autorizacao' : 'ativo';

  const acesso = await AcessoSuporte().create({
    utilizador_id: req.user.id,
    condominio_id: condominioId,
    nivel: nivelPedido,
    motivo: texto,
    estado,
    iniciado_em: agora,
    expira_em: expira,
    session_id: req.sessionID || null,
  });

  // Só um acesso já ATIVO entra na sessão. Um pedido pendente não dá contexto
  // nenhum — e como `vigente` recusa `pendente_autorizacao`, mesmo que o id
  // ficasse na sessão não autorizaria nada.
  if (estado === 'ativo') req.session[CHAVE_SESSAO] = acesso.id;
  else limparSessao(req);

  return { ok: true, acesso, pendente: estado === 'pendente_autorizacao' };
}

// ── Autorizar um pedido pendente ─────────────────────────────────
// Exige um admin ativo do MESMO condomínio (nunca de outro). Não existe
// ativação automática: sem esta chamada explícita, nada acontece.
async function autorizar({ acessoId, adminUserId, req } = {}) {
  const acesso = await AcessoSuporte().findByPk(acessoId);
  if (!acesso) return { ok: false, erro: 'nao_encontrado' };
  if (acesso.estado !== 'pendente_autorizacao') return { ok: false, erro: 'estado_invalido' };

  const assoc = await UserCondominio().findOne({
    where: {
      utilizador_id: adminUserId,
      condominio_id: acesso.condominio_id,
      role: 'admin',
      estado: 'ativo',
    },
  });
  if (!assoc) return { ok: false, erro: 'sem_permissao' };

  // Se entretanto expirou, não se autoriza um acesso morto.
  if (!acesso.expira_em || new Date(acesso.expira_em).getTime() <= Date.now()) {
    await acesso.update({ estado: 'expirado', terminado_em: new Date() }).catch(() => {});
    return { ok: false, erro: 'expirado' };
  }

  await acesso.update({ estado: 'ativo', autorizado_por: adminUserId });
  // A vinculação à sessão mantém-se a que foi gravada no ARRANQUE do pedido. Se
  // o operador tiver entretanto mudado de sessão, o acesso reaberto não vale
  // nessa sessão nova — `vigente` recusa-o, e é preciso iniciar outro.
  if (req) req.session[CHAVE_SESSAO] = acesso.id;
  return { ok: true, acesso };
}

// ── Fechar um acesso ─────────────────────────────────────────────
// `origem` distingue, na auditoria, o motivo do término (operador, logout,
// inatividade, conta desativada). O ESTADO mantém-se `terminado`.
async function terminar({ acessoId, req, origem = ORIGEM.OPERADOR, utilizadorId = null } = {}) {
  const acesso = await AcessoSuporte().findByPk(acessoId);
  if (!acesso) return { ok: false, erro: 'nao_encontrado' };
  if (eEstadoTerminal(acesso.estado)) {
    limparSessao(req);
    return { ok: false, erro: 'ja_terminado' };
  }
  await acesso.update({ estado: 'terminado', terminado_em: new Date() });
  limparSessao(req);
  await registarAuditoria({
    userId: utilizadorId || (req && req.user ? req.user.id : acesso.utilizador_id) || null,
    acao: 'suporte_terminado',
    entidade: 'Condominio',
    entidadeId: acesso.condominio_id,
    detalhes: {
      acesso_suporte_id: acesso.id,
      condominio_id: acesso.condominio_id,
      nivel: acesso.nivel,
      motivo: acesso.motivo,
      expira_em: acesso.expira_em,
      origem,
    },
  });
  return { ok: true, acesso };
}

async function revogar({ acessoId, revogadoPor, req } = {}) {
  const acesso = await AcessoSuporte().findByPk(acessoId);
  if (!acesso) return { ok: false, erro: 'nao_encontrado' };
  if (eEstadoTerminal(acesso.estado)) {
    limparSessao(req);
    return { ok: false, erro: 'ja_terminado' };
  }
  await acesso.update({ estado: 'revogado', terminado_em: new Date(), revogado_por: revogadoPor || null });
  limparSessao(req);
  return { ok: true, acesso };
}

// Recusa de um pedido PENDENTE pelo administrador do condomínio.
//
// Distinto de `revogar`: aqui não havia autorização nenhuma para retirar — o
// administrador está a dizer «não» a um pedido. O estado final é o mesmo
// (`revogado`, terminal) porque o significado operacional coincide: nunca
// autorizou e nunca vai autorizar.
async function recusar({ acessoId, resgatadoPor, req } = {}) {
  const acesso = await AcessoSuporte().findByPk(acessoId);
  if (!acesso) return { ok: false, erro: 'nao_encontrado' };
  if (acesso.estado !== 'pendente_autorizacao') return { ok: false, erro: 'estado_invalido' };
  await acesso.update({ estado: 'revogado', terminado_em: new Date(), revogado_por: resgatadoPor || null });
  limparSessao(req);
  return { ok: true, acesso };
}

// Termina o acesso associado à sessão (usado no logout/inatividade, para não
// deixar janelas abertas — a sessão morre mas o registo ficaria `ativo` até
// expirar).
//
// `origem` é OBRIGATÓRIA de explicitar pelo chamador (logout, inatividade,
// conta desativada) para que a auditoria distinga os três casos. NUNCA reusa a
// origem «operador» por omissão — o fim por sessão não é uma decisão do
// operador e não pode aparecer como tal no histórico.
async function terminarPorSessao(req, origem = ORIGEM.LOGOUT) {
  const id = idNaSessao(req);
  limparSessao(req);
  if (!id) return { ok: false, erro: 'sem_acesso' };
  return terminar({ acessoId: id, req, origem, utilizadorId: req && req.user ? req.user.id : null });
}

// Acessos vigentes de um operador (para saber quem está em suporte agora).
async function vigentesDe(utilizadorId) {
  if (!utilizadorId) return [];
  return AcessoSuporte().findAll({
    where: { utilizador_id: utilizadorId, estado: 'ativo' },
    order: [['id', 'DESC']],
  });
}

// Quantos pedidos estão à espera de decisão neste condomínio. Alimenta o aviso
// na navegação do administrador — sem isto, um pedido pendente passaria
// despercebido e expirava sem ninguém o ver.
async function contagemPendentes(condominioId) {
  if (!condominioId) return 0;
  return AcessoSuporte().count({
    where: { condominio_id: condominioId, estado: 'pendente_autorizacao' },
  });
}

// Pedidos à espera de autorização de um condomínio (para a página do admin).
async function pendentesDe(condominioId) {
  if (!condominioId) return [];
  return AcessoSuporte().findAll({
    where: { condominio_id: condominioId, estado: 'pendente_autorizacao' },
    include: [operador()],
    order: [['id', 'ASC']],
  });
}

// Acessos ATIVOS de um condomínio (o que está a acontecer agora).
async function ativosDe(condominioId) {
  if (!condominioId) return [];
  return AcessoSuporte().findAll({
    where: { condominio_id: condominioId, estado: 'ativo' },
    include: [operador()],
    order: [['id', 'DESC']],
  });
}

// Histórico de um condomínio (transparência ativa: quem acedeu, quando, porquê).
async function historicoDe(condominioId, limit = 100) {
  if (!condominioId) return [];
  return AcessoSuporte().findAll({
    where: { condominio_id: condominioId },
    include: [operador()],
    order: [['id', 'DESC']],
    limit,
  });
}

// Formaliza a expiração dos acessos cujo prazo passou. É apenas BOOKKEEPING:
// a autorização já recusa acessos expirados em `vigente`, pelo que nada depende
// da execução deste passo. Não há cron para isto — a expiração efetiva é lazy,
// dentro de `vigente`.
//
// Ao contrário do caminho de `vigente`, este passo em lote NÃO audita acesso a
// acesso: é uma operação de manutenção, não um acesso detetado em uso. Se vier
// a correr num job, cada linha formalizada deve gerar o seu `suporte_expirado`
// (a auditoria de expiração que interessa é a do acesso que estava a ser usado).
async function expirados() {
  const agora = new Date();
  const [n] = await AcessoSuporte().update(
    { estado: 'expirado', terminado_em: agora },
    { where: { estado: 'ativo', expira_em: { [require('sequelize').Op.lte]: agora } } }
  );
  return n;
}

module.exports = {
  CHAVE_SESSAO,
  ORIGEM,
  DURACOES_MINUTOS,
  DURACAO_PADRAO,
  NIVEIS_CONCEDIVEIS,
  NIVEL_PADRAO,
  ESTADOS_TERMINAIS,
  nivelConcedivel,
  eEstadoTerminal,
  idNaSessao,
  limparSessao,
  paraContexto,
  vigente,
  marcarExpirado,
  registarConsulta,
  temAdminAtivo,
  iniciar,
  autorizar,
  terminar,
  revogar,
  recusar,
  terminarPorSessao,
  vigentesDe,
  contagemPendentes,
  pendentesDe,
  ativosDe,
  historicoDe,
  expirados,
};
