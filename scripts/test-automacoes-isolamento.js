// Testes do P54-7 — âmbito por condomínio e proteção da gravação das
// AUTOMAÇÕES DE DOCUMENTOS (sem base de dados).
//
// Utilização: node scripts/test-automacoes-isolamento.js
//
// Porque é que estes testes existem. A gravação escrevia SEMPRE a chave GLOBAL
// (`auto_<tipo>_<canal>`), pelo que o administrador do condomínio A desligava
// (ou ligava) as automações de TODOS os condomínios — o B incluído, que nunca
// tinha pedido nada. E como uma checkbox desmarcada não viaja no corpo do
// pedido, «campo ausente» era indistinguível de «formulário nunca submetido»:
// um POST direto desligava tudo em silêncio.
//
// Prova-se aqui, sem BD:
//  1. A e B podem ter automações diferentes para o mesmo tipo/canal;
//  2. gravar em A não toca nas chaves de B nem na chave global (herdada);
//  3. sem valor específico usa-se a chave herdada (global);
//  4. sem específica nem global usa-se o padrão do código;
//  5. a precedência é específica → global → padrão;
//  6. sem âmbito a gravação é RECUSADA (nunca escreve a chave global);
//  7. sem o marcador de submissão completa a gravação é RECUSADA (POST direto);
//  8. campos desconhecidos — incluindo um `condominioId` no corpo — são
//     recusados: o âmbito NUNCA vem do que o cliente submete;
//  9. uma leitura SEM contexto de condomínio lê a chave herdada e NÃO é
//     ativada pelo que um condomínio gravou;
// 10. só se reportam como alteradas as chaves cujo EFEITO mudou;
// 11. a consulta (`listarAutomacoes`) e as suas linhas são por condomínio;
// 12. a chave de âmbito é `<chave>:c<ID>` e nunca é construída com id inválido;
// 13. a vista usa o padrão P54-0, envia o marcador e não tem formulário próprio;
// 14. a rota tira o âmbito do tenant (nunca do corpo) e audita condomínio +
//     chaves alteradas (nomes apenas);
// 15. os CONSUMIDORES (routes/financeiro.js) leem a automação no âmbito do
//     condomínio, não na chave herdada.
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
  guardarAutomacoes, listarAutomacoes, linhasDeConsulta, estaAtivo,
  validarCorpo, chaveDe, chavesConhecidas, MARCADOR, TIPOS, CANAIS,
} = require('../helpers/automacoes');
const { idCondominio, chaveDoCondominio } = require('../helpers/config-ambito');

function limpar() {
  for (const k of Object.keys(valores)) delete valores[k];
  escritas.length = 0;
}

// Corpo de um formulário submetido por inteiro: o marcador acompanha sempre.
const comMarcador = (campos = {}) => ({ [MARCADOR]: '1', ...campos });

// Um tipo/canal de referência que NÃO tem padrão ativo (drive/automatico nunca
// têm, por decisão: nada automático sem escolha explícita). Usar um tipo com
// padrão ligado tornaria as asserções ambíguas entre «padrão» e «gravado».
const T = 'convocatorias';

// ── 1. Dois condomínios, automações diferentes ─────────────────────
async function testeADiferenteDeB() {
  limpar();
  await guardarAutomacoes(comMarcador({ [`auto_${T}_drive`]: 'on' }), 1);
  await guardarAutomacoes(comMarcador({}), 2);

  assert.strictEqual(await estaAtivo(T, 'drive', 1), true,
    'A ligou «convocatórias → guardar»');
  assert.strictEqual(await estaAtivo(T, 'drive', 2), false,
    'B continua desligado — a gravação de A não o ativou');
  console.log('  ✓ A e B têm automações diferentes para o mesmo tipo/canal');
}

// ── 2. A gravação de A não toca nas chaves de B nem na global ──────
async function testeNaoContamina() {
  limpar();
  valores[chaveDe(T, 'drive')] = '1'; // valor herdado pré-existente

  await guardarAutomacoes(comMarcador({}), 7);

  assert.strictEqual(valores[chaveDe(T, 'drive')], '1',
    'a chave GLOBAL (herdada) nunca é reescrita por uma gravação de condomínio');
  assert.ok(escritas.length > 0, 'a gravação aconteceu');
  assert.ok(escritas.every((k) => k.endsWith(':c7')),
    `todas as chaves escritas têm o âmbito :c7 (obtido: ${escritas.filter((k) => !k.endsWith(':c7')).join(', ')})`);
  assert.ok(escritas.length === Object.keys(TIPOS).length * CANAIS.length,
    'grava-se TODOS os tipos/canais (o formulário submetido por inteiro é a verdade completa)');
  console.log('  ✓ gravar em A escreve só `:c<ID>` — a chave global e a de B ficam intactas');
}

// ── 3/4/5. Precedência: específica → global → padrão ───────────────
async function testePrecedencia() {
  limpar();
  // 3. sem específica, herda a global
  valores[chaveDe(T, 'drive')] = '1';
  assert.strictEqual(await estaAtivo(T, 'drive', 3), true,
    'sem chave específica, herda a global ligada');
  // 5. a específica ganha à global
  valores[chaveDoCondominio(chaveDe(T, 'drive'), 3)] = '0';
  assert.strictEqual(await estaAtivo(T, 'drive', 3), false,
    'a chave específica do condomínio ganha à global');
  // 4. sem específica nem global, padrão do código
  assert.strictEqual(await estaAtivo('recibos', 'email', 4), true,
    'padrão do código: «Recibos → email» começa ativo');
  assert.strictEqual(await estaAtivo('quotas', 'automatico', 4), false,
    'padrão do código: o canal «automático» começa sempre desligado');
  assert.strictEqual(await estaAtivo('orcamentos', 'drive', 4), false,
    'padrão do código: o canal «guardar» começa desligado (exceto backups)');
  assert.strictEqual(await estaAtivo('backups', 'drive', 4), true,
    'padrão do código: «Backups → guardar» começa ativo (comportamento atual)');
  console.log('  ✓ precedência específica → global → padrão, com os padrões documentados');
}

// ── 6. Sem âmbito a gravação é recusada ────────────────────────────
async function testeSemAmbitoRecusa() {
  limpar();
  for (const mau of [undefined, null, 0, -1, 'abc', '', 1.5, NaN]) {
    await assert.rejects(
      () => guardarAutomacoes(comMarcador({}), mau),
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
    () => guardarAutomacoes({ [`auto_${T}_drive`]: 'on' }, 1),
    /completa/,
    'sem marcador de submissão completa a gravação tinha de ser recusada'
  );
  await assert.rejects(
    () => guardarAutomacoes({}, 1),
    /completa/,
    'um corpo vazio também é uma submissão incompleta'
  );
  assert.strictEqual(escritas.length, 0,
    'um POST direto não desliga as automações em silêncio');
  console.log('  ✓ sem marcador de submissão completa nada é gravado (POST direto neutralizado)');
}

// ── 8. Campos desconhecidos e condomínio pelo corpo ────────────────
async function testeCamposNaoPermitidos() {
  limpar();
  await assert.rejects(
    () => guardarAutomacoes(comMarcador({ auto_tipo_inexistente_drive: 'on' }), 1),
    /não reconhecido/,
    'um tipo desconhecido tinha de ser recusado'
  );
  await assert.rejects(
    () => guardarAutomacoes(comMarcador({ [`auto_${T}_fax`]: 'on' }), 1),
    /não reconhecido/,
    'um canal desconhecido tinha de ser recusado'
  );
  // ⛔ A tentativa de ESCOLHER o condomínio pelo corpo é recusada: o âmbito
  // vem sempre do tenant, nunca de um campo que o cliente controla.
  await assert.rejects(
    () => guardarAutomacoes(comMarcador({ condominioId: '2', [`auto_${T}_drive`]: 'on' }), 1),
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
  await guardarAutomacoes(comMarcador({ [`auto_${T}_drive`]: 'on' }), 1);
  assert.strictEqual(await estaAtivo(T, 'drive', 1), true, 'A ficou ligado');

  // Leitura sem âmbito — o caso de um job global, sem condomínio a processar.
  assert.strictEqual(await estaAtivo(T, 'drive'), false,
    'sem contexto de condomínio NÃO se herda a automação de A');
  assert.strictEqual(await estaAtivo(T, 'drive', 2), false,
    'nem a de qualquer outro condomínio');

  // E continua a ler a chave herdada quando ela existe.
  valores[chaveDe(T, 'drive')] = '1';
  assert.strictEqual(await estaAtivo(T, 'drive'), true,
    'sem contexto, a chave herdada (global) continua a valer');
  console.log('  ✓ execução sem contexto de condomínio lê a chave herdada — nunca a de um condomínio');
}

// ── 10. `alterados` só conta o que muda de EFEITO ──────────────────
async function testeAlterados() {
  limpar();
  const primeiro = await guardarAutomacoes(comMarcador({ auto_recibos_email: 'on' }), 1);
  assert.ok(!primeiro.alterados.includes('auto_recibos_email'),
    'gravar o valor que já era efetivo (padrão ativo) não é uma alteração');

  const segundo = await guardarAutomacoes(comMarcador({}), 1);
  assert.ok(segundo.alterados.includes('auto_recibos_email'),
    'desligar «Recibos → email» é uma alteração');
  assert.ok(!segundo.alterados.includes(`auto_${T}_drive`),
    'um tipo que já estava desligado por omissão não é uma alteração');
  assert.strictEqual(segundo.alterados.length, 1,
    'exatamente uma chave mudou de efeito');
  console.log(`  ✓ alterações reportadas por efeito (${segundo.alterados.length} chave(s) na 2.ª gravação)`);
}

// ── 11. Consulta (listarAutomacoes + linhas) por âmbito ────────────
async function testeConsultaPorAmbito() {
  limpar();
  await guardarAutomacoes(comMarcador({ [`auto_${T}_drive`]: 'on' }), 1);
  const deA = await listarAutomacoes(1);
  const deB = await listarAutomacoes(2);

  const estadoDe = (grupos, tipo, canal) => {
    for (const g of grupos) for (const t of g.tipos) if (t.tipo === tipo) return t[canal];
    throw new Error(`tipo ${tipo} não encontrado na consulta`);
  };
  assert.strictEqual(estadoDe(deA, T, 'drive'), true, 'a consulta de A mostra a automação de A');
  assert.strictEqual(estadoDe(deB, T, 'drive'), false, 'a consulta de B não mostra a de A');

  // As duas consultas cobrem exatamente os mesmos tipos.
  const tiposDe = (grupos) => grupos.flatMap((g) => g.tipos.map((t) => t.tipo)).sort();
  assert.deepStrictEqual(tiposDe(deA), tiposDe(deB), 'as duas consultas cobrem os mesmos tipos');
  assert.deepStrictEqual(tiposDe(deA), Object.keys(TIPOS).sort(), 'a consulta cobre TODOS os tipos');

  // As linhas da CONSULTA refletem o âmbito, e são uma por tipo/canal.
  const linhasA = linhasDeConsulta(deA);
  const linhasB = linhasDeConsulta(deB);
  assert.strictEqual(linhasA.length, Object.keys(TIPOS).length * CANAIS.length,
    'há uma linha de consulta por tipo/canal');
  const linhaDe = (linhas, alvo) => linhas.filter((l) => l.rotulo.startsWith(alvo));
  const convA = linhaDe(linhasA, 'Convocatórias de assembleia · Guardar')[0];
  const convB = linhaDe(linhasB, 'Convocatórias de assembleia · Guardar')[0];
  assert.strictEqual(convA.valor, 'Ativo', 'a linha de A diz Ativo');
  assert.strictEqual(convB.valor, 'Inativo', 'a linha de B diz Inativo');
  assert.ok(linhasA.every((l) => !l.sensivel),
    '⛔ nenhuma linha é marcada como sensível: aqui não há segredos');
  console.log('  ✓ a consulta e as linhas do modo de leitura são por condomínio');
}

// ── 12. Âmbito: chaves e validação ────────────────────────────────
function testeChavesDeAmbito() {
  assert.strictEqual(chaveDoCondominio(chaveDe(T, 'drive'), 12), `auto_${T}_drive:c12`);
  assert.strictEqual(chaveDoCondominio(chaveDe(T, 'drive'), '12'), `auto_${T}_drive:c12`);
  for (const mau of [null, undefined, 0, -3, 'x', 2.5, NaN]) {
    assert.strictEqual(chaveDoCondominio(chaveDe(T, 'drive'), mau), null,
      `chave sem âmbito utilizável para ${String(mau)}`);
  }
  assert.strictEqual(idCondominio('7'), 7);
  // Todos os pares tipo/canal produzem chaves conhecidas — sem isto, um tipo
  // novo sem chave listada seria recusado pela validação da própria interface.
  for (const k of chavesConhecidas()) {
    assert.ok(validarCorpo(comMarcador({ [k]: 'on' })).ok, `a chave ${k} do próprio módulo é aceita`);
  }
  console.log('  ✓ a chave de âmbito é `<chave>:c<ID>` e nunca é construída com um id inválido');
}

// ── 13/14/15. Vista, rota e consumidores (invariantes de integração) ─
function testeVistaRotaConsumidores() {
  const vista = ler('views/admin/configuracao/automacoes.handlebars');
  assert.ok(/\{\{#> _modo-edicao id="automacoes"/.test(vista),
    'a vista usa o padrão P54-0 (`_modo-edicao`)');
  assert.ok(/name="_automacoes" value="1"/.test(vista),
    'a vista envia o marcador de submissão completa');
  assert.ok(!/<form[^>]*action="\/admin\/config\/automacoes"/.test(vista),
    'não há um segundo formulário próprio: o componente não é duplicado');
  assert.ok(!/href="\/admin\/config"[^>]*>\s*Cancelar/.test(vista),
    'o «Cancelar» deixou de ser um link que navega para fora e perde alterações');
  assert.ok(/action="\/admin\/config\/automacoes"/.test(vista) === false
    || /_modo-edicao id="automacoes" acao="\/admin\/config\/automacoes"/.test(vista),
    'a rota de gravação é a do componente (não inventada na vista)');
  assert.ok(/name="auto_\{\{tipo\}\}_drive"/.test(vista),
    'os nomes dos campos (`auto_<tipo>_<canal>`) mantêm-se inalterados');

  const rota = ler('routes/configuracao.js');
  assert.ok(/listarAutomacoes\(req\.condominioId\)/.test(rota),
    'a consulta é feita no âmbito do condomínio ativo');
  assert.ok(/guardarAutomacoes\(req\.body, req\.condominioId\)/.test(rota),
    'o âmbito da gravação vem do tenant (`req.condominioId`), não do corpo');
  assert.ok(/condominioId: req\.condominioId/.test(rota),
    'a auditoria regista o condomínio');
  assert.ok(/alterados: r\.alterados/.test(rota),
    'a auditoria regista as chaves alteradas (nomes, nunca valores)');
  assert.ok(/linhasAutomacoes: linhasDeConsulta\(grupos\)/.test(rota),
    'a rota fornece as linhas do modo de consulta');
  assert.ok(!/guardarAutomacoes\(req\.body\)/.test(rota),
    'nenhuma chamada ficou sem âmbito (o defeito original)');

  const consumidores = ler('routes/financeiro.js');
  const chamadas = consumidores.match(/automacaoAtiva\('[a-z_]+', '[a-z]+'(, [^)]*)?\)/g) || [];
  assert.ok(chamadas.length >= 5, `encontradas as chamadas do consumidor (${chamadas.length})`);
  assert.ok(chamadas.every((c) => /req\.condominioId/.test(c)),
    `TODAS as leituras do consumidor levam o condomínio ativo (encontrado: ${chamadas.filter((c) => !/req\.condominioId/.test(c)).join(' | ')})`);
  console.log('  ✓ vista, rota e consumidores: âmbito do tenant, marcador presente, sem formulário duplicado');
}

(async () => {
  // ORDEM = «asserção mais direta primeiro», para que a prova por mutação
  // apanhe cada defeito pela CAUSA e não por um sintoma mais adiante:
  //   1. a chave global nunca é reescrita e todas as escritas têm âmbito;
  //   2. a precedência específica → global → padrão;
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
  testeVistaRotaConsumidores();
  console.log('✓ Testes de isolamento e proteção das automações de documentos (P54-7) passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
