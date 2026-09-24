// Testes do P54-7 — âmbito por condomínio e proteção da gravação das
// preferências de notificações (sem base de dados).
//
// Utilização: node scripts/test-notificacoes-isolamento.js
//
// Porque é que estes testes existem. A gravação escrevia sempre a chave GLOBAL
// (`notif_<evento>_<canal>`), pelo que o administrador do condomínio A desligava
// (ou ligava) as notificações de TODOS os condomínios — o B incluído, que nunca
// tinha pedido nada. E como uma checkbox desmarcada não viaja no corpo do
// pedido, «campo ausente» era indistinguível de «formulário nunca submetido»:
// um POST direto desligava tudo em silêncio.
//
// Prova-se aqui, sem BD:
//  1. A e B podem ter preferências diferentes para o mesmo evento;
//  2. gravar em A não toca nas chaves de B nem na chave global;
//  3. sem preferência específica usa-se a chave herdada (global);
//  4. sem específica nem global usa-se o default do código;
//  5. a precedência é específica → global → default;
//  6. sem âmbito a gravação é RECUSADA (nunca escreve a chave global);
//  7. sem o marcador de submissão completa a gravação é RECUSADA (POST direto);
//  8. campos desconhecidos — incluindo um `condominioId` no corpo — são recusados;
//  9. uma execução SEM contexto de condomínio lê a chave herdada e NÃO é ativada
//     pelo que um condomínio gravou;
// 10. só se reportam como alteradas as chaves cujo EFEITO mudou;
// 11. a vista usa o padrão P54-0 (sem formulário próprio), o âmbito vem do
//     tenant e o job lê a preferência no âmbito da própria quota.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

// ── Duplo da tabela `configuracoes` (chave-valor) ───────────────────
// Guarda-se o registo COMPLETO das chaves escritas: é isso que prova que a
// gravação de um condomínio nunca toca nas chaves de outro nem na global.
const valores = {};
const escritas = [];
const configPath = require.resolve(path.join(RAIZ, 'helpers', 'config'));
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true, children: [], paths: [],
  exports: {
    getConfig: async (chave, defeito = null) => (chave in valores ? valores[chave] : defeito),
    setConfig: async (chave, valor) => {
      valores[chave] = String(valor);
      escritas.push(chave);
      return { chave, valor: String(valor) };
    },
  },
};

const {
  guardarPreferencias, listarPreferencias, estaAtivo, validarCorpo, MARCADOR,
} = require('../helpers/notificacoes');
const { idCondominio, chaveDoCondominio } = require('../helpers/config-ambito');

function limpar() {
  for (const k of Object.keys(valores)) delete valores[k];
  escritas.length = 0;
}

// Corpo de um formulário submetido por inteiro: o marcador acompanha sempre.
const comMarcador = (campos = {}) => ({ [MARCADOR]: '1', ...campos });

// ── 1. Dois condomínios, preferências diferentes ────────────────────
async function testeADiferenteDeB() {
  limpar();
  await guardarPreferencias(comMarcador({ notif_assembleias_email: 'on' }), 1);
  await guardarPreferencias(comMarcador({}), 2);

  assert.strictEqual(await estaAtivo('assembleias', 'email', 1), true,
    'A ligou «Assembleias → email»');
  assert.strictEqual(await estaAtivo('assembleias', 'email', 2), false,
    'B continua desligado — a gravação de A não o ativou');
  console.log('  ✓ A e B têm preferências diferentes para o mesmo evento');
}

// ── 2. A gravação de A não toca nas chaves de B nem na global ───────
async function testeNaoContamina() {
  limpar();
  valores['notif_assembleias_email'] = '1'; // valor herdado pré-existente

  await guardarPreferencias(comMarcador({}), 7);

  assert.strictEqual(valores['notif_assembleias_email'], '1',
    'a chave GLOBAL (herdada) nunca é reescrita por uma gravação de condomínio');
  assert.ok(escritas.length > 0, 'a gravação aconteceu');
  assert.ok(escritas.every((k) => k.endsWith(':c7')),
    `todas as chaves escritas têm o âmbito :c7 (obtido: ${escritas.filter((k) => !k.endsWith(':c7')).join(', ')})`);
  console.log('  ✓ gravar em A escreve só `:c<ID>` — a chave global e a de B ficam intactas');
}

// ── 3/4/5. Precedência: específica → global → default ──────────────
async function testePrecedencia() {
  limpar();
  // 3. sem específica, herda a global
  valores['notif_avisos_email'] = '0';
  assert.strictEqual(await estaAtivo('avisos', 'email', 3), false,
    'sem chave específica, herda a global desligada');
  // 5. a específica ganha à global
  valores['notif_avisos_email:c3'] = '1';
  assert.strictEqual(await estaAtivo('avisos', 'email', 3), true,
    'a chave específica do condomínio ganha à global');
  // 4. sem específica nem global, default do código
  assert.strictEqual(await estaAtivo('recibos', 'email', 4), true,
    'default do código: «Recibos → email» começa ativo');
  assert.strictEqual(await estaAtivo('quotas_novas', 'email', 4), false,
    'default do código: «Novas quotas → email» começa desligado');
  assert.strictEqual(await estaAtivo('recibos', 'drive', 4), false,
    'default do código: o canal Guardar começa sempre desligado');
  console.log('  ✓ precedência específica → global → default, com os defaults documentados');
}

// ── 6. Sem âmbito a gravação é recusada ────────────────────────────
async function testeSemAmbitoRecusa() {
  limpar();
  for (const mau of [undefined, null, 0, -1, 'abc', '', 1.5, NaN]) {
    await assert.rejects(
      () => guardarPreferencias(comMarcador({}), mau),
      /condominioId válido/,
      `âmbito inválido (${String(mau)}) tinha de ser recusado`
    );
  }
  assert.strictEqual(escritas.length, 0,
    'nenhuma escrita aconteceu — a chave global nunca é o destino de recurso');
  console.log('  ✓ sem âmbito válido a gravação é recusada e nada é escrito');
}

// ── 7. POST direto (sem marcador) é recusado ───────────────────────
async function testePostDiretoRecusa() {
  limpar();
  await assert.rejects(
    () => guardarPreferencias({ notif_recibos_email: 'on' }, 1),
    /completa/,
    'sem marcador de submissão completa a gravação tinha de ser recusada'
  );
  await assert.rejects(
    () => guardarPreferencias({}, 1),
    /completa/,
    'um corpo vazio também é uma submissão incompleta'
  );
  assert.strictEqual(escritas.length, 0,
    'um POST direto não desliga as preferências em silêncio');
  console.log('  ✓ sem marcador de submissão completa nada é gravado (POST direto neutralizado)');
}

// ── 8. Campos desconhecidos e condomínio pelo corpo ────────────────
async function testeCamposNaoPermitidos() {
  limpar();
  await assert.rejects(
    () => guardarPreferencias(comMarcador({ notif_inexistente_email: 'on' }), 1),
    /não reconhecido/,
    'um evento desconhecido tinha de ser recusado'
  );
  // ⛔ A tentativa de ESCOLHER o condomínio pelo corpo é recusada: o âmbito vem
  // sempre do tenant, nunca de um campo que o cliente controla.
  await assert.rejects(
    () => guardarPreferencias(comMarcador({ condominioId: '2', notif_recibos_email: 'on' }), 1),
    /não reconhecido/,
    'não se aceita o condomínio vindo do corpo do pedido'
  );
  assert.strictEqual(escritas.length, 0, 'nada foi escrito');
  assert.ok(!validarCorpo(comMarcador({ condominioId: '2' })).ok,
    'validarCorpo rejeita o campo condominioId');
  console.log('  ✓ campos desconhecidos e condomínio pelo corpo são recusados');
}

// ── 9. Execução SEM contexto de condomínio ─────────────────────────
async function testeSemContextoNaoEAtivado() {
  limpar();
  // A liga um evento cujo default é desligado.
  await guardarPreferencias(comMarcador({ notif_assembleias_email: 'on' }), 1);
  assert.strictEqual(await estaAtivo('assembleias', 'email', 1), true, 'A ficou ligado');

  // Leitura sem âmbito — o caso dos jobs globais (ex.: avisos programados).
  assert.strictEqual(await estaAtivo('assembleias', 'email'), false,
    'sem contexto de condomínio NÃO se herda a preferência de A');
  assert.strictEqual(await estaAtivo('assembleias', 'email', 2), false,
    'nem a de qualquer outro condomínio');

  // E continua a ler a chave herdada quando ela existe.
  valores['notif_assembleias_email'] = '1';
  assert.strictEqual(await estaAtivo('assembleias', 'email'), true,
    'sem contexto, a chave herdada (global) continua a valer');
  console.log('  ✓ execução sem contexto de condomínio lê a chave herdada — nunca a de um condomínio');
}

// ── 10. `alterados` só conta o que muda de EFEITO ──────────────────
async function testeAlterados() {
  limpar();
  const primeiro = await guardarPreferencias(comMarcador({ notif_recibos_email: 'on' }), 1);
  assert.ok(!primeiro.alterados.includes('notif_recibos_email'),
    'gravar o valor que já era efetivo (default ativo) não é uma alteração');

  const segundo = await guardarPreferencias(comMarcador({}), 1);
  assert.ok(segundo.alterados.includes('notif_recibos_email'),
    'desligar «Recibos → email» é uma alteração');
  assert.ok(!segundo.alterados.includes('notif_assembleias_email'),
    'um evento que já estava desligado por omissão não é uma alteração');
  console.log(`  ✓ alterações reportadas por efeito (${segundo.alterados.length} chave(s) na 2.ª gravação)`);
}

// ── Consulta: listarPreferencias respeita o âmbito ────────────────
async function testeConsultaPorAmbito() {
  limpar();
  await guardarPreferencias(comMarcador({ notif_assembleias_email: 'on' }), 1);
  const deA = await listarPreferencias(1);
  const deB = await listarPreferencias(2);
  const assembleiasDe = (l) => l.find((p) => p.evento === 'assembleias').email;
  assert.strictEqual(assembleiasDe(deA), true, 'a consulta de A mostra a preferência de A');
  assert.strictEqual(assembleiasDe(deB), false, 'a consulta de B não mostra a de A');
  assert.strictEqual(deA.length, deB.length, 'as duas consultas cobrem os mesmos eventos');
  console.log('  ✓ a consulta (modo de leitura) é por condomínio');
}

// ── 11. Âmbito: chaves e validação ────────────────────────────────
function testeChavesDeAmbito() {
  assert.strictEqual(chaveDoCondominio('notif_recibos_email', 12), 'notif_recibos_email:c12');
  assert.strictEqual(chaveDoCondominio('notif_recibos_email', '12'), 'notif_recibos_email:c12');
  for (const mau of [null, undefined, 0, -3, 'x', 2.5, NaN]) {
    assert.strictEqual(chaveDoCondominio('notif_recibos_email', mau), null,
      `chave sem âmbito utilizável para ${String(mau)}`);
  }
  assert.strictEqual(idCondominio('7'), 7);
  console.log('  ✓ a chave de âmbito é `<chave>:c<ID>` e nunca é construída com um id inválido');
}

// ── 12. Vista, rota e job (invariantes de integração) ─────────────
function testeVistaRotaEJob() {
  const vista = ler('views/admin/emails/index.handlebars');
  assert.ok(/\{\{#> _modo-edicao id="notif-prefs"/.test(vista),
    'a vista usa o padrão P54-0 (`_modo-edicao`)');
  assert.ok(/name="_notificacoes" value="1"/.test(vista),
    'a vista envia o marcador de submissão completa');
  assert.ok(!/<form action="\/admin\/emails\/notificacoes"/.test(vista),
    'não há um segundo formulário próprio: o componente não é duplicado');
  assert.ok(/id="notificacoes"/.test(vista),
    'o id do âncora `#notificacoes` mantém-se (destino do redirect)');
  assert.ok(!/id="notificacoes"[^>]*data-modo-edicao/.test(vista),
    'o bloco do modo de edição não reutiliza o id do âncora (HTML inválido)');

  const rota = ler('routes/emails.js');
  assert.ok(/guardarPreferencias\(req\.body, req\.condominioId\)/.test(rota),
    'o âmbito vem do tenant (`req.condominioId`), não do corpo');
  assert.ok(/condominioId: req\.condominioId/.test(rota),
    'a auditoria regista o condomínio');
  assert.ok(/alterados: r\.alterados/.test(rota),
    'a auditoria regista os campos alterados (nomes, nunca valores)');
  assert.ok(/linhasNotificacoes/.test(rota),
    'a rota fornece as linhas do modo de consulta');

  const job = ler('jobs/automatizacao.js');
  assert.ok(/estaAtivo\('quotas_atraso', 'email', condominioId\)/.test(job),
    'o job lê a preferência no âmbito do condomínio da própria quota');
  console.log('  ✓ vista, rota e job: âmbito do tenant, marcador presente, sem formulário duplicado');
}

(async () => {
  // ORDEM = «asserção mais direta primeiro», para que a prova por mutação
  // apanhe cada defeito pela CAUSA e não por um sintoma mais adiante:
  //   1. a chave global nunca é reescrita e todas as escritas têm âmbito;
  //   2. a precedência específica → global → default;
  //   3. só depois o isolamento entre condomínios (que é o efeito visível).
  await testeNaoContamina();
  await testePrecedencia();
  await testeADiferenteDeB();
  await testeSemAmbitoRecusa();
  await testePostDiretoRecusa();
  await testeCamposNaoPermitidos();
  await testeSemContextoNaoEAtivado();
  await testeAlterados();
  await testeConsultaPorAmbito();
  testeChavesDeAmbito();
  testeVistaRotaEJob();
  console.log('✓ Testes de isolamento e proteção das notificações (P54-7) passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
