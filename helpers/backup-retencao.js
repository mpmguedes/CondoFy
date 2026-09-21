// ─────────────────────────────────────────────────────────────────────
// Retenção dos backups — DECISÃO pura, separada do I/O.
//
// Duas retenções INDEPENDENTES, uma por destino:
//   · LOCAL — a cópia base, obrigatória (`backups/local`);
//   · CLOUD — a cópia adicional, opcional (destino configurado).
// Local 30 / Cloud 90 é uma combinação perfeitamente válida. A limpeza local
// nunca toca em ficheiros da cloud e vice-versa.
//
// A retenção é por IDADE (data), NUNCA por número de ficheiros: «eliminar os
// backups com mais de 30 dias», não «manter os últimos 30».
//
// ⛔ PROTEÇÃO OBRIGATÓRIA: a limpeza automática nunca pode deixar a instalação
// sem qualquer backup local válido. Mesmo que TODOS os backups estejam fora do
// prazo, o mais recente VÁLIDO é preservado. A mesma regra vale para as
// eliminações manuais.
//
// Mínimo configurável: 30 dias. Não há máximo artificial (30/60/90/180/365 são
// apenas sugestões da interface; o campo numérico aceita mais).
// ─────────────────────────────────────────────────────────────────────

const DIAS_MINIMO = 30;
// Guarda de sanidade (100 anos): evita valores que rebentariam a aritmética de
// datas. NÃO é um limite de política — está muito acima de qualquer retenção real.
const DIAS_MAXIMO = 36500;
const PRESETS = [30, 60, 90, 180, 365];
const MS_POR_DIA = 86400000;

// Chaves persistentes em `configuracoes` (arquitetura já existente — nenhuma
// migration). Os nomes ficam aqui, num só sítio, para não haver duas verdades.
const CHAVES = {
  retencaoLocal: 'backup_retencao_local',
  retencaoCloud: 'backup_retencao_cloud',
  limpezaAutomatica: 'backup_limpeza_automatica',
  limiteLocalGb: 'backup_limite_local_gb',
  ultimaLimpeza: 'backup_ultima_limpeza',
  resultadoLimpeza: 'backup_resultado_limpeza',
};

// Valores por omissão quando não há nada persistido nem no `.env`.
const PADROES = { retencaoLocal: 30, retencaoCloud: 90 };

// ── Validação ───────────────────────────────────────────────────────
// Devolve sempre { ok, dias, erro }. Nunca lança: quem chama decide o que fazer
// com uma recusa (a rota mostra a mensagem; o job cai no valor por omissão).
function normalizarDias(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') {
    return { ok: false, dias: null, erro: 'valor_ausente' };
  }
  const n = Number(String(valor).trim());
  if (!Number.isFinite(n)) return { ok: false, dias: null, erro: 'nao_numerico' };
  if (!Number.isInteger(n)) return { ok: false, dias: null, erro: 'nao_inteiro' };
  if (n < DIAS_MINIMO) return { ok: false, dias: null, erro: 'abaixo_do_minimo' };
  if (n > DIAS_MAXIMO) return { ok: false, dias: null, erro: 'acima_do_maximo' };
  return { ok: true, dias: n, erro: null };
}

// Mensagem PT-PT para cada recusa (a rota não inventa texto próprio).
const MENSAGENS = {
  valor_ausente: 'Indique um número de dias.',
  nao_numerico: 'O número de dias tem de ser um valor numérico.',
  nao_inteiro: 'O número de dias tem de ser um número inteiro.',
  abaixo_do_minimo: `A retenção mínima é de ${DIAS_MINIMO} dias.`,
  acima_do_maximo: `A retenção máxima aceite é de ${DIAS_MAXIMO} dias.`,
};

function mensagemDe(erro) {
  return MENSAGENS[erro] || 'Valor inválido.';
}

// Limite informativo de espaço local, em GB. `null` = sem limite definido.
// ⛔ Este limite NUNCA apaga nada — é só informação/alerta.
function normalizarLimiteGb(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const n = Number(String(valor).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// ── Seleção por idade ───────────────────────────────────────────────
// `itens` = itens do inventário ({ criadoEm, valido, … }).
// O corte pode vir de `dias` (retenção) ou de um `limite` explícito (uma data
// escolhida pelo Super Admin na eliminação manual). Devolve
// { apagar, manter, protegido, limite }.
function selecionarPorIdade({ itens, dias, limite: limiteExplicito = null, agora = new Date(), protegerUltimo = true } = {}) {
  const lista = Array.isArray(itens) ? itens.filter(Boolean) : [];

  let limiteMs;
  if (limiteExplicito !== null && limiteExplicito !== undefined && limiteExplicito !== '') {
    limiteMs = limiteExplicito instanceof Date ? limiteExplicito.getTime() : new Date(limiteExplicito).getTime();
    if (!Number.isFinite(limiteMs)) {
      return { apagar: [], manter: lista.slice(), protegido: null, limite: null, erro: 'data_invalida' };
    }
  } else {
    const validacao = normalizarDias(dias);
    if (!validacao.ok) {
      return { apagar: [], manter: lista.slice(), protegido: null, limite: null, erro: validacao.erro };
    }
    const agoraMs = agora instanceof Date ? agora.getTime() : new Date(agora).getTime();
    limiteMs = agoraMs - validacao.dias * MS_POR_DIA;
  }
  const limite = new Date(limiteMs);

  const ordenados = lista.slice().sort((a, b) => a.criadoEm - b.criadoEm);
  let apagar = ordenados.filter((i) => i.criadoEm.getTime() < limiteMs);
  let protegido = null;

  if (protegerUltimo && apagar.length > 0) {
    // Só se protege quando há backups VÁLIDOS: sem nenhum válido não há nada a
    // preservar, e um ficheiro inválido não é um backup.
    const validos = ordenados.filter((i) => i.valido);
    if (validos.length > 0) {
      const restantes = validos.filter((i) => !apagar.includes(i));
      if (restantes.length === 0) {
        // Todos os válidos estão fora do prazo: o mais recente fica.
        protegido = validos[validos.length - 1];
        apagar = apagar.filter((i) => i !== protegido);
      }
    }
  }

  const conjunto = new Set(apagar);
  return { apagar, manter: ordenados.filter((i) => !conjunto.has(i)), protegido, limite, erro: null };
}

// Uma eliminação INDIVIDUAL é recusada quando deixaria a instalação sem o
// último backup local válido. Devolve { ok, motivo }.
function podeApagarIndividual(item, itens) {
  const lista = Array.isArray(itens) ? itens.filter(Boolean) : [];
  if (!item) return { ok: false, motivo: 'nao_encontrado' };
  if (!item.valido) return { ok: true, motivo: null };
  const validos = lista.filter((i) => i.valido);
  if (validos.length <= 1) return { ok: false, motivo: 'ultimo_backup_valido' };
  return { ok: true, motivo: null };
}

// ── Configuração persistida (com o `.env` como fallback) ────────────
function inteiroDeEnv(valor) {
  const n = parseInt(String(valor === null || valor === undefined ? '' : valor), 10);
  return Number.isFinite(n) ? n : null;
}

function dataOuNull(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Lê a retenção configurada. Ordem: `configuracoes` (o que o Super Admin
// gravou) → `.env` (compatibilidade) → valor por omissão. O MÍNIMO de 30 dias é
// aplicado SEMPRE, em qualquer dos casos — a validação do frontend não conta.
async function lerConfiguracao() {
  const envLocal = inteiroDeEnv(process.env.BACKUP_DAILY_RETENTION);
  const envCloud = inteiroDeEnv(process.env.BACKUP_CLOUD_RETENTION);
  const envLimite = normalizarLimiteGb(process.env.BACKUP_LOCAL_LIMIT_GB);

  const fallback = {
    retencaoLocal: envLocal !== null && normalizarDias(envLocal).ok ? envLocal : PADROES.retencaoLocal,
    retencaoCloud: envCloud !== null && normalizarDias(envCloud).ok ? envCloud : PADROES.retencaoCloud,
    limpezaAutomatica: true,
    limiteLocalGb: envLimite,
    ultimaLimpeza: null,
    resultadoLimpeza: null,
  };

  let valores;
  try {
    const { getConfig } = require('./config');
    const nomes = Object.keys(CHAVES);
    const lidos = await Promise.all(nomes.map((n) => getConfig(CHAVES[n], null)));
    valores = {};
    nomes.forEach((n, i) => {
      valores[n] = lidos[i];
    });
  } catch (err) {
    // Sem base de dados (ou sem `Configuracao`): fica-se pelo fallback, que já
    // respeita o mínimo de 30 dias. Um problema de configuração nunca pode
    // impedir um backup — só impede que a retenção seja personalizada.
    return { ...fallback, origem: 'fallback', erroConfiguracao: err.message };
  }

  const guardadoLocal = normalizarDias(valores.retencaoLocal);
  const guardadoCloud = normalizarDias(valores.retencaoCloud);
  return {
    retencaoLocal: guardadoLocal.ok ? guardadoLocal.dias : fallback.retencaoLocal,
    retencaoCloud: guardadoCloud.ok ? guardadoCloud.dias : fallback.retencaoCloud,
    // Sem valor gravado, a limpeza automática está ATIVA (é o comportamento que
    // já existia: o job limpava sempre). Só um `0` explícito a desliga.
    limpezaAutomatica:
      valores.limpezaAutomatica === null || valores.limpezaAutomatica === undefined
        ? fallback.limpezaAutomatica
        : String(valores.limpezaAutomatica) !== '0',
    limiteLocalGb:
      valores.limiteLocalGb === null || valores.limiteLocalGb === undefined
        ? fallback.limiteLocalGb
        : normalizarLimiteGb(valores.limiteLocalGb),
    ultimaLimpeza: dataOuNull(valores.ultimaLimpeza),
    resultadoLimpeza: valores.resultadoLimpeza ? String(valores.resultadoLimpeza) : null,
    origem: 'configuracao',
  };
}

// Grava a configuração, VALIDANDO no servidor. Devolve { ok, erros, valores }.
// Não grava nada quando há erros (nunca se persiste um valor inválido).
async function gravarConfiguracao(dados = {}) {
  const erros = [];
  const local = normalizarDias(dados.retencaoLocal);
  if (!local.ok) erros.push({ campo: 'retencaoLocal', erro: local.erro, mensagem: mensagemDe(local.erro) });
  const cloud = normalizarDias(dados.retencaoCloud);
  if (!cloud.ok) erros.push({ campo: 'retencaoCloud', erro: cloud.erro, mensagem: mensagemDe(cloud.erro) });

  const limiteBruto = dados.limiteLocalGb;
  const limiteVazio = limiteBruto === null || limiteBruto === undefined || String(limiteBruto).trim() === '';
  const limite = limiteVazio ? null : Number(String(limiteBruto).trim());
  if (!limiteVazio && (!Number.isFinite(limite) || limite <= 0)) {
    erros.push({ campo: 'limiteLocalGb', erro: 'invalido', mensagem: 'O limite tem de ser um número positivo (GB) ou ficar vazio.' });
  }
  if (erros.length > 0) return { ok: false, erros, valores: null };

  const limpezaAutomatica = Boolean(dados.limpezaAutomatica);
  const { setConfig } = require('./config');
  await setConfig(CHAVES.retencaoLocal, String(local.dias));
  await setConfig(CHAVES.retencaoCloud, String(cloud.dias));
  await setConfig(CHAVES.limpezaAutomatica, limpezaAutomatica ? '1' : '0');
  await setConfig(CHAVES.limiteLocalGb, limiteVazio ? '' : String(limite));

  return {
    ok: true,
    erros: [],
    valores: { retencaoLocal: local.dias, retencaoCloud: cloud.dias, limpezaAutomatica, limiteLocalGb: limiteVazio ? null : limite },
  };
}

// Registo da última limpeza (para a área do Super Admin poder dizer quando
// correu e o que fez). Falha em silêncio: é informação, não é o backup.
async function registarLimpeza({ quando = new Date(), resultado = '' } = {}) {
  try {
    const { setConfig } = require('./config');
    await setConfig(CHAVES.ultimaLimpeza, new Date(quando).toISOString());
    await setConfig(CHAVES.resultadoLimpeza, String(resultado || ''));
  } catch (err) {
    console.error('[backup] não foi possível registar a limpeza:', err.message);
  }
}

module.exports = {
  DIAS_MINIMO,
  DIAS_MAXIMO,
  PRESETS,
  MS_POR_DIA,
  CHAVES,
  PADROES,
  MENSAGENS,
  mensagemDe,
  normalizarDias,
  normalizarLimiteGb,
  selecionarPorIdade,
  podeApagarIndividual,
  lerConfiguracao,
  gravarConfiguracao,
  registarLimpeza,
};
