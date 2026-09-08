// ─────────────────────────────────────────────────────────────────────
// Quota Extra — regras de estado e elegibilidade (fonte única, testável).
//
// Estados da Quota Extra (cabeçalho):
//  · 'pendente'   — criada, aguarda aprovação: consultável/editable, NUNCA
//                   cobrável, NUNCA incluível em aviso, NUNCA paga;
//  · 'aprovada'   — autorizada para cobrança; aguarda processamento;
//  · 'processada' — pronta para cobrança: parcelas elegíveis para aviso/pagamento;
//  · 'anulada'    — histórico: não edita/aprova/processa/cobra.
// 'Paga' (cabeçalho) é DERIVADO: todas as parcelas estão pagas (ou não há).
//
// Parcelas (por fração):
//  · 'pendente' — disponível para cobrança (quota extra processada);
//  · 'cobrada'  — já incluída num aviso de cobrança (não volta a aparecer);
//  · 'paga'     — liquidada (desbloqueia recibo);
//  · 'anulada'  — histórico.
// ─────────────────────────────────────────────────────────────────────
const ESTADOS_EXTRA = {
  pendente: 'Pendente de aprovação',
  aprovada: 'Aprovada',
  processada: 'Processada',
  anulada: 'Anulada',
};

const ESTADOS_PARCELA = {
  pendente: 'Disponível',
  cobrada: 'Cobrada',
  paga: 'Paga',
  anulada: 'Anulada',
};

function podeEditar(estado) {
  return estado === 'pendente';
}

function podeAprovar(estado) {
  return estado === 'pendente';
}

function podeProcessar(estado) {
  return estado === 'aprovada';
}

// Anular é permitido em pendente/aprovada/processada (nunca anulada); parcelas
// já pagas nunca são anuladas (permanecem pagas no histórico).
function podeAnular(estado) {
  return estado === 'pendente' || estado === 'aprovada' || estado === 'processada';
}

// Parcela cobrável por pagamento: a quota extra tem de estar processada e a
// parcela disponível (pendente) ou já incluída num aviso (cobrada).
function parcelaCobraPorPagamento({ estadoExtra, estadoParcela }) {
  return estadoExtra === 'processada' && (estadoParcela === 'pendente' || estadoParcela === 'cobrada');
}

// Parcela elegível para INCLUSÃO num aviso mensal: quota extra processada,
// parcela ainda 'pendente' (não cobrada/paga/anulada) e com vencimento dentro
// do mês do aviso (nunca cobrar no futuro).
function vencimentoNoMes(vencimento, anoAviso, mesAviso) {
  if (!vencimento) return false;
  const d = vencimento instanceof Date ? vencimento : new Date(`${String(vencimento).slice(0, 10)}T00:00:00`);
  if (isNaN(d.getTime())) return false;
  return d.getFullYear() === Number(anoAviso) && d.getMonth() + 1 === Number(mesAviso);
}

function parcelaElegivelParaAviso({ estadoExtra, estadoParcela, vencimento, anoAviso, mesAviso }) {
  return (
    estadoExtra === 'processada' &&
    estadoParcela === 'pendente' &&
    vencimentoNoMes(vencimento, anoAviso, mesAviso)
  );
}

module.exports = {
  ESTADOS_EXTRA,
  ESTADOS_PARCELA,
  podeEditar,
  podeAprovar,
  podeProcessar,
  podeAnular,
  parcelaCobraPorPagamento,
  parcelaElegivelParaAviso,
  vencimentoNoMes,
};
