// ─────────────────────────────────────────────────────────────────────
// Recomendações contextuais do portal do condómino (Fase 2G).
//
// Camada ÚNICA que decide que recomendação pode ser apresentada. Existe para
// evitar condições repetidas (`if (!req.user.two_fa_ativo)`) espalhadas por
// rotas e templates: quem quiser saber «que recomendação mostrar?» chama
// `escolher` e apresenta o resultado.
//
// Princípios (não negociáveis):
//  1. O ESTADO REAL manda sempre. Uma recomendação só aparece se a sua condição
//     continuar verdadeira no momento do pedido; ser «dispensada» não a mantém
//     viva depois de o problema deixar de existir.
//  2. Não se inventam factos. Cada condição lê um dado que já existe (hoje, o
//     estado de 2FA da própria conta). Não há contadores de «não lido» nem
//     notificações que o sistema não saiba responder.
//  3. Não se guarda o que se pode deduzir. O registo persistente guarda apenas
//     o que NÃO é dedutível: que a recomendação foi dispensada e até quando.
//     «2FA concluído» não se guarda — isso é `users.two_fa_ativo`.
//  4. A ação de cada recomendação é FIXA e vem daqui, nunca do browser: um
//     identificador manipulado não pode originar um destino arbitrário.
//
// Este ficheiro é PURO (sem base de dados, sem rede) — a persistência da
// dispensa está em `carregarDispensas`/`registarDispensa`, que são as únicas
// funções que falam com o modelo. Os testes exercitam o motor sem base de dados.
// ─────────────────────────────────────────────────────────────────────
const { RecomendacaoEstado } = require('../models');

// Intervalo por omissão entre reapresentações, em dias (30 dias, Fase 2G).
const DIAS_REAPRESENTACAO_PADRAO = 30;
const DIA_MS = 24 * 60 * 60 * 1000;

// Tipos de recomendação (o rótulo só serve para leitura do código).
const TIPOS = {
  conclusao: 'Tarefa por concluir',
  seguranca: 'Segurança da conta',
  contextual: 'Informação do condomínio',
  educativa: 'Dica de utilização',
};

// Prioridade: número maior = apresentada primeiro. Só se apresenta a primeira.
const PRIORIDADE = {
  seguranca: 100,
  conclusao: 60,
  contextual: 40,
  educativa: 20,
};

// ── Registo de recomendações ────────────────────────────────────────
// `condicao(ctx)` é a elegibilidade: devolve o motivo (objeto) quando a
// recomendação deve aparecer, ou null quando não há nada a recomendar.
// `acao` é fixa. `dismissivel` decide se se pode dispensar (e, por isso, se é
// guardado algum estado).
const REGISTO = [
  {
    id: '2fa_ativo',
    tipo: 'seguranca',
    dismissivel: true,
    dias: DIAS_REAPRESENTACAO_PADRAO,
    titulo: 'Reforce a segurança da sua conta com 2FA',
    icone: 'shield_lock',
    condicao(ctx) {
      if (!ctx || !ctx.autenticado || !ctx.userId) return null;
      if (ctx.twoFaAtivo !== false) return null; // ativo (ou desconhecido) → não há nada a recomendar
      return {
        mensagem: 'A verificação em duas etapas acrescenta um código extra em cada entrada. '
          + 'Ativa-a em Segurança da conta — a configuração demora menos de um minuto.',
      };
    },
    acao: { texto: 'Ativar 2FA', url: '/conta/seguranca' },
  },

  // ── Extensão futura (documentada; NÃO ativa nesta fase) ───────────
  // Não foi registada nenhuma recomendação de perfil nem contextual, de
  // propósito:
  //  · Perfil — os campos úteis da conta (nome, email) são obrigatórios e já
  //    existem; `users.email_confirmado` é condição de ENTRADA no sistema (a
  //    conta por confirmar é reencaminhada para o login em cada pedido), logo
  //    nunca haveria o que completar dentro do portal; `telefone` é opcional e
  //    vazio, e apresentar isso como «perfil incompleto» seria inventar uma
  //    obrigação que o sistema não tem;
  //  · Contextual (novo documento, aviso novo, assembleia próxima) — o sistema
  //    não guarda estado de leitura para estes conteúdos (o teste de integridade
  //    do portal verifica-o), e as páginas Documentos/Avisos/Calendário já
  //    mostram esses dados. Uma «novidade» aqui seria uma notificação falsa.
  // Para acrescentar uma recomendação mais tarde basta juntar uma entrada a esta
  // lista: o motor, a prioridade, a dispensa e a apresentação já existem.
];

// ── Partes puras ───────────────────────────────────────────────────

function instante(valor) {
  if (!valor) return 0;
  if (valor instanceof Date) return valor.getTime();
  const t = new Date(valor).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// Quando volta a poder aparecer: `dispensada_ate`; se o registo for anterior a
// esse campo, calcula-se a partir de `dispensada_em` + intervalo.
function escondidaAte(registo, fallbackDias = DIAS_REAPRESENTACAO_PADRAO) {
  if (!registo) return 0;
  const ate = instante(registo.dispensada_ate);
  if (ate) return ate;
  const em = instante(registo.dispensada_em);
  if (!em) return 0;
  const dias = Number(registo.intervalo_dias) > 0 ? Number(registo.intervalo_dias) : fallbackDias;
  return em + dias * DIA_MS;
}

// A recomendação está escondida agora? (dispensa em vigor)
function estaDispensada(registo, agora = Date.now(), fallbackDias = DIAS_REAPRESENTACAO_PADRAO) {
  if (!registo) return false;
  const ate = escondidaAte(registo, fallbackDias);
  return ate > instante(agora);
}

// Definições que o sistema conhece (para validar identificadores e para o
// teste «recomendação inválida/manipulada»).
function definicoes() {
  return REGISTO.map((d) => ({ id: d.id, tipo: d.tipo, dismissivel: Boolean(d.dismissivel) }));
}

function porId(id) {
  const chave = String(id == null ? '' : id);
  return REGISTO.find((d) => d.id === chave) || null;
}

// Que recomendações estão elegíveis AGORA?
// `dispensas`: mapa { id: registo } com o estado persistido de cada
// recomendação. Nada mais é consultado.
function elegiveis(ctx = {}, dispensas = {}) {
  const agora = instante(ctx.agora) || Date.now();
  const saida = [];
  for (const definicao of REGISTO) {
    const dados = definicao.condicao(ctx);
    if (!dados) continue; // condição não satisfeita: o estado real venceu
    const registo = dispensas ? dispensas[definicao.id] : null;
    if (definicao.dismissivel && estaDispensada(registo, agora, definicao.dias)) continue; // dispensada e ainda dentro do intervalo
    saida.push({
      id: definicao.id,
      tipo: definicao.tipo,
      titulo: definicao.titulo,
      mensagem: dados.mensagem,
      icone: definicao.icone,
      acao: { texto: definicao.acao.texto, url: definicao.acao.url },
      dismissivel: Boolean(definicao.dismissivel),
      prioridade: PRIORIDADE[definicao.tipo] || 0,
      // Para o registo: quando voltaria a aparecer se fosse dispensada agora.
      diasReapresentacao: definicao.dias || DIAS_REAPRESENTACAO_PADRAO,
    });
  }
  // Prioridade (maior primeiro); empate resolvido pela ordem do registo, para a
  // apresentação ser determinística.
  return saida.sort((a, b) => (b.prioridade - a.prioridade) || (REGISTO.findIndex((d) => d.id === a.id) - REGISTO.findIndex((d) => d.id === b.id)));
}

// A decisão da apresentação: no máximo UMA recomendação principal.
function escolher(ctx = {}, dispensas = {}, limite = 1) {
  const lista = elegiveis(ctx, dispensas);
  return {
    recomendacao: lista.length ? lista[0] : null,
    total: lista.length,
    // As restantes ficam identificadas (para diagnóstico/testes), mas não se
    // apresentam: nada de sucessões de cartões.
    outras: lista.slice(1),
    limite,
  };
}

// Quando expira uma dispensa registada AGORA (instante).
function proximaApresentacao(dias, agora = Date.now()) {
  const d = Number(dias) > 0 ? Number(dias) : DIAS_REAPRESENTACAO_PADRAO;
  return instante(agora) + d * DIA_MS;
}

// A extensão do formulário faz sentido? (evita identificar recomendações que
// não existem ou que, por não serem dispensáveis, nunca geram estado).
function podeDispensar(id) {
  const definicao = porId(id);
  return Boolean(definicao && definicao.dismissivel);
}

// ── Persistência da dispensa (única parte com base de dados) ────────
// Guarda-se apenas o que não é dedutível do estado atual:
//   · que recomendação foi dispensada;
//   · quando (auditoria);
//   · até quando (controlo da reapresentação).
// Nada de «concluída»: isso lê-se de `users.two_fa_ativo`.
async function carregarDispensas(userId) {
  if (!userId) return {};
  const linhas = await RecomendacaoEstado.findAll({ where: { user_id: userId }, raw: true });
  const mapa = {};
  for (const linha of linhas) mapa[linha.recomendacao] = linha;
  return mapa;
}

// Regista (ou renova) a dispensa de uma recomendação para esta conta.
async function registarDispensa({ userId, recomendacao, dias = DIAS_REAPRESENTACAO_PADRAO, agora = Date.now() }) {
  const id = String(recomendacao == null ? '' : recomendacao);
  if (!userId || !podeDispensar(id)) return { ok: false, motivo: 'recomendacao_invalida' };
  const em = new Date(instante(agora) || Date.now());
  const ate = new Date(proximaApresentacao(dias, instante(agora) || Date.now()));
  const existente = await RecomendacaoEstado.findOne({ where: { user_id: userId, recomendacao: id } });
  if (existente) {
    await existente.update({ dispensada_em: em, dispensada_ate: ate, intervalo_dias: Number(dias) || DIAS_REAPRESENTACAO_PADRAO });
    return { ok: true, criada: false };
  }
  await RecomendacaoEstado.create({
    user_id: userId,
    recomendacao: id,
    dispensada_em: em,
    dispensada_ate: ate,
    intervalo_dias: Number(dias) || DIAS_REAPRESENTACAO_PADRAO,
  });
  return { ok: true, criada: true };
}

module.exports = {
  DIAS_REAPRESENTACAO_PADRAO,
  DIA_MS,
  TIPOS,
  PRIORIDADE,
  REGISTO,
  definicoes,
  porId,
  podeDispensar,
  escondidaAte,
  estaDispensada,
  elegiveis,
  escolher,
  proximaApresentacao,
  carregarDispensas,
  registarDispensa,
};
