// ═══════════════════════════════════════════════════════════════════
// Eventos ad-hoc do calendário — modelo, CRUD, autorização, isolamento e
// integração na agregação.
//
// Utilização: node scripts/test-eventos.js
//
// PORQUÊ ESTE TESTE EXISTE
// Os eventos ad-hoc são a única origem do calendário com CRUD próprio
// (`routes/eventos.js`, montado em `/admin/calendario/eventos/*`) e a única
// com tabela nova (`eventos`, migration 20260101000078). Um erro aqui não
// rebenta nada de forma visível: escreve na conta errada (outro condomínio),
// aceita lixo (data impossível, hora de fim antes do início) ou desaparece
// do calendário.
//
// SEM BASE DE DADOS: os modelos são substituídos por stubs via `require.cache`
// (o mesmo padrão de `scripts/test-calendario.js`). O stub de `findAll`
// REGISTA o `where` recebido e o stub de `findOne` aplica-o — para se poder
// PROVAR, e não afirmar, que cada leitura filtra por `condominio_id`.
//
// A ARMADILHA CENTRAL, e o que este ficheiro recusa fazer: o stub devolve
// TODAS as linhas dos dois condomínios e aplica-lhes o `where` como faria a
// BD. Se o código deixar de filtrar, o evento do outro condomínio aparece e o
// teste FALHA. Um stub que devolvesse só o que o código pede passaria sempre
// — seria um falso verde, e o isolamento ficaria por provar.
//
// O QUE FICA COBERTO
//   · modelo `Evento` e migration `20260101000078` (tabela, colunas, FK,
//     índice, e a ausência deliberada de ENUM/ligacões);
//   · validação server-side: título e data obrigatórios; data impossível
//     (2026-02-30) recusada; horas em 'HH:MM' normalizadas; `hora_fim` só
//     aceite quando posterior a `hora`;
//   · CRUD completo nas rotas reais (criar, editar, eliminar), com auditoria;
//   · autorização: admin e gestor escrevem; `leitura` não; sem associação não
//     se chega sequer às rotas;
//   · isolamento entre condomínios com CONTRA-PROVA (trocar de condomínio
//     troca o resultado) e com prova de que `condominio_id` nunca vem do
//     formulário;
//   · agregação das TRÊS origens em `helpers/calendario.js`, com a forma do
//     evento ad-hoc idêntica à das outras duas;
//   · datas sem desvio de fuso (o caso clássico da meia-noite);
//   · montagem em `app.js` antes de `placeholders`, e ausência na allow-list
//     de suporte (uma rota nova nasce inacessível ao suporte).
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Sequelize = require('sequelize');
const Handlebars = require('handlebars');

const RAIZ = path.join(__dirname, '..');
let nTestes = 0;
const feito = (nome) => { nTestes += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

console.log('\nTestes dos eventos ad-hoc do calendário (sem BD)');

const caminhoModels = require.resolve(path.join(RAIZ, 'models'));
const caminhoCalendario = require.resolve(path.join(RAIZ, 'helpers', 'calendario'));
const caminhoRota = require.resolve(path.join(RAIZ, 'routes', 'eventos'));
const caminhoRotaCal = require.resolve(path.join(RAIZ, 'routes', 'calendario'));
const caminhoPlaceholders = require.resolve(path.join(RAIZ, 'routes', 'placeholders'));

// ─────────────────────────────────────────────────────────────────────
// 1. Stubs
//
// `registos` guarda CADA consulta: é a prova do isolamento e da ordenação.
// `eventoInserido` / `eventoAtualizado` / `eventoEliminado` guardam o que o
// código tentou escrever — incluindo o `condominio_id`, que nunca pode vir
// do formulário.
// ─────────────────────────────────────────────────────────────────────
const registos = [];
const escritas = [];

let LINHAS_EVENTO = [];     // o que a «BD» tem na tabela eventos
let LINHAS_ASSEMBLEIA = [];
let LINHAS_AVISO = [];
let proximoId = 500;

let aplicarWhere = () => {
  throw new Error('stub de modelos usado antes de ser configurado');
};

// Modelo de evento com a superfície que o código usa: findAll, findOne,
// create, update, destroy. `EventoFalso` representa a CLASSE; as instâncias
// (devolvidas por findOne/create) trazem `update`/`destroy` próprios.
//
// ⚠️ As instâncias são NOVAS a cada `findOne` (como no Sequelize real), mas o
// `id` e o `condominio_id` são copiados explicitamente para o rasto de
// escritas: sem isso, um `update` numa instância descartável registaria
// `id: undefined` e a prova «atualizou o evento certo» não provaria nada.
function fabricarLinha(dados) {
  const linha = { ...dados };
  const idLinha = dados.id;
  const condominioLinha = dados.condominio_id;
  linha.toJSON = () => ({ ...linha });
  linha.update = async (valores) => {
    escritas.push({ op: 'update', id: idLinha, condominio_id: condominioLinha, valores: { ...valores } });
    Object.assign(linha, valores);
    // Mantém a «BD» coerente: quem fizer findAll depois vê o valor novo.
    const naBd = LINHAS_EVENTO.find((l) => l.id === idLinha);
    if (naBd) Object.assign(naBd, valores);
    return linha;
  };
  linha.destroy = async () => {
    escritas.push({ op: 'destroy', id: idLinha, condominio_id: condominioLinha });
    LINHAS_EVENTO = LINHAS_EVENTO.filter((l) => l.id !== idLinha);
    return linha;
  };
  return linha;
}

const EventoFalso = {
  async findAll(opcoes) {
    const where = opcoes && opcoes.where;
    registos.push({ modelo: 'Evento', op: 'findAll', where, order: opcoes && opcoes.order });
    return aplicarWhere(LINHAS_EVENTO, where).map(fabricarLinha);
  },
  async findOne(opcoes) {
    const where = opcoes && opcoes.where;
    registos.push({ modelo: 'Evento', op: 'findOne', where });
    const encontrada = aplicarWhere(LINHAS_EVENTO, where)[0];
    return encontrada ? fabricarLinha(encontrada) : null;
  },
  async create(dados) {
    escritas.push({ op: 'create', valores: { ...dados } });
    const linha = fabricarLinha({ id: proximoId += 1, ...dados });
    LINHAS_EVENTO.push(linha);
    return linha;
  },
};

const modeloFalso = (nome, chave) => ({
  findAll: async (opcoes) => {
    const where = opcoes && opcoes.where;
    registos.push({ modelo: nome, op: 'findAll', where, order: opcoes && opcoes.order });
    return aplicarWhere(chave(), where);
  },
});

const caminhoModelsCacheAnterior = require.cache[caminhoModels];
require.cache[caminhoModels] = {
  id: caminhoModels, filename: caminhoModels, loaded: true,
  exports: {
    Op: Sequelize.Op,
    Evento: EventoFalso,
    Assembleia: modeloFalso('Assembleia', () => LINHAS_ASSEMBLEIA),
    Aviso: modeloFalso('Aviso', () => LINHAS_AVISO),
  },
};

// Os módulos importam `../models` no topo: carregam-se DEPOIS do stub.
delete require.cache[caminhoCalendario];
delete require.cache[caminhoRota];
const cal = require(caminhoCalendario);
const rotaEventos = require(caminhoRota);

// ── Implementação do `where` (imita a BD, como descrito no cabeçalho) ──
//
// ⚠️ A comparação de escalares é FEITA COM COERÇÃO, como o Sequelize real faz
// contra uma coluna numérica: `req.params.id` é a string '31' e a linha tem o
// número 31. Comparar com `!==` estrito nunca encontraria a linha, e o teste
// passaria a provar o contrário do que quer (dava «não encontrado» onde a BD
// devolveria a linha). Escrito assim, o stub comporta-se como o MySQL.
function escalaresIguais(valorLinha, condicao) {
  if (valorLinha === condicao) return true;
  if (valorLinha === null || valorLinha === undefined) return false;
  if (condicao === null || condicao === undefined) return false;
  const numeroLinha = Number(valorLinha);
  const numeroCondicao = Number(condicao);
  if (!Number.isNaN(numeroLinha) && !Number.isNaN(numeroCondicao)) {
    return numeroLinha === numeroCondicao;
  }
  return String(valorLinha) === String(condicao);
}

aplicarWhere = (linhas, where) =>
  linhas.filter((l) => {
    if (!where) return true;
    for (const [campo, condicao] of Object.entries(where)) {
      if (condicao === null) { if (l[campo] !== null) return false; continue; }
      if (typeof condicao === 'object' && condicao !== null) {
        if (condicao[Sequelize.Op.ne] !== undefined) {
          if (escalaresIguais(l[campo], condicao[Sequelize.Op.ne])) return false;
          continue;
        }
        // Condição composta não suportada de propósito: se aparecer, é sinal
        // de que o código mudou e este teste tem de acompanhar.
        throw new Error(`condição de where não suportada em ${campo}: ${JSON.stringify(condicao)}`);
      }
      if (!escalaresIguais(l[campo], condicao)) return false;
    }
    return true;
  });

// ── Fixtures ──────────────────────────────────────────────────────
const HOJE = '2026-09-20';

const E1 = { // evento do condomínio 1, futuro, com hora e fim e local
  id: 31, condominio_id: 1, titulo: 'Limpeza das garagens',
  descricao: 'Acesso condicionado das 8h às 13h.', data: '2026-10-03',
  hora: '08:00', hora_fim: '13:00', local: 'Garagem', created_by: 1,
};
const E2 = { // evento do condomínio 1, passado, sem hora (dia inteiro)
  id: 32, condominio_id: 1, titulo: 'Vistoria do elevador',
  descricao: null, data: '2026-09-01', hora: null, hora_fim: null,
  local: null, created_by: 1,
};
const E3 = { // evento do condomínio 1, no próprio dia
  id: 33, condominio_id: 1, titulo: 'Reunião informal',
  descricao: null, data: HOJE, hora: '21:00', hora_fim: null,
  local: 'Hall', created_by: 1,
};
const E9 = { // evento de OUTRO condomínio — nunca pode aparecer no 1
  id: 91, condominio_id: 2, titulo: 'Obra do vizinho',
  descricao: 'Não é daqui.', data: '2026-10-03', hora: '09:00',
  hora_fim: null, local: 'Prédio ao lado', created_by: 9,
};

const A1 = { // assembleia do condomínio 1 (origem agregada, intacta)
  id: 11, condominio_id: 1, numero: '3/2026', tipo: 'ordinaria',
  data: '2026-10-05', hora: '18:30', local: 'Sala comum',
  ordem_trabalhos: 'Orçamento', estado: 'convocada',
};
const V1 = { // aviso programado do condomínio 1 (origem agregada, intacta)
  id: 21, condominio_id: 1, tipo: 'programado', assunto: 'Corte de água',
  mensagem: 'Manutenção.', data_programada: '2026-09-25',
};

function reporFixtures() {
  LINHAS_EVENTO = [E1, E2, E3, E9].map((e) => ({ ...e }));
  LINHAS_ASSEMBLEIA = [{ ...A1 }];
  LINHAS_AVISO = [{ ...V1 }];
  registos.length = 0;
  escritas.length = 0;
}

// ─────────────────────────────────────────────────────────────────────
// 2. Estrutura: migration e modelo
// ─────────────────────────────────────────────────────────────────────
titulo('Migration e modelo');

const ficheirosMigracao = fs.readdirSync(path.join(RAIZ, 'migrations'));
const migracaoEventos = ficheirosMigracao.filter((f) => /eventos\.js$/.test(f));
assert.strictEqual(migracaoEventos.length, 1, 'existe exatamente uma migration de eventos');
const nomeMigracao = migracaoEventos[0];
assert.ok(
  /^20260101000078-eventos\.js$/.test(nomeMigracao),
  `a migration é a seguinte disponível (obtido: ${nomeMigracao})`
);
// Nada com número superior pode já existir (a migration tem de ser a próxima).
const maiorNumero = ficheirosMigracao
  .map((f) => Number((/^(\d+)/.exec(f) || [])[1] || 0))
  .reduce((a, b) => Math.max(a, b), 0);
assert.strictEqual(maiorNumero, 20260101000078, 'não há migration posterior a esta');
feito(`Migration ${nomeMigracao} é a seguinte disponível (a mais alta de ${ficheirosMigracao.length})`);

const fonteMigracao = fs.readFileSync(path.join(RAIZ, 'migrations', nomeMigracao), 'utf8');
for (const coluna of [
  'condominio_id', 'titulo', 'descricao', 'data', 'hora', 'hora_fim', 'local',
  'created_by', 'created_at', 'updated_at',
]) {
  assert.ok(
    new RegExp(`^\\s+${coluna}:`, 'm').test(fonteMigracao),
    `a migration cria a coluna ${coluna}`
  );
}
assert.ok(/createTable\('eventos'/.test(fonteMigracao), 'cria exatamente a tabela `eventos`');
assert.ok(/references:\s*\{\s*model:\s*'condominios'/.test(fonteMigracao), 'condominio_id tem FK para condominios');
assert.ok(/addIndex\('eventos'/.test(fonteMigracao), 'cria índice para o isolamento/ordenação');
assert.ok(/dropTable\('eventos'\)/.test(fonteMigracao), 'o `down` remove a tabela');
// Âmbito: nada de ENUM, de associações polimórficas nem de tabelas de ligação.
// A verificação faz-se sobre o CÓDIGO, sem comentários: a migration explica em
// prosa aquilo que deliberadamente não faz («nem se cria X»), e uma regex
// ingénua daria um falso positivo contra a própria justificação.
const codigoMigracao = fonteMigracao
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
  .join('\n');
assert.ok(!/\bENUM\b/.test(codigoMigracao), 'sem ENUM no código (âmbito mínimo)');
assert.ok(!/entidade_id|entidade_tipo|polymorphic/i.test(codigoMigracao), 'sem associação polimórfica no código');
assert.ok(
  (codigoMigracao.match(/createTable\(/g) || []).length === 1,
  'a migration cria UMA só tabela (sem tabelas de ligação)'
);
feito('Migration com as colunas do desenho, FK, índice e `down` — e sem ENUM/ligacões');

const fonteModelo = fs.readFileSync(path.join(RAIZ, 'models', 'Evento.js'), 'utf8');
assert.ok(/tableName:\s*'eventos'/.test(fonteModelo), "o modelo aponta para a tabela 'eventos'");
assert.ok(/underscored:\s*true/.test(fonteModelo), 'usa `underscored: true` (convenção do projeto)');
// A hora fica em STRING, para o MySQL não a devolver como `Date` (desvio de dia).
assert.ok(/hora:\s*\{[^}]*STRING/.test(fonteModelo), '`hora` é STRING (não TIME/DATE)');
assert.ok(/hora_fim:\s*\{[^}]*STRING/.test(fonteModelo), '`hora_fim` é STRING (não TIME/DATE)');
assert.ok(/data:\s*\{[^}]*DATEONLY/.test(fonteModelo), '`data` é DATEONLY');
feito('Modelo Evento coerente com a migration e com a convenção de horas em texto');

const fonteIndexModels = fs.readFileSync(path.join(RAIZ, 'models', 'index.js'), 'utf8');
assert.ok(/^\s+Evento,$/m.test(fonteIndexModels), 'Evento é importado em models/index.js');
// A associação automática com Condominio depende desta lista.
const blocoLista = /const MODELOS_COM_CONDOMINIO = \[([\s\S]*?)\];/.exec(fonteIndexModels);
assert.ok(blocoLista, 'models/index.js tem a lista MODELOS_COM_CONDOMINIO');
assert.ok(
  /^\s+Evento,$/m.test(blocoLista[1]),
  'Evento está em MODELOS_COM_CONDOMINIO (ganha belongsTo Condominio)'
);
feito('Evento registado no índice de modelos e na lista de isolamento');

// ─────────────────────────────────────────────────────────────────────
// 3. Isolamento na agregação — a prova que interessa
// ─────────────────────────────────────────────────────────────────────
titulo('Isolamento entre condomínios (agregação)');

(async function () {
  reporFixtures();

  const doUm = await cal.eventosDoCondominio(1);

  // 3.1 As TRÊS consultas filtram pelo condomínio indicado.
  const consultas = registos.filter((r) => r.op === 'findAll');
  assert.strictEqual(consultas.length, 3, 'três consultas: assembleias, avisos e eventos');
  for (const r of consultas) {
    assert.strictEqual(
      r.where && r.where.condominio_id, 1,
      `consulta a ${r.modelo} tem de filtrar condominio_id=1 (recebido: ${JSON.stringify(r.where)})`
    );
  }
  feito('As três consultas filtram por condominio_id (provado no where, não afirmado)');

  // 3.2 O evento do outro condomínio não aparece.
  const idsUm = doUm.map((e) => e.id).sort((a, b) => a - b);
  assert.deepStrictEqual(idsUm, [11, 21, 31, 32, 33], 'só os acontecimentos do condomínio 1');
  assert.ok(!doUm.some((e) => e.id === 91), 'o evento do condomínio 2 nunca entra');
  feito('O condomínio 1 recebe as três origens — nada do condomínio 2');

  // 3.3 CONTRA-PROVA: trocar de condomínio troca o filtro E o resultado.
  registos.length = 0;
  const doDois = await cal.eventosDoCondominio(2);
  for (const r of registos.filter((x) => x.op === 'findAll')) {
    assert.strictEqual(r.where.condominio_id, 2, `consulta a ${r.modelo} filtra condominio_id=2`);
  }
  assert.deepStrictEqual(doDois.map((e) => e.id), [91], 'o condomínio 2 recebe só o seu evento');
  feito('Trocar de condomínio troca o filtro e o resultado (contra-prova)');

  // 3.4 Sem condomínio → vazio, e nem se chega a consultar a BD.
  registos.length = 0;
  for (const vazio of [null, undefined, 0, '']) {
    assert.deepStrictEqual(
      await cal.eventosDoCondominio(vazio), [],
      `condominioId=${JSON.stringify(vazio)} devolve vazio`
    );
  }
  assert.strictEqual(registos.length, 0, 'sem condomínio NÃO se chega a consultar a BD');
  feito('Sem condomínio ativo devolve vazio e nem consulta a BD');

  // ───────────────────────────────────────────────────────────────────
  // 4. Forma do evento ad-hoc na agregação
  // ───────────────────────────────────────────────────────────────────
  titulo('Agregação: forma e relevância do evento ad-hoc');

  reporFixtures();
  const eventos = await cal.eventosDoCondominio(1);

  const e31 = eventos.find((e) => e.id === 31);
  assert.deepStrictEqual(
    e31,
    {
      origem: 'evento',
      id: 31,
      data: '2026-10-03',
      tipo: 'evento',
      tipoRotulo: 'Evento',
      icone: 'event',
      titulo: 'Limpeza das garagens',
      tituloDetalhe: null,
      hora: '08:00',
      horaFim: '13:00',
      local: 'Garagem',
      descricao: 'Acesso condicionado das 8h às 13h.',
      estadoRotulo: null,
      estadoClasse: null,
      encerrado: false,
      relevante: true,
      editavel: true,
      link: '/admin/calendario/eventos/31',
    },
    'a forma do evento ad-hoc é a mesma das outras origens, com os campos extra'
  );
  feito('Evento normalizado na mesma forma dos outros (e marcado como editável)');

  // O evento ad-hoc é relevante (é um acontecimento do condomínio), ao
  // contrário de uma comunicação programada.
  assert.strictEqual(e31.relevante, true, 'o evento ad-hoc é relevante');
  assert.strictEqual(
    eventos.find((e) => e.id === 21).relevante, false,
    'o aviso programado continua não-relevante (comportamento da Fase 1 intacto)'
  );
  feito('Relevância: evento = sim, comunicação programada = não (como antes)');

  // Sem hora → dia inteiro (sem valor inventado); a hora de fim é opcional.
  const e32 = eventos.find((e) => e.id === 32);
  assert.strictEqual(e32.hora, null, 'evento sem hora fica sem hora');
  assert.strictEqual(e32.horaFim, null, 'evento sem hora de fim fica sem hora de fim');
  feito('Evento de dia inteiro: `hora` e `horaFim` ausentes, não inventados');

  // A ordenação por data continua a valer com a terceira origem misturada.
  const datas = eventos.map((e) => e.data);
  assert.deepStrictEqual(datas, [...datas].sort(), 'a lista agregada fica ordenada por data');
  assert.ok(
    datas.indexOf('2026-09-01') < datas.indexOf('2026-09-25') &&
    datas.indexOf('2026-09-25') < datas.indexOf('2026-10-03') &&
    datas.indexOf('2026-10-03') < datas.indexOf('2026-10-05'),
    'a intercalação das três origens respeita a cronologia'
  );
  feito('As três origens intercalam-se por data (ordenação estável mantida)');

  // ───────────────────────────────────────────────────────────────────
  // 5. Datas sem desvio de fuso
  // ───────────────────────────────────────────────────────────────────
  titulo('Datas sem desvio de fuso horário');

  // O erro clássico: exprimir a data por `Date` e perder um dia ao converter
  // para UTC. O helper compara strings ISO; aqui prova-se com a meia-noite.
  const fusosDeOrigem = process.env.TZ;
  for (const tz of ['Europe/Lisbon', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Tokyo', 'UTC']) {
    process.env.TZ = tz;
    const instante = new Date('2026-10-03T00:00:00');
    assert.strictEqual(
      cal.dataISO(instante), '2026-10-03',
      `dataISO mantém o dia local em ${tz} (obtido ${cal.dataISO(instante)})`
    );
    assert.strictEqual(
      cal.dataISO('2026-10-03'), '2026-10-03',
      `dataISO mantém a string DATEONLY intacta em ${tz}`
    );
  }
  if (fusosDeOrigem === undefined) delete process.env.TZ; else process.env.TZ = fusosDeOrigem;
  feito('dataISO não desvia o dia em 5 fusos (inclui meia-noite local)');

  // `hojeISO` nunca pode recorrer a toISOString(): em Kiritimati (UTC+14) a
  // meia-noite local ainda é o dia anterior em UTC.
  // Verifica-se o CÓDIGO, sem comentários — o helper explica em prosa que não
  // usa toISOString(), e um regex sobre o ficheiro inteiro daria falso positivo.
  const fonteCal = fs.readFileSync(path.join(RAIZ, 'helpers', 'calendario.js'), 'utf8');
  const codigoCal = fonteCal
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
  assert.ok(
    !/toISOString/.test(codigoCal),
    'o helper não usa toISOString() no código (que mudaria o dia perto da meia-noite)'
  );
  feito('O helper não usa toISOString() no código');

  // ───────────────────────────────────────────────────────────────────
  // 6. Validação server-side (funções internas, via rota real)
  // ───────────────────────────────────────────────────────────────────
  titulo('Validação server-side');

  // A validação vive na rota; exercita-se pela rota real num servidor efémero
  // (a chamada direta ao router não reproduz a cadeia de guardas do tenant).
  const appVal = express();
  appVal.set('view engine', 'handlebars');
  appVal.engine('handlebars', (f, o, cb) => cb(null, 'OK'));
  appVal.set('views', path.join(RAIZ, 'views'));
  appVal.use(express.urlencoded({ extended: false }));
  appVal.use((req, res, next) => {
    req.user = { id: 1, role: 'condomino', role_global: null };
    req.session = { condominio_ativo_id: 1 };
    req.isAuthenticated = () => true;
    req.flash = () => {};
    next();
  });

  let papelInjetado = 'admin';
  const generico = new Proxy({}, {
    get: (_, k) => (k === 'count' ? async () => 0 : k === 'findAll' ? async () => [] : async () => null),
  });
  const caminhoModelsGuardado = require.cache[caminhoModels];
  const montarStub = (papel) => {
    papelInjetado = papel;
    require.cache[caminhoModels] = {
      id: caminhoModels, filename: caminhoModels, loaded: true,
      exports: new Proxy({
        UserCondominio: {
          findOne: async () => (papelInjetado ? { role: papelInjetado, estado: 'ativo' } : null),
          findAll: async () => [], count: async () => 0,
        },
        Evento: EventoFalso,
        Condominio: generico,
        AuditLog: { create: async () => ({}) },
      }, { get: (alvo, k) => (k === 'Op' ? Sequelize.Op : alvo[k] || generico) }),
    };
    for (const k of Object.keys(require.cache)) {
      if (/[\\/](helpers|routes)[\\/]/.test(k) && k.startsWith(RAIZ)) delete require.cache[k];
    }
  };
  montarStub('admin');
  appVal.use('/admin', require(caminhoRota));
  appVal.use('/admin', (req, res) => res.status(404).send('404'));

  const servidorVal = http.createServer(appVal);
  await new Promise((r) => servidorVal.listen(0, '127.0.0.1', r));
  const baseVal = `http://127.0.0.1:${servidorVal.address().port}`;

  // Envia um formulário e devolve o que importa: código, destino e se a
  // escrita chegou ao modelo (é a diferença entre «aceitou» e «recusou»).
  const submeter = (caminho, campos) =>
    new Promise((resolve) => {
      const corpo = new URLSearchParams(campos).toString();
      const req = http.request(
        `${baseVal}${caminho}`,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(corpo) } },
        (res) => { res.resume(); resolve({ status: res.statusCode, local: res.headers.location }); }
      );
      req.on('error', () => resolve({ status: 0 }));
      req.write(corpo);
      req.end();
    });

  try {
    // 6.1 Título em falta → recusado, nada escrito.
    reporFixtures();
    escritas.length = 0;
    let r = await submeter('/admin/calendario/eventos', { titulo: '   ', data: '2026-10-10' });
    assert.notStrictEqual(r.status, 302, 'título vazio não redireciona (não gravou)');
    assert.ok(!escritas.some((e) => e.op === 'create'), 'nada foi criado sem título');
    feito('Título em falta recusado, sem escrita');

    // 6.2 Data em falta → recusado.
    escritas.length = 0;
    r = await submeter('/admin/calendario/eventos', { titulo: 'Sem data' });
    assert.ok(!escritas.some((e) => e.op === 'create'), 'nada foi criado sem data');
    feito('Data em falta recusada, sem escrita');

    // 6.3 Data impossível (30 de fevereiro) → recusado. Uma validação que
    //     aceitasse isto poria o evento no dia 1 ou 2 de março.
    escritas.length = 0;
    r = await submeter('/admin/calendario/eventos', { titulo: 'Impossível', data: '2026-02-30' });
    assert.ok(!escritas.some((e) => e.op === 'create'), 'data inexistente não é aceite');
    feito('Data 2026-02-30 recusada (coerência de calendário, sem `Date`)');

    // 6.4 Data em formato errado → recusado.
    escritas.length = 0;
    r = await submeter('/admin/calendario/eventos', { titulo: 'Formato', data: '10/10/2026' });
    assert.ok(!escritas.some((e) => e.op === 'create'), 'data em formato local não é aceite');
    feito('Data 10/10/2026 (formato PT) recusada — o formulário usa ISO');

    // 6.5 Hora inválida → recusado.
    escritas.length = 0;
    r = await submeter('/admin/calendario/eventos', { titulo: 'Hora má', data: '2026-10-10', hora: '25:99' });
    assert.ok(!escritas.some((e) => e.op === 'create'), 'hora fora do intervalo não é aceite');
    feito('Hora 25:99 recusada');

    // 6.6 `hora_fim` anterior a `hora` → recusado (o requisito explícito).
    escritas.length = 0;
    r = await submeter('/admin/calendario/eventos', {
      titulo: 'Fim antes do início', data: '2026-10-10', hora: '14:00', hora_fim: '09:00',
    });
    assert.ok(!escritas.some((e) => e.op === 'create'), 'hora de fim anterior à de início não é aceite');
    feito('Hora de fim anterior à de início recusada');

    // 6.7 `hora_fim` sem `hora` → recusado.
    escritas.length = 0;
    r = await submeter('/admin/calendario/eventos', {
      titulo: 'Fim sem início', data: '2026-10-10', hora_fim: '09:00',
    });
    assert.ok(!escritas.some((e) => e.op === 'create'), 'hora de fim sem hora de início não é aceite');
    feito('Hora de fim sem hora de início recusada');

    // 6.8 Criação válida → grava com os campos certos, normalizados.
    reporFixtures();
    escritas.length = 0;
    r = await submeter('/admin/calendario/eventos', {
      titulo: '  Visita técnica  ', descricao: '  Ao quadro elétrico.  ',
      data: '2026-10-12', hora: '9:5', hora_fim: '11:30', local: '  Cave  ',
    });
    assert.strictEqual(r.status, 302, `criação válida redireciona (obtido ${r.status})`);
    const criado = escritas.find((e) => e.op === 'create');
    assert.ok(criado, `a criação chegou ao modelo (resposta ${r.status}, destino ${r.local})`);
    assert.strictEqual(criado.valores.titulo, 'Visita técnica', 'título é aparado');
    assert.strictEqual(criado.valores.data, '2026-10-12', 'data ISO guardada tal e qual');
    assert.strictEqual(criado.valores.hora, '09:05', 'hora normalizada para HH:MM');
    assert.strictEqual(criado.valores.hora_fim, '11:30', 'hora de fim guardada');
    assert.strictEqual(criado.valores.local, 'Cave', 'local aparado');
    assert.strictEqual(criado.valores.descricao, 'Ao quadro elétrico.', 'descrição aparada');
    assert.strictEqual(criado.valores.condominio_id, 1, 'condominio_id vem da sessão');
    assert.strictEqual(criado.valores.created_by, 1, 'created_by é o utilizador da sessão');
    feito('Criação válida grava valores normalizados (hora 9:5 → 09:05)');

    // 6.9 O `condominio_id` do formulário é IGNORADO. Sem isto, um utilizador
    //     com sessão no condomínio 1 poderia escrever no condomínio 2.
    escritas.length = 0;
    r = await submeter('/admin/calendario/eventos', {
      titulo: 'Tentativa de troca', data: '2026-10-13',
      condominio_id: '2', condominioId: '2', created_by: '999',
    });
    const criadoForcado = escritas.find((e) => e.op === 'create');
    assert.ok(criadoForcado, 'a criação correu');
    assert.strictEqual(
      criadoForcado.valores.condominio_id, 1,
      'condominio_id do corpo é ignorado — vale o da sessão'
    );
    assert.strictEqual(criadoForcado.valores.created_by, 1, 'created_by do corpo é ignorado');
    feito('`condominio_id` enviado no formulário é ignorado (vale a sessão)');

    // 6.10 Dia inteiro (sem horas) é válido e grava `null`, não ''.
    escritas.length = 0;
    r = await submeter('/admin/calendario/eventos', { titulo: 'Dia inteiro', data: '2026-10-14' });
    const diaInteiro = escritas.find((e) => e.op === 'create');
    assert.strictEqual(diaInteiro.valores.hora, null, 'sem hora fica NULL');
    assert.strictEqual(diaInteiro.valores.hora_fim, null, 'sem hora de fim fica NULL');
    assert.strictEqual(diaInteiro.valores.descricao, null, 'descrição vazia fica NULL');
    feito('Evento de dia inteiro grava NULL (não cadeia vazia)');

    // 6.11 Edição válida: atualiza e regista auditoria.
    reporFixtures();
    escritas.length = 0;
    r = await submeter('/admin/calendario/eventos/31', {
      titulo: 'Limpeza adiada', data: '2026-10-04', hora: '09:00', hora_fim: '12:00',
    });
    assert.strictEqual(r.status, 302, 'edição válida redireciona');
    const atualizado = escritas.find((e) => e.op === 'update');
    assert.ok(atualizado, `a atualização chegou ao modelo (resposta ${r.status}, destino ${r.local})`);
    assert.strictEqual(atualizado.id, 31, 'atualizou o evento certo');
    assert.strictEqual(atualizado.valores.titulo, 'Limpeza adiada', 'título atualizado');
    assert.strictEqual(atualizado.valores.data, '2026-10-04', 'data atualizada');
    feito('Edição válida atualiza o evento certo');

    // 6.12 Edição de evento de OUTRO condomínio → não encontrado, nada escrito.
    escritas.length = 0;
    r = await submeter('/admin/calendario/eventos/91', { titulo: 'Ataque', data: '2026-10-20' });
    assert.ok(!escritas.some((e) => e.op === 'update'), 'não se atualiza evento de outro condomínio');
    assert.ok(r.local && r.local.startsWith('/admin/calendario'), 'volta ao calendário sem alterar');
    feito('Edição de evento de outro condomínio não altera nada');

    // 6.13 Eliminação de evento de outro condomínio → não encontrado.
    reporFixtures();
    escritas.length = 0;
    r = await submeter('/admin/calendario/eventos/91/eliminar', {});
    assert.ok(!escritas.some((e) => e.op === 'destroy'), 'não se elimina evento de outro condomínio');
    assert.strictEqual(LINHAS_EVENTO.length, 4, 'nenhuma linha desapareceu');
    feito('Eliminação de evento de outro condomínio não apaga nada');

    // 6.14 Eliminação do PRÓPRIO evento → apaga e regista.
    escritas.length = 0;
    r = await submeter('/admin/calendario/eventos/32/eliminar', {});
    const apagado = escritas.find((e) => e.op === 'destroy');
    assert.ok(apagado, 'a eliminação chegou ao modelo');
    assert.strictEqual(apagado.id, 32, 'eliminou o evento certo');
    assert.ok(!LINHAS_EVENTO.some((l) => l.id === 32), 'a linha saiu da «BD»');
    assert.ok(LINHAS_EVENTO.some((l) => l.id === 91), 'o evento do outro condomínio continua lá');
    feito('Eliminação do próprio evento apaga só esse');

    // 6.15 Auditoria: cada operação relevante deixa rasto com a entidade certa.
    const fonteRotaEventos = fs.readFileSync(path.join(RAIZ, 'routes', 'eventos.js'), 'utf8');
    for (const acao of ['criar_evento', 'editar_evento', 'eliminar_evento']) {
      assert.ok(
        new RegExp(`acao:\\s*'${acao}'`).test(fonteRotaEventos),
        `a operação «${acao}» é auditada`
      );
    }
    assert.ok(
      (fonteRotaEventos.match(/entidade:\s*'Evento'/g) || []).length === 3,
      'as três operações auditam a entidade Evento'
    );
    feito('Criar/editar/eliminar passam pela auditoria (entidade Evento)');

    // ─────────────────────────────────────────────────────────────────
    // 7. Autorização
    // ─────────────────────────────────────────────────────────────────
    titulo('Autorização');

    // As guardas têm de estar declaradas antes de qualquer handler.
    const posGuardasCond = fonteRotaEventos.indexOf('comCondominioAtivo');
    const posGuardasPapel = fonteRotaEventos.indexOf("comPapel('gestor')");
    const posPrimeiroHandler = fonteRotaEventos.indexOf('router.');
    assert.ok(posGuardasCond > -1 && posGuardasPapel > -1, 'o router declara as duas guardas');
    assert.ok(
      posGuardasCond < posGuardasPapel,
      'a guarda de condomínio ativo vem antes da de papel'
    );
    const posHandlerReal = fonteRotaEventos.indexOf("router.get('/calendario/eventos/nova'");
    assert.ok(
      posGuardasPapel < posHandlerReal,
      'as guardas são declaradas antes do primeiro handler'
    );
    feito('Guardas (condomínio + papel) declaradas antes de qualquer handler');

    // Nenhum caminho lê o condomínio do pedido.
    assert.ok(
      !/req\.(body|query|params)\.condominio/i.test(fonteRotaEventos),
      'o router nunca lê o condomínio do corpo, da query ou dos params'
    );
    assert.ok(
      !/req\.(body|query|params)\.condominio_id/i.test(fonteRotaEventos),
      'nem o `condominio_id` (a chave de isolamento vem sempre da sessão)'
    );
    feito('O condomínio só pode vir da sessão (nada lido do pedido)');

    // Todas as leituras de um evento filtram por condominio_id.
    const leituras = registos.filter((r) => r.modelo === 'Evento' && r.op === 'findOne');
    assert.ok(leituras.length > 0, 'houve leituras por id durante este teste');
    for (const l of leituras) {
      assert.strictEqual(
        l.where.condominio_id, 1,
        `findOne filtra condominio_id (recebido: ${JSON.stringify(l.where)})`
      );
    }
    feito(`Todas as ${leituras.length} leituras por id filtram por condominio_id`);

    // Perfis sem permissão de escrita: `leitura` não escreve.
    montarStub('leitura');
    for (const k of Object.keys(require.cache)) {
      if (/[\\/](helpers|routes)[\\/]/.test(k) && k.startsWith(RAIZ)) delete require.cache[k];
    }
    const appLeitura = express();
    appLeitura.set('view engine', 'handlebars');
    appLeitura.engine('handlebars', (f, o, cb) => cb(null, 'OK'));
    appLeitura.set('views', path.join(RAIZ, 'views'));
    appLeitura.use(express.urlencoded({ extended: false }));
    appLeitura.use((req, res, next) => {
      req.user = { id: 2, role: 'condomino', role_global: null };
      req.session = { condominio_ativo_id: 1 };
      req.isAuthenticated = () => true;
      req.flash = () => {};
      next();
    });
    appLeitura.use('/admin', require(caminhoRota));
    appLeitura.use('/admin', (req, res) => res.status(404).send('404'));
    const servidorLeitura = http.createServer(appLeitura);
    await new Promise((r) => servidorLeitura.listen(0, '127.0.0.1', r));
    const baseLeitura = `http://127.0.0.1:${servidorLeitura.address().port}`;

    const pedirLeitura = (caminho, metodo, campos) =>
      new Promise((resolve) => {
        const corpo = campos ? new URLSearchParams(campos).toString() : null;
        const req = http.request(
          `${baseLeitura}${caminho}`,
          {
            method: metodo,
            headers: corpo
              ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(corpo) }
              : {},
          },
          (res) => { res.resume(); resolve({ status: res.statusCode, local: res.headers.location }); }
        );
        req.on('error', () => resolve({ status: 0 }));
        if (corpo) req.write(corpo);
        req.end();
      });

    try {
      reporFixtures();
      escritas.length = 0;

      let rl = await pedirLeitura('/admin/calendario/eventos/nova', 'GET');
      assert.ok(rl.status === 302 || rl.status === 403, `leitura não abre o formulário (${rl.status})`);
      feito(`Perfil «leitura» não abre o formulário de evento (${rl.status})`);

      rl = await pedirLeitura('/admin/calendario/eventos', 'POST', { titulo: 'Fuga', data: '2026-10-15' });
      assert.ok(
        rl.status === 302 || rl.status === 403,
        `leitura não cria eventos (${rl.status})`
      );
      assert.ok(!escritas.some((e) => e.op === 'create'), 'nenhuma escrita aconteceu');
      feito(`Perfil «leitura» não cria eventos (${rl.status}) e nada é gravado`);

      rl = await pedirLeitura('/admin/calendario/eventos/31', 'POST', { titulo: 'Fuga', data: '2026-10-15' });
      assert.ok(!escritas.some((e) => e.op === 'update'), 'leitura não edita eventos');
      feito('Perfil «leitura» não edita eventos');

      rl = await pedirLeitura('/admin/calendario/eventos/31/eliminar', 'POST', {});
      assert.ok(!escritas.some((e) => e.op === 'destroy'), 'leitura não elimina eventos');
      assert.strictEqual(LINHAS_EVENTO.length, 4, 'nenhuma linha foi apagada');
      feito('Perfil «leitura» não elimina eventos');
    } finally {
      await new Promise((resolve) => servidorLeitura.close(resolve));
    }

    // Admin e gestor escrevem (o oposto do perfil anterior, para não se
    // concluir que «nada acontece» só porque as rotas estão todas fechadas).
    for (const papel of ['admin', 'gestor']) {
      montarStub(papel);
      for (const k of Object.keys(require.cache)) {
        if (/[\\/](helpers|routes)[\\/]/.test(k) && k.startsWith(RAIZ)) delete require.cache[k];
      }
      const appPapel = express();
      appPapel.set('view engine', 'handlebars');
      appPapel.engine('handlebars', (f, o, cb) => cb(null, 'OK'));
      appPapel.set('views', path.join(RAIZ, 'views'));
      appPapel.use(express.urlencoded({ extended: false }));
      appPapel.use((req, res, next) => {
        req.user = { id: 1, role: 'condomino', role_global: null };
        req.session = { condominio_ativo_id: 1 };
        req.isAuthenticated = () => true;
        req.flash = () => {};
        next();
      });
      appPapel.use('/admin', require(caminhoRota));
      appPapel.use('/admin', (req, res) => res.status(404).send('404'));
      const servidorPapel = http.createServer(appPapel);
      await new Promise((r) => servidorPapel.listen(0, '127.0.0.1', r));
      const basePapel = `http://127.0.0.1:${servidorPapel.address().port}`;
      try {
        reporFixtures();
        escritas.length = 0;
        const respostaForm = await new Promise((resolve) => {
          http.get(`${basePapel}/admin/calendario/eventos/nova`, (res) => {
            res.resume();
            resolve(res.statusCode);
          }).on('error', () => resolve(0));
        });
        assert.strictEqual(respostaForm, 200, `${papel} abre o formulário de evento (200)`);
        const rCriacao = await new Promise((resolve) => {
          const corpo = new URLSearchParams({ titulo: `Escrito por ${papel}`, data: '2026-10-16' }).toString();
          const req = http.request(`${basePapel}/admin/calendario/eventos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(corpo) },
          }, (res) => { res.resume(); resolve(res.statusCode); });
          req.on('error', () => resolve(0));
          req.write(corpo);
          req.end();
        });
        assert.strictEqual(rCriacao, 302, `${papel} cria eventos (302)`);
        assert.ok(escritas.some((e) => e.op === 'create'), `${papel} gravou o evento`);
        feito(`Perfil «${papel}» abre o formulário e cria eventos`);
      } finally {
        await new Promise((resolve) => servidorPapel.close(resolve));
      }
    }

    // Sem associação ativa não há eventos, sequer.
    montarStub(null);
    for (const k of Object.keys(require.cache)) {
      if (/[\\/](helpers|routes)[\\/]/.test(k) && k.startsWith(RAIZ)) delete require.cache[k];
    }
    const appSem = express();
    appSem.set('view engine', 'handlebars');
    appSem.engine('handlebars', (f, o, cb) => cb(null, 'OK'));
    appSem.set('views', path.join(RAIZ, 'views'));
    appSem.use((req, res, next) => {
      req.user = { id: 1, role: 'condomino', role_global: null };
      req.session = { condominio_ativo_id: 7 };
      req.isAuthenticated = () => true;
      req.flash = () => {};
      next();
    });
    appSem.use('/admin', require(caminhoRota));
    appSem.use('/admin', (req, res) => res.status(404).send('404'));
    const servidorSem = http.createServer(appSem);
    await new Promise((r) => servidorSem.listen(0, '127.0.0.1', r));
    try {
      const rSem = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${servidorSem.address().port}/admin/calendario/eventos/nova`, (res) => {
          res.resume();
          resolve({ status: res.statusCode, local: res.headers.location });
        }).on('error', () => resolve({ status: 0 }));
      });
      assert.notStrictEqual(rSem.status, 200, `sem associação ativa não pode haver 200 (${rSem.status})`);
      assert.ok(rSem.local && rSem.local.startsWith('/condominios'), 'devolve o utilizador a /condominios');
      feito(`Sem condomínio ativo → ${rSem.status} ${rSem.local} (as rotas não são servidas)`);
    } finally {
      await new Promise((resolve) => servidorSem.close(resolve));
    }
  } finally {
    await new Promise((resolve) => servidorVal.close(resolve));
    if (caminhoModelsGuardado) require.cache[caminhoModels] = caminhoModelsGuardado;
  }

  // ───────────────────────────────────────────────────────────────────
  // 8. Arquitetura: montagem e allow-list
  // ───────────────────────────────────────────────────────────────────
  titulo('Arquitetura: montagem e allow-list');

  const fonteApp = fs.readFileSync(path.join(RAIZ, 'app.js'), 'utf8');
  const posEventos = fonteApp.indexOf("require('./routes/eventos')");
  const posPlaceholders = fonteApp.indexOf("require('./routes/placeholders')");
  assert.ok(posEventos > -1, 'app.js monta routes/eventos');
  assert.ok(
    posEventos < posPlaceholders,
    'routes/eventos é montado ANTES de placeholders (senão /:modulo captura o caminho)'
  );
  feito('routes/eventos montado antes de placeholders em app.js');

  const fontePlaceholders = fs.readFileSync(path.join(RAIZ, 'routes', 'placeholders.js'), 'utf8');
  const moduloPlaceholders = require(caminhoPlaceholders).MODULOS;
  assert.ok(!moduloPlaceholders.eventos, 'não existe placeholder «eventos»');
  assert.ok(!/eventos\s*:/.test(fontePlaceholders), 'nada em placeholders se chama eventos');
  feito('Não há placeholder a competir com a rota real de eventos');

  const fonteAllow = fs.readFileSync(path.join(RAIZ, 'helpers', 'suporte-allowlist.js'), 'utf8');
  // A asserção é sobre o REGISTO do módulo, não sobre a palavra solta:
  // «eventos» aparece legitimamente no ficheiro em comentários sobre eventos
  // de auditoria (`suporte_consulta`), que nada têm a ver com este router.
  const ROUTERS_ALLOW = /const ROUTERS = \{([\s\S]*?)\n\};/.exec(fonteAllow);
  assert.ok(ROUTERS_ALLOW, 'a allow-list expõe o mapa ROUTERS');
  assert.ok(
    !/eventos\s*:/.test(ROUTERS_ALLOW[1]),
    'routes/eventos não está no mapa ROUTERS da allow-list'
  );
  assert.ok(
    !/['"]eventos?['"]/.test(fonteAllow.replace(/\/\/.*$/gm, '')),
    'nenhuma entrada de código da allow-list menciona «evento»/«eventos»'
  );
  feito('CRUD de eventos fora da allow-list (rota nova nasce fechada ao suporte)');

  // O filtro do calendário tem de conhecer a terceira origem.
  const fonteRotaCal = fs.readFileSync(caminhoRotaCal, 'utf8');
  assert.ok(
    /const FILTROS = \['assembleia', 'aviso', 'evento'\]/.test(fonteRotaCal),
    'o calendário aceita `?tipo=evento`'
  );
  feito('Filtro do calendário reconhece a origem «evento»');

  // ───────────────────────────────────────────────────────────────────
  // 9. Render das vistas
  // ───────────────────────────────────────────────────────────────────
  titulo('Render das vistas');

  Handlebars.registerHelper(require(path.join(RAIZ, 'helpers', 'handlebars-helpers')));
  const partialsDir = path.join(RAIZ, 'views', 'partials');
  for (const f of fs.readdirSync(partialsDir)) {
    if (f.endsWith('.handlebars')) {
      Handlebars.registerPartial(
        f.replace(/\.handlebars$/, ''),
        fs.readFileSync(path.join(partialsDir, f), 'utf8')
      );
    }
  }

  // 9.1 Formulário de criação: campos obrigatórios marcados e sem eliminar.
  const tplForm = Handlebars.compile(
    fs.readFileSync(path.join(RAIZ, 'views', 'admin', 'eventos', 'form.handlebars'), 'utf8')
  );
  let html = tplForm({
    titulo: 'Novo evento',
    evento: { data: HOJE },
    erros: [],
    acao: '/admin/calendario/eventos',
  });
  for (const marca of ['Título', 'Descrição / notas', 'Data', 'Hora de início', 'Hora de fim', 'Local', 'Guardar', 'Cancelar']) {
    assert.ok(html.includes(marca), `o formulário tem «${marca}»`);
  }
  assert.ok(html.includes('name="titulo"') && html.includes('required'), 'título é obrigatório no HTML');
  assert.ok(html.includes('name="data"'), 'a data é enviada');
  assert.ok(html.includes('name="hora"'), 'a hora é enviada');
  assert.ok(html.includes('name="hora_fim"'), 'a hora de fim é enviada');
  assert.ok(
    html.includes('action="/admin/calendario/eventos"') && html.includes('method="POST"'),
    'o formulário de criação faz POST para a rota certa'
  );
  // No formulário de CRIAÇÃO não pode haver botão de eliminar (o evento ainda
  // não existe — seria uma promessa falsa).
  assert.ok(!html.includes('/eliminar'), 'sem botão de eliminar ao criar');
  feito('Formulário de criação: campos certos, POST correto e sem eliminar');

  // 9.2 Formulário de edição: pré-preenchido e com eliminação confirmada.
  html = tplForm({
    titulo: 'Editar evento',
    evento: {
      id: 31, titulo: 'Limpeza das garagens', descricao: 'Acesso condicionado.',
      data: '2026-10-03', hora: '08:00', hora_fim: '13:00', local: 'Garagem',
    },
    erros: [],
    acao: '/admin/calendario/eventos/31',
  });
  assert.ok(html.includes('value="Limpeza das garagens"'), 'o título vem preenchido');
  assert.ok(html.includes('value="2026-10-03"'), 'a data vem preenchida em ISO');
  assert.ok(html.includes('value="08:00"'), 'a hora vem preenchida');
  assert.ok(html.includes('value="13:00"'), 'a hora de fim vem preenchida');
  assert.ok(html.includes('action="/admin/calendario/eventos/31"'), 'o POST aponta ao evento');
  assert.ok(html.includes('/admin/calendario/eventos/31/eliminar'), 'oferece eliminar o evento');
  assert.ok(html.includes('data-confirmar'), 'a eliminação passa pela confirmação do projeto');
  assert.ok(html.includes('method="POST"'), 'a eliminação é POST (nunca um GET que apaga)');
  feito('Formulário de edição: pré-preenchido, edita o id certo e elimina com confirmação');

  // 9.3 Erros de validação mostrados ao utilizador.
  html = tplForm({
    titulo: 'Novo evento',
    evento: { titulo: 'X', data: '' },
    erros: ['A data é obrigatória.', 'A hora de fim tem de ser posterior à hora de início.'],
    acao: '/admin/calendario/eventos',
  });
  assert.ok(html.includes('A data é obrigatória.'), 'o erro da data aparece');
  assert.ok(html.includes('posterior à hora de início'), 'o erro da hora de fim aparece');
  assert.ok(html.includes('alert-danger'), 'usa o alerta de perigo do projeto');
  feito('Erros de validação são mostrados na própria página');

  // 9.4 A vista do calendário conhece o evento e os seus atalhos.
  const tplCal = Handlebars.compile(
    fs.readFileSync(path.join(RAIZ, 'views', 'admin', 'calendario.handlebars'), 'utf8')
  );
  const eventoNormalizado = cal.eventoDeEvento(E1);
  html = tplCal({
    titulo: 'Calendário',
    filtros: { tipo: '', mes: '' },
    meses: [{ valor: '2026-10', etiqueta: 'outubro 2026' }],
    temFiltros: false,
    totalSemFiltros: 1,
    totalRelevantes: 1,
    proximos: [eventoNormalizado],
    passados: [],
    proximo: eventoNormalizado,
    total: 1,
    hoje: HOJE,
  });
  assert.ok(html.includes('/admin/calendario/eventos/nova'), 'o calendário liga a criar evento');
  assert.ok(html.includes('Novo evento'), 'o atalho tem rótulo');
  assert.ok(html.includes('value="evento"'), 'o filtro oferece a origem «evento»');
  assert.ok(html.includes('/admin/calendario/eventos/31'), 'o evento liga ao seu formulário');
  assert.ok(html.includes('Editar'), 'o evento é apresentado como editável');
  // Os atalhos das outras origens continuam lá — e sem prometer edição.
  assert.ok(html.includes('/admin/assembleias/nova'), 'mantém o atalho para assembleias');
  assert.ok(html.includes('/admin/avisos/nova'), 'mantém o atalho para comunicações');
  feito('Vista do calendário: evento editável, filtro e atalhos das três origens');

  // 9.5 A vista NÃO promete edição nos eventos das outras origens.
  html = tplCal({
    titulo: 'Calendário',
    filtros: { tipo: 'assembleia', mes: '' },
    meses: [],
    temFiltros: true,
    totalSemFiltros: 2,
    totalRelevantes: 1,
    proximos: [cal.eventoDeAssembleia(A1)],
    passados: [],
    proximo: cal.eventoDeAssembleia(A1),
    total: 1,
    hoje: HOJE,
  });
  assert.ok(html.includes('/admin/assembleias/11'), 'a assembleia liga ao módulo de origem');
  assert.ok(html.includes('Ver detalhe'), 'a assembleia é apresentada como «Ver detalhe»');
  assert.ok(
    !html.includes('/admin/calendario/eventos/11'),
    'a assembleia NÃO ganha link de edição de evento'
  );
  feito('Assembleias/comunicações não ganham promessa de edição no calendário');

  // 9.6 Estado vazio oferece as duas criações.
  html = tplCal({
    titulo: 'Calendário', filtros: { tipo: '', mes: '' }, meses: [], temFiltros: false,
    totalSemFiltros: 0, totalRelevantes: 0, proximos: [], passados: [], proximo: null,
    total: 0, hoje: HOJE,
  });
  assert.ok(html.includes('/admin/calendario/eventos/nova'), 'o estado vazio leva a criar evento');
  assert.ok(html.includes('/admin/assembleias/nova'), 'e também a criar assembleia');
  feito('Estado vazio oferece criar evento e criar assembleia');

  // ───────────────────────────────────────────────────────────────────
  // 10. Reposição do cache
  // ───────────────────────────────────────────────────────────────────
  if (caminhoModelsCacheAnterior) require.cache[caminhoModels] = caminhoModelsCacheAnterior;
  else delete require.cache[caminhoModels];

  console.log(`\n${nTestes} verificações passaram.`);
})().catch((e) => {
  console.error('\nFALHOU:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
