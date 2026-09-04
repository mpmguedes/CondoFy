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

// Divide um valor anual (em cêntimos) por n parcelas IGUAIS; a diferença de
// arredondamento é atribuída à última parcela.
function parcelar(valorFracaoC, n) {
  const base = Math.floor(valorFracaoC / n);
  let resto = valorFracaoC - base * n;
  const parcelas = new Array(n).fill(base);
  parcelas[n - 1] += resto;
  return parcelas;
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
