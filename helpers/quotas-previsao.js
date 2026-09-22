// R10 / Q9 — PRÉ-VISUALIZAÇÃO da configuração de quotas (SÓ LEITURA).
//
// O que uma nova configuração (valor por 1000‰ + % de FCR) faria às quotas do
// condomínio, calculado SEM ESCREVER NADA.
//
// A fronteira é `data_emissao` (R10), nunca `estado` nem `data_vencimento`:
//  · `afetadas`   — quotas NÃO emitidas (`data_emissao IS NULL`) e não anuladas.
//                   São as únicas que uma nova configuração pode vir a calcular
//                   — e fá-lo-á na GERAÇÃO seguinte de quotas, não reescrevendo
//                   documentos já existentes;
//  · `protegidas` — quotas JÁ emitidas. R10 congela os seus valores: a
//                   configuração não as reprecifica, agora nem depois.
//
// Este módulo nunca chama `update`/`create`/`destroy`. A garantia de que não
// escreve é estrutural: não importa nada que escreva.
const { Op } = require('sequelize');
const { Quota, Fracao } = require('../models');
const { calcularQuota } = require('./quotas-calc');
const { toCents } = require('./money');

/**
 * Calcula o impacto de uma configuração de quotas, sem gravar.
 *
 * @param {object} p
 * @param {number} p.condominioId  âmbito (obrigatório — nunca inferido da sessão)
 * @param {string|number} p.valorPor1000   total do condomínio por 1000‰
 * @param {string|number} p.fcrPercentagem percentagem do FCR
 * @returns {Promise<{afetadas: object[], protegidas: object[], nAfetadas: number, nMudam: number, nProtegidas: number}>}
 */
async function previsaoRecalculo({ condominioId, valorPor1000, fcrPercentagem }) {
  const quotas = await Quota.findAll({
    where: {
      condominio_id: condominioId,
      // Uma quota anulada não é candidata a cálculo nenhum.
      estado: { [Op.ne]: 'anulada' },
    },
    order: [['id', 'ASC']],
  });

  // Cada fração é lida uma só vez (a permilagem não muda dentro da pré-visualização).
  const fracoes = new Map();
  const fracaoDe = async (id) => {
    if (!fracoes.has(id)) fracoes.set(id, await Fracao.findByPk(id));
    return fracoes.get(id);
  };

  const afetadas = [];
  const protegidas = [];

  for (const q of quotas) {
    const fracao = await fracaoDe(q.fracao_id);
    // Sem fração não há permilagem: não se inventa um valor para a mostrar.
    if (!fracao) continue;

    if (q.data_emissao) {
      // EMITIDA ⇒ R10 congela. Mostrada apenas para o utilizador ver que nada
      // lhe acontece (a configuração não toca em documentos emitidos).
      protegidas.push({
        id: q.id, fracao_id: q.fracao_id, ano: q.ano, mes: q.mes, valor: q.valor,
      });
      continue;
    }

    const calc = calcularQuota(fracao.permilagem, valorPor1000, fcrPercentagem);
    afetadas.push({
      id: q.id,
      fracao_id: q.fracao_id,
      ano: q.ano,
      mes: q.mes,
      de: q.valor,
      para: calc.total,
      muda: toCents(q.valor) !== toCents(calc.total),
    });
  }

  return {
    afetadas,
    protegidas,
    nAfetadas: afetadas.length,
    nMudam: afetadas.filter((a) => a.muda).length,
    nProtegidas: protegidas.length,
  };
}

module.exports = { previsaoRecalculo };
