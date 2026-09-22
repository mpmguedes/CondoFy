// ═══════════════════════════════════════════════════════════════════
// Período da listagem de emails — resolução PURA (sem BD, sem HTTP).
//
// Cobre `helpers/periodo-filtro.js` e a aritmética de datas de
// `helpers/dates.js` que ele usa. O que aqui se fixa é o CONTRATO de que
// depende o filtro do histórico:
//
//   · por omissão, o MÊS EM CURSO até hoje (início do dia / fim do dia);
//   · atalhos com intervalo calculado (mês anterior, últimos 7/30 dias);
//   · intervalo personalizado escrito pelo utilizador, com normalização de
//     ordem e rejeição de datas inexistentes;
//   · o atalho ativo é o PEDIDO quando é um atalho calculado válido, e
//     DERIVADO do intervalo efetivo só quando não há parâmetro (P51).
//
// Todas as datas são construídas em hora LOCAL (nunca `toISOString`), tal como
// o módulo — a asserção é, por isso, independente do fuso da máquina.
// Utilização: node scripts/test-periodo-filtro.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');

const {
  ATALHOS,
  IDS_ATALHO,
  dataDeInput,
  intervaloDoAtalho,
  resolverPeriodo,
} = require('../helpers/periodo-filtro');
const { somarDias, primeiroDiaDoMes, inicioDoDia, fimDoDia, toDateInput } = require('../helpers/dates');

let n = 0;
const feito = (nome) => { n += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

const igualData = (a, b, msg) => assert.strictEqual(
  a instanceof Date ? a.getTime() : a,
  b instanceof Date ? b.getTime() : b,
  `${msg} (obtido ${a instanceof Date ? a.toString() : a}, esperado ${b instanceof Date ? b.toString() : b})`
);

// Instante de referência: 20 de setembro de 2026, 14:30 (hora local).
const AGORA = new Date(2026, 8, 20, 14, 30, 0, 0);

// ── 1. dataDeInput — validação ESTRITA ─────────────────────────────
titulo('dataDeInput — só aceita datas que existem mesmo');
assert.strictEqual(toDateInput(dataDeInput('2026-09-20')), '2026-09-20', 'data válida é aceite');
assert.strictEqual(dataDeInput('2026-9-20'), null, 'formato sem zero à esquerda é rejeitado');
assert.strictEqual(dataDeInput('20/09/2026'), null, 'formato PT é rejeitado (o campo é <input type=date>)');
assert.strictEqual(dataDeInput(''), null, 'vazio é rejeitado');
assert.strictEqual(dataDeInput(null), null, 'nulo é rejeitado');
assert.strictEqual(dataDeInput(undefined), null, 'indefinido é rejeitado');
assert.strictEqual(dataDeInput({}), null, 'objeto é rejeitado');
assert.strictEqual(toDateInput(dataDeInput(' 2026-09-20 ')), '2026-09-20', 'espaços em volta são tolerados');
// ⛔ As datas INEXISTENTES não podem transbordar em silêncio: `new Date(2026,1,30)`
// dá 2 de março e `new Date(2026,12,1)` dá janeiro do ano seguinte.
assert.strictEqual(dataDeInput('2026-02-30'), null, '30 de fevereiro é rejeitado (não transborda para março)');
assert.strictEqual(dataDeInput('2026-02-29'), null, '2026 não é bissexto — 29 de fevereiro é rejeitado');
assert.ok(dataDeInput('2024-02-29') instanceof Date, '2024 é bissexto — 29 de fevereiro é aceite');
assert.strictEqual(dataDeInput('2026-13-01'), null, 'mês 13 é rejeitado');
assert.strictEqual(dataDeInput('2026-00-10'), null, 'mês 0 é rejeitado');
assert.strictEqual(dataDeInput('2026-09-00'), null, 'dia 0 é rejeitado');
assert.strictEqual(dataDeInput('2026-09-31'), null, '31 de setembro é rejeitado');
feito('datas inexistentes e formatos inválidos são rejeitados sem transbordo');

// ── 2. Aritmética de datas em hora local ───────────────────────────
titulo('somarDias / primeiroDiaDoMes / inicioDoDia / fimDoDia');
igualData(somarDias(new Date(2026, 8, 20), 1), new Date(2026, 8, 21), 'somar 1 dia');
igualData(somarDias(new Date(2026, 8, 30), 1), new Date(2026, 9, 1), 'passagem de mês');
igualData(somarDias(new Date(2026, 11, 31), 1), new Date(2027, 0, 1), 'passagem de ano');
igualData(somarDias(new Date(2026, 0, 1), -1), new Date(2025, 11, 31), 'subtrair através do ano');
assert.strictEqual(somarDias(null, 1), null, 'sem data não há soma');
igualData(primeiroDiaDoMes(new Date(2026, 8, 20)), new Date(2026, 8, 1), 'primeiro dia do mês');
igualData(primeiroDiaDoMes(new Date(2026, 8, 1)), new Date(2026, 8, 1), 'o 1.º dia é o primeiro dia');
igualData(inicioDoDia(new Date(2026, 8, 20, 14, 30, 12, 345)), new Date(2026, 8, 20, 0, 0, 0, 0), 'início do dia');
igualData(fimDoDia(new Date(2026, 8, 20, 14, 30, 12, 345)), new Date(2026, 8, 20, 23, 59, 59, 999), 'fim do dia');
// O intervalo é INCLUSIVO: um email criado às 23:59 do último dia conta.
assert.strictEqual(inicioDoDia(new Date(2026, 8, 20)).getTime() <= new Date(2026, 8, 20, 23, 59, 59, 999).getTime(), true, 'início ≤ fim no mesmo dia');
feito('aritmética local correta (mês, ano, limites do dia)');

// ── 3. Intervalo por omissão: mês em curso até hoje ────────────────
titulo('resolverPeriodo — por omissão, mês em curso até hoje');
let p = resolverPeriodo({}, AGORA);
igualData(p.de, new Date(2026, 8, 1, 0, 0, 0, 0), 'início = 1.º dia do mês');
igualData(p.ate, new Date(2026, 8, 20, 23, 59, 59, 999), 'fim = hoje, fim do dia');
assert.strictEqual(p.deInput, '2026-09-01', 'campo Data inicial pré-preenchido');
assert.strictEqual(p.ateInput, '2026-09-20', 'campo Data final pré-preenchido');
assert.strictEqual(p.atalho, 'este-mes', 'o atalho ativo é derivado (e não «personalizado»)');
assert.strictEqual(p.rotulo, 'Este mês', 'rótulo legível do período');
// `resolverPeriodo()` sem argumentos não pode rebentar (rota sem query).
const semArgs = resolverPeriodo();
assert.ok(semArgs.de instanceof Date && semArgs.ate instanceof Date, 'sem query usa o intervalo por omissão');
// Query com lixo → cai no intervalo por omissão, sem lançar.
const lixo = resolverPeriodo({ periodo: 'ontem', de: 'x', ate: 'y' });
igualData(lixo.de, primeiroDiaDoMes(new Date()), 'atalho desconhecido não altera o início');
assert.strictEqual(lixo.atalho, 'este-mes', 'atalho desconhecido cai no período por omissão');
feito('entrada sem filtros, sem argumentos e com parâmetros inválidos');

// ── 4. Atalhos ─────────────────────────────────────────────────────
titulo('resolverPeriodo — atalhos');
const casos = [
  ['este-mes', '2026-09-01', '2026-09-20'],
  ['mes-anterior', '2026-08-01', '2026-08-31'],
  ['ultimos-7', '2026-09-14', '2026-09-20'],
  ['ultimos-30', '2026-08-22', '2026-09-20'],
];
for (const [id, deInput, ateInput] of casos) {
  const r = resolverPeriodo({ periodo: id }, AGORA);
  assert.strictEqual(r.deInput, deInput, `atalho ${id}: data inicial`);
  assert.strictEqual(r.ateInput, ateInput, `atalho ${id}: data final`);
  assert.strictEqual(r.atalho, id, `atalho ${id}: fica assinalado como ativo`);
}
// «Últimos 7 dias» inclui hoje: 7 dias, não 6.
const sete = resolverPeriodo({ periodo: 'ultimos-7' }, AGORA);
assert.strictEqual(
  Math.round((dataDeInput(sete.ateInput) - dataDeInput(sete.deInput)) / 86400000), 6,
  'últimos 7 dias: 6 dias de diferença entre os extremos (7 dias inclusivos)'
);
// O atalho MANDA sobre as datas que o formulário envia sempre: sem isto,
// clicar «Mês anterior» com as datas do mês em curso nos campos não fazia nada.
const comDatasContraditorias = resolverPeriodo({ periodo: 'mes-anterior', de: '2026-09-01', ate: '2026-09-20' }, AGORA);
assert.strictEqual(comDatasContraditorias.deInput, '2026-08-01', 'o atalho prevalece sobre as datas dos campos');
assert.strictEqual(comDatasContraditorias.ateInput, '2026-08-31', 'o atalho prevalece sobre as datas dos campos (fim)');
feito('os quatro atalhos com intervalo calculado, e a prioridade do atalho');

// ── 5. Atalhos em fronteiras de calendário ─────────────────────────
titulo('resolverPeriodo — fronteiras de calendário');
// Em janeiro, «mês anterior» é dezembro do ano ANTERIOR.
const janeiro = resolverPeriodo({ periodo: 'mes-anterior' }, new Date(2026, 0, 15));
assert.strictEqual(janeiro.deInput, '2025-12-01', 'janeiro: mês anterior começa em dezembro do ano anterior');
assert.strictEqual(janeiro.ateInput, '2025-12-31', 'janeiro: mês anterior termina a 31 de dezembro');
// Em março, «mês anterior» é fevereiro (e o mês anterior é curto).
const marco = resolverPeriodo({ periodo: 'mes-anterior' }, new Date(2026, 2, 10));
assert.strictEqual(marco.deInput, '2026-02-01', 'março: mês anterior começa a 1 de fevereiro');
assert.strictEqual(marco.ateInput, '2026-02-28', 'março: mês anterior termina no último dia de fevereiro');
// No dia 1, «este mês» é um só dia — e continua a ser o atalho escolhido.
const dia1 = resolverPeriodo({}, new Date(2026, 8, 1));
assert.strictEqual(dia1.deInput, '2026-09-01', 'dia 1: início do mês');
assert.strictEqual(dia1.ateInput, '2026-09-01', 'dia 1: fim = o próprio dia');
assert.strictEqual(dia1.atalho, 'este-mes', 'dia 1: continua a ser «Este mês» (e não «Últimos 30 dias»)');
// Em 31 de dezembro, «este mês» vai do dia 1 ao dia 31.
const fimAno = resolverPeriodo({}, new Date(2026, 11, 31));
assert.strictEqual(fimAno.deInput, '2026-12-01', '31/12: início do mês');
assert.strictEqual(fimAno.ateInput, '2026-12-31', '31/12: fim = hoje');
feito('meses curtos, mudança de ano e dia 1');

// ── 6. Intervalo personalizado ─────────────────────────────────────
titulo('resolverPeriodo — intervalo personalizado');
p = resolverPeriodo({ de: '2026-01-01', ate: '2026-01-31' }, AGORA);
igualData(p.de, new Date(2026, 0, 1, 0, 0, 0, 0), 'personalizado: início do dia inicial');
igualData(p.ate, new Date(2026, 0, 31, 23, 59, 59, 999), 'personalizado: fim do dia final');
assert.strictEqual(p.atalho, 'personalizado', 'um intervalo que não coincide com nenhum atalho é «personalizado»');
assert.strictEqual(p.rotulo, 'Personalizado', 'rótulo do intervalo personalizado');

// `periodo=personalizado` (o botão da vista) NÃO é um atalho calculado: usa as
// datas escritas nos campos.
p = resolverPeriodo({ periodo: 'personalizado', de: '2026-03-05', ate: '2026-03-09' }, AGORA);
assert.strictEqual(p.deInput, '2026-03-05', '«Personalizado» usa a data inicial dos campos');
assert.strictEqual(p.ateInput, '2026-03-09', '«Personalizado» usa a data final dos campos');

// Um intervalo INVERTIDO é normalizado: sem isto, o utilizador veria «sem
// emails» por causa de uma troca de datas, e não por não haver emails.
p = resolverPeriodo({ de: '2026-09-30', ate: '2026-09-01' }, AGORA);
assert.strictEqual(p.deInput, '2026-09-01', 'intervalo invertido: normalizado para ordem cronológica');
assert.strictEqual(p.ateInput, '2026-09-30', 'intervalo invertido: normalizado para ordem cronológica (fim)');
assert.ok(p.de.getTime() <= p.ate.getTime(), 'intervalo invertido: início ≤ fim depois de normalizar');

// Só uma das datas: a outra cai no limite por omissão.
p = resolverPeriodo({ de: '2026-09-10' }, AGORA);
assert.strictEqual(p.deInput, '2026-09-10', 'só data inicial: é respeitada');
assert.strictEqual(p.ateInput, '2026-09-20', 'só data inicial: a final é hoje');
p = resolverPeriodo({ ate: '2026-09-10' }, AGORA);
assert.strictEqual(p.deInput, '2026-09-01', 'só data final: a inicial é o 1.º do mês');
assert.strictEqual(p.ateInput, '2026-09-10', 'só data final: é respeitada');

// Uma data inexistente é ignorada (não produz um intervalo inventado).
p = resolverPeriodo({ de: '2026-02-30', ate: '2026-09-15' }, AGORA);
assert.strictEqual(p.deInput, '2026-09-01', 'data inexistente: cai no limite por omissão');
assert.strictEqual(p.ateInput, '2026-09-15', 'data inexistente: a outra data é respeitada');
feito('intervalo personalizado, invertido, parcial e inválido');

// ── 7. Coerência da lista de atalhos ───────────────────────────────
titulo('ATALHOS — a lista apresentada na vista');
assert.deepStrictEqual(ATALHOS.map((a) => a.id), ['este-mes', 'mes-anterior', 'ultimos-7', 'ultimos-30', 'personalizado'],
  'os cinco atalhos, por ordem, com os identificadores esperados');
assert.deepStrictEqual(IDS_ATALHO, ['este-mes', 'mes-anterior', 'ultimos-7', 'ultimos-30'],
  '«personalizado» não é um atalho calculado');
for (const a of ATALHOS) {
  assert.ok(a.rotulo && a.rotulo.length > 2, `atalho ${a.id}: tem rótulo legível`);
}
for (const id of IDS_ATALHO) {
  const iv = intervaloDoAtalho(id, AGORA);
  assert.ok(iv && iv.de instanceof Date && iv.ate instanceof Date, `atalho ${id}: intervalo calculável`);
  assert.ok(iv.de.getTime() <= iv.ate.getTime(), `atalho ${id}: início ≤ fim`);
}
assert.strictEqual(intervaloDoAtalho('personalizado', AGORA), null, '«personalizado» não tem intervalo próprio');
assert.strictEqual(intervaloDoAtalho('inventado', AGORA), null, 'atalho desconhecido não tem intervalo');
feito('lista de atalhos coerente e intervalos bem formados');

// ── 8. Determinismo ───────────────────────────────────────────────
titulo('resolverPeriodo — determinismo e ausência de efeitos');
const a = resolverPeriodo({ de: '2026-01-01', ate: '2026-01-31' }, AGORA);
const b = resolverPeriodo({ de: '2026-01-01', ate: '2026-01-31' }, AGORA);
assert.deepStrictEqual(a, b, 'a mesma entrada produz sempre o mesmo resultado');
// Não muta a query recebida (o `req.query` é partilhado com o Express).
const query = { de: '2026-01-01', ate: '2026-01-31' };
const copia = { ...query };
resolverPeriodo(query, AGORA);
assert.deepStrictEqual(query, copia, 'não altera o objeto de query');
// O instante de referência não é mutado.
const ref = new Date(2026, 8, 20, 14, 30);
const refCopia = ref.getTime();
resolverPeriodo({ periodo: 'mes-anterior' }, ref);
assert.strictEqual(ref.getTime(), refCopia, 'não altera a data de referência recebida');
feito('função pura: determinística e sem efeitos colaterais');

// ── 9. P51 — o atalho assinalado é o BOTÃO CARREGADO ──────────────
titulo('P51 — atalho pedido prevalece quando o intervalo COLIDE');
// Os intervalos de dois atalhos COLIDEM em dois dias do mês: no dia 7,
// «Este mês» e «Últimos 7 dias» dão exatamente o mesmo intervalo; no dia 30,
// «Este mês» e «Últimos 30 dias». A consulta é a mesma, mas derivar o atalho
// do intervalo assinalava sempre «Este mês» — o botão pressionado não era o
// botão assinalado. O `periodo` pedido passa a mandar.
const DIA7 = new Date(2026, 8, 7, 14, 30);
const DIA30 = new Date(2026, 8, 30, 14, 30);

// (a) A colisão é REAL: os dois atalhos produzem o mesmo intervalo nesses dias.
const col7a = resolverPeriodo({ periodo: 'este-mes' }, DIA7);
const col7b = resolverPeriodo({ periodo: 'ultimos-7' }, DIA7);
assert.strictEqual(col7a.deInput, '2026-09-01', 'dia 7: «Este mês» começa no dia 1');
assert.strictEqual(col7a.ateInput, '2026-09-07', 'dia 7: «Este mês» termina hoje');
assert.strictEqual(col7b.deInput, col7a.deInput, 'dia 7: «Últimos 7 dias» tem o MESMO início (colisão real)');
assert.strictEqual(col7b.ateInput, col7a.ateInput, 'dia 7: «Últimos 7 dias» tem o MESMO fim (colisão real)');
const col30a = resolverPeriodo({ periodo: 'este-mes' }, DIA30);
const col30b = resolverPeriodo({ periodo: 'ultimos-30' }, DIA30);
assert.strictEqual(col30b.deInput, col30a.deInput, 'dia 30: «Últimos 30 dias» tem o MESMO início (colisão real)');
assert.strictEqual(col30b.ateInput, col30a.ateInput, 'dia 30: «Últimos 30 dias» tem o MESMO fim (colisão real)');

// (b) Apesar da colisão, cada botão fica assinalado por si.
assert.strictEqual(col7a.atalho, 'este-mes', 'dia 7: carregar «Este mês» assinala «Este mês»');
assert.strictEqual(col7b.atalho, 'ultimos-7', 'dia 7: carregar «Últimos 7 dias» assinala «Últimos 7 dias» (não «Este mês»)');
assert.strictEqual(col7b.rotulo, 'Últimos 7 dias', 'dia 7: o rótulo acompanha o atalho pedido');
assert.strictEqual(col30a.atalho, 'este-mes', 'dia 30: carregar «Este mês» assinala «Este mês»');
assert.strictEqual(col30b.atalho, 'ultimos-30', 'dia 30: carregar «Últimos 30 dias» assinala «Últimos 30 dias»');
assert.strictEqual(col30b.rotulo, 'Últimos 30 dias', 'dia 30: o rótulo acompanha o atalho pedido');

// (c) Sem parâmetro, a derivação continua a dar «Este mês» — a entrada inicial
// da listagem não pode passar a aparecer como «Personalizado».
assert.strictEqual(resolverPeriodo({}, DIA7).atalho, 'este-mes', 'dia 7 sem parâmetro: deriva «Este mês»');
assert.strictEqual(resolverPeriodo({}, DIA30).atalho, 'este-mes', 'dia 30 sem parâmetro: deriva «Este mês»');

// (d) O atalho pedido só manda se for CALCULADO e válido: «personalizado» e
// valores inventados continuam a cair na derivação.
assert.strictEqual(
  resolverPeriodo({ periodo: 'personalizado', de: '2026-01-01', ate: '2026-01-31' }, AGORA).atalho,
  'personalizado',
  '«personalizado» não é atalho calculado: usa as datas dos campos'
);
assert.strictEqual(resolverPeriodo({ periodo: 'inventado' }, AGORA).atalho, 'este-mes', 'atalho inventado cai na derivação');
assert.strictEqual(
  resolverPeriodo({ periodo: 'ultimos-7', de: '2026-01-01', ate: '2026-01-31' }, AGORA).deInput,
  '2026-09-14',
  'o atalho pedido continua a mandar sobre as datas dos campos'
);
feito('P51 — atalho pedido prevalece, com derivação preservada na ausência de parâmetro');

console.log(`\n✓ Testes do período da listagem de emails passaram (${n} verificações, sem BD).`);
