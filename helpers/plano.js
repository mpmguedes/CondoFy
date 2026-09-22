const { toCents, fromCents } = require('./money');
const { acrescentarFcrAoTotal } = require('./quotas-calc');

// Lista dos meses {ano, mes} dentro do período (inclusivo), na ordem cronológica.
function mesesDoPeriodo(dataInicio, dataFim) {
  const inicio = new Date(dataInicio);
  const fim = new Date(dataFim);
  const meses = [];
  const cur = new Date(inicio.getFullYear(), inicio.getMonth(), 1);
  const fimMes = new Date(fim.getFullYear(), fim.getMonth(), 1);
  while (cur <= fimMes) {
    meses.push({ ano: cur.getFullYear(), mes: cur.getMonth() + 1 });
    cur.setMonth(cur.getMonth() + 1);
  }
  return meses;
}

function numCobrancas(periodicidade) {
  return { mensal: 12, trimestral: 4, semestral: 2, anual: 1, unica: 1 }[periodicidade] || 12;
}

// Índices dos meses (0-based, dentro do período) em que uma rubrica é cobrada.
function indicesCobranca(periodicidade, totalMeses) {
  if (periodicidade === 'trimestral') return [0, 3, 6, 9].filter((i) => i < totalMeses);
  if (periodicidade === 'semestral') return [0, 6].filter((i) => i < totalMeses);
  if (periodicidade === 'anual' || periodicidade === 'unica') return [0];
  return Array.from({ length: totalMeses }, (_, i) => i); // mensal
}

// Divide um total em cêntimos por n partes cuja soma é EXATAMENTE o total (P22).
//
// Antes: `Math.round(totalC / n)` repetido n vezes. O erro de arredondamento era
// multiplicado por n — um valor anual de 3.333,33 € dava 12 × 277,78 € =
// 3.333,36 €, ou seja +3 cêntimos por rubrica × fração. Medido na auditoria de
// 2026-09-20: +0,08 €/ano num orçamento de 10.000 € repartido por 3 frações.
//
// Agora: as partes diferem no máximo 1 cêntimo (maior-resto) e a soma fecha ao
// cêntimo por construção. O cêntimo sobrante é atribuído de forma
// determinística aos primeiros índices — nunca «atirado» ao último mês, que era
// o padrão que inflacionava a última célula noutros módulos.
function dividirEm(totalC, n) {
  const total = Math.round(Number(totalC) || 0);
  const partesN = Math.max(1, Math.round(Number(n) || 0));
  const base = Math.floor(total / partesN);
  const resto = total - base * partesN; // 0 … partesN−1 cêntimos
  return Array.from({ length: partesN }, (_, i) => base + (i < resto ? 1 : 0));
}

// Calcula o plano de quotas de um orçamento a partir da distribuição.
// orcamento: { data_inicio, data_fim }
// rubricas: [{ id, periodicidade }]
// distribuicoes: [{ rubrica_id, fracao_id, valor_anual }]
// fracoes: [{ id }]
// fcrPercentagem: percentagem do Fundo Comum de Reserva do condomínio. As
//   `distribuicoes` são DESPESAS; o valor a cobrar em cada quota é o total
//   (despesas + FCR), obtido pelo ÚNICO ponto do acréscimo
//   (`acrescentarFcrAoTotal`, a mesma função usada na geração de quotas).
//   ⛔ Sem percentagem (0 ou omitida) o comportamento é exatamente o anterior —
//   é o que mantém este caminho retrocompatível.
// devolve: [{ fracaoId, ano, mes, valor, dataVencimento }]  (valor = total a cobrar)
function calcularPlano({ orcamento, rubricas, distribuicoes, fracoes, diaVencimento = 8, fcrPercentagem = 0 }) {
  const meses = mesesDoPeriodo(orcamento.data_inicio, orcamento.data_fim);
  const plano = new Map(); // key `${fracaoId}|${ano}|${mes}` -> valorC (int)

  for (const fracao of fracoes) {
    for (const rubrica of rubricas) {
      const dist = distribuicoes.find(
        (d) => d.rubrica_id === rubrica.id && d.fracao_id === fracao.id
      );
      if (!dist) continue;

      const valorAnualC = toCents(dist.valor_anual);
      const indices = indicesCobranca(rubrica.periodicidade, meses.length);
      if (indices.length === 0) continue;

      const partes = dividirEm(valorAnualC, indices.length);
      indices.forEach((idx, i) => {
        const { ano, mes } = meses[idx];
        const key = `${fracao.id}|${ano}|${mes}`;
        plano.set(key, (plano.get(key) || 0) + partes[i]);
      });
    }
  }

  const fcrP = Number(String(fcrPercentagem === null || fcrPercentagem === undefined ? '' : fcrPercentagem).replace(',', '.')) || 0;

  return [...plano.entries()].map(([key, despesasC]) => {
    const [fracaoId, ano, mes] = key.split('|').map(Number);
    // O que se cobra é o TOTAL (despesas + FCR). Com `fcrP = 0` o valor sai
    // byte-idêntico ao de antes desta alteração.
    const valorC = fcrP > 0 ? acrescentarFcrAoTotal(despesasC, fcrP) : despesasC;
    const dataVencimento = new Date(ano, mes - 1, Math.min(diaVencimento, 28));
    return { fracaoId, ano, mes, valor: fromCents(valorC), dataVencimento };
  });
}

module.exports = { calcularPlano, mesesDoPeriodo };
