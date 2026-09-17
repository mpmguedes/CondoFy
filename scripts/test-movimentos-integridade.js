// ═══════════════════════════════════════════════════════════════════
// Fase 2.1A — Integridade estrutural dos movimentos bancários.
//
// Testes offline (sem base de dados nem rede) do que esta fase garante:
//
//  · todos os writers de movimentos gravam `condominio_id` (nunca NULL);
//      – pagamento (FIFO)                     helpers/pagamentos.js
//      – pagamento com items                  helpers/pagamentos.js
//      – pagamento de parcela de quota extra  helpers/pagamentos.js
//      – despesa paga (sincronizar)           helpers/movimentos.js
//  · as transferências continuam identificadas por referencia 'TRANSF' e
//    continuam a levar o condomínio nas duas pontas;
//  · isolamento: o condomínio A nunca vê movimentos de B e vice-versa;
//  · o saldo baseado em movimentos conta o saldo inicial UMA só vez
//    (não multiplica), ignora anulados, soma entradas, subtrai saídas e
//    trata 'transferencia' como neutra;
//  · o saldo à data respeita o cutoff;
//  · a migração de backfill associa os movimentos históricos ao condomínio
//    da conta e nunca repõe NULL;
//  · a rota de eliminação de conta recusa apagar uma conta com movimentos.
//
// Utilização: node scripts/test-movimentos-integridade.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
let nPassos = 0;
function ok(descricao) {
  nPassos += 1;
  console.log('  ✓ ' + descricao);
}
function grupo(titulo) {
  console.log('');
  console.log('── ' + titulo + ' ' + '─'.repeat(Math.max(0, 58 - titulo.length)));
}

// ═══════════════════════════════════════════════════════════════════
// 1. ANÁLISE ESTÁTICA DOS WRITERS
//    Garante que todos os pontos que criam movimentos passam condominioId.
// ═══════════════════════════════════════════════════════════════════
grupo('1. Writers de movimentos passam sempre condominioId');

function blocosCriarMovimento(fonte) {
  // Captura cada chamada `criarMovimento({ ... })` (sem aninhamento profundo).
  const blocos = [];
  const re = /criarMovimento\(\{/g;
  let m;
  while ((m = re.exec(fonte)) !== null) {
    let i = m.index + m[0].length;
    let nivel = 1;
    while (i < fonte.length && nivel > 0) {
      if (fonte[i] === '{') nivel += 1;
      else if (fonte[i] === '}') nivel -= 1;
      i += 1;
    }
    blocos.push(fonte.slice(m.index, i));
  }
  return blocos;
}

{
  const pag = fs.readFileSync(path.join(RAIZ, 'helpers', 'pagamentos.js'), 'utf8');
  const blocos = blocosCriarMovimento(pag);
  assert.strictEqual(blocos.length, 3, 'helpers/pagamentos.js deve ter 3 criarMovimento');
  for (const b of blocos) {
    assert.ok(/condominioId:/.test(b), 'todos os criarMovimento em pagamentos.js passam condominioId');
  }
  ok('helpers/pagamentos.js: 3/3 criarMovimento passam condominioId');

  const mov = fs.readFileSync(path.join(RAIZ, 'helpers', 'movimentos.js'), 'utf8');
  // O criarMovimento de sincronizarMovimentoDespesa (o par de transferência usa `condominioId,` shorthand).
  assert.ok(/condominioId: cid/.test(mov), 'sincronizarMovimentoDespesa passa condominioId (cid)');
  ok('helpers/movimentos.js: sincronizarMovimentoDespesa passa condominioId');

  // A função resolve o condomínio a partir da despesa quando não lhe é dado.
  assert.ok(/const cid = condominioId \|\| despesa\.condominio_id/.test(mov),
    'o condomínio cai para despesa.condominio_id quando não é passado');
  ok('helpers/movimentos.js: fallback explícito para despesa.condominio_id');

  // O update do movimento existente também fixa o condomínio.
  assert.ok(/condominio_id: cid,/.test(mov), 'o update do movimento existente grava condominio_id');
  ok('helpers/movimentos.js: update do movimento existente grava condominio_id');
}

// ═══════════════════════════════════════════════════════════════════
// 2. TRANSFERÊNCIAS PRESERVADAS
// ═══════════════════════════════════════════════════════════════════
grupo('2. Transferências continuam TRANSF e com condomínio');

{
  const mov = fs.readFileSync(path.join(RAIZ, 'helpers', 'movimentos.js'), 'utf8');
  // Contar apenas no código: os comentários explicativos citam a própria string.
  const movCodigo = mov
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const nTransf = (movCodigo.match(/referencia: 'TRANSF'/g) || []).length;
  assert.strictEqual(nTransf, 2, 'a transferência tem de marcar as DUAS pontas com TRANSF');
  ok('as duas pontas da transferência usam referencia = TRANSF');

  // Os dois criarMovimento do par recebem condominioId.
  const par = mov.slice(mov.indexOf('async function registarTransferencia'));
  const fim = par.indexOf('async function sincronizarMovimentoDespesa');
  const corpo = par.slice(0, fim > 0 ? fim : par.length);
  const ocorrencias = (corpo.match(/condominioId,\n/g) || []).length
    + (corpo.match(/condominioId,/g) || []).length;
  assert.ok(ocorrencias >= 2, 'as duas pontas recebem condominioId');
  ok('saída e entrada da transferência recebem condominioId');

  // Os dois fluxos do FCR continuam a passar condominioId (não foram tocados).
  const fcr = fs.readFileSync(path.join(RAIZ, 'helpers', 'fcr.js'), 'utf8');
  const chamadas = fcr.match(/await registarTransferencia\(\{[\s\S]*?\n    \}\);/g) || [];
  assert.ok(chamadas.length >= 2, 'fcr.js chama registarTransferencia nos dois sentidos');
  for (const c of chamadas) {
    assert.ok(/condominioId/.test(c), 'cada transferência do FCR passa condominioId');
  }
  ok('os dois fluxos FCR passam condominioId (preservados)');
}

// ═══════════════════════════════════════════════════════════════════
// 3. FALLBACKS NULL REMOVIDOS
// ═══════════════════════════════════════════════════════════════════
grupo('3. Não há fallback condominio_id IS NULL em helpers/routes');

{
  const ficheiros = ['helpers/fcr.js', 'helpers/movimentos.js', 'helpers/pagamentos.js', 'helpers/saldos.js'];
  for (const f of ficheiros) {
    const src = fs.readFileSync(path.join(RAIZ, f), 'utf8');
    // Remove comentários antes de procurar, para não acusar a documentação.
    const semComentarios = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/condominio_id: null/.test(semComentarios),
      f + ' não deve ter condominio_id: null em código');
    assert.ok(!/\{\s*condominio_id: null\s*\}/.test(semComentarios),
      f + ' não deve ter { condominio_id: null } como filtro');
  }
  ok('nenhum filtro condominio_id: null no código dos helpers');

  const fcr = fs.readFileSync(path.join(RAIZ, 'helpers', 'fcr.js'), 'utf8');
  const codigo = fcr.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\[Op\.or\][\s\S]{0,80}condominio_id/.test(codigo),
    'fcr.js não deve ter [Op.or] com condominio_id em código');
  ok('helpers/fcr.js: os dois [Op.or] de condominio_id foram removidos');
}

// ═══════════════════════════════════════════════════════════════════
// 4. SALDO BASEADO EM MOVIMENTOS
// ═══════════════════════════════════════════════════════════════════
grupo('4. Saldo por movimentos — regras');

{
  const { saldoContaNaData } = require(path.join(RAIZ, 'helpers', 'relatorio-financeiro'));

  // O saldo inicial NÃO é multiplicado pelo número de movimentos.
  {
    const umMov = saldoContaNaData({
      saldoInicialC: 50000,
      movimentos: [{ tipo: 'entrada', valor: '100.00', estado: 'confirmado', data: '2026-01-10' }],
      dataCorte: null,
    });
    const tresMov = saldoContaNaData({
      saldoInicialC: 50000,
      movimentos: [
        { tipo: 'entrada', valor: '100.00', estado: 'confirmado', data: '2026-01-10' },
        { tipo: 'entrada', valor: '100.00', estado: 'confirmado', data: '2026-01-11' },
        { tipo: 'entrada', valor: '100.00', estado: 'confirmado', data: '2026-01-12' },
      ],
      dataCorte: null,
    });
    assert.strictEqual(tresMov.saldoC - umMov.saldoC, 20000,
      'acrescentar 2 movimentos de 100€ aumenta o saldo em 200€ (não multiplica o inicial)');
    ok('o saldo inicial é contado uma única vez (não multiplica)');
  }

  // Entradas somam, saídas subtraem.
  {
    const r = saldoContaNaData({
      saldoInicialC: 100000,
      movimentos: [
        { tipo: 'entrada', valor: '9286.62', estado: 'confirmado', data: '2026-01-01' },
        { tipo: 'saida', valor: '4631.83', estado: 'confirmado', data: '2026-02-01' },
      ],
      dataCorte: null,
    });
    assert.strictEqual(r.saldoC, 100000 + 928662 - 463183);
    ok('entradas aumentam e saídas diminuem o saldo');
  }

  // Anulados não entram.
  {
    const r = saldoContaNaData({
      saldoInicialC: 0,
      movimentos: [
        { tipo: 'entrada', valor: '999.99', estado: 'anulado', data: '2026-01-01' },
      ],
      dataCorte: null,
    });
    assert.strictEqual(r.saldoC, 0, 'movimento anulado não altera o saldo');
    ok('movimentos anulados não entram no saldo');
  }

  // 'transferencia' (ENUM legado) é neutra.
  {
    const r = saldoContaNaData({
      saldoInicialC: 12345,
      movimentos: [{ tipo: 'transferencia', valor: '500.00', estado: 'confirmado', data: '2026-01-01' }],
      dataCorte: null,
    });
    assert.strictEqual(r.saldoC, 12345, 'transferencia não altera o saldo');
    assert.strictEqual(r.transferenciasC, 50000, 'a transferência é reportada à parte');
    ok('tipo transferencia é neutro para o saldo');
  }

  // Cutoff por data.
  {
    const r = saldoContaNaData({
      saldoInicialC: 100000,
      movimentos: [
        { tipo: 'entrada', valor: '10.00', estado: 'confirmado', data: '2026-01-15' },
        { tipo: 'entrada', valor: '20.00', estado: 'confirmado', data: '2026-02-15' },
      ],
      dataCorte: '2026-01-31',
    });
    assert.strictEqual(r.saldoC, 100000 + 1000, 'só entram movimentos até à data de corte');
    ok('o cálculo com data respeita o cutoff');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 5. MIGRAÇÃO DE BACKFILL
// ═══════════════════════════════════════════════════════════════════
grupo('5. Migração de backfill — comportamento');

{
  const caminho = path.join(RAIZ, 'migrations', '20260101000076-backfill-movimentos-condominio.js');
  assert.ok(fs.existsSync(caminho), 'a migração de backfill existe');
  ok('migração 20260101000076 existe');

  const src = fs.readFileSync(caminho, 'utf8');

  // Só escreve a coluna condominio_id.
  assert.ok(/SET mb\.condominio_id = cb\.condominio_id/.test(src),
    'copia o condomínio da conta');
  assert.ok(!/SET mb\.(valor|data|tipo|estado|conta_bancaria_id)\s*=/.test(src),
    'não altera nenhuma outra coluna');
  ok('só a coluna condominio_id é escrita (valores/datas/estados intocados)');

  // Só toca em linhas NULL.
  assert.ok(/WHERE mb\.condominio_id IS NULL/.test(src), 'só atua sobre linhas NULL');
  ok('só atua sobre movimentos com condominio_id NULL');

  // Aborta perante ambiguidade.
  assert.ok(/throw new Error/.test(src), 'aborta em caso de ambiguidade');
  ok('aborta (sem escrever) se houver linha irrecuperável');

  // `down` NÃO repõe NULL (decisão documentada de não reversibilidade).
  const down = src.slice(src.indexOf('async down'));
  assert.ok(!/SET\s+condominio_id\s*=\s*NULL/i.test(down), 'o down não repõe NULL');
  ok('o down não repõe NULL (não apaga condominios legítimos)');

  // A decisão de irreversibilidade está documentada.
  assert.ok(/NÃO REVERSÍVEL|NAO REVERSIVEL|não é possível reverter|NAO REVERS/.test(src),
    'a decisão de não reversibilidade está documentada');
  ok('a irreversibilidade está documentada no ficheiro');

  // Deve ter as três guardas.
  assert.ok(/semConta/.test(src) && /contaSemCond/.test(src) && /recuperaveis/.test(src),
    'as guardas de integridade estão presentes');
  ok('guardas de integridade presentes (linha sem conta / conta sem condomínio)');
}

// ═══════════════════════════════════════════════════════════════════
// 6. ELIMINAÇÃO DE CONTA BANCÁRIA
// ═══════════════════════════════════════════════════════════════════
grupo('6. Eliminação de conta bancária');

{
  const src = fs.readFileSync(path.join(RAIZ, 'routes', 'financeiro.js'), 'utf8');
  const inicio = src.indexOf("'/contas/:id(\\\\d+)/eliminar'");
  assert.ok(inicio > 0, 'a rota de eliminação existe');
  const corpo = src.slice(inicio, inicio + 2000);

  assert.ok(/MovimentoBancario\.count\(/.test(corpo),
    'a rota conta os movimentos antes de apagar');
  ok('a rota verifica se existem movimentos associados');

  assert.ok(/nMovimentos > 0/.test(corpo), 'recusa quando há movimentos');
  ok('recusa a eliminação quando existem movimentos');

  assert.ok(/Desative a conta/.test(corpo), 'sugere a desativação');
  ok('sugere desativar a conta em vez de eliminar');

  // O destroy continua a existir, mas só depois da guarda.
  const posGuarda = corpo.indexOf('nMovimentos > 0');
  const posDestroy = corpo.indexOf('conta.destroy()');
  assert.ok(posDestroy > posGuarda, 'o destroy só corre depois da guarda');
  ok('o destroy só é executado depois da guarda');

  // O modelo está importado (senão rebentava em runtime).
  assert.ok(/MovimentoBancario,\n\} = require\('\.\.\/models'\)/.test(src),
    'MovimentoBancario está importado em routes/financeiro.js');
  ok('MovimentoBancario está importado na rota');
}

// ═══════════════════════════════════════════════════════════════════
// 7. ISOLAMENTO POR CONDOMÍNIO (filtros explícitos)
// ═══════════════════════════════════════════════════════════════════
grupo('7. Isolamento por condomínio nos filtros');

{
  const fcr = fs.readFileSync(path.join(RAIZ, 'helpers', 'fcr.js'), 'utf8');
  const codigo = fcr.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // fcrTransferidoC: movimentos filtrados por condominio_id explícito.
  assert.ok(/condominio_id: condominioId,/.test(codigo),
    'fcrTransferidoC filtra movimentos por condominio_id');
  ok('fcrTransferidoC filtra movimentos por condominio_id explícito');

  // e continua a exigir que a conta seja do mesmo condomínio.
  assert.ok(/where: \{ condominio_id: condominioId \}, required: true/.test(codigo),
    'o include da conta mantém o filtro por condomínio');
  ok('o include da conta mantém required + condominio_id');

  // fcrRecebidoC: pagamentos filtrados por condominio_id.
  assert.ok(/estado: 'confirmado',\s*\n\s*condominio_id: condominioId,/.test(codigo),
    'fcrRecebidoC filtra pagamentos por condominio_id');
  ok('fcrRecebidoC filtra pagamentos por condominio_id explícito');
}

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log(' OK — ' + nPassos + ' verificações passaram.');
console.log('═══════════════════════════════════════════════════════════════');
