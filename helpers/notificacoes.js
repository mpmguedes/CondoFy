// ─────────────────────────────────────────────────────────────────────
// Notificações — preferências de comunicação por evento.
//
// Cada evento pode ser enviado por email e/ou guardado no Google Drive.
// Guarda-se na BD (chaves `notif_<evento>_<canal>` = '1'/'0').
//
// Por omissão mantém-se o comportamento atual da aplicação: os envios
// automáticos já existentes (recibo por email, lembretes de quotas em
// atraso) ficam ATIVOS. As restantes preferências ficam guardadas para
// os fluxos automáticos, sem ativar comportamento novo.
//
// ── P54-7 — ÂMBITO POR CONDOMÍNIO (isolamento) ──────────────────────
// Como nas automações de documentos: grava-se em `notif_<evento>_<canal>:c<ID>`
// e a chave base fica como valor herdado. Antes gravava-se sempre a chave GLOBAL
// e a preferência de um condomínio passava a valer para todos.
// A gravação EXIGE âmbito; uma leitura sem contexto lê a chave base.
// ─────────────────────────────────────────────────────────────────────
const { idCondominio, lerComPrecedencia, gravarNoAmbito } = require('./config-ambito');

const EVENTOS = {
  quotas_novas: 'Novas quotas',
  quotas_atraso: 'Quotas em atraso',
  recibos: 'Recibos',
  avisos: 'Avisos',
  assembleias: 'Assembleias',
  convocatorias: 'Convocatórias',
  atas: 'Atas',
  documentos: 'Documentos',
  pagamentos: 'Pagamentos',
  administrativos: 'Outros avisos administrativos',
};

const CANAIS = ['email', 'drive'];

// Marcador de submissão COMPLETA — mesma razão das automações: sem ele, um
// `POST` direto desligava todas as notificações por omissão dos campos ausentes.
const MARCADOR = '_notificacoes';

// Comportamento atual por omissão ('1' = ativo). Canal "drive" começa
// desligado — nunca se ativa armazenamento automático sem decisão do admin.
// Nota: só eventos que já têm envio automático começam com email='1'
// (recibo e lembretes de quotas em atraso); os restantes ficam '0' para
// não alterar o comportamento atual da aplicação.
const DEFAULTS = {
  quotas_novas_email: '0',
  quotas_atraso_email: '1',
  recibos_email: '1',
  avisos_email: '1',
  assembleias_email: '0',
  convocatorias_email: '0',
  atas_email: '0',
  documentos_email: '0',
  pagamentos_email: '0',
  administrativos_email: '1',
};

// Chave (sem âmbito) de uma preferência. O âmbito é acrescentado por
// `helpers/config-ambito.js`.
function chaveDe(evento, canal) {
  return `notif_${evento}_${canal}`;
}

function chavesConhecidas() {
  const out = [];
  for (const evento of Object.keys(EVENTOS)) for (const canal of CANAIS) out.push(chaveDe(evento, canal));
  return out;
}

// `condominioId` é opcional na LEITURA: sem ele lê-se a chave herdada (global),
// que é o que um job sem contexto de condomínio deve usar.
async function estaAtivo(evento, canal, condominioId) {
  if (!EVENTOS[evento] || !CANAIS.includes(canal)) return false;
  const v = await lerComPrecedencia(chaveDe(evento, canal), condominioId);
  if (v === undefined) return DEFAULTS[`${evento}_${canal}`] === '1';
  return v === '1';
}

// Lista de eventos com o estado atual, para a interface.
async function listarPreferencias(condominioId) {
  const out = [];
  for (const [evento, rotulo] of Object.entries(EVENTOS)) {
    out.push({
      evento,
      rotulo,
      email: await estaAtivo(evento, 'email', condominioId),
      drive: await estaAtivo(evento, 'drive', condominioId),
    });
  }
  return out;
}

// Valida o corpo antes de escrever. Devolve `{ ok, motivo, mensagem }`.
function validarCorpo(body) {
  const corpo = body && typeof body === 'object' ? body : {};
  if (corpo[MARCADOR] !== '1') {
    return {
      ok: false,
      motivo: 'submissao_incompleta',
      mensagem: 'A submissão não foi identificada como completa. Recarregue a página e tente de novo '
        + '(nenhuma preferência foi alterada).',
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

// Grava preferências a partir do formulário (campos notif_<evento>_<canal>)
// NO ÂMBITO do condomínio indicado. Devolve as chaves cujo EFEITO mudou.
//
// ⛔ A exigência de âmbito vive SÓ em `gravarNoAmbito` (o ponto único por onde
// passam todas as escritas). Duplicá-la aqui criaria dois sítios a manter e um
// deles poderia divergir sem que nada o detetasse.
async function guardarPreferencias(body, condominioId) {
  const id = idCondominio(condominioId);
  const validacao = validarCorpo(body);
  if (!validacao.ok) {
    const err = new Error(validacao.mensagem);
    err.motivo = validacao.motivo;
    err.campos = validacao.campos;
    throw err;
  }

  const alterados = [];
  for (const evento of Object.keys(EVENTOS)) {
    for (const canal of CANAIS) {
      const chave = chaveDe(evento, canal);
      const valor = body[chave] === 'on' || body[chave] === '1' ? '1' : '0';
      const antes = (await estaAtivo(evento, canal, id)) ? '1' : '0';
      if (antes !== valor) alterados.push(chave);
      await gravarNoAmbito(chave, valor, id, { origem: 'guardarPreferencias' });
    }
  }
  return { eventos: Object.keys(EVENTOS).length, canais: CANAIS.length, alterados };
}

module.exports = {
  EVENTOS, CANAIS, MARCADOR, chaveDe, chavesConhecidas,
  estaAtivo, listarPreferencias, validarCorpo, guardarPreferencias,
};
