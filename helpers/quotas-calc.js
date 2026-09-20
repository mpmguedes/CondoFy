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

  // ── Divisão mensal EXATA (C3) ─────────────────────────────────────
  //
  // Dois níveis de fecho, ambos ao cêntimo:
  //   ANO   Σ frações === despesas + FCR            (o que o condomínio cobra)
  //   ANO(f) totalAnoC(f) === total que a distribuição por permilagem lhe deu
  //   MÊS   Σ meses(f) === totalAnoC(f)              (I-2)
  //   MÊS   Σ base + Σ FCR === Σ total, em cada mês  (I-4)
  //
  // O defeito corrigido: dividia-se o anual por `nMeses` com `Math.floor` POR
  // FRAÇÃO e atirava-se a SOMA dos restos para o último mês da última fração.
  // Como cada fração perde `anual(f) mod nMeses` e o resto somado é maior do que
  // a perda de UMA só fração, o último mês ficava INFLACIONADO — `Σ nMeses ×
  // mensal > totalC` (2×500‰ de 5.500 € davam 5.501,76 €; com mensalidades
  // pequenas o desvio podia ser de ordem de grandeza).
  //
  // O FCR é repartido a partir do ANO (não arredondado mês a mês, que somaria
  // erros de arredondamento e afastaria o FCR anual do seu valor exato).
  //   fcrAnoC = round(totalAnoC × pct/(100+pct))   ← fecha ao ano
  //   fcrMês  = repartição desse FCR anual pelos meses (maior resto)
  //   baseMês = totalMês − fcrMês                  ← fecha por construção
  //
  // Invariantes garantidos (ver `scripts/test-quotas-mensal.js`):
  //   I-1  Σ de todos os meses de todas as frações === totalC
  //   I-2  Σ meses(f) === anual(f)  ·  Σ fcrMês === fcrAno(f)
  //   I-3  frações de permilagem igual → mesma sequência de meses
  //   I-4  base + FCR === total, em cada mês
  //   I-5  meses consecutivos nunca diferem mais de 1 cêntimo
  //   I-6  base + FCR === total, no ano da fração
  const mensalC = [];
  const fcrMensalC = [];
  for (const d of distribuicao) {
    const cotasMes = distribuirPorPesos(
      d.valorC,
      Array.from({ length: nMeses }, (_, i) => ({ fracaoId: i, peso: 1 }))
    );
    mensalC.push(cotasMes.map((p) => p.valorC));
    // O FCR do ANO fecha no valor exato de D1; só depois se reparte pelos meses.
    const fcrAnoC = dividirComponentesQuota(d.valorC, fcrP).fcrC;
    const fcrMes = distribuirPorPesos(
      fcrAnoC,
      Array.from({ length: nMeses }, (_, i) => ({ fracaoId: i, peso: 1 }))
    );
    fcrMensalC.push(fcrMes.map((p) => p.valorC));
  }

  // `valorPor1000` = TOTAL a cobrar por 1000‰, JÁ COM FCR. O total por mês do
  // condomínio é a média dos meses — mas como cada mês pode diferir em 1 cêntimo
  // (I-5), é o total ANUAL × 1000 / Σpesos que dá o valor estável a apresentar.
  const somaPesos = pesos.reduce((s, p) => s + p.peso, 0);
  const valorPor1000C = somaPesos > 0
    ? Math.round((totalC * 1000) / somaPesos)
    : 0;

  const resultado = new Map();
  distribuicao.forEach((d, idx) => {
    // O total de CADA MÊS manda; a componente FCR do mês vem da repartição do
    // FCR ANUAL (não de um novo arredondamento, que somaria desvios) e a BASE
    // absorve a diferença — `base + FCR = total` mantém-se em cada mês (I-4).
    const mesesC = mensalC[idx];
    const fcrMesesC = fcrMensalC[idx];
    const porMes = mesesC.map((mC, i) => {
      const fcrMesC = fcrMesesC[i];
      const baseMesC = mC - fcrMesC;
      return {
        baseC: baseMesC,
        fcrC: fcrMesC,
        totalC: mC,
        base: fromCents(baseMesC),
        fcr: fromCents(fcrMesC),
        total: fromCents(mC),
      };
    });

    // Totais anuais da fração = soma exata dos seus meses (I-2). A base fecha
    // por construção: `Σ baseMês = Σ totalMês − Σ fcrMês = anual − fcrAno`.
    const baseC = porMes.reduce((s, m) => s + m.baseC, 0);
    const fcrC = porMes.reduce((s, m) => s + m.fcrC, 0);
    const totalAnoC = porMes.reduce((s, m) => s + m.totalC, 0);
    const peso = (pesos.find((p) => p.fracaoId === d.fracaoId) || {}).peso || 0;

    resultado.set(d.fracaoId, {
      baseC,
      fcrC,
      totalC: totalAnoC,
      base: fromCents(baseC),
      fcr: fromCents(fcrC),
      total: fromCents(totalAnoC),
      // Compatibilidade com os consumidores de C2: quando todos os meses são
      // iguais (caso comum), `mensalC` é esse valor; quando diferem em 1 cêntimo
      // (I-5), é o MENOR mês — o maior está em `porMes`. Para gravar/emitir,
      // usar SEMPRE `porMes[c.mes - 1]`.
      mensalC: Math.min(...mesesC),
      porMes,
      valorPor1000: fromCents(valorPor1000C),
      permilagem: peso,
      fcrPercentagem: fcrP,
    });
  });
  return resultado;
}

module.exports = { calcularQuota, dividirComponentesQuota, acrescentarFcrAoTotal, dividirIgual, calcularQuotasOrcamento };
