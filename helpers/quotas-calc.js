const { toCents, toNumber, fromCents } = require('./money');
const { distribuirPorPesos } = require('./distribuicao');

// Calcula o valor de uma quota a partir da permilagem da fração.
// - valorPermilagem: valor em euros por cada 1‰ (ex.: 0.1000 € → 0,10 € por ‰)
// - fcrPercentagem: percentagem do Fundo Comum de Reserva (ex.: 10)
// Fórmula:
//   base  = permilagem × valorPorPermilagem
//   fcr   = base × fcrPercentagem / 100
//   total = base + fcr
function calcularQuota(permilagem, valorPermilagem, fcrPercentagem = 0) {
  const perm = parseFloat(String(permilagem).replace(',', '.')) || 0;
  const valorPorPermilagemC = Math.round(toNumber(valorPermilagem) * 100); // cêntimos por ‰
  const baseC = Math.round(perm * valorPorPermilagemC);
  const fcrC = Math.round((baseC * (parseFloat(fcrPercentagem) || 0)) / 100);
  const totalC = baseC + fcrC;

  return {
    baseC,
    fcrC,
    totalC,
    base: fromCents(baseC),
    fcr: fromCents(fcrC),
    total: fromCents(totalC),
  };
}

// Divide um total em euros por n frações em partes iguais (sem perdas de cêntimos).
// Devolve um array com os valores em euros, soma === total.
function dividirIgual(total, n) {
  const { toCents } = require('./money');
  const totalC = toCents(total);
  const base = Math.floor(totalC / n);
  let resto = totalC - base * n;
  const partes = new Array(n).fill(base);
  for (let i = 0; i < resto; i++) partes[i] += 1;
  return partes.map((c) => fromCents(c));
}

// Método 2 — orçamento define a receita: o total anual de rubricas do orçamento
// (incluindo o FCR, quando registado como rubrica) é distribuído pelas frações
// (permilagem ou igual) e dividido uniformemente pelos meses cobrados.
// fracoes: [{ id, permilagem }] · metodo: 'permilagem' | 'igual'
// devolve: Map<fracaoId, { baseC, fcrC, totalC, base, fcr, total }> (mensal)
function calcularQuotasOrcamento({ fracoes, totalAnual, metodo = 'permilagem', meses = 12 }) {
  const totalC = toCents(totalAnual);
  const pesos = fracoes.map((f) => ({
    fracaoId: f.id,
    peso: metodo === 'igual' ? 1 : parseFloat(String(f.permilagem).replace(',', '.')) || 0,
  }));
  const distribuicao = distribuirPorPesos(totalC, pesos);
  const resultado = new Map();
  for (const d of distribuicao) {
    const mensalC = Math.round(d.valorC / meses);
    resultado.set(d.fracaoId, {
      baseC: mensalC,
      fcrC: 0, // FCR já integrado nas rubricas do orçamento
      totalC: mensalC,
      base: fromCents(mensalC),
      fcr: 0,
      total: fromCents(mensalC),
    });
  }
  return resultado;
}

module.exports = { calcularQuota, dividirIgual, calcularQuotasOrcamento };
