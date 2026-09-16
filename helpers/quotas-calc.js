const { toCents, toNumber, fromCents } = require('./money');
const { distribuirPorPesos } = require('./distribuicao');

// Divide um valor TOTAL mensal (em cêntimos) nas duas componentes da quota:
//   base = quota-parte das despesas correntes
//   fcr  = Fundo Comum de Reserva = base × percentagem / 100
//
// INVARIANTE: `baseC + fcrC === totalC`, sempre. O FCR é arredondado ao cêntimo
// e a componente base recebe a diferença, para que a soma das duas componentes
// nunca fique 1 cêntimo acima ou abaixo do valor a pagar (era o que acontecia
// quando as duas componentes eram arredondadas em separado).
//
// É a fórmula única usada no cálculo final (servidor) e na pré-visualização
// (browser): a pré-visualização recebe esta função já avaliada, para não existir
// uma segunda implementação da mesma regra.
function dividirComponentesQuota(totalC, fcrPercentagem = 0) {
  const total = Math.max(0, Math.round(Number(totalC) || 0));
  const p = Number(String(fcrPercentagem).replace(',', '.'));
  const percentagem = Number.isFinite(p) && p > 0 ? p : 0;
  const fcrC = percentagem > 0 ? Math.round((total * percentagem) / (100 + percentagem)) : 0;
  return { baseC: total - fcrC, fcrC, totalC: total, fcrPercentagem: percentagem };
}

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
// pelas frações (permilagem ou igual) e dividido uniformemente pelos meses,
// com o FCR separado pela percentagem configurada.
// fracoes: [{ id, permilagem }] · metodo: 'permilagem' | 'igual'
// devolve: Map<fracaoId, { baseC, fcrC, totalC, base, fcr, total, valorPor1000, fcrPercentagem }>
//
// `fcrPercentagem` SEMPRE explícito: quem chama tem de o passar (vem da
// configuração do condomínio). Se ficar em falta, o FCR sai a zero e a quota
// deixa de discriminar o fundo — foi exatamente esse o defeito corrigido.
function calcularQuotasOrcamento({ fracoes, totalAnual, metodo = 'permilagem', meses = 12, fcrPercentagem = 0 }) {
  const totalC = toCents(totalAnual);
  const nMeses = Number(meses) > 0 ? Number(meses) : 12;
  const fcrP = parseFloat(String(fcrPercentagem).replace(',', '.')) || 0;
  const pesos = fracoes.map((f) => ({
    fracaoId: f.id,
    peso: metodo === 'igual' ? 1 : parseFloat(String(f.permilagem).replace(',', '.')) || 0,
  }));
  const distribuicao = distribuirPorPesos(totalC, pesos);

  // Valor mensal de cada fração: o resto da divisão por mês fica na última
  // fração, para que `meses × Σ mensal === total anual` ao cêntimo.
  const mensalC = distribuicao.map((d) => Math.floor(d.valorC / nMeses));
  const restoC = totalC - mensalC.reduce((s, v) => s + v, 0) * nMeses;
  if (restoC > 0 && mensalC.length) mensalC[mensalC.length - 1] += restoC;

  const totalPorMesC = mensalC.reduce((s, v) => s + v, 0);
  const valorPor1000C = pesos.reduce((s, p) => s + p.peso, 0) > 0
    ? Math.round((totalPorMesC * 1000) / pesos.reduce((s, p) => s + p.peso, 0))
    : 0;

  const resultado = new Map();
  distribuicao.forEach((d, idx) => {
    // O total mensal da fração manda; as componentes são sempre derivadas dele
    // (base + FCR = total, por construção).
    const partes = dividirComponentesQuota(mensalC[idx], fcrP);
    const peso = (pesos.find((p) => p.fracaoId === d.fracaoId) || {}).peso || 0;
    resultado.set(d.fracaoId, {
      baseC: partes.baseC,
      fcrC: partes.fcrC,
      totalC: partes.totalC,
      base: fromCents(partes.baseC),
      fcr: fromCents(partes.fcrC),
      total: fromCents(partes.totalC),
      valorPor1000: fromCents(valorPor1000C),
      permilagem: peso,
      fcrPercentagem: fcrP,
    });
  });
  return resultado;
}

module.exports = { calcularQuota, dividirComponentesQuota, dividirIgual, calcularQuotasOrcamento };
