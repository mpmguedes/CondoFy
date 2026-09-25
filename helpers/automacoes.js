// ─────────────────────────────────────────────────────────────────────
// Automações de documentos — comportamento automático por tipo de
// documento quando o GesCondu gera/regista um documento.
//
// Por cada tipo guarda-se na BD (chaves `auto_<tipo>_<canal>`):
//  · drive      → guardar automaticamente no serviço de armazenamento (0/1)
//  · email      → disponibilizar para envio por email (0/1, informativo)
//  · automatico → enviar automaticamente por email quando aplicável (0/1)
//
// Regra de segurança: NADA é enviado/guardado automaticamente sem
// configuração explícita ('1'). O padrão é tudo desligado, exceto o que
// já era o comportamento da aplicação (ex.: backups com Drive ligado).
//
// ── P54-7 — ÂMBITO POR CONDOMÍNIO (isolamento) ──────────────────────
// Antes gravava-se SEMPRE a chave GLOBAL (`auto_<tipo>_<canal>`), pelo que o
// administrador do condomínio A desligava as automações de TODOS — o B
// incluído, que nunca tinha pedido nada. Agora:
//
//   · a GRAVAÇÃO escreve `auto_<tipo>_<canal>:c<ID>` e EXIGE âmbito (sem
//     condomínio válido é recusada — nunca cai na chave global);
//   · a LEITURA usa a precedência específica → global → default do código,
//     pelo que a chave base fica como valor HERDADO (uma instalação que só
//     tenha as chaves globais comporta-se exatamente como antes, sem uma
//     única escrita nova na base de dados);
//   · uma leitura SEM contexto de condomínio (jobs globais) nunca é afetada
//     pelo que um condomínio gravou no seu próprio âmbito.
//
// A convenção vive em `helpers/config-ambito.js` (a mesma que o P54-7 usou nas
// notificações) — este módulo não a reimplementa.
//
// ── Submissão COMPLETA (marcador) ───────────────────────────────────
// Uma checkbox desmarcada não viaja no corpo do pedido: «campo ausente» era
// indistinguível de «formulário nunca submetido», e um POST direto desligava
// todas as automações em silêncio. O formulário envia `_automacoes=1` e a
// gravação recusa qualquer corpo sem ele.
// ─────────────────────────────────────────────────────────────────────
const { idCondominio, chaveDoCondominio, lerComPrecedencia, gravarNoAmbito } = require('./config-ambito');

const CATEGORIAS = {
  assembleias: 'ASSEMBLEIAS',
  financeiro: 'FINANCEIRO',
  comunicacao: 'COMUNICAÇÃO',
  documentos: 'DOCUMENTOS',
  fornecedores: 'FORNECEDORES',
  backups: 'BACKUPS',
};

// Tipo → { categoria, rotulo }
const TIPOS = {
  quotas: { categoria: 'financeiro', rotulo: 'Quotas (avisos de quota)' },
  recibos: { categoria: 'financeiro', rotulo: 'Recibos' },
  avisos_pagamento: { categoria: 'financeiro', rotulo: 'Avisos de pagamento' },
  convocatorias: { categoria: 'assembleias', rotulo: 'Convocatórias de assembleia' },
  atas: { categoria: 'assembleias', rotulo: 'Atas' },
  orcamentos: { categoria: 'financeiro', rotulo: 'Orçamentos' },
  despesas: { categoria: 'financeiro', rotulo: 'Despesas' },
  documentos_gerais: { categoria: 'documentos', rotulo: 'Documentos gerais' },
  documentos_fornecedores: { categoria: 'fornecedores', rotulo: 'Documentos de fornecedores' },
  comprovativos_pagamento: { categoria: 'fornecedores', rotulo: 'Comprovativos de pagamento' },
  backups: { categoria: 'backups', rotulo: 'Backups' },
};

// Canais na ORDEM em que aparecem na interface e nas chaves.
const CANAIS = ['drive', 'email', 'automatico'];

// Rótulo de cada canal para a consulta (modo de leitura do P54-0).
// ⛔ Os nomes das CHAVES (`drive`, `email`, `automatico`) nunca mudam: são a
// chave gravada na BD e o `name` do campo no formulário. Isto é só texto.
const CANAIS_ROTULO = {
  drive: 'Guardar',
  email: 'Disponível por email',
  automatico: 'Automático',
};

// Marcador de submissão COMPLETA. O formulário envia-o sempre; a gravação
// recusa um corpo que não o traga.
const MARCADOR = '_automacoes';

// Padrões (comportamento atual da aplicação):
//  · email='1' para tipos que já são sempre disponibilizados/enváveis;
//  · drive/automatico desligados por omissão (nada automático sem decisão).
const DEFAULT_EMAIL = { quotas: '1', recibos: '1', convocatorias: '1', atas: '1', avisos_pagamento: '1', backups: '1' };
const DEFAULT_DRIVE = { backups: '1' }; // com storage ligado, backups já vão para lá
const DEFAULT_AUTO = {};

function canalPadrao(tipo, canal) {
  if (canal === 'email') return DEFAULT_EMAIL[tipo] === '1';
  if (canal === 'drive') return DEFAULT_DRIVE[tipo] === '1';
  if (canal === 'automatico') return DEFAULT_AUTO[tipo] === '1';
  return false;
}

// Chave (sem âmbito) de uma automação. O âmbito é acrescentado por
// `helpers/config-ambito.js`.
function chaveDe(tipo, canal) {
  return `auto_${tipo}_${canal}`;
}

function chavesConhecidas() {
  const out = [];
  for (const tipo of Object.keys(TIPOS)) for (const canal of CANAIS) out.push(chaveDe(tipo, canal));
  return out;
}

// `condominioId` é OPCIONAL na LEITURA: sem ele lê-se a chave herdada (global),
// que é o que uma execução sem contexto de condomínio deve usar. O padrão do
// código só entra quando não há nem chave específica nem global.
async function estaAtivo(tipo, canal, condominioId) {
  if (!TIPOS[tipo] || !CANAIS.includes(canal)) return false;
  const v = await lerComPrecedencia(chaveDe(tipo, canal), condominioId);
  if (v === undefined) return canalPadrao(tipo, canal);
  return v === '1';
}

// Lista agrupada por categoria, com os estados atuais NO ÂMBITO indicado —
// para a interface (`GET /admin/config/automacoes`, sempre com o condomínio da
// sessão).
async function listarAutomacoes(condominioId) {
  const grupos = Object.keys(CATEGORIAS).map((cat) => ({ categoria: cat, rotulo: CATEGORIAS[cat], tipos: [] }));
  const porCat = Object.fromEntries(grupos.map((g) => [g.categoria, g]));
  for (const [tipo, def] of Object.entries(TIPOS)) {
    const estados = {};
    for (const canal of CANAIS) estados[canal] = await estaAtivo(tipo, canal, condominioId);
    porCat[def.categoria].tipos.push({ tipo, rotulo: def.rotulo, ...estados });
  }
  return grupos.filter((g) => g.tipos.length);
}

// Linhas do estado de CONSULTA (padrão P54-0) para uma lista de grupos.
//
// Construídas AQUI, e não na vista, porque o Handlebars não compõe arrays — e
// porque a mesma verdade (o estado efetivo) tem de servir a consulta e o
// formulário, sem duas cópias que possam divergir.
function linhasDeConsulta(grupos) {
  const linhas = [];
  for (const grupo of grupos || []) {
    for (const t of grupo.tipos || []) {
      for (const canal of CANAIS) {
        linhas.push({
          rotulo: `${t.rotulo} · ${CANAIS_ROTULO[canal]}`,
          valor: t[canal] ? 'Ativo' : 'Inativo',
          grupo: grupo.rotulo,
        });
      }
    }
  }
  return linhas;
}

// Valida o corpo antes de escrever. Devolve `{ ok, motivo, mensagem, campos }`.
function validarCorpo(body) {
  const corpo = body && typeof body === 'object' ? body : {};
  if (corpo[MARCADOR] !== '1') {
    return {
      ok: false,
      motivo: 'submissao_incompleta',
      mensagem: 'A submissão não foi identificada como completa. Recarregue a página e tente de novo '
        + '(nenhuma automação foi alterada).',
    };
  }
  const conhecidas = new Set([MARCADOR, ...chavesConhecidas()]);
  const desconhecidas = Object.keys(corpo).filter((k) => !conhecidas.has(k));
  if (desconhecidas.length) {
    return {
      ok: false,
      motivo: 'campo_desconhecido',
      campos: desconhecidas,
      mensagem: `Campo não reconhecido: ${desconhecidas.join(', ')}. Nada foi alterado.`,
    };
  }
  return { ok: true };
}

// Grava as automações do formulário (campos `auto_<tipo>_<canal>`) NO ÂMBITO do
// condomínio indicado. Devolve `{ tipos, canais, alterados }`, onde `alterados`
// lista as chaves cujo EFEITO mudou (e não as que foram reescritas com o mesmo
// valor — gravar o que já estava não é uma alteração).
//
// ⛔ A exigência de âmbito vive SÓ em `gravarNoAmbito` (o ponto único por onde
// passam todas as escritas). Duplicá-la aqui criaria dois sítios a manter, e um
// deles poderia divergir sem que nada o detetasse.
async function guardarAutomacoes(body, condominioId) {
  const id = idCondominio(condominioId);
  const validacao = validarCorpo(body);
  if (!validacao.ok) {
    const err = new Error(validacao.mensagem);
    err.motivo = validacao.motivo;
    err.campos = validacao.campos;
    throw err;
  }

  const alterados = [];
  for (const tipo of Object.keys(TIPOS)) {
    for (const canal of CANAIS) {
      const chave = chaveDe(tipo, canal);
      const valor = body[chave] === 'on' || body[chave] === '1' ? '1' : '0';
      const antes = (await estaAtivo(tipo, canal, id)) ? '1' : '0';
      if (antes !== valor) alterados.push(chave);
      await gravarNoAmbito(chave, valor, id, { origem: 'guardarAutomacoes' });
    }
  }
  return { tipos: Object.keys(TIPOS).length, canais: CANAIS.length, alterados };
}

// ── Resumo para o painel (A14 §15) ─────────────────────────────────────
// O painel mostrava «Automações: Configuradas» escrito à mão na vista: continuava
// a dizê-lo depois de alguém desligar tudo, e era indistinguível de um estado
// realmente lido. Este resumo devolve o estado REAL.
//
// ⛔ NÃO é um segundo cálculo do estado: usa os mesmos `chaveDe`, `canalPadrao`
//    e a mesma precedência (condomínio → global → padrão) que `estaAtivo`. Só
//    muda a forma de ler a base de dados: UMA consulta em vez de 33 (uma por
//    chave), que é o que `listarAutomacoes` faria se fosse chamado do painel.
//
// Conta-se um tipo como «automatizado» quando `drive` ou `automatico` está
// ativo. O canal `email` NÃO conta: significa apenas «disponível por email»,
// não é automatização — e como é '1' por omissão em 6 tipos, contá-lo daria um
// número inflado que não corresponde a nada que o utilizador tenha decidido.
async function resumo(condominioId) {
  // ⛔ `require` DENTRO da função, de propósito: este módulo é carregado por
  //    testes que correm sem base de dados e que substituem `helpers/config.js`.
  //    Exigir os modelos no topo mudaria o comportamento de carga deles.
  const { Configuracao } = require('../models');
  const { Op } = require('sequelize');
  // Sem o modelo (testes que correm sem base de dados) não há resumo: devolve-se
  // `null` e a vista mostra só a ligação. ⛔ Nunca se inventa um número.
  if (!Configuracao || typeof Configuracao.findAll !== 'function') return null;

  const id = idCondominio(condominioId);
  const base = chavesConhecidas();
  const procurar = id ? base.concat(base.map((c) => chaveDoCondominio(c, id))) : base.slice();
  const registos = await Configuracao.findAll({
    attributes: ['chave', 'valor'],
    where: { chave: { [Op.in]: procurar } },
    raw: true,
  });
  const porChave = new Map(registos.map((r) => [r.chave, r.valor]));

  // A mesma precedência de `lerComPrecedencia`: específica → global → padrão.
  const valorDe = (chave) => {
    if (id) {
      const proprio = porChave.get(chaveDoCondominio(chave, id));
      if (proprio !== undefined && proprio !== null && proprio !== '') return proprio;
    }
    const global = porChave.get(chave);
    if (global === undefined || global === null || global === '') return undefined;
    return global;
  };

  const tipos = Object.keys(TIPOS);
  let ativos = 0;
  for (const tipo of tipos) {
    for (const canal of ['drive', 'automatico']) {
      const v = valorDe(chaveDe(tipo, canal));
      if (v === undefined ? canalPadrao(tipo, canal) : v === '1') { ativos += 1; break; }
    }
  }
  return { tipos: tipos.length, ativos };
}

// Converte um tipo de documento lógico (Documento.tipo ou slug) na chave
// de automação correspondente (mapeamento usado nos módulos).
function tipoAutomacao(tipoDocumento) {
  const mapa = {
    aviso_quota: 'quotas',
    recibo: 'recibos',
    convocatoria: 'convocatorias',
    ata: 'atas',
    orcamento: 'orcamentos',
    fatura: 'despesas',
    contrato: 'documentos_fornecedores',
    comprovativo: 'comprovativos_pagamento',
    relatorio: 'documentos_gerais',
    outro: 'documentos_gerais',
  };
  return mapa[tipoDocumento] || tipoDocumento || 'documentos_gerais';
}

module.exports = {
  CATEGORIAS, TIPOS, CANAIS, CANAIS_ROTULO, MARCADOR,
  chaveDe, chavesConhecidas,
  estaAtivo, listarAutomacoes, linhasDeConsulta, validarCorpo, guardarAutomacoes, tipoAutomacao,
  resumo,
};
