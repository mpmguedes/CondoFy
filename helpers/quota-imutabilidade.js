// R10 — IMUTABILIDADE FINANCEIRA DE UMA QUOTA EMITIDA.
//
// `data_emissao IS NOT NULL` ⇒ a quota é um DOCUMENTO. Os seus elementos
// financeiros e identificadores ficam congelados: nenhuma rota normal de
// configuração, recálculo ou edição os pode alterar.
//
// A fronteira é `data_emissao` — NUNCA `estado` nem `data_vencimento`:
//  · `estado` é DERIVADO dos pagamentos: uma quota `pendente` pode já estar
//    emitida e entregue ao condómino. Usar `estado` como critério deixava o
//    documento emitido desprotegido (era o antigo filtro P19);
//  · `data_vencimento` é uma data de calendário: deslocá-la não torna um
//    documento reescrevível, e usá-la como critério protegia «por acidente»
//    as quotas com vencimento no passado.
//
// Este módulo é lógica pura (não toca na base de dados), para que a regra seja
// a mesma em qualquer rota que a aplique.
const { toCents } = require('./money');

// Campos que uma edição NUNCA pode alterar numa quota emitida.
const CAMPOS_CONGELADOS = [
  // Elementos financeiros do documento.
  'valor', 'valor_base', 'valor_fcr',
  'valor_por_1000', 'permilagem_aplicada', 'fcr_percentagem',
  // Identificadores do documento (mudá-los trocaria a quota por outra).
  'ano', 'mes', 'fracao_id',
  // Vínculo HISTÓRICO ao orçamento de origem: não se troca por edição.
  'orcamento_id',
  // A própria âncora da imutabilidade: alterá-la seria «des-emitir» o documento
  // por via de uma edição normal.
  'data_emissao',
];

const CAMPOS_MONETARIOS = new Set([
  'valor', 'valor_base', 'valor_fcr',
  'valor_por_1000', 'permilagem_aplicada', 'fcr_percentagem',
]);

// Data em texto ISO ('YYYY-MM-DD'). A base de dados devolve `Date` (ou texto com
// hora) e o formulário envia 'YYYY-MM-DD': sem normalizar, o MESMO dia
// apareceria como «alterado».
function isoData(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    const dd = String(v.getDate()).padStart(2, '0');
    return `${v.getFullYear()}-${mm}-${dd}`;
  }
  return String(v).slice(0, 10);
}

// Compara um campo pela sua natureza: dinheiro em cêntimos, datas em ISO,
// identificadores como número, o resto como texto.
function normalizar(campo, valor) {
  if (campo === 'data_emissao') return isoData(valor);
  if (CAMPOS_MONETARIOS.has(campo)) return toCents(valor);
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : String(valor);
}

/** A quota já foi emitida (é um documento)? */
function estaEmitida(quota) {
  return Boolean(quota && quota.data_emissao);
}

/**
 * Alterações PROIBIDAS que `propostas` introduziria na quota.
 * Só compara os campos presentes em `propostas` — uma rota que não mencione um
 * campo não o está a propor.
 *
 * @returns {{campo: string, de: *, para: *}[]}
 */
function alteracoesCongeladas(quota, propostas) {
  const alteracoes = [];
  for (const campo of CAMPOS_CONGELADOS) {
    if (!(campo in propostas)) continue;
    const antes = normalizar(campo, quota[campo]);
    const depois = normalizar(campo, propostas[campo]);
    if (antes !== depois) alteracoes.push({ campo, de: quota[campo], para: propostas[campo] });
  }
  return alteracoes;
}

/**
 * Invariante I-4: o total de uma quota é a soma das suas componentes
 * (`valor = valor_base + valor_fcr`).
 *
 * Quando as componentes não existem (NULL) o invariante não é verificável — a
 * linha pertence a uma classe DISTINTA (registos anteriores à decomposição) e
 * não é tratada como incoerente. Detetar/reportar é trabalho de quem lê (Q10):
 * esta função não corrige nada.
 */
function invarianteOk({ valor, valor_base, valor_fcr }) {
  if (valor_base === null || valor_base === undefined) return true;
  if (valor_fcr === null || valor_fcr === undefined) return true;
  return toCents(valor) === toCents(valor_base) + toCents(valor_fcr);
}

module.exports = {
  CAMPOS_CONGELADOS,
  isoData,
  estaEmitida,
  alteracoesCongeladas,
  invarianteOk,
};
