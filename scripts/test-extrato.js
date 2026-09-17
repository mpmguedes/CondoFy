// ═══════════════════════════════════════════════════════════════════
// Fase 2.1B — Extrato bancário.
//
// Testes offline (sem base de dados nem rede) do que esta fase garante:
//
//  · CONSULTA — o extrato de A só devolve movimentos de A (e vice-versa);
//    os filtros por conta, período e tipo funcionam; uma transferência é
//    classificada corretamente nas DUAS convenções (referencia 'TRANSF' e
//    o ENUM legado 'transferencia'); um movimento anulado aparece como
//    anulado e não altera o saldo;
//  · SALDO — saldo inicial + entradas − saídas; o saldo inicial conta UMA
//    vez (não é multiplicado); o saldo anterior ao período está correto; o
//    saldo de uma conta não contaminada o de outra; o saldo após cada
//    movimento é determinístico;
//  · ORIGENS — pagamento, despesa, quota extra, transferência e ajuste;
//  · SEGURANÇA / MULTI-TENANCY — acesso cruzado entre condomínios (consulta
//    de movimentos, de conta, e anulação) nunca é permitido, e nunca
//    produz 500;
//  · IMUTABILIDADE OPERACIONAL — um movimento com origem operacional não é
//    anulável/edítável no extrato.
//
// Utilização: node scripts/test-extrato.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
let nPassos = 0;

// Escrita direta no fd 1: a secção 7 monta um servidor Express com um motor de
// vistas que redireciona a saída, e sem isto as verificações da secção 6
// (que correm antes) ficariam contadas mas invisíveis no relatório.
function escrever(texto) {
  try {
    fs.writeSync(1, texto + '\n');
  } catch (e) {
    console.log(texto);
  }
}
function ok(descricao) {
  nPassos += 1;
  escrever('  ✓ ' + descricao);
}
function grupo(titulo) {
  escrever('');
  escrever('── ' + titulo + ' ' + '─'.repeat(Math.max(0, 58 - titulo.length)));
}

// ═══════════════════════════════════════════════════════════════════
// 1. CLASSIFICAÇÃO DE ORIGEM E DE TRANSFERÊNCIA (puro)
// ═══════════════════════════════════════════════════════════════════
grupo('1. Classificação de transferência e de origem');

const extrato = require(path.join(RAIZ, 'helpers', 'extrato'));

{
  // As DUAS convenções de transferência.
  assert.strictEqual(extrato.ehTransferencia({ referencia: 'TRANSF' }), true, 'referencia TRANSF');
  assert.strictEqual(extrato.ehTransferencia({ tipo: 'transferencia' }), true, 'ENUM transferencia legado');
  assert.strictEqual(extrato.ehTransferencia({ tipo: 'entrada', referencia: null }), false, 'entrada normal');
  assert.strictEqual(extrato.ehTransferencia({ tipo: 'saida', referencia: 'OUTRA' }), false, 'saida normal');
  assert.strictEqual(extrato.ehTransferencia(null), false, 'nulo não rebenta');
  ok('a transferência é reconhecida nas duas convenções (TRANSF e ENUM)');

  // Ordem de precedência: uma ponta de transferência FCR pode ter
  // deliberacao_id, mas a origem continua a ser transferência.
  assert.strictEqual(extrato.categoriaDe({ referencia: 'TRANSF', pagamento_id: null, despesa_id: null }), 'transferencia');
  ok('movimento TRANSF é classificado como transferência');

  // Cada origem operacional.
  assert.strictEqual(extrato.categoriaDe({ pagamento_id: 7 }), 'pagamento');
  assert.strictEqual(extrato.categoriaDe({ despesa_id: 9 }), 'despesa');
  assert.strictEqual(extrato.categoriaDe({ extra_quota_parcela_id: 3 }), 'quota_extra');
  assert.strictEqual(extrato.categoriaDe({}), 'ajuste');
  ok('pagamento / despesa / quota extra / ajuste são distinguidos');

  // Uma transferência NÃO é um órfão: é uma categoria própria, com etiqueta.
  assert.strictEqual(extrato.ETIQUETAS.transferencia, 'Transferência');
  assert.strictEqual(extrato.ETIQUETAS.ajuste, 'Ajuste manual');
  assert.notStrictEqual(extrato.ETIQUETAS.transferencia, extrato.ETIQUETAS.ajuste);
  ok('transferência e ajuste manual têm etiquetas distintas (nada de "órfão")');

  // Precedência: um movimento com pagamento e referencia TRANSF (não acontece
  // hoje, mas a ordem tem de ser determinística) é pagamento.
  assert.strictEqual(extrato.categoriaDe({ pagamento_id: 1, referencia: 'TRANSF' }), 'pagamento');
  ok('a precedência das origens é determinística');
}

// ═══════════════════════════════════════════════════════════════════
// 2. VALIDAÇÃO DOS FILTROS (puro)
// ═══════════════════════════════════════════════════════════════════
grupo('2. Validação dos filtros recebidos da query string');

{
  // O filtro de conta nunca aceita lixo: só inteiro positivo.
  assert.strictEqual(extrato.lerFiltros({ conta: '10' }).conta, 10);
  assert.strictEqual(extrato.lerFiltros({ conta: 'abc' }).conta, null, 'conta inválida → null');
  assert.strictEqual(extrato.lerFiltros({ conta: '-3' }).conta, null, 'conta negativa → null');
  assert.strictEqual(extrato.lerFiltros({ conta: '10 OR 1=1' }).conta, null, 'tentativa de injeção → null');
  assert.strictEqual(extrato.lerFiltros({}).conta, null, 'sem conta → todas');
  ok('o filtro de conta só aceita um id inteiro positivo');

  // Datas: só ISO válido; lixo é ignorado (não rebenta, não inventa).
  assert.strictEqual(extrato.lerFiltros({ inicio: '2026-07-01' }).inicio, '2026-07-01');
  assert.strictEqual(extrato.lerFiltros({ inicio: '01/07/2026' }).inicio, '', 'formato PT é ignorado');
  assert.strictEqual(extrato.lerFiltros({ inicio: '2026-13-99' }).inicio, '', 'data impossível é ignorada');
  ok('o filtro de período só aceita datas ISO válidas');

  // Período invertido é normalizado (início ≤ fim), como no Relatório.
  const invertido = extrato.lerFiltros({ inicio: '2026-12-31', fim: '2026-01-01' });
  assert.strictEqual(invertido.inicio, '2026-01-01', 'início passa a ser o menor');
  assert.strictEqual(invertido.fim, '2026-12-31', 'fim passa a ser o maior');
  ok('um período invertido é normalizado (início ≤ fim)');

  // Tipo: só os valores conhecidos.
  assert.strictEqual(extrato.lerFiltros({ tipo: 'entrada' }).tipo, 'entrada');
  assert.strictEqual(extrato.lerFiltros({ tipo: 'transferencia' }).tipo, 'transferencia');
  assert.strictEqual(extrato.lerFiltros({ tipo: 'lixo' }).tipo, '', 'tipo desconhecido é ignorado');
  ok('o filtro de tipo só aceita entrada / saida / transferencia');
}

// ═══════════════════════════════════════════════════════════════════
// 3. WHERE DOS MOVIMENTOS — ISOLAMENTO SEMPRE PRESENTE
// ═══════════════════════════════════════════════════════════════════
grupo('3. O where dos movimentos inclui sempre o condomínio');

{
  const w = extrato.construirWhere(7, {});
  assert.strictEqual(w.condominio_id, 7, 'o condomínio está sempre no where');
  ok('sem filtros, o where só tem o condomínio');

  const comConta = extrato.construirWhere(7, { conta: 3 });
  assert.strictEqual(comConta.condominio_id, 7, 'condomínio mantém-se com filtro de conta');
  assert.strictEqual(comConta.conta_bancaria_id, 3, 'a conta é acrescentada, não substitui');
  ok('o filtro de conta não substitui o isolamento');

  // O período usa operadores de intervalo (não igualdade).
  const periodo = extrato.construirWhere(7, { inicio: '2026-07-01', fim: '2026-07-31' });
  assert.ok(periodo.data, 'o período define data');
  assert.ok(periodo.condominio_id === 7, 'o isolamento mantém-se com período');
  ok('o filtro de período mantém o isolamento');

  // Tipo transferência: o where tem de abranger as DUAS convenções. Verifica-se
  // pelo COMPORTAMENTO (os dois movimentos têm de passar o filtro e um normal
  // não), e não pela forma interna do objeto — assim o teste não fica preso aos
  // símbolos do Sequelize.
  const transf = extrato.construirWhere(7, { tipo: 'transferencia' });
  assert.strictEqual(transf.condominio_id, 7, 'o isolamento mantém-se no filtro de transferências');

  // Recolhe as cláusulas do OR por símbolo, sem assumir a sua representação.
  const chaveOr = Object.getOwnPropertySymbols(transf).find((s) => Array.isArray(transf[s]));
  assert.ok(chaveOr, 'o filtro de transferências usa uma disjunção (OR) das duas convenções');
  const clausulas = transf[chaveOr];
  const casa = (mov) => clausulas.some((c) => Object.entries(c).every(([k, v]) => String(mov[k]) === String(v)));
  assert.strictEqual(casa({ referencia: 'TRANSF', tipo: 'saida' }), true, 'a convenção TRANSF passa');
  assert.strictEqual(casa({ tipo: 'transferencia' }), true, 'o ENUM legado passa');
  assert.strictEqual(casa({ referencia: 'OUTRA', tipo: 'entrada' }), false, 'um movimento normal não passa');
  ok('o filtro de transferência abrange TRANSF e o ENUM legado, sem perder o isolamento');
}

// ═══════════════════════════════════════════════════════════════════
// 4A. SALDO POR CONTA — o correctivo do modo "Todas as contas"
//     Cada linha tem o saldo da SUA conta; nunca um acumulado entre contas.
// ═══════════════════════════════════════════════════════════════════
grupo('4A. Saldo corrente independente por conta (filtro "todas as contas")');

{
  // Movimentos INTERCALADOS de duas contas. Conta 1: 1000,00. Conta 2: 200,00.
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-02', tipo: 'entrada', valor: '100.00', estado: 'confirmado' },
    { id: 2, conta_bancaria_id: 2, data: '2026-07-03', tipo: 'entrada', valor: '25.00', estado: 'confirmado' },
    { id: 3, conta_bancaria_id: 1, data: '2026-07-10', tipo: 'saida', valor: '40.00', estado: 'confirmado' },
    { id: 4, conta_bancaria_id: 2, data: '2026-07-12', tipo: 'saida', valor: '5.00', estado: 'confirmado' },
  ];
  const iniciais = new Map([[1, 100000], [2, 20000]]);
  const r = extrato.calcularSaldos({ conta: null, movimentos: movs, saldosIniciaisPorConta: iniciais });

  // Conta 1: 1000 → 1100 → 1060
  assert.strictEqual(r.saldoPorId.get(1), 110000, 'conta 1 após +100,00: 1100,00');
  assert.strictEqual(r.saldoPorId.get(3), 106000, 'conta 1 após −40,00: 1060,00');
  // Conta 2: 200 → 225 → 220
  assert.strictEqual(r.saldoPorId.get(2), 22500, 'conta 2 após +25,00: 225,00 (NÃO 1325,00)');
  assert.strictEqual(r.saldoPorId.get(4), 22000, 'conta 2 após −5,00: 220,00');
  ok('cada linha tem o saldo da respetiva conta (movimentos intercalados)');

  // Prova da não-acumulação cruzada: a linha da conta 2 NÃO soma o saldo da
  // conta 1. Com um acumulador único, a linha 2 daria 1000+100+25 = 1125,00.
  assert.notStrictEqual(r.saldoPorId.get(2), 112500, 'o saldo da conta 2 não acumula o da conta 1');
  assert.strictEqual(r.saldoPorId.get(2), 22500);
  ok('os saldos não são acumulados entre contas');

  // O TOTAL agregado mantém-se: 1060,00 + 220,00 = 1280,00.
  assert.strictEqual(r.saldoFinalC, 128000, 'saldo final agregado = 1060,00 + 220,00');
  ok('o total agregado continua a somar as duas contas');

  // Coerência com o filtro de conta única: os números por linha são os mesmos
  // que o utilizador veria ao filtrar por essa conta.
  const soConta1 = extrato.calcularSaldos({
    conta: { id: 1 },
    movimentos: movs.filter((m) => m.conta_bancaria_id === 1),
    saldosIniciaisPorConta: new Map([[1, 100000]]),
  });
  assert.strictEqual(soConta1.saldoPorId.get(1), r.saldoPorId.get(1), 'conta 1: mesmo saldo com ou sem filtro');
  assert.strictEqual(soConta1.saldoPorId.get(3), r.saldoPorId.get(3), 'conta 1: mesmo saldo na 2.ª linha');
  ok('o saldo por linha é igual com o filtro de uma conta ou com "todas as contas"');
}

{
  // Duas contas com movimentos no MESMO DIA: o saldo de cada linha continua a
  // ser exclusivamente o da sua conta (não se somam por partilharem a data).
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-05', tipo: 'entrada', valor: '500.00', estado: 'confirmado' },
    { id: 2, conta_bancaria_id: 2, data: '2026-07-05', tipo: 'saida', valor: '400.00', estado: 'confirmado' },
  ];
  const iniciais = new Map([[1, 100000], [2, 20000]]);
  const r = extrato.calcularSaldos({ conta: null, movimentos: movs, saldosIniciaisPorConta: iniciais });
  assert.strictEqual(r.saldoPorId.get(1), 150000, 'conta 1 no mesmo dia: 1000,00 + 500,00 = 1500,00');
  assert.strictEqual(r.saldoPorId.get(2), -20000, 'conta 2 no mesmo dia: 200,00 − 400,00 = −200,00');
  // Com acumulador único, a linha 1 daria 1000+200+500 = 1700,00.
  assert.notStrictEqual(r.saldoPorId.get(1), 170000, 'não soma a outra conta só por ser o mesmo dia');
  ok('movimentos de contas diferentes no mesmo dia mantêm saldos independentes');
}

{
  // Saldo anterior POR CONTA: a base do acumulador de cada conta é o seu saldo
  // à data de corte, não o inicial nem o de outra conta.
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-10', tipo: 'entrada', valor: '10.00', estado: 'confirmado' },
    { id: 2, conta_bancaria_id: 2, data: '2026-07-10', tipo: 'entrada', valor: '5.00', estado: 'confirmado' },
  ];
  const r = extrato.calcularSaldos({
    conta: null,
    movimentos: movs,
    saldosIniciaisPorConta: new Map([[1, 100000], [2, 20000]]),
    saldosAnterioresPorConta: new Map([[1, 130000], [2, 22000]]),
  });
  assert.strictEqual(r.saldoPorId.get(1), 131000, 'conta 1 parte do seu anterior 1300,00 → 1310,00');
  assert.strictEqual(r.saldoPorId.get(2), 22500, 'conta 2 parte do seu anterior 220,00 → 225,00');
  assert.strictEqual(r.saldoFinalC, 153500, 'total = 1310,00 + 225,00 = 1535,00');
  ok('o saldo anterior é aplicado por conta, na base certa de cada acumulador');
}

{
  // Conta sem movimentos no período: entra no total pelo seu saldo (anterior ou
  // inicial), para o total do extrato continuar a ser o total das contas.
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-10', tipo: 'entrada', valor: '10.00', estado: 'confirmado' },
  ];
  const r = extrato.calcularSaldos({
    conta: null,
    movimentos: movs,
    saldosIniciaisPorConta: new Map([[1, 100000], [2, 20000]]),
    saldosAnterioresPorConta: new Map([[1, 130000], [2, 25000]]),
  });
  assert.strictEqual(r.saldoFinalC, 156000, 'conta 1 (1310,00) + conta 2 sem movimentos (250,00) = 1560,00');
  ok('uma conta sem movimentos no período conta para o total pelo seu próprio saldo');
}

{
  // Anulado: continua a aparecer e a não alterar o saldo da SUA conta.
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-02', tipo: 'entrada', valor: '100.00', estado: 'confirmado' },
    { id: 2, conta_bancaria_id: 1, data: '2026-07-03', tipo: 'saida', valor: '999.00', estado: 'anulado' },
    { id: 3, conta_bancaria_id: 2, data: '2026-07-04', tipo: 'entrada', valor: '7.00', estado: 'confirmado' },
  ];
  const r = extrato.calcularSaldos({
    conta: null,
    movimentos: movs,
    saldosIniciaisPorConta: new Map([[1, 100000], [2, 20000]]),
  });
  assert.strictEqual(r.saldoPorId.get(2), 110000, 'o anulado mostra o saldo em vigor da conta 1');
  assert.strictEqual(r.saldoPorId.get(3), 20700, 'a conta 2 não foi afetada pelo anulado da conta 1 (200,00 + 7,00)');
  assert.strictEqual(r.nAnulados, 1);
  assert.strictEqual(r.saldoFinalC, 130700, 'total = 1100,00 + 207,00 (anulado neutro)');
  ok('um anulado não afeta o saldo da sua conta nem o das outras');
}

{
  // Conta única continua a comportar-se como antes (retrocompatibilidade).
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-01', tipo: 'entrada', valor: '100.00', estado: 'confirmado' },
    { id: 2, conta_bancaria_id: 1, data: '2026-07-05', tipo: 'saida', valor: '30.00', estado: 'confirmado' },
  ];
  const r = extrato.calcularSaldos({
    conta: { id: 1 },
    movimentos: movs,
    saldoAnteriorC: 5000,
    saldosIniciaisPorConta: new Map([[1, 100000]]),
    saldosAnterioresPorConta: new Map([[1, 5000]]),
  });
  assert.strictEqual(r.saldoPorId.get(1), 15000, 'conta única: 50,00 + 100,00');
  assert.strictEqual(r.saldoPorId.get(2), 12000, 'conta única: 150,00 − 30,00');
  assert.strictEqual(r.saldoFinalC, 12000);
  ok('com uma só conta o comportamento mantém-se (retrocompatível)');
}

// ═══════════════════════════════════════════════════════════════════
// 4B. EMPARELHAMENTO DE TRANSFERÊNCIAS («De → Para»)
// ═══════════════════════════════════════════════════════════════════
grupo('4B. Emparelhamento das transferências (De → Para)');

{
  // Par determinável: saída numa conta, entrada noutra, mesmo valor e data.
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-05', tipo: 'saida', valor: '25.00', referencia: 'TRANSF', estado: 'confirmado' },
    { id: 2, conta_bancaria_id: 2, data: '2026-07-05', tipo: 'entrada', valor: '25.00', referencia: 'TRANSF', estado: 'confirmado' },
  ];
  const { pares, porId } = extrato.emparelharTransferencias(movs);
  assert.strictEqual(pares.length, 1, 'um par identificado');
  assert.strictEqual(pares[0].deId, 1, 'a origem é a conta da saída');
  assert.strictEqual(pares[0].paraId, 2, 'o destino é a conta da entrada');
  assert.deepStrictEqual([...porId.keys()].sort((a, b) => a - b), [1, 2], 'as duas pontas ficam mapeadas');
  ok('um par determinável expõe origem e destino');
}

{
  // Sem par: a transferência existe mas não é emparelhável.
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-05', tipo: 'entrada', valor: '25.00', referencia: 'TRANSF', estado: 'confirmado' },
  ];
  const { pares, porId } = extrato.emparelharTransferencias(movs);
  assert.strictEqual(pares.length, 0, 'sem par não há origem/destino');
  assert.strictEqual(porId.size, 0, 'nada é mapeado');
  ok('uma transferência sem par determinável fica sem origem/destino');
}

{
  // Valores diferentes: NÃO são o mesmo par (o critério exige valor igual).
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-05', tipo: 'saida', valor: '25.00', referencia: 'TRANSF', estado: 'confirmado' },
    { id: 2, conta_bancaria_id: 2, data: '2026-07-05', tipo: 'entrada', valor: '30.00', referencia: 'TRANSF', estado: 'confirmado' },
  ];
  assert.strictEqual(extrato.emparelharTransferencias(movs).pares.length, 0, 'valores diferentes não emparelham');
  ok('valores diferentes não são emparelhados');
}

{
  // Datas diferentes: também não emparelham.
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-05', tipo: 'saida', valor: '25.00', referencia: 'TRANSF', estado: 'confirmado' },
    { id: 2, conta_bancaria_id: 2, data: '2026-07-06', tipo: 'entrada', valor: '25.00', referencia: 'TRANSF', estado: 'confirmado' },
  ];
  assert.strictEqual(extrato.emparelharTransferencias(movs).pares.length, 0, 'datas diferentes não emparelham');
  ok('datas diferentes não são emparelhadas');
}

{
  // Uma saída só serve UM par: duas entradas não podem consumir a mesma saída.
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-05', tipo: 'saida', valor: '25.00', referencia: 'TRANSF', estado: 'confirmado' },
    { id: 2, conta_bancaria_id: 2, data: '2026-07-05', tipo: 'entrada', valor: '25.00', referencia: 'TRANSF', estado: 'confirmado' },
    { id: 3, conta_bancaria_id: 3, data: '2026-07-05', tipo: 'entrada', valor: '25.00', referencia: 'TRANSF', estado: 'confirmado' },
  ];
  assert.strictEqual(extrato.emparelharTransferencias(movs).pares.length, 1, 'uma saída emparelha com uma só entrada');
  ok('uma saída nunca é consumida por dois pares');
}

{
  // Um anulado não entra no emparelhamento (não é dinheiro em movimento).
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-05', tipo: 'saida', valor: '25.00', referencia: 'TRANSF', estado: 'anulado' },
    { id: 2, conta_bancaria_id: 2, data: '2026-07-05', tipo: 'entrada', valor: '25.00', referencia: 'TRANSF', estado: 'confirmado' },
  ];
  assert.strictEqual(extrato.emparelharTransferencias(movs).pares.length, 0, 'um anulado não emparelha');
  ok('uma ponta anulada não produz par');
}

{
  // Isolamento: o emparelhamento só vê o que recebe. Movimentos de outro
  // condomínio nunca chegam aqui porque `listarMovimentos` os exclui — a
  // função é pura e não consulta nada por si.
  const soDoCondominioA = [
    { id: 1, condominio_id: 1, conta_bancaria_id: 1, data: '2026-07-05', tipo: 'saida', valor: '25.00', referencia: 'TRANSF', estado: 'confirmado' },
    { id: 2, condominio_id: 1, conta_bancaria_id: 2, data: '2026-07-05', tipo: 'entrada', valor: '25.00', referencia: 'TRANSF', estado: 'confirmado' },
  ];
  const r = extrato.emparelharTransferencias(soDoCondominioA);
  assert.strictEqual(r.pares.length, 1, 'emparelha dentro do mesmo condomínio');
  assert.ok(r.pares.every((p) => [1, 2].includes(p.saidaId) && [1, 2].includes(p.entradaId)), 'só ids recebidos');
  ok('o emparelhamento não pode juntar pontas de condomínios diferentes');
}

{
  // `anotarTransferencias` preenche os nomes quando o par existe e deixa
  // `transferenciaTemPar` a false quando não existe.
  const linhas = [
    { id: 1, contaId: 1, tipo: 'saida', valorC: 2500, data: '2026-07-05', referencia: 'TRANSF', estado: 'confirmado', transferencia: true },
    { id: 2, contaId: 2, tipo: 'entrada', valorC: 2500, data: '2026-07-05', referencia: 'TRANSF', estado: 'confirmado', transferencia: true },
    { id: 3, contaId: 1, tipo: 'entrada', valorC: 900, data: '2026-07-09', referencia: 'TRANSF', estado: 'confirmado', transferencia: true },
  ];
  extrato.anotarTransferencias(linhas, new Map([[1, 'CA Ordem'], [2, 'CA FCR']]));
  assert.strictEqual(linhas[0].transferenciaDe, 'CA Ordem');
  assert.strictEqual(linhas[0].transferenciaPara, 'CA FCR');
  assert.strictEqual(linhas[0].transferenciaTemPar, true);
  assert.strictEqual(linhas[1].transferenciaDe, 'CA Ordem', 'a ponta de entrada tem a mesma origem');
  assert.strictEqual(linhas[1].transferenciaPara, 'CA FCR');
  assert.strictEqual(linhas[2].transferenciaTemPar, false, 'sem par fica sem origem/destino');
  assert.strictEqual(linhas[2].transferenciaDe, null);
  ok('a anotação preenche «De → Para» só quando o par existe');
}

// ═══════════════════════════════════════════════════════════════════
// 4. SALDO CORRENTE (puro)
// ═══════════════════════════════════════════════════════════════════
grupo('4. Saldo corrente por movimento');

{
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-01', tipo: 'entrada', valor: '100.00', estado: 'confirmado' },
    { id: 2, conta_bancaria_id: 1, data: '2026-07-05', tipo: 'saida', valor: '30.00', estado: 'confirmado' },
    { id: 3, conta_bancaria_id: 1, data: '2026-07-10', tipo: 'entrada', valor: '20.00', estado: 'confirmado' },
  ];
  const conta = { id: 1 };
  const r = extrato.calcularSaldos({ conta, movimentos: movs, saldoAnteriorC: 5000, saldosIniciaisPorConta: new Map([[1, 5000]]) });
  assert.strictEqual(r.saldoPorId.get(1), 15000, 'após a 1.ª entrada: 50,00 + 100,00 = 150,00');
  assert.strictEqual(r.saldoPorId.get(2), 12000, 'após a saída: 150,00 − 30,00 = 120,00');
  assert.strictEqual(r.saldoPorId.get(3), 14000, 'após a 2.ª entrada: 120,00 + 20,00 = 140,00');
  assert.strictEqual(r.saldoFinalC, 14000);
  assert.strictEqual(r.entradasC, 12000, 'entradas = 100,00 + 20,00');
  assert.strictEqual(r.saidasC, 3000, 'saídas = 30,00');
  ok('saldo inicial + entradas − saídas, linha a linha');

  // O saldo inicial entra UMA vez: o resultado não depende do nº de movimentos.
  // (Se entrasse por movimento, o saldo cresceria com o nº de linhas.)
  const umMov = extrato.calcularSaldos({ conta, movimentos: [movs[0]], saldoAnteriorC: 5000, saldosIniciaisPorConta: new Map([[1, 5000]]) });
  const tresMov = extrato.calcularSaldos({ conta, movimentos: movs, saldoAnteriorC: 5000, saldosIniciaisPorConta: new Map([[1, 5000]]) });
  assert.strictEqual(umMov.saldoPorId.get(1), 15000, 'com 1 movimento, o inicial não duplica');
  assert.strictEqual(tresMov.saldoPorId.get(1), 15000, 'com 3 movimentos, o inicial é o mesmo');
  // Com o inicial multiplicado, o 1.º movimento daria 5000×3 + 10000 = 25000.
  assert.notStrictEqual(tresMov.saldoPorId.get(1), 5000 * 3 + 10000, 'o inicial não é multiplicado pelas linhas');
  ok('o saldo inicial é contado UMA única vez (não multiplica)');
}

{
  // Movimento anulado: aparece, não altera o saldo, e o saldo da linha é o
  // mesmo do movimento confirmado anterior. (Conta única — caminho legado.)
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-01', tipo: 'entrada', valor: '100.00', estado: 'confirmado' },
    { id: 2, conta_bancaria_id: 1, data: '2026-07-05', tipo: 'saida', valor: '999.00', estado: 'anulado' },
    { id: 3, conta_bancaria_id: 1, data: '2026-07-10', tipo: 'entrada', valor: '20.00', estado: 'confirmado' },
  ];
  const r = extrato.calcularSaldos({
    conta: { id: 1 },
    movimentos: movs,
    saldoAnteriorC: 1000,
    saldosIniciaisPorConta: new Map([[1, 1000]]),
  });
  assert.strictEqual(r.saldoPorId.get(2), 11000, 'o anulado mostra o saldo em vigor (100,00 + 10,00)');
  assert.strictEqual(r.saldoPorId.get(3), 13000, 'o anulado não subtraiu 999,00');
  assert.strictEqual(r.saldoFinalC, 13000, 'o saldo final ignora o anulado');
  assert.strictEqual(r.saidasC, 0, 'a saída anulada não conta para as saídas');
  assert.strictEqual(r.nAnulados, 1, 'o anulado é contabilizado como anulado');
  ok('um movimento anulado aparece mas NÃO altera o saldo');
}

{
  // ENUM 'transferencia' tem efeito nulo no saldo (linha legada).
  const movs = [
    { id: 1, conta_bancaria_id: 1, data: '2026-07-01', tipo: 'transferencia', valor: '50.00', estado: 'confirmado' },
  ];
  const r = extrato.calcularSaldos({
    conta: { id: 1 },
    movimentos: movs,
    saldoAnteriorC: 7000,
    saldosIniciaisPorConta: new Map([[1, 7000]]),
  });
  assert.strictEqual(r.saldoPorId.get(1), 7000, 'a transferência legada não altera o saldo');
  assert.strictEqual(r.saldoFinalC, 7000);
  ok('o ENUM legado "transferencia" é neutro para o saldo');
}

// ═══════════════════════════════════════════════════════════════════
// 5. DATA ANTERIOR (aritmética de calendário)
// ═══════════════════════════════════════════════════════════════════
grupo('5. Cálculo do dia anterior');

{
  assert.strictEqual(extrato.dataAnterior('2026-07-01'), '2026-06-30', 'viragem de mês');
  assert.strictEqual(extrato.dataAnterior('2026-01-01'), '2025-12-31', 'viragem de ano');
  assert.strictEqual(extrato.dataAnterior('2026-03-01'), '2026-02-28', 'fim de fevereiro (não bissexto)');
  assert.strictEqual(extrato.dataAnterior('2024-03-01'), '2024-02-29', 'ano bissexto');
  assert.strictEqual(extrato.dataAnterior('2026-07-15'), '2026-07-14', 'dia comum (sem derivar de fuso)');
  ok('o dia anterior ao início do período é correto (mês, ano, bissexto)');
}

// ═══════════════════════════════════════════════════════════════════
// 6. CONSULTA END-TO-END COM MODELOS EM MEMÓRIA
//    Mocka `models` (ContaBancaria, MovimentoBancario) para exercitar o
//    helper inteiro — filtros, isolamento e saldo — sem base de dados.
// ═══════════════════════════════════════════════════════════════════
grupo('6. Consulta do extrato com modelos em memória');

const modelosPath = require.resolve(path.join(RAIZ, 'models'));
const extratoPath = require.resolve(path.join(RAIZ, 'helpers', 'extrato'));

// "Base de dados" em memória.
const db = { contas: [], movimentos: [] };

function onde(linhas, where) {
  if (!where) return linhas;
  return linhas.filter((l) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const syms = Object.getOwnPropertySymbols(v).map(String);
      if (syms.some((s) => s === 'Symbol(gte)')) {
        const op = v[Object.getOwnPropertySymbols(v).find((s) => String(s) === 'Symbol(gte)')];
        if (String(l[k]) < String(op)) return false;
      }
      if (syms.some((s) => s === 'Symbol(lte)')) {
        const op = v[Object.getOwnPropertySymbols(v).find((s) => String(s) === 'Symbol(lte)')];
        if (String(l[k]) > String(op)) return false;
      }
      if (syms.some((s) => s === 'Symbol(ne)')) {
        const op = v[Object.getOwnPropertySymbols(v).find((s) => String(s) === 'Symbol(ne)')];
        if (String(l[k]) === String(op)) return false;
      }
      if (syms.length === 0) return Object.entries(v).every(([kk, vv]) => String(l[kk]) === String(vv));
      return true;
    }
    return String(l[k]) === String(v);
  }));
}

// `Op.or` é um array de cláusulas: satisfazer UMA chega.
function aplicarWhere(linhas, where) {
  const orKey = Object.getOwnPropertySymbols(where || {}).find((s) => String(s) === 'Symbol(or)');
  if (orKey) {
    const clausulas = where[orKey];
    const resto = { ...where };
    delete resto[orKey];
    const base = onde(linhas, resto);
    return base.filter((l) => clausulas.some((c) => onde([l], c).length === 1));
  }
  return onde(linhas, where);
}

const modelosMock = {
  ContaBancaria: {
    findOne: async ({ where }) => {
      const r = aplicarWhere(db.contas, where);
      return r.length ? r[0] : null;
    },
    findAll: async ({ where, order }) => {
      let r = aplicarWhere(db.contas, where);
      if (order) r = r.slice().sort((a, b) => (a.nome > b.nome ? 1 : -1));
      return r;
    },
  },
  MovimentoBancario: {
    findAll: async ({ where, order }) => {
      let r = aplicarWhere(db.movimentos, where);
      // Ordem cronológica (data, id) — como no helper real.
      r = r.slice().sort((a, b) => String(a.data).localeCompare(String(b.data)) || a.id - b.id);
      return r.map((m) => ({ ...m, toJSON: () => ({ ...m }) }));
    },
    findOne: async ({ where }) => {
      const r = aplicarWhere(db.movimentos, where);
      return r.length ? { ...r[0], update: async (v) => Object.assign(r[0], v) } : null;
    },
  },
};

require.cache[modelosPath] = {
  id: modelosPath,
  filename: modelosPath,
  loaded: true,
  children: [],
  paths: [],
  exports: modelosMock,
};
delete require.cache[extratoPath];
// eslint-disable-next-line global-require
const extratoMockado = require(extratoPath);

function semear() {
  db.contas = [
    { id: 1, condominio_id: 1, nome: 'CA Ordem A', saldo_inicial: '1000.00', ativa: true, tipo: 'corrente' },
    { id: 2, condominio_id: 1, nome: 'CA FCR A', saldo_inicial: '200.00', ativa: true, tipo: 'fundo_reserva' },
    { id: 3, condominio_id: 2, nome: 'CA Ordem B', saldo_inicial: '5000.00', ativa: true, tipo: 'corrente' },
  ];
  db.movimentos = [
    // Condomínio 1
    { id: 1, condominio_id: 1, conta_bancaria_id: 1, data: '2026-06-15', tipo: 'entrada', valor: '300.00', estado: 'confirmado', pagamento_id: 11 },
    { id: 2, condominio_id: 1, conta_bancaria_id: 1, data: '2026-07-02', tipo: 'entrada', valor: '100.00', estado: 'confirmado', pagamento_id: 12 },
    { id: 3, condominio_id: 1, conta_bancaria_id: 1, data: '2026-07-10', tipo: 'saida', valor: '40.00', estado: 'confirmado', despesa_id: 21 },
    { id: 4, condominio_id: 1, conta_bancaria_id: 1, data: '2026-07-20', tipo: 'saida', valor: '10.00', estado: 'anulado', despesa_id: 22 },
    { id: 5, condominio_id: 1, conta_bancaria_id: 1, data: '2026-07-25', tipo: 'saida', valor: '25.00', referencia: 'TRANSF', estado: 'confirmado' },
    { id: 6, condominio_id: 1, conta_bancaria_id: 2, data: '2026-07-25', tipo: 'entrada', valor: '25.00', referencia: 'TRANSF', estado: 'confirmado' },
    { id: 7, condominio_id: 1, conta_bancaria_id: 2, data: '2026-07-28', tipo: 'entrada', valor: '15.00', estado: 'confirmado', extra_quota_parcela_id: 31 },
    { id: 8, condominio_id: 1, conta_bancaria_id: 1, data: '2026-07-29', tipo: 'entrada', valor: '5.00', estado: 'confirmado' },
    // Condomínio 2 (nunca pode aparecer no extrato do 1)
    { id: 9, condominio_id: 2, conta_bancaria_id: 3, data: '2026-07-03', tipo: 'entrada', valor: '777.00', estado: 'confirmado', pagamento_id: 99 },
    { id: 10, condominio_id: 2, conta_bancaria_id: 3, data: '2026-07-04', tipo: 'saida', valor: '111.00', estado: 'confirmado' },
  ];
}

// Grupo 6 como função — tem de ser AGUARDADO antes da secção 7, senão as
// suas verificações correriam fora de ordem e uma falha aqui passaria
// despercebida (o IIFE solto não é awaited por ninguém).
async function grupo6() {
  // ── 6.1 Isolamento: A só vê A ────────────────────────────────────
  semear();
  const e1 = await extratoMockado.extrato({ condominioId: 1, filtros: { inicio: '2026-07-01', fim: '2026-07-31' } });
  const ids1 = e1.linhas.map((l) => l.id).sort((a, b) => a - b);
  assert.deepStrictEqual(ids1, [2, 3, 4, 5, 6, 7, 8], 'o extrato de A devolve só os movimentos de A');
  assert.ok(!ids1.includes(9) && !ids1.includes(10), 'nenhum movimento de B aparece');
  assert.ok(e1.linhas.every((l) => l.contaId === 1 || l.contaId === 2), 'só contas de A');
  ok('o extrato do condomínio A só devolve movimentos de A');

  const e2 = await extratoMockado.extrato({ condominioId: 2, filtros: { inicio: '2026-07-01', fim: '2026-07-31' } });
  const ids2 = e2.linhas.map((l) => l.id).sort((a, b) => a - b);
  assert.deepStrictEqual(ids2, [9, 10], 'o extrato de B devolve só os movimentos de B');
  ok('o extrato do condomínio B só devolve movimentos de B');

  // ── 6.2 Filtro por conta ─────────────────────────────────────────
  semear();
  const eConta1 = await extratoMockado.extrato({ condominioId: 1, filtros: { conta: 1, inicio: '2026-07-01', fim: '2026-07-31' } });
  assert.ok(eConta1.linhas.every((l) => l.contaId === 1), 'o filtro por conta devolve só essa conta');
  assert.ok(!eConta1.linhas.some((l) => l.id === 6 || l.id === 7), 'movimentos da outra conta ficam fora');
  ok('o filtro por conta funciona');

  // Uma conta de OUTRO condomínio não devolve nada (e não rebenta).
  const eContaAlheia = await extratoMockado.extrato({ condominioId: 1, filtros: { conta: 3 } });
  assert.strictEqual(eContaAlheia.conta, null, 'conta de outro condomínio → não encontrada');
  assert.strictEqual(eContaAlheia.linhas.length, 0, 'sem movimentos');
  ok('uma conta de outro condomínio é tratada como inexistente (nunca 500)');

  // ── 6.3 Filtro por período + saldo anterior ──────────────────────
  semear();
  const eJulho = await extratoMockado.extrato({ condominioId: 1, filtros: { conta: 1, inicio: '2026-07-01', fim: '2026-07-31' } });
  // Conta 1: inicial 1000,00 + movimento de junho (300,00) = 1300,00 antes de julho.
  assert.strictEqual(eJulho.resumo.saldoAnteriorC, 130000, 'saldo anterior a julho = 1000,00 + 300,00');
  assert.strictEqual(eJulho.linhas.length, 5, 'os 5 movimentos de julho da conta 1');
  const priJulho = eJulho.linhas.find((l) => l.id === 2);
  assert.strictEqual(priJulho.saldoC, 140000, 'o 1.º movimento de julho NÃO começa em zero (1300,00 + 100,00)');
  assert.strictEqual(priJulho.saldoC, 140000, 'saldo anterior + entrada');
  ok('o saldo anterior ao período é calculado com os movimentos anteriores');

  // Conta 2: inicial 200,00, sem movimentos antes de julho.
  const eConta2 = await extratoMockado.extrato({ condominioId: 1, filtros: { conta: 2, inicio: '2026-07-01', fim: '2026-07-31' } });
  assert.strictEqual(eConta2.resumo.saldoAnteriorC, 20000, 'saldo anterior da conta 2 = só o inicial');
  ok('cada conta tem o seu próprio saldo anterior');

  // Saldos das duas contas não se contaminam.
  assert.notStrictEqual(eJulho.resumo.saldoAnteriorC, eConta2.resumo.saldoAnteriorC, 'os saldos das contas são independentes');
  assert.strictEqual(eJulho.resumo.saldoAnteriorC, 130000);
  assert.strictEqual(eConta2.resumo.saldoAnteriorC, 20000);
  ok('o saldo de uma conta não contamina o da outra');

  // ── 6.4 Saldo: anulado não conta, saldo final correto ────────────
  semear();
  // Conta 1, julho: +100 (id 2), −40 (id 3), −10 anulado (id 4), −25 TRANSF (id 5), +5 (id 8)
  // saldoAnterior 1300,00 → 1300 + 100 − 40 − 25 + 5 = 1340,00
  assert.strictEqual(eJulho.resumo.entradasC, 10500, 'entradas = 100,00 + 5,00');
  assert.strictEqual(eJulho.resumo.saidasC, 6500, 'saídas = 40,00 + 25,00 (a anulada não conta)');
  assert.strictEqual(eJulho.resumo.saldoFinalC, 134000, 'saldo final = 1300,00 + 105,00 − 65,00');
  assert.strictEqual(eJulho.resumo.nAnulados, 1, 'um movimento anulado');
  const anulado = eJulho.linhas.find((l) => l.id === 4);
  assert.strictEqual(anulado.anulado, true, 'o anulado está marcado como anulado');
  assert.strictEqual(anulado.saldoC, 136000, 'o anulado mostra o saldo em vigor, não o altera');
  ok('o movimento anulado aparece identificado e não altera o saldo');

  // ── 6.5 Filtro por tipo ──────────────────────────────────────────
  semear();
  const soEntradas = await extratoMockado.extrato({ condominioId: 1, filtros: { tipo: 'entrada', inicio: '2026-07-01', fim: '2026-07-31' } });
  assert.ok(soEntradas.linhas.every((l) => l.tipo === 'entrada' && !l.transferencia), 'só entradas puras');
  assert.ok(!soEntradas.linhas.some((l) => l.id === 2 && l.transferencia), 'a ponta de transferência fica fora de "Entradas"');
  ok('o filtro "Entradas" exclui transferências');

  const soSaidas = await extratoMockado.extrato({ condominioId: 1, filtros: { tipo: 'saida', inicio: '2026-07-01', fim: '2026-07-31' } });
  assert.ok(!soSaidas.linhas.some((l) => l.id === 5), 'a saída de transferência fica fora de "Saídas"');
  assert.ok(soSaidas.linhas.some((l) => l.id === 3), 'a despesa continua em "Saídas"');
  ok('o filtro "Saídas" exclui transferências');

  const soTransf = await extratoMockado.extrato({ condominioId: 1, filtros: { tipo: 'transferencia', inicio: '2026-07-01', fim: '2026-07-31' } });
  assert.deepStrictEqual(soTransf.linhas.map((l) => l.id).sort((a, b) => a - b), [5, 6], 'as duas pontas da transferência');
  assert.ok(soTransf.linhas.every((l) => l.transferencia && l.categoria === 'transferencia'), 'todas classificadas como transferência');
  ok('o filtro "Transferências" devolve as duas pontas, classificadas');

  // ── 6.6 Origens ──────────────────────────────────────────────────
  semear();
  const completo = await extratoMockado.extrato({ condominioId: 1, filtros: { inicio: '2026-07-01', fim: '2026-07-31' } });
  const porId = (id) => completo.linhas.find((l) => l.id === id);
  assert.strictEqual(porId(2).categoria, 'pagamento', 'pagamento_id → pagamento');
  assert.strictEqual(porId(2).pagamentoId, 12, 'o id do pagamento é exposto');
  assert.strictEqual(porId(3).categoria, 'despesa', 'despesa_id → despesa');
  assert.strictEqual(porId(7).categoria, 'quota_extra', 'extra_quota_parcela_id → quota extra');
  assert.strictEqual(porId(5).categoria, 'transferencia', 'TRANSF → transferência');
  assert.strictEqual(porId(8).categoria, 'ajuste', 'sem origem → ajuste manual');
  ok('as cinco origens são identificadas (pagamento, despesa, quota extra, transferência, ajuste)');

  // ── 6.7 Editabilidade: operacional não é editável no extrato ─────
  assert.strictEqual(porId(2).editavel, false, 'um pagamento não é anulável aqui');
  assert.strictEqual(porId(3).editavel, false, 'uma despesa não é anulável aqui');
  assert.strictEqual(porId(7).editavel, false, 'uma quota extra não é anulável aqui');
  assert.strictEqual(porId(6).editavel, false, 'uma transferência não é anulável aqui');
  assert.strictEqual(porId(8).editavel, true, 'um ajuste manual é anulável aqui');
  ok('só os ajustes manuais são anuláveis no extrato (operação não diverge da origem)');

  // ── 6.8 Apresentação invertida, saldos preservados ───────────────
  const datasApresentacao = eJulho.linhas.map((l) => l.data);
  const datasOrdenadas = datasApresentacao.slice().sort().reverse();
  assert.deepStrictEqual(datasApresentacao, datasOrdenadas, 'a apresentação é do mais recente para o mais antigo');
  assert.strictEqual(eJulho.linhas[eJulho.linhas.length - 1].id, 2, 'o mais antigo fica em último');
  ok('a apresentação é cronológica inversa, sem alterar os saldos');

  // ── 6.9 Sem período: saldo anterior = saldo inicial ──────────────
  semear();
  const semPeriodo = await extratoMockado.extrato({ condominioId: 1, filtros: { conta: 2 } });
  assert.strictEqual(semPeriodo.resumo.saldoAnteriorC, 20000, 'sem período, parte do saldo inicial');
  assert.strictEqual(semPeriodo.resumo.temPeriodo, false, 'sem período assinalado');
  ok('sem período, o saldo parte do saldo inicial da conta');

  // ── 6.10 Extrato vazio ───────────────────────────────────────────
  semear();
  const vazio = await extratoMockado.extrato({ condominioId: 1, filtros: { inicio: '2020-01-01', fim: '2020-12-31' } });
  assert.strictEqual(vazio.linhas.length, 0, 'sem movimentos no período');
  assert.strictEqual(vazio.temMovimentos, false, 'assinalado como vazio');
  ok('um período sem movimentos devolve um extrato vazio (sem rebentar)');

  // ── 6.11 Isolamento do saldo entre condomínios ───────────────────
  semear();
  const saldoA = (await extratoMockado.extrato({ condominioId: 1, filtros: {} })).resumo.saldoInicialC;
  const saldoB = (await extratoMockado.extrato({ condominioId: 2, filtros: {} })).resumo.saldoInicialC;
  assert.strictEqual(saldoA, 120000, 'saldo inicial de A = 1000,00 + 200,00');
  assert.strictEqual(saldoB, 500000, 'saldo inicial de B = 5000,00');
  ok('o saldo inicial de um condomínio não inclui contas do outro');

  // ── 6.12 O saldo inicial não é multiplicado ──────────────────────
  // Se o saldo inicial fosse multiplicado pelo nº de movimentos, o saldo
  // final de A seria absurdo. Verificação explícita sobre o total.
  const totalContasA = (await extratoMockado.contasDoCondominio(1))
    .reduce((s, c) => s + Number(c.saldo_inicial), 0);
  assert.strictEqual(totalContasA, 1200, 'soma das contas de A = 1200,00 (2 contas, cada uma 1 vez)');
  ok('o saldo inicial é somado uma vez por conta, nunca por movimento');
}

// ═══════════════════════════════════════════════════════════════════
// 7. SEGURANÇA DAS ROTAS — ISOLAMENTO POR CONDOMÍNIO
//    Monta o router REAL em `/admin` e aplica HTTP a sério. É aqui que se
//    prova que `req.condominioId` (da sessão) governa tudo e que um id
//    vindo da URL nunca dá acesso a dados de outro condomínio.
//
//    O cabeçalho do grupo é impresso DENTRO do IIFE (depois de `grupo6()`),
//    para a secção 6 não aparecer debaixo do título da 7.
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const { Op } = require('sequelize');

// "Base de dados" das rotas: dois condomínios com contas e movimentos.
const rotaDb = { contas: [], movimentos: [], auditorias: [], escritas: [] };

function ondeRota(linhas, where) {
  if (!where) return linhas;
  return linhas.filter((l) => Object.entries(where).every(([k, v]) => {
    if (v === null) return l[k] === null || l[k] === undefined;
    if (v && typeof v === 'object' && v[Op.in]) return v[Op.in].map(String).includes(String(l[k]));
    if (v && typeof v === 'object' && v[Op.ne] !== undefined) return String(l[k]) !== String(v[Op.ne]);
    if (v && typeof v === 'object' && v[Op.or]) return v[Op.or].some((c) => ondeRota([l], c).length === 1);
    if (v && typeof v === 'object' && (v[Op.gte] !== undefined || v[Op.lte] !== undefined)) {
      if (v[Op.gte] !== undefined && String(l[k]) < String(v[Op.gte])) return false;
      if (v[Op.lte] !== undefined && String(l[k]) > String(v[Op.lte])) return false;
      return true;
    }
    return String(l[k]) === String(v);
  }));
}

const comMetodosRota = (l) => (l
  ? Object.assign(l, {
    update: async (v) => { Object.assign(l, v); rotaDb.escritas.push({ id: l.id, ...v }); },
    toJSON: () => ({ ...l }),
  })
  : l);

function semearRotas() {
  rotaDb.contas = [
    { id: 10, condominio_id: 1, nome: 'Conta A', tipo: 'corrente', saldo_inicial: '100.00', ativa: true },
    { id: 20, condominio_id: 2, nome: 'Conta B', tipo: 'corrente', saldo_inicial: '900.00', ativa: true },
  ];
  rotaDb.movimentos = [
    { id: 100, condominio_id: 1, conta_bancaria_id: 10, data: '2026-07-01', tipo: 'entrada', valor: '10.00', estado: 'confirmado', pagamento_id: 1 },
    { id: 101, condominio_id: 1, conta_bancaria_id: 10, data: '2026-07-02', tipo: 'saida', valor: '5.00', estado: 'confirmado' },
    { id: 200, condominio_id: 2, conta_bancaria_id: 20, data: '2026-07-01', tipo: 'entrada', valor: '999.00', estado: 'confirmado' },
    { id: 201, condominio_id: 2, conta_bancaria_id: 20, data: '2026-07-02', tipo: 'saida', valor: '1.00', estado: 'confirmado' },
  ];
  rotaDb.auditorias = [];
  rotaDb.escritas = [];
  rotaDb.flashes = [];
}

// Modelos que as rotas usam. Só se implementa o que o extrato toca.
const modelosRotas = {
  ContaBancaria: {
    findOne: async (o = {}) => comMetodosRota(ondeRota(rotaDb.contas, o.where)[0]) || null,
    findAll: async (o = {}) => ondeRota(rotaDb.contas, o.where).map(comMetodosRota),
  },
  MovimentoBancario: {
    findAll: async (o = {}) => ondeRota(rotaDb.movimentos, o.where)
      .sort((a, b) => String(a.data).localeCompare(String(b.data)) || a.id - b.id)
      .map((m) => comMetodosRota({ ...m })),
    findOne: async (o = {}) => comMetodosRota(ondeRota(rotaDb.movimentos, o.where)[0]) || null,
    count: async (o = {}) => ondeRota(rotaDb.movimentos, o.where).length,
    sum: async () => 0,
  },
  // Modelos referenciados pelo router mas não usados no extrato.
  Categoria: { findAll: async () => [] },
  MetodoPagamento: { findAll: async () => [] },
  Despesa: { findAll: async () => [], sum: async () => 0, findOne: async () => null },
  Quota: { findAll: async () => [], sum: async () => 0, findOne: async () => null },
  Pagamento: { findAll: async () => [], sum: async () => 0, findOne: async () => null },
  PagamentoQuota: { findAll: async () => [] },
  Fracao: { findAll: async () => [], findOne: async () => null },
  Orcamento: { findAll: async () => [], findOne: async () => null },
  OrcamentoRubrica: { findAll: async () => [] },
  Documento: { findAll: async () => [], findOne: async () => null },
  Fornecedor: { findAll: async () => [], findOne: async () => null },
  EmailFila: { findAll: async () => [], create: async () => ({}) },
  ExtraQuota: { findAll: async () => [], findOne: async () => null },
  ExtraQuotaParcela: { findAll: async () => [], findOne: async () => null, sum: async () => 0 },
  PagamentoExtraParcela: { findAll: async () => [], findOne: async () => null },
  Recibo: { findAll: async () => [], findOne: async () => null },
  ReciboQuota: { findAll: async () => [] },
  ReciboExtraParcela: { findAll: async () => [] },
  AgendaItem: { findAll: async () => [], findByPk: async () => null },
  Assembleia: { findAll: async () => [], findOne: async () => null },
  sequelize: { query: async () => [[]], transaction: async (fn) => fn({ commit: async () => {}, rollback: async () => {} }) },
  Op,
};

// Middleware de tenant substituído: injeta o condomínio ativo como a sessão
// faria, mas escolhido pelo CABEÇALHO do pedido (para simular os dois
// utilizadores). É a única peça simulada — o handler da rota é o real.
function tenantFalso(req, res, next) {
  req.condominioId = Number(req.headers['x-condominio']);
  req.user = { id: 7 };
  req.session = {};
  req.flash = (tipo, msg) => {
    (req.flashes = req.flashes || []).push({ tipo, msg });
    // Registo global: um redirect termina a resposta sem corpo, pelo que os
    // flashes do pedido são a única forma de os inspecionar.
    rotaDb.flashes = (rotaDb.flashes || []).concat([{ tipo, msg }]);
  };
  next();
}

const caminhoRouter = require.resolve(path.join(RAIZ, 'routes', 'financeiro'));
const caminhoModels = require.resolve(path.join(RAIZ, 'models'));
const caminhoTenant = require.resolve(path.join(RAIZ, 'helpers', 'tenant'));
const caminhoAudit = require.resolve(path.join(RAIZ, 'helpers', 'audit'));
const caminhoExtrato = extratoPath;

// A montagem do router fica numa função porque tem de correr DEPOIS de a
// secção 6 ter terminado: ambas substituem o mesmo `require.cache`, e quem
// correr por último é quem manda. Chamar isto dentro do IIFE da secção 7
// garante que o router vê os modelos da secção 7, não os da 6.
function montarAppExtrato() {
  require.cache[caminhoModels] = { id: caminhoModels, filename: caminhoModels, loaded: true, children: [], paths: [], exports: modelosRotas };
  require.cache[caminhoTenant] = {
    id: caminhoTenant,
    filename: caminhoTenant,
    loaded: true,
    children: [],
    paths: [],
    exports: {
      comCondominioAtivo: tenantFalso,
      comPapel: () => (req, res, next) => next(),
      ativo: (req) => req.condominioId,
      PAPEIS: { admin: 30, gestor: 20, leitura: 10 },
    },
  };
  require.cache[caminhoAudit] = {
    id: caminhoAudit,
    filename: caminhoAudit,
    loaded: true,
    children: [],
    paths: [],
    exports: { audit: async (d) => { rotaDb.auditorias.push(d); } },
  };
  delete require.cache[caminhoRouter];
  // `helpers/extrato.js` também guarda os modelos que importou no topo; se
  // continuar em cache da secção 6, as rotas consultariam a BD errada.
  delete require.cache[caminhoExtrato];
  // eslint-disable-next-line global-require
  const routerExtrato = require(caminhoRouter);

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.set('view engine', 'handlebars');
  app.engine('handlebars', (filePath, options, cb) => {
    // Não se renderiza a vista a sério: devolve-se o modelo para inspeção.
    cb(null, JSON.stringify({
      __view: path.basename(filePath),
      titulo: options.titulo,
      linhas: (options.linhas || []).map((l) => ({
        id: l.id, categoria: l.categoria, editavel: l.editavel, anulado: l.anulado, saldoC: l.saldoC, tipo: l.tipo,
      })),
      resumo: options.resumo,
      contaSelecionada: options.contaSelecionada,
      contas: (options.contas || []).map((c) => c.id),
      filtros: options.filtros,
      flashes: options.flashes,
      __redirect: options.__redirect,
      __status: options.__status,
    }));
  });
  // Interceção de redirect/render: o redirect real do Express termina a
  // resposta; aqui guarda-se o destino E termina-se, para o cliente HTTP não
  // ficar pendurado à espera.
  app.use((req, res, next) => {
    const renderOriginal = res.render.bind(res);
    res.redirect = (url) => {
      res.__redirect = url;
      res.__done = true;
      res.statusCode = 302;
      res.setHeader('Location', url);
      res.end();
    };
    res.render = function (vista, opcoes, cb) {
      if (cb) return renderOriginal(vista, opcoes, cb);
      return renderOriginal(vista, { ...opcoes, flashes: req.flashes, __redirect: res.__redirect, __status: res.statusCode }, cb);
    };
    next();
  });
  app.use('/admin', routerExtrato);
  app.use((err, req, res, next) => { res.__erro = err; res.status(500).end(); });
  return app;
}

const http = require('http');

function pedir(caminho, { metodo = 'GET', condominio = 1, corpo = null } = {}) {
  return new Promise((resolve, reject) => {
    // A app é (re)montada por pedido: garante que o router usa os modelos
    // desta secção e que cada pedido parte de um estado limpo.
    const servidor = http.createServer(montarAppExtrato());
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address();
      const dados = corpo ? new URLSearchParams(corpo).toString() : null;
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: caminho,
        method: metodo,
        headers: {
          'x-condominio': String(condominio),
          ...(dados ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(dados) } : {}),
        },
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          servidor.close();
          let json = null;
          try { json = JSON.parse(body); } catch (e) { /* resposta não-JSON */ }
          resolve({ status: res.statusCode, body, json, headers: res.headers });
        });
      });
      req.on('error', (e) => { servidor.close(); reject(e); });
      if (dados) req.write(dados);
      req.end();
    });
  });
}

(async () => {
  // A secção 6 corre primeiro, e é AGUARDADA: uma falha lá dentro tem de
  // abortar o teste, não passar em silêncio.
  await grupo6();
  grupo('7. Segurança das rotas do extrato (isolamento por condomínio)');

  // ── 7.1 A vê só os seus movimentos ───────────────────────────────
  semearRotas();
  const rA = await pedir('/admin/movimentos?inicio=2026-07-01&fim=2026-07-31', { condominio: 1 });
  assert.strictEqual(rA.status, 200, 'a rota responde 200');
  const idsA = rA.json.linhas.map((l) => l.id).sort((a, b) => a - b);
  assert.deepStrictEqual(idsA, [100, 101], 'o condomínio A vê os seus dois movimentos');
  assert.ok(!idsA.includes(200) && !idsA.includes(201), 'nenhum movimento de B aparece no extrato de A');
  assert.deepStrictEqual(rA.json.contas, [10], 'o seletor de contas só oferece contas de A');
  ok('o extrato do condomínio A só devolve movimentos e contas de A');

  // ── 7.2 B vê só os seus ──────────────────────────────────────────
  const rB = await pedir('/admin/movimentos?inicio=2026-07-01&fim=2026-07-31', { condominio: 2 });
  const idsB = rB.json.linhas.map((l) => l.id).sort((a, b) => a - b);
  assert.deepStrictEqual(idsB, [200, 201], 'o condomínio B vê os seus dois movimentos');
  assert.ok(!idsB.includes(100), 'nenhum movimento de A aparece no extrato de B');
  ok('o extrato do condomínio B só devolve movimentos de B');

  // ── 7.3 Não se consulta uma conta de outro condomínio ────────────
  semearRotas();
  const rContaAlheia = await pedir('/admin/movimentos?conta=20', { condominio: 1 });
  assert.strictEqual(rContaAlheia.status, 302, 'redireciona (não dá 500)');
  assert.strictEqual(rContaAlheia.headers.location, '/admin/movimentos', 'destino do redirecionamento');
  assert.ok(rotaDb.flashes.some((f) => f.tipo === 'error_msg'), 'com erro funcional claro');
  ok('consultar uma conta de outro condomínio é recusado sem 500');

  // ── 7.4 Não se anula um movimento de outro condomínio ────────────
  semearRotas();
  const rAnularAlheio = await pedir('/admin/movimentos/200/anular', { metodo: 'POST', condominio: 1 });
  assert.strictEqual(rAnularAlheio.status, 302, 'redireciona (não dá 500)');
  assert.strictEqual(rotaDb.movimentos.find((m) => m.id === 200).estado, 'confirmado', 'o movimento de B ficou intacto');
  assert.strictEqual(rotaDb.escritas.length, 0, 'nenhuma escrita aconteceu');
  assert.ok(rotaDb.flashes.some((f) => /não encontrado/i.test(f.msg || '')), 'mensagem de não encontrado, sem revelar outros condomínios');
  ok('anular um movimento de outro condomínio é recusado e não escreve nada');

  // ── 7.5 Não se anula um movimento operacional ────────────────────
  semearRotas();
  const rAnularPagamento = await pedir('/admin/movimentos/100/anular', { metodo: 'POST', condominio: 1 });
  assert.strictEqual(rotaDb.movimentos.find((m) => m.id === 100).estado, 'confirmado', 'o movimento de pagamento ficou intacto');
  assert.strictEqual(rotaDb.escritas.length, 0, 'nenhuma escrita aconteceu');
  assert.ok(rotaDb.flashes.some((f) => /origem/i.test(f.msg || '')), 'a mensagem explica que a correção é na origem');
  ok('anular um movimento com origem operacional é recusado (a origem manda)');

  // ── 7.6 Anula-se um ajuste manual do próprio condomínio ──────────
  semearRotas();
  const rAnularAjuste = await pedir('/admin/movimentos/101/anular', { metodo: 'POST', condominio: 1 });
  assert.strictEqual(rotaDb.movimentos.find((m) => m.id === 101).estado, 'anulado', 'o ajuste manual foi anulado');
  assert.strictEqual(rotaDb.escritas.length, 1, 'exatamente uma escrita');
  assert.strictEqual(rotaDb.auditorias.length, 1, 'a anulação fica auditada');
  assert.strictEqual(rotaDb.auditorias[0].acao, 'anular_movimento_bancario', 'com a ação esperada');
  ok('um ajuste manual do próprio condomínio é anulado, auditado e preservado');

  // ── 7.7 Não se anula duas vezes ──────────────────────────────────
  const rReanular = await pedir('/admin/movimentos/101/anular', { metodo: 'POST', condominio: 1 });
  assert.strictEqual(rotaDb.escritas.length, 1, 'a segunda tentativa não escreve');
  assert.ok(rotaDb.flashes.some((f) => /já está anulado/i.test(f.msg || '')), 'mensagem de já anulado');
  ok('um movimento já anulado não volta a ser anulado');

  // ── 7.8 O saldo da rota respeita o isolamento ────────────────────
  semearRotas();
  const rSaldoA = await pedir('/admin/movimentos?inicio=2026-07-01&fim=2026-07-31', { condominio: 1 });
  assert.strictEqual(rSaldoA.json.resumo.saldoInicialC, 10000, 'saldo inicial de A = 100,00');
  assert.strictEqual(rSaldoA.json.resumo.saldoFinalC, 10500, 'saldo final de A = 100,00 + 10,00 − 5,00');
  const rSaldoB = await pedir('/admin/movimentos?inicio=2026-07-01&fim=2026-07-31', { condominio: 2 });
  assert.strictEqual(rSaldoB.json.resumo.saldoInicialC, 90000, 'saldo inicial de B = 900,00');
  assert.strictEqual(rSaldoB.json.resumo.saldoFinalC, 189800, 'saldo final de B = 900,00 + 999,00 − 1,00');
  ok('o saldo de cada condomínio nunca inclui o do outro');

  // ── 7.9 Sem parâmetros, aplica-se o período por omissão ──────────
  semearRotas();
  const rOmissao = await pedir('/admin/movimentos', { condominio: 1 });
  assert.strictEqual(rOmissao.json.filtros.inicio, `${new Date().getFullYear()}-01-01`, 'início = 1 de janeiro do ano corrente');
  assert.strictEqual(rOmissao.json.filtros.fim, `${new Date().getFullYear()}-12-31`, 'fim = 31 de dezembro do ano corrente');
  ok('sem parâmetros, o período por omissão é o ano corrente (padrão do Relatório Financeiro)');

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(' OK — ' + nPassos + ' verificações passaram (incluindo as rotas).');
  console.log('═══════════════════════════════════════════════════════════════════');
  process.exit(0);
})().catch((err) => {
  console.log('');
  console.log('✗ FALHA: ' + err.message);
  console.log('');
  console.log(err.stack);
  process.exit(1);
});
