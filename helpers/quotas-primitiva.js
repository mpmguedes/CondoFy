// ─────────────────────────────────────────────────────────────────────
// FASE A — Primitiva matemática única do cálculo das quotas.
//
// Esta é a ÚNICA implementação da matemática das quotas no sistema. Todos os
// motores antigos (`calcularQuota`, `calcularQuotasOrcamento`) passam a ser
// wrappers finos sobre esta primitiva (C3). Nada aqui depende da base de dados,
// de sessão ou de pedido HTTP: é aritmética pura e testável.
//
// ── Princípios (Fase A, decisões fechadas) ─────────────────────────
//
// D1  O FCR é COMPONENTE do total, nunca um valor somado:
//        fcrC  = round(totalC × pct / (100 + pct))
//        baseC = totalC − fcrC
//     A componente base absorve a diferença de arredondamento; o FCR nunca é
//     ajustado para baixo (é o valor que tem de ser afetado ao fundo).
//
// D3  A igualdade entre frações é por IGUALDADE EXATA da permilagem ARMAZENADA
//     (DECIMAL(7,2) — 2 casas decimais), sem tolerância. `142,86` e `142,86` são
//     o mesmo grupo; `142,86` e `142,87` são grupos distintos.
//
//     ⚠ Consequência do schema: como a coluna é DECIMAL(7,2), só existem duas
//     casas decimais. Valores como `142,857‰` NÃO são representáveis (gravam
//     `142,86‰`). A comparação é feita sobre o valor realmente armazenado —
//     normalizado a inteiro (`permilagem × 100`) para não depender de `float`.
//
// D4  O total teórico, no modo preço, respeita a permilagem REAL:
//        totalTeóricoC = round(valorPor1000C × Σ permilagem / 1000)
//     E1 = totalTeóricoC − valorPor1000C é a DIFERENÇA ESTRUTURAL da permilagem
//     (Σ ≠ 1000‰). E1 não é um residual de arredondamento e não se confunde com R1.
//
// ── Residuais: R1, R2, E1 ──────────────────────────────────────────
//
//   R1 = totalTeóricoC − Σ totalC emitidos         (arredondamento do total)
//   R2 = fcrTeoricoC  − Σ fcrC emitidos            (arredondamento do FCR)
//   E1 = totalTeóricoC − valorPor1000C             (diferença estrutural)
//
// Os três são INDEPENDENTES e nenhum é absorvido por uma fração. Não são dívida,
// pagamento, movimento bancário nem receita. Nesta fase não são persistidos.
//
// ── Invariantes garantidos (ver I-01…I-10) ─────────────────────────
//
//   I-01  Todos os valores são inteiros em cêntimos.
//   I-02  baseC + fcrC === totalC, sempre.
//   I-03  baseC ≥ 0 e fcrC ≥ 0.
//   I-04  fcrC === round(totalC × pct / (100 + pct)).
//   I-05  Permilagem exata igual ⇒ totalC igual (quando o grupo recebe valor).
//   I-06  Sem tolerância: 142,86 e 142,87 são grupos distintos.
//   I-07  Σ partes + residualC === totalC, exatamente.
//   I-08  |residualC| ≤ nGrupos + Σ(nMembrosDoGrupo − 1)   [ver nota abaixo]
//   I-09  O residual nunca é somado a nenhuma parte nem ao FCR.
//   I-10  Σ FCR emitido pode ≠ fcrTeoricoC; R2 é reportado, nunca absorvido.
//
// ── Nota ao I-08 (revisão aprovada na Fase A) ───────────────────────
//
// O I-08 original (`|residualC| ≤ nGrupos`) é INCOMPATÍVEL com D3. O residual
// tem duas origens independentes:
//
//   · nGrupos cêntimos            — resto do arredondamento ENTRE grupos
//     (maior-resto: cada grupo recebe um quinhão inteiro e sobra < 1 cêntimo
//      por grupo);
//   · Σ(nMembrosDoGrupo − 1)      — resto DENTRO de cada grupo, quando o valor
//     do grupo não é divisível pelo número de membros. É o CUSTO de D3: como
//     nenhum membro pode ficar com o cêntimo indivisível (isso quebraria a
//     igualdade), esse cêntimo sobra. Com n membros sobram até n−1 cêntimos.
//
// D3 (igualdade exata, sem tolerância) e o limite antigo excluíam-se — medido:
// o I-08 antigo falhava em 20 977 de 40 000 casos aleatórios (52 %). O limite
// correto é a soma das duas parcelas. Não se relaxou a D3 para caber num limite
// errado: corrigiu-se o limite.
//
// ⛔ O `ORDER BY id` NÃO distribui cêntimos dentro de um grupo. É apenas o
// desempate estável onde exista efetivamente um empate entre elementos que
// possam receber valores diferentes (ordem dos grupos na atribuição do resto).
// Nunca quebra a igualdade de valores dentro de um grupo de permilagem igual.
// ─────────────────────────────────────────────────────────────────────
const { toCents, fromCents } = require('./money');

// Casas decimais da permilagem armazenada (migrations/…-create-fracoes.js:
// `permilagem: Sequelize.DECIMAL(7, 2)`). É a escala da igualdade exata.
const CASAS_PERMILAGEM = 2;
const ESCALA_PERMILAGEM = 10 ** CASAS_PERMILAGEM; // 100

// ── Normalização ────────────────────────────────────────────────────

// Permilagem → inteiro na escala da coluna (142,86 → 14286).
// Aceita número, string decimal ("142.86") e string com vírgula ("142,86").
// Devolve sempre um inteiro ≥ 0.
function permilagemEscalada(valor) {
  const n = Number(String(valor === null || valor === undefined ? '' : valor).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return 0;
  // `Math.round` na escala da coluna: é a mesma precisão do DECIMAL(7,2), logo
  // dois valores que a BD considera iguais têm a mesma chave.
  return Math.round(n * ESCALA_PERMILAGEM);
}

// Inteiro na escala da coluna → número em ‰ (14286 → 142.86).
function permilagemDeEscala(escalada) {
  return (Number(escalada) || 0) / ESCALA_PERMILAGEM;
}

// Percentagem do FCR → número ≥ 0 (aceita "12,5" e 12.5).
function normalizarPercentagem(valor) {
  const n = Number(String(valor === null || valor === undefined ? '' : valor).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── Grupos por igualdade exata de permilagem (D3) ───────────────────

// Agrupa frações por igualdade EXATA da permilagem armazenada, sem tolerância.
//
// fracoes: [{ id, permilagem }]
// devolve: [{ chave, permilagemEscalada, permilagem, membros: [id, …] }]
//
// Determinismo: os grupos saem ordenados pela permilagem descendente e, em caso
// de empate (impossível — seria o mesmo grupo), pelo primeiro `id` de cada
// grupo. Dentro de um grupo, os membros ficam ordenados por `id` ascendente —
// é o tie-break estável decidido em D3 (`ORDER BY id`).
function agruparPorPermilagem(fracoes) {
  const lista = Array.isArray(fracoes) ? fracoes : [];
  const porChave = new Map();

  for (const f of lista) {
    const escalada = permilagemEscalada(f && f.permilagem);
    const chave = String(escalada);
    if (!porChave.has(chave)) {
      porChave.set(chave, { chave, permilagemEscalada: escalada, permilagem: permilagemDeEscala(escalada), membros: [] });
    }
    porChave.get(chave).membros.push(f && f.id);
  }

  const grupos = [...porChave.values()];
  for (const g of grupos) {
    g.membros.sort((a, b) => (Number(a) || 0) - (Number(b) || 0)); // ORDER BY id
  }
  grupos.sort((a, b) => {
    if (b.permilagemEscalada !== a.permilagemEscalada) return b.permilagemEscalada - a.permilagemEscalada;
    return (Number(a.membros[0]) || 0) - (Number(b.membros[0]) || 0);
  });
  return grupos;
}

// ── Distribuição determinística com residual explícito (D3, I-07, I-08) ──

// Distribui um total (cêntimos) por grupos de igualdade de permilagem.
//
// Regras:
//   1. maior-resto sobre os GRUPOS → cada grupo recebe o seu quinhão inteiro;
//   2. dentro do grupo, TODOS os membros recebem o mesmo valor:
//        valorMembro = floor(valorGrupo / nMembros)
//      o quinhão indivisível NÃO vai para um membro privilegiado;
//   3. o que sobra (do passo 1 e do passo 2) vai para `residualC`, nunca para
//      uma fração. É a materialização de D3 e de I-09.
//
// totalC: inteiro ≥ 0 em cêntimos
// grupos: [{ chave, membros: [id…], permilagemEscalada }]
// devolve: { porFracao: Map<id, valorC>, residualC, nGrupos }
//
//   I-07: Σ porFracao.values() + residualC === totalC
//   I-08: 0 ≤ residualC ≤ nGrupos + Σ(nMembrosDoGrupo − 1)
//         (nunca negativo: o maior-resto nunca dá parte negativa, e o floor
//          intra-grupo só pode sobrar para cima)
function distribuirPorGrupos(totalC, grupos) {
  const lista = Array.isArray(grupos) ? grupos : [];
  const total = Math.max(0, Math.round(Number(totalC) || 0));
  const porFracao = new Map();

  if (!lista.length) {
    // Sem frações não há a quem distribuir: o total inteiro é residual.
    return { porFracao, residualC: total, nGrupos: 0 };
  }

  const grupos_ = lista;

  // Peso do grupo = permilagem do grupo. Com peso total zero (todas a 0‰), o
  // critério de repartição desaparece e cai-se na divisão igualitária — é a
  // única leitura razoável e é determinística.
  const somaEscalas = grupos_.reduce((s, g) => s + (g.permilagemEscalada || 0), 0);
  const usarPermilagem = somaEscalas > 0;

  // 1) maior-resto ao nível do GRUPO
  const exatos = grupos_.map((g, idx) => {
    const peso = usarPermilagem ? g.permilagemEscalada : 1;
    const denominador = usarPermilagem ? somaEscalas : grupos_.length;
    return {
      idx,
      grupo: g,
      peso,
      exato: (total * peso) / denominador,
    };
  });

  const partes = exatos.map((e) => Math.floor(e.exato));
  let distribuido = partes.reduce((s, v) => s + v, 0);
  let restoGrupos = total - distribuido;

  // Ordem determinística: maior parte fracionária primeiro; empate por `idx`
  // (que segue a ordem dos grupos — permilagem desc, depois id).
  const ordem = exatos
    .map((e, i) => ({ i, frac: e.exato - Math.floor(e.exato) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));

  let k = 0;
  while (restoGrupos > 0 && ordem.length) {
    partes[ordem[k % ordem.length].i] += 1;
    restoGrupos -= 1;
    k += 1;
  }

  // 2) e 3) dentro de cada grupo: quinhão igual + resto para o residual.
  let residualC = 0;
  grupos_.forEach((g, i) => {
    const nMembros = (g.membros || []).length;
    if (nMembros === 0) {
      residualC += partes[i]; // grupo sem membros: nada a atribuir
      return;
    }
    const porMembro = Math.floor(partes[i] / nMembros);
    for (const id of g.membros) porFracao.set(id, porMembro);
    residualC += partes[i] - porMembro * nMembros;
  });

  return { porFracao, residualC, nGrupos: grupos_.length };
}

// Limite superior do residual de uma distribuição (I-08 revisto):
//   nGrupos                      → resto do arredondamento ENTRE grupos
//   Σ(nMembrosDoGrupo − 1)       → resto INTRA-grupo imposto por D3
//
// Exposto para que o teste e os consumidores possam assertar o limite sem o
// reimplementar (evita uma segunda fórmula, que é exatamente o defeito que a
// Fase A corrige).
function limiteResidual(grupos = []) {
  const nGrupos = (grupos || []).length;
  const intra = (grupos || []).reduce(
    (s, g) => s + Math.max(0, (g.membros ? g.membros.length : 0) - 1),
    0
  );
  return { entreGruposC: nGrupos, intraGruposC: intra, limiteC: nGrupos + intra };
}

// ── Componentes base/FCR (D1) ───────────────────────────────────────

// Divide um total (cêntimos) nas componentes usando D1:
//   fcrC  = round(totalC × pct / (100 + pct))    ← o FCR é parte do total
//   baseC = totalC − fcrC                        ← a base absorve a diferença
//
// Mantém-se a assinatura e a forma de retorno já usadas pelo resto do sistema
// (e injetada no browser em routes/financeiro.js), para compatibilidade.
function dividirComponentesQuota(totalC, fcrPercentagem = 0) {
  const total = Math.max(0, Math.round(Number(totalC) || 0));
  const percentagem = normalizarPercentagem(fcrPercentagem);
  const fcrC = percentagem > 0 ? Math.round((total * percentagem) / (100 + percentagem)) : 0;
  return { baseC: total - fcrC, fcrC, totalC: total, fcrPercentagem: percentagem };
}

// FCR teórico do conjunto, à escala do total (base do R2).
function fcrTeoricoC(totalTeoricoC, fcrPercentagem = 0) {
  const total = Math.max(0, Math.round(Number(totalTeoricoC) || 0));
  const percentagem = normalizarPercentagem(fcrPercentagem);
  return percentagem > 0 ? Math.round((total * percentagem) / (100 + percentagem)) : 0;
}

// ── Cálculo completo (o único ponto de entrada) ─────────────────────

// Calcula as quotas de um período a partir de um total teórico.
//
// Parâmetros:
//   fracoes     [{ id, permilagem }]
//   fcrPercentagem
//   totalC         total teórico em cêntimos (modo receita OU preço já resolvido)
//   valorPor1000C  (opcional) valor por 1000‰ em cêntimos, para calcular E1
//   meses          nº de meses do período (default 1) — informativo no retorno
//
// Retorno:
//   {
//     porFracao: Map<id, { baseC, fcrC, totalC, base, fcr, total,
//                          permilagem, permilagemEscalada, fcrPercentagem }>,
//     totalTeoricoC, totalEmitidoC,
//     grupos: [{ chave, permilagem, membros }],
//     diferencaArredondamento: { totalC: R1, fcrC: R2, estruturalC: E1 },
//     totais: { baseC, fcrC, totalC }
//   }
function calcularDistribuicaoQuotas({ fracoes, fcrPercentagem = 0, totalC = 0, valorPor1000C = null, meses = 1 } = {}) {
  const listaFracoes = Array.isArray(fracoes) ? fracoes : [];
  const percentagem = normalizarPercentagem(fcrPercentagem);
  const totalTeorico = Math.max(0, Math.round(Number(totalC) || 0));

  const grupos = agruparPorPermilagem(listaFracoes);
  const { porFracao: valores, residualC, nGrupos } = distribuirPorGrupos(totalTeorico, grupos);

  const porFracao = new Map();
  let somaTotalC = 0;
  let somaBaseC = 0;
  let somaFcrC = 0;
  const escaladaPorId = new Map();

  for (const g of grupos) {
    for (const id of g.membros) escaladaPorId.set(id, g.permilagemEscalada);
  }

  for (const f of listaFracoes) {
    const id = f && f.id;
    const totalFracaoC = valores.get(id) || 0;
    const partes = dividirComponentesQuota(totalFracaoC, percentagem);
    const escalada = escaladaPorId.get(id) || 0;
    somaTotalC += partes.totalC;
    somaBaseC += partes.baseC;
    somaFcrC += partes.fcrC;
    porFracao.set(id, {
      baseC: partes.baseC,
      fcrC: partes.fcrC,
      totalC: partes.totalC,
      base: fromCents(partes.baseC),
      fcr: fromCents(partes.fcrC),
      total: fromCents(partes.totalC),
      permilagem: permilagemDeEscala(escalada),
      permilagemEscalada: escalada,
      fcrPercentagem: percentagem,
    });
  }

  // ── Residuais ──
  // R1 = totalTeórico − Σ totalC emitidos. Coincide com o `residualC` da
  // distribuição (o que sobra ao grupo não vai para nenhuma fração).
  const R1 = totalTeorico - somaTotalC;
  // R2 = FCR implícito no total teórico − Σ FCR emitidos. Independente de R1:
  // pode ser ≠ 0 mesmo com R1 = 0.
  const R2 = fcrTeoricoC(totalTeorico, percentagem) - somaFcrC;
  // E1 = diferença estrutural da permilagem (modo preço). Só se aplica quando o
  // chamador fornece o valor por 1000‰.
  const E1 = valorPor1000C === null || valorPor1000C === undefined
    ? null
    : totalTeorico - Math.max(0, Math.round(Number(valorPor1000C) || 0));

  return {
    porFracao,
    totalTeoricoC: totalTeorico,
    totalEmitidoC: somaTotalC,
    grupos,
    diferencaArredondamento: {
      totalC: R1,
      fcrC: R2,
      estruturalC: E1,
    },
    // O residual da distribuição é R1 por construção — exposto para conferência.
    residualDistribuicaoC: residualC,
    nGrupos,
    meses: Number(meses) > 0 ? Number(meses) : 1,
    totais: { baseC: somaBaseC, fcrC: somaFcrC, totalC: somaTotalC },
  };
}

// ── Total teórico (modo preço, D4) ──────────────────────────────────

// Total teórico de um conjunto de frações, dado o valor por 1000‰.
//   totalTeóricoC = round(valorPor1000C × Σ permilagem / 1000)
// Quando Σ permilagem ≠ 1000‰, o resultado difere de `valorPor1000C` — essa
// diferença é E1 (estrutural), não um residual de arredondamento.
//
// A soma das permilagens é feita na escala da coluna (inteiros), pelo que o
// desvio é exato — sem acumulação de erro de `float`.
function totalTeoricoDoModoPreco(fracoes, valorPor1000C) {
  const v = Math.max(0, Math.round(Number(valorPor1000C) || 0));
  const somaEscalas = (fracoes || []).reduce((s, f) => s + permilagemEscalada(f && f.permilagem), 0);
  if (somaEscalas <= 0) return 0;
  // Σ escalada está em permilagem×100; o denominador é 1000×100.
  return Math.round((v * somaEscalas) / (1000 * ESCALA_PERMILAGEM));
}

// ── Conversão do retorno para estruturas simples (compatibilidade) ──

// Map<fracaoId, valor> no formato dos motores antigos, para os consumidores que
// ainda esperam `valorPor1000` e `permilagem` na raiz do objeto (C3).
function comoMapaCompativel(resultado) {
  const mapa = new Map();
  const vp1000 = resultado.valorPor1000C === undefined ? null : resultado.valorPor1000C;
  for (const [id, v] of resultado.porFracao) {
    mapa.set(id, {
      ...v,
      valorPor1000: vp1000 === null ? null : fromCents(vp1000),
      permilagem: v.permilagem,
      fcrPercentagem: v.fcrPercentagem,
    });
  }
  return mapa;
}

module.exports = {
  // primitiva
  agruparPorPermilagem,
  distribuirPorGrupos,
  limiteResidual,
  calcularDistribuicaoQuotas,
  totalTeoricoDoModoPreco,
  comoMapaCompativel,
  // componentes e auxiliares
  dividirComponentesQuota,
  fcrTeoricoC,
  permilagemEscalada,
  permilagemDeEscala,
  normalizarPercentagem,
  // constantes
  CASAS_PERMILAGEM,
  ESCALA_PERMILAGEM,
};
