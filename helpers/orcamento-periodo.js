// ─────────────────────────────────────────────────────────────────────
// P56 — PERÍODO DE UM ORÇAMENTO (12 meses) e NÃO-SOBREPOSIÇÃO entre
// orçamentos do MESMO condomínio.
//
// Lógica PURA (não toca na base de dados): a mesma regra é aplicada na
// criação e na edição do orçamento, e pode ser provada offline.
//
// Duas regras distintas, que antes não existiam:
//
//  1. `periodoValido()` — um orçamento dura EXATAMENTE 12 meses e esses
//     12 meses têm de ser meses de calendário INTEIROS. Sem esta segunda
//     condição, um período como `2026-07-15 → 2027-07-14` (que é
//     «exatamente 1 ano» em dias) atravessa 13 meses de calendário e o
//     plano de quotas gerava uma 13.ª cobrança em silêncio.
//
//  2. `sobrepoe-se()` — dois orçamentos do mesmo condomínio não podem
//     partilhar um único mês. Períodos ADJACENTES (um acaba no último dia
//     de um mês, o outro começa no dia 1.º do mês seguinte) são válidos:
//     a regra proíbe sobreposição, não continuidade.
//
// ⛔ NÃO se usa `UNIQUE(condominio_id, ano)`: dois orçamentos do mesmo
//    condomínio podem legitimamente coexistir no mesmo ano civil (ex.:
//    período personalizado `2026-07-01 → 2027-06-30`), e o índice único
//    já existente (`quotas_unique` sobre `fracao_id, ano, mes`) é o que
//    impede a duplicação de quotas. A sobreposição é recusada ANTES, com
//    mensagem ao utilizador — nunca deixando rebentar a constraint.
// ─────────────────────────────────────────────────────────────────────

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' válido? (rejeita datas inexistentes como 2026-02-31) */
function dataIsoValida(v) {
  if (typeof v !== 'string' || !ISO.test(v)) return false;
  const [a, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Primeiro dia do mês seguinte ao de `v`. */
function mesSeguinte(v) {
  const [a, m] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(a, m, 1));
  return dt.toISOString().slice(0, 10);
}

/**
 * O período é de 12 meses de calendário INTEIROS?
 *
 * Válido quando `data_inicio` é o dia 1.º de um mês e `data_fim` é o
 * último dia do 12.º mês seguinte (inclusive). É a forma canónica dos
 * ciclos de gestão (ano civil ou ano de gestão deslocado).
 *
 * @returns {{ok: boolean, motivo: string|null}}
 */
function periodoValido(dataInicio, dataFim) {
  if (!dataIsoValida(dataInicio) || !dataIsoValida(dataFim)) {
    return { ok: false, motivo: 'datas' };
  }
  if (dataFim < dataInicio) return { ok: false, motivo: 'invertido' };

  // 12 meses de calendário inteiros: começa no dia 1, acaba no último dia
  // do 12.º mês (o dia anterior ao 1.º do mês 13).
  const [a, m, d] = dataInicio.split('-').map(Number);
  if (d !== 1) return { ok: false, motivo: 'dias' };
  const decimoTerceiro = new Date(Date.UTC(a, m - 1 + 12, 1));
  const limite = new Date(decimoTerceiro.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (dataFim !== limite) return { ok: false, motivo: 'dias' };

  return { ok: true, motivo: null };
}

/**
 * Meses de calendário de dois períodos: `{primeiro, ultimo}` como
 * 'YYYY-MM' (comparáveis lexicograficamente). Adjacentes quando
 * `a.ultimo < b.primeiro` (ou vice-versa).
 */
function intervaloMeses({ dataInicio, dataFim }) {
  return { primeiro: dataInicio.slice(0, 7), ultimo: dataFim.slice(0, 7) };
}

/**
 * `candidato` sobrepõe-se a `existente`? (mesmo condomínio, já filtrado
 * pelo chamador — esta função não conhece condomínios.)
 */
function sobrepoeSe(candidato, existente) {
  const a = intervaloMeses(candidato);
  const b = intervaloMeses(existente);
  return a.primeiro <= b.ultimo && b.primeiro <= a.ultimo;
}

/** O orçamento ainda ocupa os seus meses? (anulado liberta o período) */
function ocupaPeriodo(orcamento) {
  return Boolean(orcamento) && orcamento.estado !== 'anulado';
}

/**
 * Qualquer orçamento ATIVO do mesmo condomínio que colida com o candidato.
 *
 * @param {{dataInicio: string, dataFim: string}} candidato
 * @param {Array} existentes orçamentos do MESMO condomínio
 * @param {{ignorarId?: number|string}} opcoes `ignorarId` exclui o próprio
 *        orçamento (edição: o período pode manter-se sem colidir consigo).
 * @returns {object|null} o primeiro orçamento em conflito, ou null.
 */
function conflitoDePeriodo(candidato, existentes, { ignorarId = null } = {}) {
  const ignorar = ignorarId === null || ignorarId === undefined ? null : Number(ignorarId);
  for (const o of existentes || []) {
    if (!ocupaPeriodo(o)) continue;
    if (ignorar !== null && Number(o.id) === ignorar) continue;
    if (sobrepoeSe(candidato, { dataInicio: isoDe(o.data_inicio), dataFim: isoDe(o.data_fim) })) {
      return o;
    }
  }
  return null;
}

/** Data vinda da BD (`Date` ou texto com hora) → 'YYYY-MM-DD'. */
function isoDe(v) {
  if (v instanceof Date) {
    const mm = String(v.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(v.getUTCDate()).padStart(2, '0');
    return `${v.getUTCFullYear()}-${mm}-${dd}`;
  }
  return String(v).slice(0, 10);
}

/** Mensagem de recusa, em português, para o utilizador. */
function mensagemConflito(orcamento) {
  const de = isoDe(orcamento.data_inicio);
  const ate = isoDe(orcamento.data_fim);
  return `O período indicado sobrepõe-se ao orçamento «${orcamento.designacao}» `
    + `(${de} a ${ate}). Um orçamento dura 12 meses e não pode coincidir com outro `
    + 'do mesmo condomínio — ajuste as datas, ou anule o orçamento anterior se '
    + 'pretender substituí-lo.';
}

module.exports = {
  dataIsoValida,
  mesSeguinte,
  periodoValido,
  intervaloMeses,
  sobrepoeSe,
  ocupaPeriodo,
  conflitoDePeriodo,
  isoDe,
  mensagemConflito,
};
