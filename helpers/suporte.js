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
//   · o condomínio tem de coincidir com o ativo da sessão (âmbito fixo);
//   · `pendente_autorizacao` NÃO autoriza nada (não há ativação automática);
//   · `agora > expira_em` ⇒ expira e deixa de autorizar, no mesmo pedido.
async function vigente(req, condominioId) {
  const utilizador = req && req.user;
  if (!utilizador) return null;
  const id = idNaSessao(req);
  if (!id) return null;

  const acesso = await AcessoSuporte().findOne({
    where: { id, utilizador_id: utilizador.id },
  });
  if (!acesso) {
    limparSessao(req);
    return null;
  }

  // Âmbito: o acesso vale para UM condomínio. Se o alvo não coincidir com o
  // que está na sessão, não autoriza (impede trocar de condomínio reutilizando
  // o mesmo acesso).
  if (condominioId != null && Number(acesso.condominio_id) !== Number(condominioId)) {
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
  // estado e deixa de autorizar já — a decisão não espera por nenhum job.
  if (!acesso.expira_em || new Date(acesso.expira_em).getTime() <= Date.now()) {
    await acesso.update({ estado: 'expirado', terminado_em: new Date() }).catch(() => {});
    limparSessao(req);
    return null;
  }

  return acesso;
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
  if (req) req.session[CHAVE_SESSAO] = acesso.id;
  return { ok: true, acesso };
}

// ── Fechar um acesso ─────────────────────────────────────────────
async function terminar({ acessoId, req } = {}) {
  const acesso = await AcessoSuporte().findByPk(acessoId);
  if (!acesso) return { ok: false, erro: 'nao_encontrado' };
  if (eEstadoTerminal(acesso.estado)) {
    limparSessao(req);
    return { ok: false, erro: 'ja_terminado' };
  }
  await acesso.update({ estado: 'terminado', terminado_em: new Date() });
  limparSessao(req);
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

// Termina o acesso associado à sessão (usado no logout, para não deixar
// janelas abertas — a sessão morre mas o registo ficaria `ativo` até expirar).
async function terminarPorSessao(req) {
  const id = idNaSessao(req);
  limparSessao(req);
  if (!id) return { ok: false, erro: 'sem_acesso' };
  return terminar({ acessoId: id, req });
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
// da execução deste passo.
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
