const { toCents, fromCents } = require('./money');
const { distribuirPorPesos } = require('./distribuicao');

// Distribui o valor total de uma quota extra pelas frações.
// metodo: 'igual' (partes iguais) | 'permilagem' (proporcional à permilagem).
// Devolve [{ fracaoId, valorC }] com soma === totalC.
function distribuicaoExtra(valorTotal, fracoes, metodo) {
  const totalC = toCents(valorTotal);
  const pesos = fracoes.map((f) => ({
    fracaoId: f.id,
    peso: metodo === 'igual' ? 1 : parseFloat(String(f.permilagem).replace(',', '.')) || 0,
  }));
  return distribuirPorPesos(totalC, pesos);
}

// Divide um valor (em cêntimos) por n parcelas cuja soma é EXATAMENTE o valor.
//
// Antes: `parcelas[n-1] += resto`. A soma também fechava, mas TODO o resto caía
// na última parcela — com 60 parcelas isso é até **0,59 €** de diferença numa
// parcela só, contra a promessa do próprio comentário («parcelas IGUAIS») e
// contra o que a vista mostra (cada parcela tem o seu `valor`).
//
// Agora: maior-resto — as parcelas diferem no máximo 1 cêntimo e a soma continua
// a fechar por construção. É a MESMA regra do `dividirEm` (`helpers/plano.js`,
// P22) e o padrão que o preflight da Fase A marca como comportamento antigo a
// alterar (assinatura A4, `scripts/diagnostico-fase-a-preflight.js`).
function parcelar(valorFracaoC, n) {
  const total = Math.round(Number(valorFracaoC) || 0);
  const partesN = Math.max(1, Math.round(Number(n) || 0));
  const base = Math.floor(total / partesN);
  const resto = total - base * partesN; // 0 … partesN−1 cêntimos
  return Array.from({ length: partesN }, (_, i) => base + (i < resto ? 1 : 0));
}

const PERIODICIDADE_MESES = { mensal: 1, bimestral: 2, trimestral: 3, semestral: 6, anual: 12 };

// Devolve os períodos de vencimento das parcelas (ano, mês, data de vencimento).
function periodosVencimento(mesInicio, anoInicio, n, periodicidade) {
  const passo = PERIODICIDADE_MESES[periodicidade] || 1;
  const periodos = [];
  for (let i = 0; i < n; i++) {
    const totalMeses = mesInicio - 1 + i * passo;
    const ano = anoInicio + Math.floor(totalMeses / 12);
    const mes = (totalMeses % 12) + 1;
    periodos.push({ ano, mes, dataVencimento: new Date(ano, mes - 1, 8) });
  }
  return periodos;
}

module.exports = { distribuicaoExtra, parcelar, periodosVencimento, PERIODICIDADE_MESES };
