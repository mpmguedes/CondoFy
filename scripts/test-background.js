// Testes do motor de tarefas em segundo plano (sem base de dados).
// Utilização: node scripts/test-background.js
const assert = require('assert');
const background = require('../helpers/background-jobs');

function dormir(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function aguardarCondicao(fn, limiteMs = 4000) {
  const inicio = Date.now();
  while (Date.now() - inicio < limiteMs) {
    if (fn()) return;
    await dormir(20);
  }
  throw new Error('tempo limite excedido a aguardar condição');
}

async function main() {
  // 1. Registo de handler + execução assíncrona com progresso.
  const eventos = [];
  background.registar('teste_lento', async (dados, progresso) => {
    eventos.push(`inicio:${dados.n}` );
    progresso({ fases: { trabalho: { estado: 'a_processar', atual: 0, total: dados.n } } });
    await dormir(30);
    progresso({ fases: { trabalho: { estado: 'concluido', atual: dados.n, total: dados.n } } });
    eventos.push(`fim:${dados.n}`);
  });

  // 2. enqueue devolve de imediato (não bloqueia o "request").
  const t0 = Date.now();
  const id1 = background.enqueue('teste_lento', { n: 1 });
  const id2 = background.enqueue('teste_lento', { n: 2 });
  assert.ok(id1 && id1 !== id2, 'ids diferentes');
  assert.ok(Date.now() - t0 < 500, 'enqueue não bloqueia (resposta imediata)');

  // 3. O processamento é sequencial e conclui as tarefas.
  await aguardarCondicao(() => {
    const t1 = background.obterTarefa(id1);
    const t2 = background.obterTarefa(id2);
    return t1 && t2 && t1.estado === 'concluido' && t2.estado === 'concluido';
  });
  assert.deepStrictEqual(eventos, ['inicio:1', 'fim:1', 'inicio:2', 'fim:2'], 'execução sequencial');
  const t1 = background.obterTarefa(id1);
  assert.strictEqual(t1.estado, 'concluido');
  assert.strictEqual(t1.progresso.fases.trabalho.estado, 'concluido');

  // 4. Erro registado sem matar a fila.
  background.registar('teste_erro', async () => {
    throw new Error('falha controlada');
  });
  const idErr = background.enqueue('teste_erro', {});
  await aguardarCondicao(() => {
    const e = background.obterTarefa(idErr);
    return e && e.estado === 'erro';
  });
  assert.ok(background.obterTarefa(idErr).erro.includes('falha controlada'), 'erro registado');
  const resumo = background.resumo();
  assert.ok(typeof resumo.ativas === 'number' && typeof resumo.emErro === 'number', 'resumo disponível');

  console.log('✓ Testes de processamento em segundo plano passaram (sem rede).');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
