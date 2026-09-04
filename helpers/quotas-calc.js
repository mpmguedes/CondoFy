const { toCents, toNumber, fromCents } = require('./money');
const { distribuirPorPesos } = require('./distribuicao');

// Calcula o valor de uma quota a partir da permilagem da fração.
// - valorPor1000: valor em euros para a totalidade do condomínio (1000‰).
//   Ex.: 100 € por 1000‰ → uma fração de 500‰ paga 50 € de base.
// - fcrPercentagem: percentagem do Fundo Comum de Reserva (ex.: 10).
// Fórmula (especificação):
//   base  = (permilagem / 1000) × valorPor1000
//   fcr   = base × fcrPercentagem / 100
//   total = base + fcr
function calcularQuota(permilagem, valorPor1000, fcrPercentagem = 0) {
  const perm = parseFloat(String(permilagem).replace(',', '.')) || 0;
  const valorPor1000C = Math.round(toNumber(valorPor1000) * 100); // cêntimos por 1000‰
  const baseC = Math.round((perm / 1000) * valorPor1000C);
  const fcrC = Math.round((baseC * (parseFloat(fcrPercentagem) || 0)) / 100);
  const totalC = baseC + fcrC;

  return {
    baseC,
    fcrC,
    totalC,
    base: fromCents(baseC),
    fcr: fromCents(fcrC),
    total: fromCents(totalC),
    valorPor1000: fromCents(valorPor1000C),
    permilagem: perm,
    fcrPercentagem: parseFloat(fcrPercentagem) || 0,
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

// Modo B — orçamento define a receita: o total anual pretendido é distribuído
// pelas frações (permilagem ou igual) e dividido uniformemente pelos meses.
// fracoes: [{ id, permilagem }] · metodo: 'permilagem' | 'igual'
// devolve: Map<fracaoId, { baseC, fcrC, totalC, base, fcr, total, valorPor1000 }>
function calcularQuotasOrcamento({ fracoes, totalAnual, metodo = 'permilagem', meses = 12, fcrPercentagem = 0 }) {
  const totalC = toCents(totalAnual);
  const pesos = fracoes.map((f) => ({
    fracaoId: f.id,
    peso: metodo === 'igual' ? 1 : parseFloat(String(f.permilagem).replace(',', '.')) || 0,
  }));
  const distribuicao = distribuirPorPesos(totalC, pesos);
  const resultado = new Map();

  const fcrP = parseFloat(fcrPercentagem) || 0;
  // Valor por 1000‰ implícito no Modo B: base anual ÷ 12 (sem FCR), mensal.
  const baseAnualC = Math.round(totalC * 100 / (100 + fcrP));
  const valorPor1000C = Math.round(baseAnualC / meses);

  for (const d of distribuicao) {
    const mensalC = Math.round(d.valorC / meses);
    const baseC = Math.round(mensalC * 100 / (100 + fcrP));
    const fcrC = mensalC - baseC;
    resultado.set(d.fracaoId, {
      baseC,
      fcrC,
      totalC: mensalC,
      base: fromCents(baseC),
      fcr: fromCents(fcrC),
      total: fromCents(mensalC),
      valorPor1000: fromCents(valorPor1000C),
      permilagem: parseFloat(String((pesos.find((p) => p.fracaoId === d.fracaoId) || {}).peso)) || 0,
      fcrPercentagem: fcrP,
    });
  }
  return resultado;
}

module.exports = { calcularQuota, dividirIgual, calcularQuotasOrcamento };
