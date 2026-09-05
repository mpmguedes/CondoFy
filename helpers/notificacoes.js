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
// ─────────────────────────────────────────────────────────────────────
const { getConfig, setConfig } = require('./config');

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

async function estaAtivo(evento, canal) {
  if (!EVENTOS[evento] || !['email', 'drive'].includes(canal)) return false;
  const chave = `notif_${evento}_${canal}`;
  const v = await getConfig(chave, null);
  if (v === null) return DEFAULTS[`${evento}_${canal}`] === '1';
  return v === '1';
}

// Lista de eventos com o estado atual, para a interface.
async function listarPreferencias() {
  const out = [];
  for (const [evento, rotulo] of Object.entries(EVENTOS)) {
    out.push({
      evento,
      rotulo,
      email: await estaAtivo(evento, 'email'),
      drive: await estaAtivo(evento, 'drive'),
    });
  }
  return out;
}

// Grava preferências a partir do formulário (campos notif_<evento>_<canal>).
async function guardarPreferencias(body) {
  const escritas = [];
  for (const [evento, rotulo] of Object.entries(EVENTOS)) {
    for (const canal of ['email', 'drive']) {
      const chave = `notif_${evento}_${canal}`;
      const valor = body[chave] === 'on' || body[chave] === '1' ? '1' : '0';
      await setConfig(chave, valor);
      escritas.push(chave);
    }
  }
  return { eventos: Object.keys(EVENTOS).length, canais: 2, escritas: escritas.length };
}

module.exports = { EVENTOS, estaAtivo, listarPreferencias, guardarPreferencias };
