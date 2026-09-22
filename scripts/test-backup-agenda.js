// ═══════════════════════════════════════════════════════════════════
// Agenda dos backups automáticos (sem rede, sem BD, sem cron real)
//
// Contexto: `backup_logs.tipo` sempre aceitou `diario | semanal | mensal |
// manual`, mas só o `diario` corria no cron — `semanal` e `mensal` existiam no
// ENUM e nunca eram disparados. Este teste prova as TRÊS metades:
//
//  1. a decisão pura (`helpers/backup-agenda.js`): validação, valores por
//     omissão e o plano para cada combinação de ambiente;
//  2. a VALIDADE das expressões para o `node-cron` REAL — o duplo usado na
//     secção 4 aceita qualquer string, pelo que só aqui se prova que as três
//     expressões são registáveis. O semanal saía `0 3 * * SU` e o
//     `cron.schedule` REAL lançava «SU is a invalid expression for week day»,
//     abortando o registo das tarefas seguintes (o `mensal` nunca era agendado);
//  3. a LIGAÇÃO (`jobs/scheduler.js`): com `node-cron` e os jobs substituídos
//     por duplos, o que o `iniciar()` regista é exatamente o plano — e disparar
//     cada tarefa chama `executarBackup` com o TIPO certo.
//
// `manual` NÃO é agendado (dispara-se à mão): o teste falha se aparecer.
//
// Utilização: node scripts/test-backup-agenda.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');

const agenda = require('../helpers/backup-agenda');

// ── 1. Validação dos valores de ambiente ────────────────────────────
function testarValidacao() {
  // Hora: 0–23; tudo o resto cai no valor por omissão (nunca se inventa uma
  // hora a partir de lixo — uma expressão cron inválida nunca é registada).
  assert.strictEqual(agenda.normalizarHora('0'), 0);
  assert.strictEqual(agenda.normalizarHora('23'), 23);
  assert.strictEqual(agenda.normalizarHora(' 7 '), 7, 'espaços tolerados');
  for (const mau of ['24', '-1', '3.5', 'abc', '', null, undefined, 'NaN']) {
    assert.strictEqual(agenda.normalizarHora(mau), agenda.HORA_PADRAO, `hora inválida (${JSON.stringify(mau)}) → ${agenda.HORA_PADRAO}`);
  }

  // Dia da semana: nomes de 3 letras (case-insensitive) ou 0–6. ⛔ O valor
  // DEVOLVIDO é sempre o NÚMERO — é o único formato que o node-cron aceita.
  assert.strictEqual(agenda.normalizarDiaSemanal('SU'), '0', 'nome convertido para número');
  assert.strictEqual(agenda.normalizarDiaSemanal('we'), '3', 'minúsculas aceites');
  assert.strictEqual(agenda.normalizarDiaSemanal('6'), '6', '0=domingo … 6=sábado');
  assert.strictEqual(agenda.normalizarDiaSemanal('0'), '0');
  for (const mau of ['7', '-1', 'segunda', '', null, undefined]) {
    assert.strictEqual(agenda.normalizarDiaSemanal(mau), agenda.DIA_SEMANAL_PADRAO, `dia da semana inválido (${JSON.stringify(mau)}) → ${agenda.DIA_SEMANAL_PADRAO}`);
  }
  // O padrão é `0` (domingo) e TODO o vocabulário de saída é numérico: um nome
  // de 3 letras a chegar à expressão fazia `cron.schedule` lançar.
  assert.strictEqual(agenda.DIA_SEMANAL_PADRAO, '0', 'o padrão do dia semanal é 0 (domingo)');
  for (const dia of agenda.DIAS_SEMANA) {
    assert.ok(/^[0-6]$/.test(dia), `DIAS_SEMANA só contém números (recebido ${JSON.stringify(dia)})`);
  }

  // Dia do mês: 1–28. ⛔ O 29–31 é recusado de propósito: esses dias não
  // existem em todos os meses (um backup a 31 nunca corria em fevereiro).
  assert.strictEqual(agenda.normalizarDiaMensal('1'), 1);
  assert.strictEqual(agenda.normalizarDiaMensal('28'), 28);
  for (const mau of ['29', '31', '0', '-3', '1.5', 'abc', '', null, undefined]) {
    assert.strictEqual(agenda.normalizarDiaMensal(mau), agenda.DIA_MENSAL_PADRAO, `dia do mês inválido (${JSON.stringify(mau)}) → 1`);
  }
  assert.strictEqual(agenda.DIA_MENSAL_MAXIMO, 28, 'o máximo do dia mensal é 28');

  // Ligar/desligar um ciclo.
  assert.strictEqual(agenda.ativo(undefined, true), true, 'ausente → defeito');
  assert.strictEqual(agenda.ativo('', true), true, 'vazio → defeito');
  for (const desligado of ['0', 'false', 'FALSE', 'no', 'nao', 'não', 'off']) {
    assert.strictEqual(agenda.ativo(desligado, true), false, `"${desligado}" desliga`);
  }
  for (const ligado of ['1', 'true', 'yes', 'sim', 'on']) {
    assert.strictEqual(agenda.ativo(ligado, false), true, `"${ligado}" liga`);
  }
  assert.strictEqual(agenda.ativo('talvez', true), true, 'valor desconhecido → defeito');
}

// ── 2. Expressões cron ──────────────────────────────────────────────
function testarExpressoes() {
  const e = agenda.expressoes({ hora: 3, diaSemanal: 'SU', diaMensal: 1 });
  assert.strictEqual(e.diario, '0 3 * * *');
  assert.strictEqual(e.semanal, '0 3 * * 0', 'domingo NUMÉRICO — o node-cron rejeita `SU`');
  assert.strictEqual(e.mensal, '0 3 1 * *');
  // Os três campos cron têm exatamente 5 partes (minuto hora dia mês semana).
  for (const [nome, expressao] of Object.entries(e)) {
    assert.strictEqual(expressao.split(' ').length, 5, `${nome}: 5 campos cron`);
  }
  // Sem argumentos usam-se os valores por omissão (03:00, domingo, dia 1).
  assert.deepStrictEqual(agenda.expressoes(), e, 'por omissão = 03:00 · 0 (domingo) · dia 1');
  assert.deepStrictEqual(agenda.expressoes({}), e, 'objeto vazio = por omissão');
}

// ── 3. As expressões são aceites pelo `node-cron` REAL ──────────────
// ⛔ Esta secção existe porque a secção 4 substitui o `node-cron` por um duplo
// que aceita qualquer string: sem ela, um dia da semana inválido (`0 3 * * SU`)
// passava despercebido — foi exatamente o defeito corrigido.
function testarNodeCronReal() {
  const cron = require('node-cron');
  assert.strictEqual(typeof cron.validate, 'function', 'node-cron real disponível');
  assert.strictEqual(typeof cron.schedule, 'function', 'node-cron real disponível');

  // As três expressões do plano por omissão são válidas…
  const plano = agenda.plano({});
  assert.strictEqual(plano.length, 3, 'por omissão: diário + semanal + mensal');
  for (const t of plano) {
    assert.strictEqual(cron.validate(t.expressao), true, `node-cron aceita ${t.tipo}: «${t.expressao}»`);
  }

  // …e `schedule()` REAL não lança para nenhuma delas (é o que o agendador faz
  // no arranque). `scheduled: false` cria a tarefa sem a pôr a correr.
  const tarefas = [];
  try {
    for (const t of plano) tarefas.push(cron.schedule(t.expressao, () => {}, { scheduled: false }));
    assert.strictEqual(tarefas.length, 3, 'as três tarefas foram instanciadas sem lançar');
  } finally {
    for (const t of tarefas) t.stop();
  }

  // Todas as variações de ambiente continuam registáveis.
  const ambientes = [
    {},
    { BACKUP_HOUR: '0' },
    { BACKUP_HOUR: '23' },
    { BACKUP_WEEKLY_DAY: 'SU' },
    { BACKUP_WEEKLY_DAY: 'MO' },
    { BACKUP_WEEKLY_DAY: 'we' },
    { BACKUP_WEEKLY_DAY: '6' },
    { BACKUP_MONTHLY_DAY: '28' },
    { BACKUP_HOUR: '5', BACKUP_WEEKLY_DAY: 'WE', BACKUP_MONTHLY_DAY: '15' },
    { BACKUP_HOUR: '99', BACKUP_WEEKLY_DAY: 'XX', BACKUP_MONTHLY_DAY: '31' },
  ];
  for (const env of ambientes) {
    for (const t of agenda.plano(env)) {
      assert.strictEqual(cron.validate(t.expressao), true, `node-cron aceita ${t.tipo} com ${JSON.stringify(env)}: «${t.expressao}»`);
    }
  }

  // ⛔ PROVA DE QUE O TESTE MORDE: o formato antigo (nome de 3 letras) é
  // REJEITADO pelo node-cron real — era precisamente o defeito.
  for (const nome of ['SU', 'MO', 'WE']) {
    assert.strictEqual(cron.validate(`0 3 * * ${nome}`), false, `node-cron rejeita o nome «${nome}» (formato antigo)`);
  }
  assert.throws(
    () => cron.schedule('0 3 * * SU', () => {}),
    /invalid expression for week day/,
    'o formato antigo lançava ao agendar (era o defeito em produção)'
  );
}

// ── 4. Plano (o que o agendador regista) ────────────────────────────
function testarPlano() {
  // Por omissão: os três ciclos, todos à mesma hora.
  assert.deepStrictEqual(agenda.plano({}), [
    { tipo: 'diario', expressao: '0 3 * * *' },
    { tipo: 'semanal', expressao: '0 3 * * 0' },
    { tipo: 'mensal', expressao: '0 3 1 * *' },
  ], 'por omissão: diário + semanal + mensal');

  // Hora e dias configurados.
  assert.deepStrictEqual(agenda.plano({ BACKUP_HOUR: '5', BACKUP_WEEKLY_DAY: 'MO', BACKUP_MONTHLY_DAY: '10' }), [
    { tipo: 'diario', expressao: '0 5 * * *' },
    { tipo: 'semanal', expressao: '0 5 * * 1' },
    { tipo: 'mensal', expressao: '0 5 10 * *' },
  ], 'hora e dias respeitados');

  // Desligar o semanal não mexe no mensal nem no diário.
  assert.deepStrictEqual(agenda.plano({ BACKUP_WEEKLY_ENABLED: '0' }), [
    { tipo: 'diario', expressao: '0 3 * * *' },
    { tipo: 'mensal', expressao: '0 3 1 * *' },
  ], 'semanal desligado');

  // Desligar os dois: só o diário (o diário corre SEMPRE).
  assert.deepStrictEqual(agenda.plano({ BACKUP_WEEKLY_ENABLED: 'false', BACKUP_MONTHLY_ENABLED: 'false' }), [
    { tipo: 'diario', expressao: '0 3 * * *' },
  ], 'só o diário');

  // `manual` NUNCA é agendado — em nenhuma combinação.
  for (const env of [{}, { BACKUP_WEEKLY_ENABLED: '0' }, { BACKUP_MONTHLY_ENABLED: '0' }, { BACKUP_HOUR: '9' }]) {
    assert.ok(!agenda.plano(env).some((t) => t.tipo === 'manual'), 'manual nunca entra no plano');
  }

  // Valores inválidos não produzem expressões inválidas.
  const comLixo = agenda.plano({ BACKUP_HOUR: '99', BACKUP_WEEKLY_DAY: 'XX', BACKUP_MONTHLY_DAY: '31' });
  assert.deepStrictEqual(comLixo.map((t) => t.expressao), ['0 3 * * *', '0 3 * * 0', '0 3 1 * *'], 'valores inválidos caem nos defaults');
}

// ── 5. Ligação real: `jobs/scheduler.js` regista o plano ────────────
async function testarAgendador() {
  // Duplo do `node-cron`: captura as expressões registadas, sem agendar nada.
  // ⛔ Aceita QUALQUER expressão — a validade real é provada na secção 3.
  const cronPath = require.resolve('node-cron');
  const agendados = [];
  require.cache[cronPath] = {
    id: cronPath, filename: cronPath, loaded: true, children: [], paths: [],
    exports: {
      schedule: (expressao, fn) => {
        agendados.push({ expressao, fn });
        return { stop() {} };
      },
    },
  };
  // Duplos dos jobs: nenhum toca na BD, no email ou no dump.
  const chamadasBackup = [];
  const duplos = {
    '../helpers/email-fila': { processarFilaEmail: async () => ({ processados: 0 }) },
    '../jobs/automatizacao': { gerarQuotasAutomaticas: async () => ({}), enviarLembretesAutomaticos: async () => ({}) },
    '../jobs/backup': {
      executarBackup: async (tipo) => {
        chamadasBackup.push(tipo);
        return { tipo };
      },
    },
  };
  for (const [rel, valor] of Object.entries(duplos)) {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
  }

  const scheduler = require('../jobs/scheduler');

  const envAntes = {
    BACKUP_HOUR: process.env.BACKUP_HOUR,
    BACKUP_WEEKLY_DAY: process.env.BACKUP_WEEKLY_DAY,
    BACKUP_MONTHLY_DAY: process.env.BACKUP_MONTHLY_DAY,
    BACKUP_WEEKLY_ENABLED: process.env.BACKUP_WEEKLY_ENABLED,
    BACKUP_MONTHLY_ENABLED: process.env.BACKUP_MONTHLY_ENABLED,
  };
  try {
    // `planear()` é o plano que `iniciar()` regista (é a mesma função).
    process.env.BACKUP_HOUR = '4';
    process.env.BACKUP_WEEKLY_DAY = 'WE';
    process.env.BACKUP_MONTHLY_DAY = '15';
    delete process.env.BACKUP_WEEKLY_ENABLED;
    delete process.env.BACKUP_MONTHLY_ENABLED;
    assert.deepStrictEqual(scheduler.planear(), agenda.plano(process.env), 'planear() = plano da agenda');

    scheduler.iniciar();

    const expressoes = agendados.map((a) => a.expressao);
    // As três tarefas dos backups, com as expressões do plano.
    assert.ok(expressoes.includes('0 4 * * *'), 'diário agendado à hora configurada');
    assert.ok(expressoes.includes('0 4 * * 3'), 'semanal agendado no dia configurado (WE = 3)');
    assert.ok(expressoes.includes('0 4 15 * *'), 'mensal agendado no dia configurado');

    // Disparar TODAS as tarefas registadas: só as três dos backups chamam
    // `executarBackup`, e cada uma com o seu tipo.
    for (const a of agendados) a.fn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(chamadasBackup, ['diario', 'semanal', 'mensal'], 'cada tarefa dispara o ciclo do seu tipo');
    assert.ok(!chamadasBackup.includes('manual'), 'nenhum agendamento dispara o ciclo manual');

    // Desligar o semanal remove-o do agendamento (e o diário mantém-se).
    agendados.length = 0;
    process.env.BACKUP_WEEKLY_ENABLED = '0';
    scheduler.iniciar();
    const expressoes2 = agendados.map((a) => a.expressao);
    assert.ok(expressoes2.includes('0 4 * * *'), 'o diário continua agendado');
    assert.ok(!expressoes2.includes('0 4 * * 3'), 'o semanal desligado não é agendado');
    assert.ok(expressoes2.includes('0 4 15 * *'), 'o mensal não é afetado');
  } finally {
    for (const [k, v] of Object.entries(envAntes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

(async () => {
  testarValidacao();
  testarExpressoes();
  testarNodeCronReal();
  testarPlano();
  await testarAgendador();
  console.log('✓ Testes da agenda dos backups passaram (diário · semanal · mensal; manual fora da agenda; as três expressões aceites pelo node-cron real).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
