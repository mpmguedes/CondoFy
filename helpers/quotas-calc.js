const { toCents, toNumber, fromCents } = require('./money');
const { distribuirPorPesos } = require('./distribuicao');

// ═══════════════════════════════════════════════════════════════════
// D1 — O FCR é COMPONENTE do total, nunca um valor somado por cima.
//
// Regra de negócio (Fase A / C2), com um total JÁ com FCR:
//   despesas previstas + FCR = orçamento total  → é este total que se
//   distribui; e, para cada quota:
//        fcrC  = round(totalC × pct / (100 + pct))
//        baseC = totalC − fcrC
//        totalC = baseC + fcrC        (invariante, sempre)
//
// O FCR é arredondado ao cêntimo e a componente BASE absorve a diferença de
// arredondamento, para que `baseC + fcrC === totalC` ao cêntimo. NUNCA se
// acrescenta FCR depois de o total já o conter (era o defeito da fórmula
// legada: `base = total`, `fcr = round(base × pct/100)`, `total = base + fcr`
// — inflacionava o valor a pagar).
//
// É a ÚNICA implementação da decomposição, usada no cálculo final (servidor) e
// na pré-visualização (browser) — que a recebe já avaliada, para não existir
// uma segunda implementação da mesma regra.
// ═══════════════════════════════════════════════════════════════════
function dividirComponentesQuota(totalC, fcrPercentagem = 0) {
  const total = Math.max(0, Math.round(Number(totalC) || 0));
  const p = Number(String(fcrPercentagem).replace(',', '.'));
  const percentagem = Number.isFinite(p) && p > 0 ? p : 0;
  const fcrC = percentagem > 0 ? Math.round((total * percentagem) / (100 + percentagem)) : 0;
  return { baseC: total - fcrC, fcrC, totalC: total, fcrPercentagem: percentagem };
}

// Acrescenta o FCR a um total de DESPESAS, produzindo o total a distribuir:
//   totalComFcrC = round(despesasC × (100 + pct) / 100)
//
// É a operação inversa de `dividirComponentesQuota`: aí parte-se de um total
// que já contém FCR; aqui constrói-se esse total a partir das despesas. Fica
// num único lugar para nunca haver duas interpretações do mesmo acréscimo.
function acrescentarFcrAoTotal(despesasC, fcrPercentagem = 0) {
  const despesas = Math.max(0, Math.round(Number(despesasC) || 0));
  const p = Number(String(fcrPercentagem).replace(',', '.'));
  const percentagem = Number.isFinite(p) && p > 0 ? p : 0;
  if (percentagem <= 0) return despesas;
  return Math.round((despesas * (100 + percentagem)) / 100);
}

// Calcula o valor de uma quota a partir da permilagem da fração.
// - valorPor1000: valor em euros para a totalidade do condomínio (1000‰),
//   JÁ COM FCR incluído (é o total a cobrar por 1000‰, não as despesas puras).
//   Ex.: 110 € por 1000‰ → uma fração de 500‰ paga 55 € no total.
// - fcrPercentagem: percentagem do Fundo Comum de Reserva (ex.: 10).
// Semântica D1:
//   total = (permilagem / 1000) × valorPor1000      ← o valor a pagar
//   base + fcr = total                              ← decomposto por D1
// O FCR NUNCA é somado outra vez: o total já o contém.
function calcularQuota(permilagem, valorPor1000, fcrPercentagem = 0) {
  const perm = parseFloat(String(permilagem).replace(',', '.')) || 0;
  const valorPor1000C = Math.round(toNumber(valorPor1000) * 100); // cêntimos por 1000‰
  const totalC = Math.round((perm / 1000) * valorPor1000C);

  // D1: o total manda; as componentes derivam dele (base + FCR = total exato).
  const partes = dividirComponentesQuota(totalC, fcrPercentagem);

  return {
    baseC: partes.baseC,
    fcrC: partes.fcrC,
    totalC: partes.totalC,
    base: fromCents(partes.baseC),
    fcr: fromCents(partes.fcrC),
    total: fromCents(partes.totalC),
    valorPor1000: fromCents(valorPor1000C),
    permilagem: perm,
    fcrPercentagem: partes.fcrPercentagem,
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

// Modo B — o orçamento define a receita. `totalAnual` são as DESPESAS PREVISTAS
// (soma das rubricas ativas); o FCR é acrescentado a esse valor antes de
// distribuir, porque é o TOTAL (despesas + FCR) que é distribuído pelas frações:
//
//   despesas  ──(+FCR %)──▶  total a distribuir  ──(permilagem)──▶  quota
//                                                                     │
//                                                            D1 ──▶ base + FCR
//
// O total de cada fração é depois repartido por D1 (`dividirComponentesQuota`),
// pelo que `base + FCR = total` e o FCR **não** é somado outra vez.
// fracoes: [{ id, permilagem }] · metodo: 'permilagem' | 'igual'
// devolve: Map<fracaoId, { baseC, fcrC, totalC, base, fcr, total, valorPor1000, fcrPercentagem }>
//
// `fcrPercentagem` SEMPRE explícito: quem chama tem de o passar (vem da
// configuração do condomínio). Se ficar em falta, o FCR sai a zero e a quota
// deixa de discriminar o fundo — foi exatamente esse o defeito corrigido.
function calcularQuotasOrcamento({ fracoes, totalAnual, metodo = 'permilagem', meses = 12, fcrPercentagem = 0 }) {
  const despesasC = toCents(totalAnual);
  const nMeses = Number(meses) > 0 ? Number(meses) : 12;
  const fcrP = parseFloat(String(fcrPercentagem).replace(',', '.')) || 0;

  // O FCR entra ANTES da distribuição: o total a distribuir é despesas + FCR.
  const totalC = acrescentarFcrAoTotal(despesasC, fcrP);

  const pesos = fracoes.map((f) => ({
    fracaoId: f.id,
    peso: metodo === 'igual' ? 1 : parseFloat(String(f.permilagem).replace(',', '.')) || 0,
  }));
  const distribuicao = distribuirPorPesos(totalC, pesos);

  // Valor mensal de cada fração: `floor` do valor anual por mês, com o resto
  // acumulado atirado para a ÚLTIMA FRAÇÃO.
  //
  // ⚠ LIMITAÇÃO CONHECIDA (não introduzida por C2): `12 × totalC` de uma fração
  // pode não fechar com o seu valor anual e frações de permilagem igual podem
  // divergir em cêntimos nas quotas MENSAIS (o resto não é repartido por mês nem
  // por grupo). É matéria do motor de residuais de C1 — `distribuirPorGrupos` /
  // `limiteResidual` em `helpers/quotas-primitiva.js` — e será tratada ao ligar
  // a primitiva a este motor (C3). O invariante que C2 garante é o TOTAL
  // DISTRIBUÍDO no ano: `Σ partes === despesas + FCR` (exato, ver
  // `distribuirPorPesos`).
  const mensalC = distribuicao.map((d) => Math.floor(d.valorC / nMeses));
  const restoC = totalC - mensalC.reduce((s, v) => s + v, 0) * nMeses;
  if (restoC > 0 && mensalC.length) mensalC[mensalC.length - 1] += restoC;

  const totalPorMesC = mensalC.reduce((s, v) => s + v, 0);
  const somaPesos = pesos.reduce((s, p) => s + p.peso, 0);
  const valorPor1000C = somaPesos > 0
    ? Math.round((totalPorMesC * 1000) / somaPesos)
    : 0;

  const resultado = new Map();
  distribuicao.forEach((d, idx) => {
    // O total mensal da fração manda; as componentes são sempre derivadas dele
    // (base + FCR = total, por construção). O FCR não é somado outra vez.
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

module.exports = { calcularQuota, dividirComponentesQuota, acrescentarFcrAoTotal, dividirIgual, calcularQuotasOrcamento };
