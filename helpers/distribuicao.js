const { toCents, fromCents } = require('./money');

// Distribui um total (em cêntimos) por frações segundo pesos, usando o método do
// "maior resto" para garantir que a soma das partes é exatamente o total
// (sem diferenças silenciosas de 0,01 € / 0,02 €).
//
// pesos: [{ fracaoId, peso }]  →  permilagem usa peso = permilagem (‰); igual usa peso = 1.
// devolve: [{ fracaoId, valorC }] com soma(valorC) === totalC.
function distribuirPorPesos(totalC, pesos) {
  const totalPeso = pesos.reduce((s, p) => s + p.peso, 0);
  if (totalPeso <= 0) {
    return pesos.map((p) => ({ fracaoId: p.fracaoId, valorC: 0 }));
  }

  const exatos = pesos.map((p) => ({
    fracaoId: p.fracaoId,
    exato: (totalC * p.peso) / totalPeso,
  }));

  const partes = exatos.map((e) => ({
    fracaoId: e.fracaoId,
    valorC: Math.floor(e.exato),
  }));

  let distribuido = partes.reduce((s, p) => s + p.valorC, 0);
  let resto = totalC - distribuido;

  const ordem = exatos
    .map((e, idx) => ({ idx, frac: e.exato - Math.floor(e.exato) }))
    .sort((a, b) => b.frac - a.frac);

  let i = 0;
  while (resto > 0) {
    partes[ordem[i % ordem.length].idx].valorC += 1;
    resto -= 1;
    i += 1;
  }

  return partes;
}

// Distribui um valor anual (em euros) por frações com o método indicado.
// metodo: 'permilagem' | 'igual'. Para 'valor_fixo', os valores são introduzidos
// explicitamente e não passam por aqui.
function distribuirValorAnual(valor, fracoes, metodo) {
  const totalC = toCents(valor);
  let pesos;
  if (metodo === 'igual') {
    pesos = fracoes.map((f) => ({ fracaoId: f.id, peso: 1 }));
  } else {
    // permilagem
    pesos = fracoes.map((f) => ({ fracaoId: f.id, peso: toCents(String(f.permilagem)) || 0 }));
  }
  const partes = distribuirPorPesos(totalC, pesos);
  return partes.map((p) => ({ fracaoId: p.fracaoId, valor: fromCents(p.valorC) }));
}

module.exports = { distribuirPorPesos, distribuirValorAnual };
