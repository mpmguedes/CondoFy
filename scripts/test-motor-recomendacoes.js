// ═══════════════════════════════════════════════════════════════════
// Recomendações contextuais do portal — MOTOR (Fase 2G).
//
// O motor (`helpers/recomendacoes.js`) é a única camada que decide o que pode
// ser apresentado. Aqui exercita-se essa decisão SEM base de dados: as
// condições são funções puras e a dispensa é um mapa em memória.
//
// Uma dependência é substituída de propósito: o modelo `RecomendacaoEstado`
// (a parte que persiste a dispensa) não existe sem BD — a persistência é
// testada à parte, a sério, em scripts/test-rotas-recomendacoes.js.
//
// Utilização: node scripts/test-recomendacoes.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');

// Modelo em duplo: este teste não persiste nada.
const modelsPath = require.resolve(path.join(__dirname, '..', 'models'));
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: { RecomendacaoEstado: {} },
};

const rec = require('../helpers/recomendacoes');

const DIA = 24 * 60 * 60 * 1000;
const AGORA = Date.parse('2026-09-20T10:00:00.000Z');
const CHAVE_2FA = '2fa_ativo';

// ── 1. Utilizador com 2FA ativo → recomendação inexistente ─────────
function testeDoisFatoresAtivo() {
  const escolha = rec.escolher({ userId: 7, autenticado: true, twoFaAtivo: true }, {}, 1);
  assert.strictEqual(escolha.recomendacao, null, '2FA ativo: nenhuma recomendação');
  assert.strictEqual(escolha.total, 0, '2FA ativo: nada elegível');
  // Mesmo que exista um registo de dispensa antigo, o estado real manda.
  const comHistorico = rec.escolher(
    { userId: 7, autenticado: true, twoFaAtivo: true },
    { [CHAVE_2FA]: { dispensada_em: new Date(AGORA - 5 * DIA), dispensada_ate: new Date(AGORA - 2 * DIA) } }
  );
  assert.strictEqual(comHistorico.recomendacao, null, '2FA ativo: histórico de dispensa não ressuscita a recomendação');
  console.log('  ✓ 2FA ativo → não aparece');
}

// ── 2. Utilizador sem 2FA → elegível ──────────────────────────────
function testeSemDoisFatores() {
  const escolha = rec.escolher({ userId: 7, autenticado: true, twoFaAtivo: false, agora: AGORA }, {}, 1);
  assert.ok(escolha.recomendacao, 'sem 2FA: há recomendação');
  assert.strictEqual(escolha.recomendacao.id, CHAVE_2FA, 'sem 2FA: é a recomendação de segurança');
  assert.strictEqual(escolha.recomendacao.tipo, 'seguranca', 'sem 2FA: tipo segurança');
  assert.strictEqual(escolha.recomendacao.acao.url, '/conta/seguranca', 'ação aponta para a página de segurança existente');
  assert.strictEqual(escolha.recomendacao.dismissivel, true, 'a recomendação de 2FA pode ser dispensada');
  assert.strictEqual(escolha.total, 1, 'só há uma recomendação registada nesta fase');
  console.log('  ✓ sem 2FA → elegível (segurança, ação /conta/seguranca)');
}

// ── 3. Não autenticado / sem conta → nunca há recomendação ────────
function testeNaoAutenticado() {
  for (const ctx of [{}, { autenticado: false, userId: 7, twoFaAtivo: false }, { autenticado: true, twoFaAtivo: false }]) {
    const escolha = rec.escolher(ctx, {});
    assert.strictEqual(escolha.recomendacao, null, `contexto ${JSON.stringify(ctx)}: sem recomendação`);
  }
  console.log('  ✓ não autenticado (ou sem conta) → não existe recomendação');
}

// ── 4. Dispensa → deixa de aparecer ───────────────────────────────
function testeDispensa() {
  const contexto = { userId: 7, autenticado: true, twoFaAtivo: false, agora: AGORA };
  const antes = rec.escolher(contexto, {});
  assert.ok(antes.recomendacao, 'antes de dispensar: aparece');

  const ate = rec.proximaApresentacao(rec.DIAS_REAPRESENTACAO_PADRAO, AGORA);
  assert.strictEqual(ate - AGORA, 30 * DIA, 'a dispensa dura 30 dias');

  const dispensas = { [CHAVE_2FA]: { dispensada_em: new Date(AGORA), dispensada_ate: new Date(ate), intervalo_dias: 30 } };
  const depois = rec.escolher(contexto, dispensas);
  assert.strictEqual(depois.recomendacao, null, 'depois de dispensar: não aparece');
  console.log('  ✓ dispensar esconde a recomendação');
}

// ── 5. Ainda dentro dos 30 dias → continua escondida ──────────────
function testeDentroDoIntervalo() {
  const dispensas = { [CHAVE_2FA]: { dispensada_em: new Date(AGORA), dispensada_ate: new Date(AGORA + 30 * DIA), intervalo_dias: 30 } };
  for (const diasDecorridos of [0, 1, 10, 29]) {
    const escolha = rec.escolher(
      { userId: 7, autenticado: true, twoFaAtivo: false, agora: AGORA + diasDecorridos * DIA },
      dispensas
    );
    assert.strictEqual(escolha.recomendacao, null, `passados ${diasDecorridos} dia(s): continua escondida`);
  }
  console.log('  ✓ dentro do intervalo → continua escondida');
}

// ── 6. Passado o intervalo → volta a ser elegível ─────────────────
function testeDepoisDoIntervalo() {
  const dispensas = { [CHAVE_2FA]: { dispensada_em: new Date(AGORA), dispensada_ate: new Date(AGORA + 30 * DIA), intervalo_dias: 30 } };
  const noLimite = rec.escolher({ userId: 7, autenticado: true, twoFaAtivo: false, agora: AGORA + 30 * DIA }, dispensas);
  assert.ok(noLimite.recomendacao, 'ao fim de exatamente 30 dias: volta a aparecer');
  const muitoDepois = rec.escolher({ userId: 7, autenticado: true, twoFaAtivo: false, agora: AGORA + 400 * DIA }, dispensas);
  assert.ok(muitoDepois.recomendacao, 'muito depois: continua elegível (2FA ainda desligado)');
  assert.strictEqual(rec.podeDispensar(CHAVE_2FA), true, 'pode ser dispensada novamente');
  console.log('  ✓ passado o intervalo → volta a aparecer');
}

// ── 7. Ativação do 2FA → desaparece independentemente do histórico ─
function testeAtivacaoVenceHistorico() {
  const dispensas = { [CHAVE_2FA]: { dispensada_em: new Date(AGORA), dispensada_ate: new Date(AGORA + 30 * DIA), intervalo_dias: 30 } };
  const aindaEscondidaMasInativa = rec.escolher({ userId: 7, autenticado: true, twoFaAtivo: false, agora: AGORA + DIA }, dispensas);
  assert.strictEqual(aindaEscondidaMasInativa.recomendacao, null, 'enquanto desligado e dispensado: escondida');
  const ativado = rec.escolher({ userId: 7, autenticado: true, twoFaAtivo: true, agora: AGORA + DIA }, dispensas);
  assert.strictEqual(ativado.recomendacao, null, 'ativado: desaparece mesmo com dispensa em vigor');
  // Caso central: dispensa JÁ EXPIRADA + 2FA ativo → continua sem aparecer.
  const expirada = { [CHAVE_2FA]: { dispensada_em: new Date(AGORA - 60 * DIA), dispensada_ate: new Date(AGORA - 30 * DIA), intervalo_dias: 30 } };
  const ativadoComDispensaExpirada = rec.escolher({ userId: 7, autenticado: true, twoFaAtivo: true, agora: AGORA }, expirada);
  assert.strictEqual(ativadoComDispensaExpirada.recomendacao, null,
    'ativado não aparece, mesmo com a dispensa já terminada');
  console.log('  ✓ 2FA ativado → deixa de aparecer (o estado real vence o histórico)');
}

// ── 8. Condomínio: a recomendação é da CONTA, não do condomínio ───
function testeIndependeDoCondominio() {
  // O contexto do motor não tem condomínio: dispensar num condomínio esconde no
  // outro, e não há forma de «perder» a dispensa ao mudar de condomínio.
  const dispensas = { [CHAVE_2FA]: { dispensada_em: new Date(AGORA), dispensada_ate: new Date(AGORA + 30 * DIA), intervalo_dias: 30 } };
  for (const contexto of [
    { userId: 7, autenticado: true, twoFaAtivo: false, agora: AGORA, condominioId: 1 },
    { userId: 7, autenticado: true, twoFaAtivo: false, agora: AGORA, condominioId: 2 },
    { userId: 7, autenticado: true, twoFaAtivo: false, agora: AGORA, condominioId: null },
  ]) {
    const escolha = rec.escolher(contexto, dispensas);
    assert.strictEqual(escolha.recomendacao, null, `condomínio ${contexto.condominioId}: a dispensa continua a valer`);
  }
  // E a elegibilidade também não depende de haver condomínio ativo.
  const semCondominio = rec.escolher({ userId: 7, autenticado: true, twoFaAtivo: false, agora: AGORA, condominioId: null }, {});
  assert.ok(semCondominio.recomendacao, 'sem condomínio ativo: a recomendação da conta continua elegível');
  console.log('  ✓ a recomendação é da conta (não muda com o condomínio)');
}

// ── 9. Recomendação inválida/manipulada ───────────────────────────
function testeIdentificadorInvalido() {
  for (const id of ['', 'inexistente', '../../etc/passwd', 'https://exemplo.pt', '2FA_ATIVO', '2fa_ativo ', null, undefined, 'constructor']) {
    assert.strictEqual(rec.porId(id), null, `id «${String(id)}» não corresponde a nenhuma recomendação`);
    assert.strictEqual(rec.podeDispensar(id), false, `id «${String(id)}» não pode ser dispensado`);
  }
  // A ação NUNCA vem do browser: o resultado do motor tem sempre a ação fixa.
  const escolha = rec.escolher({ userId: 7, autenticado: true, twoFaAtivo: false }, {});
  assert.strictEqual(escolha.recomendacao.acao.url, '/conta/seguranca', 'a ação vem da definição, não de um parâmetro');
  assert.ok(!/^https?:/.test(escolha.recomendacao.acao.url), 'a ação é sempre interna');
  console.log('  ✓ identificador inválido/manipulado → recusado, sem ação arbitrária');
}

// ── 10. Outras recomendações não aparecem por dados inventados ────
function testeSemRecomendacoesInventadas() {
  // Só existe uma recomendação registada nesta fase: nada de «perfil incompleto»
  // nem de «documentos novos» (isso exigiria estado de leitura que não existe).
  const definicoes = rec.definicoes();
  assert.strictEqual(definicoes.length, 1, 'uma só recomendação registada nesta fase');
  assert.deepStrictEqual(definicoes.map((d) => d.id), [CHAVE_2FA], 'a recomendação registada é a de 2FA');
  const idsProibidos = ['perfil_incompleto', 'documentos_novos', 'avisos_novos', 'assembleia_proxima'];
  for (const proibido of idsProibidos) {
    assert.strictEqual(rec.porId(proibido), null, `não existe recomendação inventada «${proibido}»`);
  }
  // Todos os tipos usados têm prioridade definida (ordenação previsível).
  for (const d of definicoes) {
    assert.ok(rec.PRIORIDADE[d.tipo] > 0, `tipo ${d.tipo} tem prioridade definida`);
  }
  console.log('  ✓ nenhuma recomendação inventada (só as que têm dados reais)');
}

// ── 11. Prioridade: uma só recomendação apresentada ───────────────
function testePrioridade() {
  // Regra de prioridade do motor, exercitada com definições de exemplo.
  assert.ok(rec.PRIORIDADE.seguranca > rec.PRIORIDADE.conclusao, 'segurança acima de tarefa por concluir');
  assert.ok(rec.PRIORIDADE.conclusao > rec.PRIORIDADE.contextual, 'tarefa acima de informação contextual');
  assert.ok(rec.PRIORIDADE.contextual > rec.PRIORIDADE.educativa, 'informação acima de dica educativa');

  // Ordenação: injeta-se uma segunda recomendação no registo real (e remove-se
  // no fim) para provar que só a de maior prioridade é apresentada.
  const extra = {
    id: 'teste_contextual',
    tipo: 'contextual',
    dismissivel: false,
    titulo: 'Teste contextual',
    condicao: () => ({ mensagem: 'Teste' }),
    acao: { texto: 'Ver', url: '/condomino/avisos' },
  };
  rec.REGISTO.push(extra);
  try {
    const escolha = rec.escolher({ userId: 7, autenticado: true, twoFaAtivo: false, agora: AGORA }, {});
    assert.strictEqual(escolha.total, 2, 'duas recomendações elegíveis');
    assert.strictEqual(escolha.recomendacao.id, CHAVE_2FA, 'apresenta-se a de maior prioridade (segurança)');
    assert.deepStrictEqual(escolha.outras.map((r) => r.id), ['teste_contextual'], 'a outra fica em segundo plano, sem cartão');
    assert.strictEqual(escolha.recomendacao.dismissivel, true, 'a principal é dispensável');
    // Não dispensável continua a aparecer mesmo que exista um registo.
    const comRegisto = rec.escolher({ userId: 7, autenticado: true, twoFaAtivo: false, agora: AGORA },
      { teste_contextual: { dispensada_ate: new Date(AGORA + 30 * DIA) } });
    assert.strictEqual(comRegisto.total, 2, 'recomendação não dispensável ignora o registo de dispensa');
    assert.strictEqual(rec.podeDispensar('teste_contextual'), false, 'não dispensável não pode ser dispensada');
  } finally {
    rec.REGISTO.pop();
  }
  console.log('  ✓ prioridade: apresenta-se só uma (a mais prioritária)');
}

// ── 12. Registo de dispensa robusto (campo em falta / valores estranhos) ──
function testeRegistosRobustos() {
  // Registo antigo, sem `dispensada_ate`: calcula-se pelo intervalo.
  const antigo = { dispensada_em: new Date(AGORA), intervalo_dias: 30 };
  assert.strictEqual(rec.estaDispensada(antigo, AGORA + 10 * DIA), true, 'sem `dispensada_ate`, usa `dispensada_em` + intervalo');
  assert.strictEqual(rec.estaDispensada(antigo, AGORA + 31 * DIA), false, 'passado o intervalo calculado, deixa de esconder');
  // Valores estranhos não escondem nada (nunca esconder por engano).
  assert.strictEqual(rec.estaDispensada({ dispensada_em: 'não é uma data' }, AGORA), false, 'data inválida não esconde');
  assert.strictEqual(rec.estaDispensada(null, AGORA), false, 'sem registo não esconde');
  assert.strictEqual(rec.estaDispensada({ dispensada_ate: null, dispensada_em: null }, AGORA), false, 'registo vazio não esconde');
  // Dispensa sem intervalo válido usa o intervalo por omissão.
  assert.strictEqual(rec.proximaApresentacao(0, AGORA) - AGORA, rec.DIAS_REAPRESENTACAO_PADRAO * DIA, 'intervalo 0 usa o por omissão');
  assert.strictEqual(rec.proximaApresentacao('x', AGORA) - AGORA, rec.DIAS_REAPRESENTACAO_PADRAO * DIA, 'intervalo inválido usa o por omissão');
  assert.strictEqual(rec.DIAS_REAPRESENTACAO_PADRAO, 30, 'o intervalo por omissão é de 30 dias');
  console.log('  ✓ registo de dispensa robusto (nunca esconde por engano)');
}

// ── 13. Persistência recusa registos inválidos ────────────────────
async function testePersistenciaInvalida() {
  const vazio = await rec.carregarDispensas(null);
  assert.deepStrictEqual(vazio, {}, 'sem conta não há dispensas');
  const invalido = await rec.registarDispensa({ userId: null, recomendacao: CHAVE_2FA });
  assert.strictEqual(invalido.ok, false, 'sem conta não se regista dispensa');
  const desconhecido = await rec.registarDispensa({ userId: 7, recomendacao: 'inexistente' });
  assert.strictEqual(desconhecido.ok, false, 'recomendação desconhecida não é registada');
  console.log('  ✓ persistência recusa registos inválidos');
}

(async () => {
  testeDoisFatoresAtivo();
  testeSemDoisFatores();
  testeNaoAutenticado();
  testeDispensa();
  testeDentroDoIntervalo();
  testeDepoisDoIntervalo();
  testeAtivacaoVenceHistorico();
  testeIndependeDoCondominio();
  testeIdentificadorInvalido();
  testeSemRecomendacoesInventadas();
  testePrioridade();
  testeRegistosRobustos();
  await testePersistenciaInvalida();
  console.log('✓ Testes do motor de recomendações passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
