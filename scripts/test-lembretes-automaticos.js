// ─────────────────────────────────────────────────────────────────────
// Lembretes de vencimento e avisos de atraso (`jobs/automatizacao.js`).
//
// O que este teste morde:
//   1. as datas da janela são calculadas em componentes LOCAIS — o defeito
//      antigo (`toISOString()` sobre meia-noite local) recuava o dia em fusos a
//      leste de UTC e fazia os «dias configuráveis» valerem um dia a menos;
//   2. a janela é RELATIVA e LIMITADA: recupera dias perdidos (paragem, deploy)
//      sem varrer o histórico inteiro;
//   3. o MARCADOR na fila impede o reenvio (a janela relativa mantém a mesma
//      quota dentro dela amanhã);
//   4. o assunto enviado e a chave do marcador são o MESMO valor — reescrever um
//      isoladamente volta a enviar.
//
// Corre em `Europe/Lisbon` (offset +1) para o desvio de dia ser OBSERVÁVEL mesmo
// numa máquina em UTC. As dependências de BD são substituídas por um duplo que
// HONRA o `where` (inclusive `Op.or`/`Op.between`): um duplo que ignore os
// filtros dá falsos verdes.
// ─────────────────────────────────────────────────────────────────────
process.env.TZ = 'Europe/Lisbon';

const assert = require('assert');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const { Op } = require('sequelize');
const { toDateInput, somarDias } = require(path.join(RAIZ, 'helpers', 'dates'));

const DIAS_LEMBRETE = 5; // omissão de `lembrete_dias` (o duplo devolve null ⇒ fallback)
const DIAS_ATRASO = 3; // omissão de `atraso_dias`
const DIAS_RECUPERACAO = 7; // folga da janela de atraso

let verificacoes = 0;
function ok(mensagem) {
  verificacoes++;
  console.log(`  ✓ ${mensagem}`);
}

// ── mini-BD: aplica os operadores que o job usa e FALHA no que não modela ──
const OPERADORES = [Op.ne, Op.in, Op.between, Op.lte, Op.gte];

function casaOperador(valor, cond) {
  if (cond === null || cond === undefined || typeof cond !== 'object' || cond instanceof Date) {
    return valor === cond;
  }
  const simbolos = Object.getOwnPropertySymbols(cond);
  const tratados = OPERADORES.filter((s) => s in cond);
  if (simbolos.length !== tratados.length) {
    throw new Error(
      `o duplo não modela ${simbolos.map(String).join(', ')} — não pode passar por omissão`
    );
  }
  if (Op.ne in cond && valor === cond[Op.ne]) return false;
  if (Op.in in cond && !cond[Op.in].map(String).includes(String(valor))) return false;
  if (Op.between in cond) {
    const [a, b] = cond[Op.between];
    if (String(valor) < String(a) || String(valor) > String(b)) return false;
  }
  if (Op.lte in cond && String(valor) > String(cond[Op.lte])) return false;
  if (Op.gte in cond && String(valor) < String(cond[Op.gte])) return false;
  return true;
}

function aplicarWhere(linha, where) {
  for (const [chave, cond] of Object.entries(where)) {
    if (!casaOperador(linha[chave], cond)) return false;
  }
  const ou = where[Op.or];
  if (Array.isArray(ou) && !ou.some((sub) => aplicarWhere(linha, sub))) return false;
  return true;
}

// ── duplos + execução do job ─────────────────────────────────────────
async function correrJob({ quotas, fila = [], condominios = [1, 2], preferenciaAtraso = true }) {
  const capturado = { filtrosQuota: [], whereMarcador: null, enfileirados: [], destinatarios: [] };

  const fakeModels = {
    Configuracao: { async findOne() { return null; } },
    Condominio: { async findAll() { return condominios.map((id) => ({ id })); } },
    Fracao: {},
    Quota: {
      async findAll({ where }) {
        capturado.filtrosQuota.push(where);
        return quotas.filter((q) => aplicarWhere(q, where));
      },
    },
    EmailFila: {
      async findAll({ where }) {
        capturado.whereMarcador = where;
        return fila.filter((f) => aplicarWhere(f, where));
      },
    },
  };

  const caminhos = {
    models: require.resolve(path.join(RAIZ, 'models')),
    avisos: require.resolve(path.join(RAIZ, 'helpers', 'avisos')),
    fila: require.resolve(path.join(RAIZ, 'helpers', 'email-fila')),
    notif: require.resolve(path.join(RAIZ, 'helpers', 'notificacoes')),
    job: require.resolve(path.join(RAIZ, 'jobs', 'automatizacao')),
  };
  const originais = {};
  for (const [chave, caminho] of Object.entries(caminhos)) originais[chave] = require.cache[caminho];

  const duplo = (id, exports) => ({ id, filename: id, loaded: true, children: [], paths: [], exports });

  require.cache[caminhos.models] = duplo('models', fakeModels);
  require.cache[caminhos.avisos] = duplo('avisos', {
    async resolverDestinatarios(selecao, condominioId) {
      capturado.destinatarios.push({ selecao, condominioId });
      if (!condominioId) throw new Error('destinatários resolvidos SEM âmbito de condomínio');
      return [{ pessoa_id: 1, email: `t${condominioId}@exemplo.pt`, nome: `Titular ${condominioId}` }];
    },
  });
  require.cache[caminhos.fila] = duplo('fila', {
    async enfileirarEmail(payload) {
      capturado.enfileirados.push(payload);
      return payload;
    },
  });
  require.cache[caminhos.notif] = duplo('notif', {
    async estaAtivo() { return preferenciaAtraso; },
  });
  delete require.cache[caminhos.job];

  let resultado;
  try {
    const job = require('../jobs/automatizacao');
    resultado = await job.enviarLembretesAutomaticos();
  } finally {
    for (const [chave, caminho] of Object.entries(caminhos)) {
      if (originais[chave]) require.cache[caminho] = originais[chave];
      else delete require.cache[caminho];
    }
  }

  return { resultado, ...capturado };
}

// ── cenário base ─────────────────────────────────────────────────────
const hoje = new Date();
hoje.setHours(0, 0, 0, 0);
const dia = (n) => toDateInput(somarDias(hoje, n));

const q = (id, condominio_id, venc, estado = 'pendente') => ({
  id,
  condominio_id,
  fracao_id: 100 + id,
  ano: hoje.getFullYear(),
  mes: hoje.getMonth() + 1,
  valor: '60.00',
  data_vencimento: venc,
  estado,
  fracao: { designacao: `F-${id}` },
});

const QUOTAS = [
  q(1, 1, dia(5)), // limite SUPERIOR da janela do lembrete
  q(2, 1, dia(6)), // fora: mais do que lembrete_dias
  q(3, 1, dia(-3)), // limite SUPERIOR da janela de atraso
  q(4, 1, dia(-10)), // limite INFERIOR da janela de atraso (atraso + recuperação)
  q(5, 1, dia(-11)), // fora: para lá da folga de recuperação
  q(6, 1, dia(2)), // lembrete normal
  q(7, 1, dia(-1)), // atrasado, mas ainda não chegou a atraso_dias
  q(8, 1, dia(0)), // vence HOJE ⇒ lembrete, não atraso
  q(9, 2, dia(3)), // outro condomínio (isolamento)
  q(10, 1, dia(3), 'paga'), // estado fora da lista ⇒ nunca é considerado
];

const filaDe = (entidade_id, assunto, estado = 'enviado') => ({
  entidade_tipo: 'Quota',
  entidade_id,
  assunto,
  estado,
});

const ASSUNTO_LEMBRETE = 'Lembrete de vencimento da quota';
const ASSUNTO_ATRASO = 'Aviso de atraso — quota em dívida';

function idsEnfileirados(r) {
  return [...new Set(r.enfileirados.map((e) => Number(e.entidade_id)))].sort((a, b) => a - b);
}

(async () => {
  console.log('\nLembretes e avisos de atraso — janela relativa, marcador e fuso local\n');

  // ── 1. O teste corre mesmo num fuso POSITIVO (senão o desvio não é observável)
  assert.strictEqual(
    new Date(2026, 8, 22).getTimezoneOffset(),
    -60,
    'o teste exige um fuso a leste de UTC (Europe/Lisbon) para o desvio de dia ser observável'
  );
  ok('o teste corre em Europe/Lisbon (offset +1) — o desvio de dia é observável');

  // ── 2. A janela é calculada em componentes LOCAIS (o defeito antigo)
  const base = await correrJob({ quotas: QUOTAS });
  const onde = base.filtrosQuota[0];
  const [janelaLembrete, janelaAtraso] = onde[Op.or].map((b) => b.data_vencimento[Op.between]);

  assert.strictEqual(base.filtrosQuota.length, 1, 'uma única consulta de quotas');
  assert.ok(onde.condominio_id, 'a consulta continua limitada por condominio_id (nunca global)');

  assert.strictEqual(janelaLembrete[0], dia(0), 'o lembrete começa HOJE');
  assert.strictEqual(janelaLembrete[1], dia(DIAS_LEMBRETE), 'o lembrete acaba em hoje+lembrete_dias');
  assert.strictEqual(janelaAtraso[0], dia(-DIAS_ATRASO - DIAS_RECUPERACAO), 'o atraso começa em hoje-atraso-recuperação');
  assert.strictEqual(janelaAtraso[1], dia(-DIAS_ATRASO), 'o atraso acaba em hoje-atraso_dias');
  ok('a janela usa datas LOCAIS (hoje … hoje+5 · hoje−10 … hoje−3)');

  // O valor que o defeito antigo produzia: `toISOString()` sobre meia-noite local.
  const deslocado = somarDias(hoje, DIAS_LEMBRETE).toISOString().slice(0, 10);
  assert.notStrictEqual(
    janelaLembrete[1],
    deslocado,
    'a janela NÃO pode usar o dia deslocado do `toISOString()` (era o defeito: hoje+4 em vez de hoje+5)'
  );
  assert.strictEqual(deslocado, dia(DIAS_LEMBRETE - 1), 'o valor antigo era exatamente um dia a menos');
  ok('o dia deslocado do `toISOString()` (hoje+4) ficou de fora — o desvio de um dia está corrigido');

  // ── 3. Seleção: limites incluídos, fora da folga excluído, estado excluído
  assert.deepStrictEqual(
    idsEnfileirados(base),
    [1, 3, 4, 6, 8, 9],
    'só entram as quotas dentro das duas janelas e com estado elegível'
  );
  assert.strictEqual(base.resultado.alvos, 6, 'a consulta devolve os 6 candidatos (a 10 está paga, a 2/5/7 fora)');
  ok('limites incluídos, fora da folga excluído (a 5, a −11, não gera aviso) e a `paga` nunca entra');

  // ── 4. Lembrete vs atraso, pela data de vencimento
  const assuntoDe = (id) => base.enfileirados.find((e) => Number(e.entidade_id) === id).assunto;
  for (const id of [1, 6, 8, 9]) assert.strictEqual(assuntoDe(id), ASSUNTO_LEMBRETE, `quota ${id} é lembrete`);
  for (const id of [3, 4]) assert.strictEqual(assuntoDe(id), ASSUNTO_ATRASO, `quota ${id} é atraso`);
  ok('quota que vence hoje é lembrete (não atraso); atraso só depois de `atraso_dias`');

  // ── 5. Isolamento preservado
  const emailCond2 = base.enfileirados.find((e) => Number(e.condominioId) === 2);
  assert.ok(emailCond2, 'a quota do condomínio 2 é processada');
  assert.ok(
    base.enfileirados.every((e) => Number(e.condominioId) === 2 || Number(e.condominioId) === 1),
    'nenhum email sai sem condomínio'
  );
  assert.strictEqual(base.destinatarios.length, 6, 'destinatários resolvidos uma vez por quota candidata');
  ok('âmbito por condomínio preservado (o duplo recusa resolver destinatários sem âmbito)');

  // ── 6. O MARCADOR impede o reenvio
  const comMarcador = await correrJob({
    quotas: QUOTAS,
    fila: [
      filaDe(1, ASSUNTO_LEMBRETE, 'enviado'),
      filaDe(3, ASSUNTO_ATRASO, 'erro'), // um envio que falhou NÃO é ressuscitado
      filaDe(6, ASSUNTO_LEMBRETE, 'cancelado'), // nem um cancelado
      filaDe(4, ASSUNTO_ATRASO, 'a_enviar'), // em curso também bloqueia
    ],
  });
  assert.deepStrictEqual(idsEnfileirados(comMarcador), [8, 9], 'as quotas já despachadas não voltam a ser enviadas');
  assert.strictEqual(comMarcador.resultado.repetidos, 4, 'o resultado reporta quantas foram travadas pelo marcador');
  ok('marcador: `enviado`, `a_enviar`, `erro` e `cancelado` bloqueiam — nada é reenviado');

  // O marcador só olha para as quotas candidatas (nunca uma varredura global).
  const ondeMarcador = comMarcador.whereMarcador;
  assert.strictEqual(ondeMarcador.entidade_tipo, 'Quota', 'o marcador procura a ligação segura à quota');
  assert.ok(ondeMarcador.entidade_id[Op.in].every((id) => [1, 3, 4, 6, 8, 9].includes(Number(id))), 'o marcador é limitado às candidatas');
  ok('a consulta do marcador é limitada às quotas candidatas (não varre a fila inteira)');

  // ── 7. O assunto enviado É a chave do marcador (não podem divergir)
  const chavesDoMarcador = ondeMarcador.assunto[Op.in];
  for (const e of comMarcador.enfileirados) {
    assert.ok(
      chavesDoMarcador.includes(e.assunto),
      `o assunto «${e.assunto}» tem de estar na chave do marcador (${chavesDoMarcador.join(' / ')})`
    );
  }
  ok('o assunto enviado é o mesmo valor que a chave do marcador (reescrever um volta a enviar)');

  // ── 8. A preferência de notificação só trava o atraso
  const semAtraso = await correrJob({ quotas: QUOTAS, preferenciaAtraso: false });
  assert.deepStrictEqual(idsEnfileirados(semAtraso), [1, 6, 8, 9], 'com «Quotas em atraso → email» desligado só saem lembretes');
  ok('a preferência «Quotas em atraso → email» desligada não trava os lembretes de vencimento');

  // ── 9. Sem quotas candidatas, não há consulta ao marcador
  const vazio = await correrJob({ quotas: [q(2, 1, dia(6)), q(5, 1, dia(-11))] });
  assert.strictEqual(vazio.enfileirados.length, 0, 'nada fora da janela é enviado');
  assert.strictEqual(vazio.whereMarcador, null, 'sem candidatas não há consulta ao marcador');
  ok('sem candidatas: nenhum envio e nenhuma consulta ao marcador');

  console.log(`\n✓ Lembretes automáticos: ${verificacoes} verificações passaram (sem BD).`);
})().catch((e) => {
  console.error('\n✗ FALHA:', e.message);
  process.exit(1);
});
