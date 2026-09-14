// ─────────────────────────────────────────────────────────────────────
// Titularidades de frações — quem tem acesso a uma fração, e desde quando.
//
// Princípios (não negociáveis):
//  · o condomínio e a fração são permanentes; a relação de uma pessoa com uma
//    fração é TEMPORAL;
//  · uma relação terminada nunca é apagada: fica com `data_fim` e
//    `estado='cessada'` (histórico);
//  · o acesso é determinado por `estado='ativa'` E pelas datas — nunca pela
//    simples existência de uma linha, e nunca por um campo "proprietário" na
//    fração (que não existe);
//  · a autorização é sempre reavaliada a cada pedido (esta função é chamada no
//    momento, não a partir da sessão).
//
// Compatibilidade com os dados existentes: enquanto um titular não tiver
// registos em `fracao_titularidades`, é usado o modelo anterior
// (`fracao_pessoas` via `users.pessoa_id`), mas JÁ a respeitar `data_fim` — uma
// relação encerrada deixa de dar acesso nos dois modelos. Nenhuma relação
// válida de hoje perde acesso por causa desta implementação.
//
// O histórico financeiro e documental (quotas, pagamentos, recibos, extra
// quotas, despesas, documentos) está ligado ao condomínio e à fração e NUNCA é
// alterado aqui.
// ─────────────────────────────────────────────────────────────────────
const { Op } = require('sequelize');
const { FracaoTitularidade, FracaoPessoa, Fracao, Pessoa, User } = require('../models');
const { audit } = require('./audit');

const VINCULOS = ['proprietario', 'arrendatario', 'usufrutuario'];
const VINCULO_LABEL = {
  proprietario: 'Proprietário',
  arrendatario: 'Arrendatário',
  usufrutuario: 'Usufrutuário',
};

// ── Datas (comparações em texto ISO: DATEONLY, sem fusos) ───────────
function hojeISO(agora = new Date()) {
  const d = agora instanceof Date ? agora : new Date(agora);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function normalizarData(valor) {
  if (!valor) return null;
  const texto = String(valor).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(texto) ? texto : null;
}
function normalizarVinculo(valor) {
  return VINCULOS.includes(valor) ? valor : 'proprietario';
}
// Id numérico ou null: evita comparar "7" com 7 e distingue ausência de valor.
function normalizarId(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : null;
}
// Dia anterior a uma data (usado para fechar o período anterior no dia anterior
// ao início do novo, sem sobreposição nem buraco).
function diaAnterior(dataISO) {
  const d = normalizarData(dataISO);
  if (!d) return null;
  const data = new Date(`${d}T00:00:00Z`);
  data.setUTCDate(data.getUTCDate() - 1);
  return data.toISOString().slice(0, 10);
}

// Uma titularidade dá acesso AGORA?
//  · só se o registo estiver em curso (`estado='ativa'`);
//  · e se as datas cobrirem a data de referência (uma data de fim já passada
//    corta o acesso, mesmo que o estado não tenha sido fechado).
// Esta é a função usada para AUTORIZAR — nunca a existência da linha.
function estaAtiva(titularidade, dataRef = hojeISO()) {
  if (!titularidade) return false;
  if (String(titularidade.estado || 'ativa') !== 'ativa') return false;
  return vigenteNaData(titularidade, dataRef);
}

// Esta titularidade VIGORAVA naquela data? (pergunta histórica: ignora o estado
// atual e olha só para o período — é o que o histórico de titularidade mostra.)
function vigenteNaData(titularidade, dataRef = hojeISO()) {
  if (!titularidade) return false;
  const inicio = normalizarData(titularidade.data_inicio);
  const fim = normalizarData(titularidade.data_fim);
  if (inicio && inicio > dataRef) return false; // ainda não tinha começado
  if (fim && fim < dataRef) return false; // já tinha terminado
  return true;
}

// ── Titulares atuais de uma fração (histórico fica intacto) ─────────
async function titularesAtuais({ condominioId, fracaoId, dataRef = hojeISO() } = {}) {
  const linhas = await FracaoTitularidade.findAll({
    where: { condominio_id: condominioId, fracao_id: fracaoId },
    include: [
      { model: Pessoa, as: 'pessoa', attributes: ['id', 'nome', 'email'], required: false },
      { model: User, as: 'utilizador', attributes: ['id', 'nome', 'email'], required: false },
    ],
    order: [['data_inicio', 'ASC'], ['id', 'ASC']],
  });
  return linhas.filter((l) => estaAtiva(l, dataRef));
}

async function historicoDaFracao({ condominioId, fracaoId } = {}) {
  return FracaoTitularidade.findAll({
    where: { condominio_id: condominioId, fracao_id: fracaoId },
    include: [
      { model: Pessoa, as: 'pessoa', attributes: ['id', 'nome'], required: false },
      { model: User, as: 'utilizador', attributes: ['id', 'nome', 'email'], required: false },
    ],
    order: [['data_inicio', 'DESC'], ['id', 'DESC']],
  });
}

async function historicoDaPessoa({ condominioId, pessoaId } = {}) {
  if (!pessoaId) return [];
  return FracaoTitularidade.findAll({
    where: { condominio_id: condominioId, pessoa_id: pessoaId },
    include: [{ model: Fracao, as: 'fracao', attributes: ['id', 'designacao'], required: true }],
    order: [['data_inicio', 'DESC'], ['id', 'DESC']],
  });
}

// Uma titularidade dá acesso a ESTA conta? Regra única, explícita:
//  · a titularidade tem `utilizador_id` → só essa conta (a ligação nomeada é a
//    mais forte e decide; a conta é que foi ligada à fração);
//  · a titularidade só tem `pessoa_id` → a conta, desde que esteja ligada a essa
//    pessoa (`users.pessoa_id`). Contas SEM `pessoa_id` não herdam acesso por a
//    titularidade referir uma pessoa: quem liga a conta à pessoa é a
//    administração, e essa ligação é que dá acesso;
//  · a titularidade não tem pessoa nem conta → não dá acesso a ninguém (registo
//    histórico órfão); a conta também tem de existir.
function eContaDaLigacao(titularidade, { utilizadorId = null, pessoaId = null } = {}) {
  if (!titularidade) return false;
  if (!utilizadorId && !pessoaId) return false;
  const donoConta = normalizarId(titularidade.utilizador_id);
  const conta = normalizarId(utilizadorId);
  const contaPessoa = normalizarId(pessoaId);
  const titularPessoa = normalizarId(titularidade.pessoa_id);

  if (donoConta) return donoConta === conta;
  if (titularPessoa) return Boolean(contaPessoa) && titularPessoa === contaPessoa;
  return false;
}

// ── Frações a que um utilizador tem acesso AGORA ────────────────────
// Devolve { origem, motivo, fracoes: [{ fracao, vinculo, titularidadeId, origem }] }.
//  · origem 'titularidades' → a fração/pessoa tem registos na tabela nova, pelo
//    que é essa tabela que decide, mesmo que o resultado seja vazio (uma
//    titularidade cessada, futura ou de outra conta NUNCA é contornada pelo
//    modelo antigo);
//  · origem 'legado'        → sem NENHUM registo na tabela nova para esta pessoa
//    ou conta, decide-se por `fracao_pessoas` (respeitando `data_fim`) —
//    compatibilidade com os dados anteriores a esta funcionalidade;
//  · origem 'nenhuma'       → sem acesso a nenhuma fração.
// `motivo` distingue os casos sem acesso (sem relação, relação encerrada,
// ligação entre a conta e a pessoa em falta) e é usado pela interface e pelos
// testes para explicar a decisão.
async function fracoesDoUtilizador({ condominioId, utilizadorId, pessoaId, dataRef = hojeISO() } = {}) {
  if (!condominioId) return { origem: 'nenhuma', motivo: 'sem_condominio', fracoes: [] };
  const conta = normalizarId(utilizadorId);
  const pessoa = normalizarId(pessoaId);

  if (conta || pessoa) {
    // Sem filtro de estado: a existência de qualquer registo (ativo, futuro ou
    // cessado) é o que determina qual dos modelos manda — a decisão de acesso é
    // feita por `eContaDaLigacao`, não por já ter havido uma linha.
    const linhas = await FracaoTitularidade.findAll({
      where: {
        condominio_id: condominioId,
        // A pessoa é consultada sempre que existir (mesmo quando a conta não
        // está ligada a ela): é o que permite distinguir "não há relação
        // nenhuma" de "há relação da pessoa, mas falta ligar a conta" — dois
        // motivos com consequências diferentes para o administrador.
        [Op.or]: [
          ...(conta ? [{ utilizador_id: conta }] : []),
          ...(pessoa ? [{ pessoa_id: pessoa }] : []),
        ],
      },
      include: [{ model: Fracao, as: 'fracao', where: { condominio_id: condominioId }, required: true }],
      order: [['id', 'ASC']],
    });
    if (linhas.length) {
      const ativas = linhas.filter(
        (l) => estaAtiva(l, dataRef) && eContaDaLigacao(l, { utilizadorId: conta, pessoaId: pessoa })
      );
      return {
        origem: 'titularidades',
        motivo: ativas.length ? 'titularidade_em_vigor' : (linhas.length ? 'sem_ligacao_a_conta' : 'sem_relacao'),
        fracoes: ativas.map((l) => ({
          fracao: l.fracao,
          vinculo: l.vinculo,
          titularidadeId: l.id,
          origem: 'titularidades',
        })),
      };
    }
  }

  // Compatibilidade com o modelo anterior (só quando não há titularidades).
  // Sem `pessoa_id` não há como ligar a conta a um condómino neste modelo, pelo
  // que uma conta sem pessoa não recebe frações por esta via.
  if (!pessoa) return { origem: 'nenhuma', motivo: 'conta_sem_condomino', fracoes: [] };
  const legado = await FracaoPessoa.findAll({
    where: { pessoa_id: pessoa },
    include: [{ model: Fracao, as: 'fracao', where: { condominio_id: condominioId }, required: true }],
    order: [['id', 'ASC']],
  });
  const vivas = legado.filter((l) => {
    const fim = normalizarData(l.data_fim);
    return !fim || fim >= dataRef;
  });
  return {
    origem: vivas.length ? 'legado' : 'nenhuma',
    motivo: vivas.length ? 'vinculo_anterior_em_vigor' : 'sem_relacao',
    fracoes: vivas.map((l) => ({
      fracao: l.fracao,
      vinculo: l.vinculo,
      titularidadeId: null,
      origem: 'legado',
    })),
  };
}

// O utilizador tem acesso a ESTA fração agora?
async function temAcessoFracao({ condominioId, fracaoId, utilizadorId, pessoaId, dataRef = hojeISO() } = {}) {
  if (!condominioId || !fracaoId) return false;
  const filtros = [];
  if (utilizadorId) filtros.push({ utilizador_id: utilizadorId });
  if (pessoaId) filtros.push({ pessoa_id: pessoaId });

  if (filtros.length) {
    const linhas = await FracaoTitularidade.findAll({
      where: { condominio_id: condominioId, fracao_id: fracaoId, [Op.or]: filtros },
    });
    // Se existir qualquer titularidade (mesmo cessada ou futura), é ela que
    // decide — nunca o modelo antigo.
    if (linhas.length) return linhas.some((l) => estaAtiva(l, dataRef));
  }
  if (!pessoaId) return false;
  const legado = await FracaoPessoa.findOne({ where: { fracao_id: fracaoId, pessoa_id: pessoaId } });
  if (!legado) return false;
  const fim = normalizarData(legado.data_fim);
  return !fim || fim >= dataRef;
}

// ── Escrita: criar e encerrar titularidades ────────────────────────
// Criar NUNCA encerra nem substitui nada: se a fração já tiver titular ativo,
// quem chama tem de decidir explicitamente o que fazer (e é avisado).
async function criarTitularidade({
  condominioId, fracaoId, pessoaId = null, utilizadorId = null,
  vinculo = 'proprietario', dataInicio = null, userId = null, origem = 'manual', motivo = null,
} = {}) {
  const titulo = await FracaoTitularidade.create({
    condominio_id: condominioId,
    fracao_id: fracaoId,
    pessoa_id: pessoaId,
    utilizador_id: utilizadorId,
    vinculo: normalizarVinculo(vinculo),
    data_inicio: normalizarData(dataInicio) || hojeISO(),
    data_fim: null,
    estado: 'ativa',
    motivo_cessacao: null,
    created_by: userId,
  });
  await audit({
    userId,
    acao: 'criar_titularidade',
    entidade: 'FracaoTitularidade',
    entidadeId: titulo.id,
    detalhes: { condominioId, fracaoId, pessoaId, utilizadorId, vinculo: titulo.vinculo, dataInicio: titulo.data_inicio, origem, motivo },
  });
  return titulo;
}

// Encerrar: preenche data_fim + estado 'cessada' (a linha fica para histórico) e
// fecha também o vínculo correspondente em `fracao_pessoas`, quando existe, para
// que os restantes consumidores (avisos, recibos) deixem de o considerar atual.
async function cessarTitularidade({ titularidadeId, dataFim = null, motivo = null, userId = null } = {}) {
  const titulo = await FracaoTitularidade.findByPk(titularidadeId);
  if (!titulo) return null;
  if (titulo.estado === 'cessada') return titulo;

  const fim = normalizarData(dataFim) || hojeISO();
  await titulo.update({ estado: 'cessada', data_fim: fim, motivo_cessacao: motivo || null });

  if (titulo.pessoa_id) {
    const vinculo = await FracaoPessoa.findOne({
      where: { fracao_id: titulo.fracao_id, pessoa_id: titulo.pessoa_id, vinculo: titulo.vinculo },
    });
    if (vinculo && !vinculo.data_fim) {
      await vinculo.update({ data_fim: fim });
    }
  }

  await audit({
    userId,
    acao: 'cessar_titularidade',
    entidade: 'FracaoTitularidade',
    entidadeId: titulo.id,
    detalhes: { condominioId: titulo.condominio_id, fracaoId: titulo.fracao_id, pessoaId: titulo.pessoa_id, utilizadorId: titulo.utilizador_id, dataFim: fim, motivo: motivo || null },
  });
  return titulo;
}

// Encerra todas as titularidades ativas de um utilizador (ou pessoa) num
// condomínio. Usado no fluxo "Preparar saída do condomínio" e na mudança de
// proprietário. Devolve as titularidades encerradas.
async function cessarTitularidadesAtivas({
  condominioId, utilizadorId = null, pessoaId = null, dataFim = null, motivo = null, userId = null,
} = {}) {
  const filtros = [];
  if (utilizadorId) filtros.push({ utilizador_id: utilizadorId });
  if (pessoaId) filtros.push({ pessoa_id: pessoaId });
  if (!filtros.length) return [];

  const linhas = await FracaoTitularidade.findAll({
    where: { condominio_id: condominioId, estado: 'ativa', [Op.or]: filtros },
    order: [['id', 'ASC']],
  });
  const encerradas = [];
  for (const linha of linhas) {
    if (!estaAtiva(linha, normalizarData(dataFim) || hojeISO())) continue;
    encerradas.push(await cessarTitularidade({ titularidadeId: linha.id, dataFim, motivo, userId }));
  }
  return encerradas;
}

// ── Contactos ATUAIS de uma fração (comunicações: avisos, quotas, recibos) ──
// Devolve as pessoas que hoje representam a fração. Depois de uma mudança de
// proprietário, o anterior deixa de constar (ou porque o período foi cessado,
// ou porque o vínculo antigo em `fracao_pessoas` ficou com `data_fim`) e o novo
// passa a constar. Cada pessoa traz `vinculoAtual` para manter a ordem de
// apresentação (proprietário primeiro). Arrendatários e usufrutuários são
// incluídos: a fração continua a comunicar com quem lá vive.
async function pessoasAtuaisDaFracao({ condominioId, fracaoId, dataRef = hojeISO() } = {}) {
  if (!fracaoId) return [];
  const ordem = { proprietario: 0, arrendatario: 1, usufrutuario: 2 };
  const vazio = { origem: 'nenhuma', pessoas: [] };

  // O condomínio da fração é a fonte de verdade do âmbito (quando não é
  // indicado, procura-se — evita cruzar dados de outro condomínio).
  if (!condominioId) {
    const fracao = await Fracao.findOne({ where: { id: fracaoId }, attributes: ['id', 'condominio_id'] });
    if (!fracao) return vazio;
    condominioId = fracao.condominio_id;
  }

  let atuais = await titularesAtuais({ condominioId, fracaoId, dataRef });
  const pessoasIds = atuais.filter((t) => t.pessoa_id).map((t) => Number(t.pessoa_id));

  // Qualquer registo de titularidade (mesmo cessado ou futuro) decide: o modelo
  // anterior só é consultado quando a fração ainda não tem titularidades.
  let origem = 'titularidades';
  if (!atuais.length) {
    const existentes = await FracaoTitularidade.findAll({
      where: { condominio_id: condominioId, fracao_id: fracaoId },
      attributes: ['id'],
      limit: 1,
    });
    if (existentes.length) return vazio;
    atuais = await FracaoPessoa.findAll({
      where: { fracao_id: fracaoId, data_fim: null },
      include: [{ model: Pessoa, as: 'pessoa', required: true }],
      order: [['id', 'ASC']],
    });
    origem = 'legado';
  }

  const ids = atuais.map((t) => Number(t.pessoa_id || (t.pessoa && t.pessoa.id))).filter(Boolean);
  if (!ids.length) return vazio;
  const registos = await Pessoa.findAll({ where: { id: { [Op.in]: ids } } });
  const porId = new Map(registos.map((p) => [Number(p.id), p]));

  const pessoas = [];
  const vistos = new Set();
  atuais.forEach((t) => {
    const pessoa = t.pessoa || porId.get(Number(t.pessoa_id));
    if (!pessoa || vistos.has(Number(pessoa.id))) return;
    vistos.add(Number(pessoa.id));
    pessoa.vinculoAtual = t.vinculo || null;
    pessoas.push(pessoa);
  });
  pessoas.sort((a, b) => (ordem[a.vinculoAtual] ?? 3) - (ordem[b.vinculoAtual] ?? 3));
  return { origem, pessoas };
}

// ── Acesso a um condomínio: guardar dados não reativa nada ─────────
// A associação `utilizador_condominios` (estado 'ativo'/'inativo') é o que dá
// acesso ao condomínio. Regra única, usada pela administração de utilizadores:
//  · associação já ativa → manter ativa (comportamento normal de quem nunca saiu);
//  · associação inativa  → só volta a 'ativo' com pedido EXPLÍCITO de reativação.
//    Guardar o formulário não é intenção de reabrir o acesso.
function pedidoDeReativacao(valor) {
  return valor === true || valor === '1' || valor === 'on' || valor === 1;
}

function decidirEstadoAssociacao({ estadoAtual, reativar = false } = {}) {
  const estavaAtiva = estadoAtual === 'ativo';
  const reativada = !estavaAtiva && pedidoDeReativacao(reativar);
  return {
    estavaAtiva,
    reativada,
    estado: estavaAtiva || reativada ? 'ativo' : (estadoAtual || null),
  };
}

// Situação resumida de uma fração (para o ecrã de administração).
async function situacaoDaFracao({ condominioId, fracaoId, dataRef = hojeISO() } = {}) {
  const [atuais, historico] = await Promise.all([
    titularesAtuais({ condominioId, fracaoId, dataRef }),
    historicoDaFracao({ condominioId, fracaoId }),
  ]);
  return {
    atuais,
    historico,
    semTitular: atuais.length === 0,
    // Vários titulares ativos com o mesmo vínculo é sinal de dados a corrigir
    // (o antigo proprietário não foi encerrado).
    duplicados: atuais.filter((a) => atuais.some((b) => b.id !== a.id && b.vinculo === a.vinculo && a.vinculo === 'proprietario')).length > 0,
  };
}

module.exports = {
  VINCULOS,
  VINCULO_LABEL,
  hojeISO,
  normalizarData,
  normalizarVinculo,
  normalizarId,
  eContaDaLigacao,
  decidirEstadoAssociacao,
  pedidoDeReativacao,
  diaAnterior,
  estaAtiva,
  vigenteNaData,
  titularesAtuais,
  historicoDaFracao,
  historicoDaPessoa,
  fracoesDoUtilizador,
  temAcessoFracao,
  pessoasAtuaisDaFracao,
  criarTitularidade,
  cessarTitularidade,
  cessarTitularidadesAtivas,
  situacaoDaFracao,
};
