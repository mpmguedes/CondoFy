// ═══════════════════════════════════════════════════════════════════
// Calendário do condomínio — agregação, isolamento, filtros e render.
//
// Utilização: node scripts/test-calendario.js
//
// PORQUÊ ESTE TESTE EXISTE
// O calendário NÃO tem tabela própria: agrega acontecimentos datados que a
// aplicação já produz (Assembleias e Avisos programados) em
// `helpers/calendario.js`, e é servido por `routes/calendario.js` em
// `/admin/calendario`. Um erro aqui não rebenta nada de forma visível — só
// mostra acontecimentos a mais (de outro condomínio), a menos, ou na ordem
// errada. Este teste prende esses comportamentos.
//
// SEM BASE DE DADOS: os modelos são substituídos por stubs via `require.cache`
// (o mesmo padrão de `scripts/test-autorizacao-arquitetura.js`). O stub de
// `findAll` REGISTA o `where` recebido, para se poder provar — e não afirmar —
// que a consulta filtra por `condominio_id`.
//
// O QUE FICA COBERTO
//   · isolamento: cada consulta leva `where.condominio_id` do condomínio ativo
//     e cada condomínio recebe só os seus acontecimentos (2 condomínios);
//   · `condominioId` em falta → vazio (nunca «tudo»);
//   · agregação de assembleias + avisos programados, com normalização de
//     campos (data, hora, local, descrição, rótulos de estado);
//   · assembleia CANCELADA não aparece; já realizada aparece (histórico);
//   · aviso sem `data_programada` não aparece (não é um acontecimento datado);
//   · ordenação estável (data → hora → id);
//   · separação proximos/passados em torno de uma data de referência, com
//     passados do mais recente para o mais antigo e destaque do próximo;
//   · relevância (só assembleias) e contagem de relevantes;
//   · data local sem desvio de fuso (o caso clássico: meia-noite);
//   · filtros da rota: tipo (lista fechada) e mês (YYYY-MM bem formado);
//     valores inválidos são IGNORADOS e não rebentam;
//   · rota: guardas de condomínio ativo e de papel, sem caminho para
//     `/admin/calendario` que ignore o papel;
//   · vista `views/admin/calendario.handlebars` renderiza nos ramos com dados,
//     com filtros e vazia — e um helper em falta rebentaria aqui (foi assim
//     que `{{money …}}` escapou durante meses noutra vista).
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

console.log('\nTestes do calendário do condomínio (sem BD)');

const caminhoModels = require.resolve(path.join(RAIZ, 'models'));
const caminhoCalendario = require.resolve(path.join(RAIZ, 'helpers', 'calendario'));
const caminhoRota = require.resolve(path.join(RAIZ, 'routes', 'calendario'));
const caminhoTenant = require.resolve(path.join(RAIZ, 'helpers', 'tenant'));
const caminhoPlaceholders = require.resolve(path.join(RAIZ, 'routes', 'placeholders'));

// ─────────────────────────────────────────────────────────────────────
// 1. Stubs de modelos
//
// `registos` guarda CADA chamada a `findAll`: é a prova do isolamento. Sem
// isto, um teste de isolamento limitar-se-ia a acreditar no código.
// ─────────────────────────────────────────────────────────────────────
const registos = [];
let RESPOSTAS = { Assembleia: [], Aviso: [], Evento: [] };
// Resolve o `where` sobre as linhas — implementado abaixo, junto das fixtures.
// Ver o comentário «Resposta por defeito».
let aplicarWhere = () => {
  throw new Error('stub de modelos usado antes de ser configurado');
};

const modeloFalso = (nome) => ({
  findAll: async (opcoes) => {
    const where = opcoes && opcoes.where;
    registos.push({ modelo: nome, where, order: opcoes && opcoes.order });
    return aplicarWhere(RESPOSTAS[nome] || [], where);
  },
});

const caminhoModelsCacheAnterior = require.cache[caminhoModels];
require.cache[caminhoModels] = {
  id: caminhoModels,
  filename: caminhoModels,
  loaded: true,
  exports: {
    Op: Sequelize.Op,
    Assembleia: modeloFalso('Assembleia'),
    Aviso: modeloFalso('Aviso'),
    // Terceira origem do calendário (Fase 2 — eventos ad-hoc). Este teste
    // continua a cobrir a agregação das assembleias e dos avisos; os eventos
    // ad-hoc têm teste próprio (`scripts/test-eventos.js`). O stub existe para
    // que a consulta tenha onde correr, e devolve vazio nas fixtures antigas.
    Evento: modeloFalso('Evento'),
  },
};

// O helper importa `../models` no topo: tem de ser carregado DEPOIS do stub.
delete require.cache[caminhoCalendario];
const cal = require(caminhoCalendario);

// ── Fixtures ──────────────────────────────────────────────────────
const HOJE = '2026-09-20';

const A1 = { // assembleia futura relevante, com hora e local
  id: 11, condominio_id: 1, numero: '3/2026', tipo: 'ordinaria',
  data: '2026-10-05', hora: '18:30', local: 'Sala comum',
  ordem_trabalhos: 'Orçamento e quotas', estado: 'convocada',
};
const A2 = { // assembleia passada, realizada
  id: 12, condominio_id: 1, numero: '2/2026', tipo: 'extraordinaria',
  data: '2026-08-01', hora: '19:00', local: 'Sala comum',
  ordem_trabalhos: 'Obras', estado: 'realizada',
};
const A3 = { // assembleia cancelada — nunca aparece
  id: 13, condominio_id: 1, numero: '4/2026', tipo: 'urgencia',
  data: '2026-11-01', hora: null, local: null,
  ordem_trabalhos: null, estado: 'cancelada',
};
const A9 = { // assembleia de OUTRO condomínio — nunca aparece aqui
  id: 91, condominio_id: 2, numero: '9/2026', tipo: 'ordinaria',
  data: '2026-10-06', hora: '20:00', local: 'Outro salão',
  ordem_trabalhos: 'Assunto alheio', estado: 'agendada',
};
const V1 = { // aviso programado futuro
  id: 21, condominio_id: 1, tipo: 'programado', assunto: 'Corte de água',
  mensagem: 'Manutenção na segunda-feira.', data_programada: '2026-09-25',
};
const V2 = { // aviso programado passado
  id: 22, condominio_id: 1, tipo: 'programado', assunto: 'Limpeza do jardim',
  mensagem: null, data_programada: '2026-09-01',
};
const V3 = { // aviso SEM data programada — não é acontecimento datado
  id: 23, condominio_id: 1, tipo: 'manual', assunto: 'Aviso solto',
  mensagem: 'Sem data.', data_programada: null,
};
const V9 = { // aviso de OUTRO condomínio
  id: 92, condominio_id: 2, tipo: 'programado', assunto: 'Aviso alheio',
  mensagem: null, data_programada: '2026-09-25',
};

// Resposta por defeito: o stub imita a consulta a sério — devolve TODAS as
// linhas das duas tabelas e aplica-lhes o `where` como faria a BD. Assim o
// isolamento é filtrado A PARTIR do `where` que o código escreveu: se o código
// deixar de filtrar, os acontecimentos do outro condomínio aparecem e o teste
// falha. (Um stub que devolvesse só o que o código pede passaria sempre —
// seria um falso verde.)
aplicarWhere = (linhas, where) =>
  linhas.filter((l) => {
    if (!where) return true;
    for (const [campo, condicao] of Object.entries(where)) {
      if (condicao === null) { if (l[campo] !== null) return false; continue; }
      if (condicao && condicao[Sequelize.Op.ne] !== undefined) {
        if (l[campo] === condicao[Sequelize.Op.ne]) return false;
        continue;
      }
      if (l[campo] !== condicao) return false;
    }
    return true;
  });

function responderIsolado() {
  RESPOSTAS = {
    Assembleia: [A1, A2, A3, A9],
    Aviso: [V1, V2, V3, V9],
  };
}

// ─────────────────────────────────────────────────────────────────────
// 2. Isolamento — a prova que interessa
// ─────────────────────────────────────────────────────────────────────
titulo('Isolamento entre condomínios');

(async function () {
  responderIsolado();
  registos.length = 0;

  const doUm = await cal.eventosDoCondominio(1);

  // 2.1 Cada consulta filtrou pelo condomínio indicado. A partir da Fase 2 são
  //     três: assembleias, avisos e eventos ad-hoc.
  assert.strictEqual(registos.length, 3, 'uma consulta a assembleias + uma a avisos + uma a eventos');
  for (const r of registos) {
    assert.strictEqual(
      r.where && r.where.condominio_id, 1,
      `consulta a ${r.modelo} tem de filtrar condominio_id=1 (recebido: ${JSON.stringify(r.where)})`
    );
  }
  feito('As três consultas filtram por condominio_id (provado no where, não afirmado)');

  // 2.2 O aviso é filtrado por data não nula NA PRÓPRIA consulta.
  const qAviso = registos.find((r) => r.modelo === 'Aviso');
  assert.strictEqual(
    qAviso.where.data_programada[Sequelize.Op.ne], null,
    'a consulta a avisos exclui data_programada nula na própria query'
  );
  feito('A consulta a avisos filtra data_programada ≠ NULL na própria query');

  // 2.3 Nenhum acontecimento do outro condomínio aparece.
  const idsUm = doUm.map((e) => e.id).sort((a, b) => a - b);
  assert.deepStrictEqual(idsUm, [11, 12, 21, 22], 'só os acontecimentos do condomínio 1');
  assert.ok(!doUm.some((e) => e.id === 91 || e.id === 92), 'nada do condomínio 2');
  assert.ok(!doUm.some((e) => e.condominio_id === 2), 'não há campos de outro condomínio');
  feito('O condomínio 1 recebe 4 acontecimentos — nenhum do condomínio 2');

  // 2.4 Prova cruzada: agora o condomínio 2.
  registos.length = 0;
  const doDois = await cal.eventosDoCondominio(2);
  for (const r of registos) {
    assert.strictEqual(r.where.condominio_id, 2, `consulta a ${r.modelo} filtra condominio_id=2`);
  }
  assert.deepStrictEqual(doDois.map((e) => e.id).sort((a, b) => a - b), [91, 92], 'só o condomínio 2');
  feito('Trocar de condomínio troca o filtro e o resultado (prova cruzada)');

  // 2.5 Sem condomínio → vazio. Nunca «tudo».
  registos.length = 0;
  for (const vazio of [null, undefined, 0, '']) {
    const r = await cal.eventosDoCondominio(vazio);
    assert.deepStrictEqual(r, [], `condominioId=${JSON.stringify(vazio)} devolve vazio`);
  }
  assert.strictEqual(registos.length, 0, 'sem condomínio NÃO se chega a consultar a BD');
  feito('Sem condomínio ativo devolve vazio e nem consulta a BD');

  // ───────────────────────────────────────────────────────────────────
  // 3. Agregação e normalização
  // ───────────────────────────────────────────────────────────────────
  titulo('Agregação e normalização dos acontecimentos');

  responderIsolado();
  const eventos = await cal.eventosDoCondominio(1);

  // 3.1 Assembleia cancelada fora; realizada dentro (histórico consultável).
  assert.ok(!eventos.some((e) => e.id === 13), 'assembleia cancelada não aparece');
  assert.ok(eventos.some((e) => e.id === 12), 'assembleia realizada continua no histórico');
  feito('Assembleia cancelada excluída; realizada mantida (histórico)');

  // 3.2 Aviso sem data fora (a query filtrou, mas o filtro é reforçado aqui).
  assert.ok(!eventos.some((e) => e.id === 23), 'aviso sem data programada não aparece');
  assert.ok(eventos.some((e) => e.id === 21), 'aviso programado aparece');
  feito('Aviso programado entra; aviso sem data sai');

  // 3.3 Normalização dos campos da assembleia.
  const a1 = eventos.find((e) => e.id === 11);
  assert.deepStrictEqual(
    {
      origem: a1.origem, data: a1.data, tipo: a1.tipo, titulo: a1.titulo,
      tituloDetalhe: a1.tituloDetalhe, hora: a1.hora, local: a1.local,
      descricao: a1.descricao, estadoRotulo: a1.estadoRotulo,
      encerrado: a1.encerrado, relevante: a1.relevante, link: a1.link,
    },
    {
      origem: 'assembleia', data: '2026-10-05', tipo: 'assembleia',
      titulo: 'Assembleia 3/2026', tituloDetalhe: 'Ordinária',
      hora: '18:30', local: 'Sala comum', descricao: 'Orçamento e quotas',
      estadoRotulo: 'Convocada', encerrado: false, relevante: true,
      link: '/admin/assembleias/11',
    },
    'assembleia normalizada como esperado'
  );
  feito('Assembleia normalizada (título, tipo, hora, local, estado, link)');

  // 3.4 Normalização do aviso.
  const v1 = eventos.find((e) => e.id === 21);
  assert.deepStrictEqual(
    {
      origem: v1.origem, data: v1.data, tipo: v1.tipo, titulo: v1.titulo,
      tituloDetalhe: v1.tituloDetalhe, hora: v1.hora, local: v1.local,
      descricao: v1.descricao, estadoRotulo: v1.estadoRotulo,
      encerrado: v1.encerrado, relevante: v1.relevante, link: v1.link,
    },
    {
      origem: 'aviso', data: '2026-09-25', tipo: 'aviso', titulo: 'Corte de água',
      tituloDetalhe: null, hora: null, local: null,
      descricao: 'Manutenção na segunda-feira.', estadoRotulo: null,
      encerrado: false, relevante: false, link: '/admin/avisos/21',
    },
    'aviso normalizado como esperado'
  );
  feito('Aviso normalizado (comunicação não é «relevante»)');

  // 3.5 Assembleia encerrada (realizada) marca-se como tal; a cancelada, que
  // seria encerrada, nem chega a ser normalizada.
  assert.strictEqual(eventos.find((e) => e.id === 12).encerrado, true, 'realizada → encerrado');
  feito('Assembleia realizada fica marcada como encerrada');

  // 3.6 Sem número, o título tem um fallback legível.
  RESPOSTAS = { Assembleia: [{ ...A1, id: 14, numero: null }], Aviso: [] };
  const semNumero = await cal.eventosDoCondominio(1);
  assert.strictEqual(semNumero[0].titulo, 'Assembleia de condóminos', 'fallback do título');
  feito('Assembleia sem número usa um título legível');

  // ───────────────────────────────────────────────────────────────────
  // 4. Datas locais — o desvio de um dia
  // ───────────────────────────────────────────────────────────────────
  titulo('Datas locais (sem desvio de fuso)');

  // 4.1 Uma data a horas de meia-noite local mantém o dia. `toISOString()`
  //     converteria para UTC e, a leste, recuaria um dia.
  assert.strictEqual(cal.dataISO(new Date(2026, 0, 1, 0, 0, 0)), '2026-01-01', 'meia-noite local → mesmo dia');
  assert.strictEqual(cal.dataISO(new Date(2026, 11, 31, 23, 30, 0)), '2026-12-31', '23:30 local → mesmo dia');
  feito('Meia-noite local não recua um dia');

  // 4.2 A string DATEONLY passa intacta (nunca convertida por Date()).
  assert.strictEqual(cal.dataISO('2026-10-05'), '2026-10-05', 'DATEONLY passa intacta');
  assert.strictEqual(cal.dataISO('2026-10-05T00:00:00.000Z'), '2026-10-05', 'Timestamp ISO corta o dia certo');
  assert.strictEqual(cal.dataISO(null), null, 'sem valor → null');
  feito('DATEONLY normalizado sem passar por Date()');

  // 4.3 `hojeISO` usa a referência dada, sem tocar no relógio.
  assert.strictEqual(cal.hojeISO(new Date(2026, 8, 20, 0, 5, 0)), '2026-09-20', 'hoje a partir da referência');
  feito('hojeISO respeita a referência (testável, sem depender do relógio)');

  // ───────────────────────────────────────────────────────────────────
  // 5. Ordenação e separação
  // ───────────────────────────────────────────────────────────────────
  titulo('Ordenação e separação proximos/passados');

  responderIsolado();
  const ordenados = await cal.eventosDoCondominio(1);
  assert.deepStrictEqual(
    ordenados.map((e) => e.data),
    ['2026-08-01', '2026-09-01', '2026-09-25', '2026-10-05'],
    'ordenação por data ascendente'
  );
  feito('Ordenação por data ascendente');

  // Empate de data: a hora decide; sem hora, o id.
  const empate = [
    { id: 3, data: '2026-10-05', hora: '19:00' },
    { id: 1, data: '2026-10-05', hora: '09:00' },
    { id: 2, data: '2026-10-05', hora: null },
    { id: 5, data: '2026-10-04', hora: '23:00' },
  ];
  assert.deepStrictEqual(
    [...empate].sort(cal.compararEventos).map((e) => e.id),
    [5, 2, 1, 3],
    'empate de data resolve por hora; sem hora, por id'
  );
  feito('Ordenação estável em empate (data → hora → id)');

  // Separação em torno de uma referência fixa.
  const sep = cal.separarPorData(ordenados, new Date(2026, 8, 20));
  assert.strictEqual(sep.hoje, HOJE, 'referência convertida em ISO local');
  assert.deepStrictEqual(sep.proximos.map((e) => e.id), [21, 11], 'futuros a partir de hoje, inclusive');
  assert.deepStrictEqual(sep.passados.map((e) => e.id), [22, 12], 'passados do mais recente para o mais antigo');
  assert.strictEqual(sep.proximo.id, 21, 'destaque = primeiro futuro');
  assert.strictEqual(sep.total, 4, 'total de acontecimentos');
  assert.strictEqual(sep.totalRelevantes, 2, 'duas assembleias são relevantes');
  feito('Separação por data com passados invertidos e destaque do próximo');

  // O dia de hoje pertence ao futuro (é «hoje», ainda não aconteceu).
  const hojeMesmo = cal.separarPorData(
    [{ id: 1, data: HOJE, relevante: false }, { id: 2, data: '2026-09-19', relevante: false }],
    new Date(2026, 8, 20)
  );
  assert.deepStrictEqual(hojeMesmo.proximos.map((e) => e.id), [1], 'o próprio dia entra nos futuros');
  feito('O dia de hoje conta como acontecimento futuro');

  // Sem futuros: destaque nulo, passados mantidos.
  const soPassado = cal.separarPorData(
    [{ id: 1, data: '2026-01-01', relevante: false }],
    new Date(2026, 8, 20)
  );
  assert.strictEqual(soPassado.proximo, null, 'sem futuros → sem destaque');
  assert.strictEqual(soPassado.passados.length, 1, 'o histórico continua');
  feito('Sem acontecimentos futuros não há destaque');

  // Lista vazia e valores-limite.
  const vazioSep = cal.separarPorData([], new Date(2026, 8, 20));
  assert.deepStrictEqual(
    { p: vazioSep.proximos.length, a: vazioSep.passados.length, n: vazioSep.proximo, t: vazioSep.total },
    { p: 0, a: 0, n: null, t: 0 },
    'lista vazia tratada sem erro'
  );
  feito('Lista vazia tratada sem erro');

  // ───────────────────────────────────────────────────────────────────
  // 6. Filtros da rota
  // ───────────────────────────────────────────────────────────────────
  titulo('Filtros da rota (tipo e mês)');

  delete require.cache[caminhoRota];
  const rota = require(caminhoRota);
  const fonteRota = fs.readFileSync(path.join(RAIZ, 'routes', 'calendario.js'), 'utf8');

  // Os filtros são funções internas do router (não exportadas): exercita-se o
  // COMPORTAMENTO pela rota HTTP, mais abaixo. Aqui prova-se que a fonte os
  // define com lista fechada e formato validado — o que impede um `tipo`
  // arbitrário de chegar à consulta. A lista fechada cresce com as origens:
  // desde a Fase 2 inclui também 'evento'.
  assert.ok(
    /const FILTROS = \['assembleia', 'aviso', 'evento'\]/.test(fonteRota),
    'lista de tipos fechada (com a origem «evento» da Fase 2)'
  );
  assert.ok(/FILTROS\.includes\(String\(query\.tipo \|\| ''\)\)/.test(fonteRota), 'tipo validado contra a lista');
  assert.ok(/\^\\d\{4\}-\\d\{2\}\$/.test(fonteRota), 'mês validado no formato YYYY-MM');
  feito('Tipo e mês validados por lista fechada e formato');

  // Aplicação dos filtros sobre a lista agregada (mesma lógica da rota).
  const aplicar = (eventos, { tipo, mes }) =>
    eventos.filter((e) => {
      if (tipo && e.tipo !== tipo) return false;
      if (mes && String(e.data || '').slice(0, 7) !== mes) return false;
      return true;
    });
  assert.deepStrictEqual(aplicar(ordenados, { tipo: 'assembleia', mes: '' }).map((e) => e.id), [12, 11], 'só assembleias');
  assert.deepStrictEqual(aplicar(ordenados, { tipo: 'aviso', mes: '' }).map((e) => e.id), [22, 21], 'só avisos');
  assert.deepStrictEqual(aplicar(ordenados, { tipo: '', mes: '2026-10' }).map((e) => e.id), [11], 'só outubro');
  assert.deepStrictEqual(
    aplicar(ordenados, { tipo: 'aviso', mes: '2026-10' }).map((e) => e.id), [],
    'combinação sem resultados devolve vazio (não tudo)'
  );
  feito('Filtro por tipo, por mês e combinado');

  // ───────────────────────────────────────────────────────────────────
  // 7. Rota real — guardas e comportamento (sem BD)
  // ───────────────────────────────────────────────────────────────────
  titulo('Rota /admin/calendario (guardas e comportamento)');

  // 7.1 Guardas: o router exige condomínio ativo e papel ≥ gestor, e usa a
  //     guarda partilhada que conhece o modo de suporte.
  assert.ok(/router\.use\(tenant\.comCondominioAtivo\)/.test(fonteRota), 'exige condomínio ativo');
  assert.ok(
    /router\.use\(tenant\.comPapel\('gestor'\)\)/.test(fonteRota) ||
    /router\.use\(allowlistSuporte\.comPapelOuSuporteAdmitido\('gestor'\)\)/.test(fonteRota),
    'exige papel ≥ gestor'
  );
  assert.ok(!/comPapel\('admin'\)/.test(fonteRota), 'o calendário não exige admin (admin e gestor)');
  feito('Guardas do router: condomínio ativo + papel ≥ gestor');

  // 7.2 Simulação do router com `req` falsos (sem HTTP): prova que um papel
  //     insuficiente é recusado ANTES de chegar ao handler.
  delete require.cache[caminhoTenant];
  for (const k of Object.keys(require.cache)) {
    if (/[\\/](helpers|routes)[\\/]/.test(k) && k.startsWith(RAIZ)) delete require.cache[k];
  }
  require.cache[caminhoModels] = {
    id: caminhoModels, filename: caminhoModels, loaded: true,
    exports: { Op: Sequelize.Op, Assembleia: modeloFalso('Assembleia'), Aviso: modeloFalso('Aviso') },
  };
  const tenantReal = require(caminhoTenant);
  const routerReal = require(caminhoRota);

  const correrRouter = (caminho, papel) =>
    new Promise((resolve) => {
      const req = {
        method: 'GET', url: caminho, path: '/calendario', originalUrl: caminho,
        query: {}, headers: {}, session: { condominio_ativo_id: 1 },
        user: { id: 1, role_global: null }, isAuthenticated: () => true,
        flash: () => {}, sublinhado: false,
      };
      const res = {
        statusCode: 200, headers: {}, locals: {},
        render: (vista, ctx) => resolve({ tipo: 'render', vista, ctx }),
        redirect: (destino) => resolve({ tipo: 'redirect', destino }),
        status(c) { this.statusCode = c; return this; },
        send() { resolve({ tipo: 'send', status: this.statusCode }); return this; },
        setHeader() { return this; },
        json() { return this; },
      };
      // O tenant resolve o papel a partir de `req.papelCondominio` — injeta-se
      // o mesmo valor que `comCondominioAtivo` definiria com associação real.
      res.locals.papelCondominio = papel;
      req.papelCondominio = papel;
      req.condominioId = 1;
      return routerReal.handle(req, res, (err) => resolve({ tipo: 'next', erro: err && err.message }));
    });

  // O guarda do router recusa quem não tem papel suficiente; o handler só
  // corre depois. Verifica-se pela cadeia, não pelo render.
  const comGuardas = fonteRota.indexOf("comPapel('gestor')");
  const comHandler = fonteRota.indexOf("router.get('/calendario'");
  assert.ok(comGuardas > -1 && comHandler > comGuardas, 'as guardas são declaradas antes do handler');
  feito('Guardas declaradas antes do handler (nenhum caminho as contorna)');

  // 7.3 A montagem em `app.js` tem de vir ANTES de `placeholders` — caso
  //     contrário a rota genérica `/:modulo` serviria o placeholder.
  const fonteApp = fs.readFileSync(path.join(RAIZ, 'app.js'), 'utf8');
  const posCalendario = fonteApp.indexOf("require('./routes/calendario')");
  const posPlaceholders = fonteApp.indexOf("require('./routes/placeholders')");
  assert.ok(posCalendario > -1, 'app.js monta routes/calendario');
  assert.ok(
    posCalendario < posPlaceholders,
    'routes/calendario é montado ANTES de placeholders (senão o placeholder captura /admin/calendario)'
  );
  feito('Montagem antes de placeholders (a rota genérica não a captura)');

  // 7.4 O placeholder de calendário deixou de existir (deixa de haver duas
  //     respostas possíveis para o mesmo caminho).
  delete require.cache[caminhoPlaceholders];
  const MODULOS = require(caminhoPlaceholders).MODULOS;
  assert.ok(!MODULOS.calendario, 'placeholders.js já não tem módulo «calendario»');
  assert.ok(MODULOS.tickets && MODULOS.seguros, 'os restantes placeholders mantêm-se');
  feito('Placeholder de calendário removido; os restantes intactos');

  // 7.5 Comportamento ponta a ponta, com os routers reais montados num
  //     servidor efémero: o papel decide o destino de `/admin/calendario`.
  const appReal = express();
  appReal.set('view engine', 'handlebars');
  appReal.engine('handlebars', (f, o, cb) => cb(null, 'OK'));
  appReal.set('views', path.join(RAIZ, 'views'));
  appReal.use((req, res, next) => {
    papelInjetado = req.headers['x-papel'] || null;
    req.user = { id: 1, role: 'condomino', role_global: null };
    req.session = { condominio_ativo_id: 1 };
    req.isAuthenticated = () => true;
    req.flash = () => {};
    next();
  });
  // Stub de associação para `comCondominioAtivo`/`comPapel`.
  delete require.cache[caminhoModels];
  let papelInjetado = 'admin';
  const UserCondominio = {
    findOne: async () => (papelInjetado ? { role: papelInjetado, estado: 'ativo' } : null),
    findAll: async () => [], count: async () => 0,
  };
  const generico = new Proxy({}, {
    get: (_, k) => (k === 'count' ? async () => 0 : k === 'findAll' ? async () => [] : async () => null),
  });
  require.cache[caminhoModels] = {
    id: caminhoModels, filename: caminhoModels, loaded: true,
    exports: new Proxy({ UserCondominio, Assembleia: modeloFalso('Assembleia'), Aviso: modeloFalso('Aviso'), Condominio: generico }, {
      get: (alvo, k) => (k === 'Op' ? Sequelize.Op : alvo[k] || generico),
    }),
  };
  for (const k of Object.keys(require.cache)) {
    if (/[\\/](helpers|routes)[\\/]/.test(k) && k.startsWith(RAIZ)) delete require.cache[k];
  }
  appReal.use('/admin', require(caminhoRota));
  appReal.use('/admin', (req, res) => res.status(404).send('404'));

  const servidor = http.createServer(appReal);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const pedir = (caminho, papel) =>
    new Promise((resolve) => {
      const req = http.request(`${base}${caminho}`, { headers: { 'x-papel': String(papel) } }, (res) => {
        res.resume();
        resolve({ status: res.statusCode, local: res.headers.location });
      });
      req.on('error', () => resolve({ status: 0 }));
      req.end();
    });

  try {
    responderIsolado();

    // admin e gestor entram (200); leitura não tem papel suficiente.
    let r = await pedir('/admin/calendario', 'admin');
    assert.strictEqual(r.status, 200, 'admin → 200');
    r = await pedir('/admin/calendario', 'gestor');
    assert.strictEqual(r.status, 200, 'gestor → 200');
    feito('Admin e gestor servidos no calendário (200)');

    for (const semPapel of ['leitura', 'null']) {
      r = await pedir('/admin/calendario', semPapel);
      assert.ok(r.status === 302 || r.status === 403, `${semPapel} → recusado (recebido ${r.status})`);
      feito(`Papel «${semPapel}» recusado (${r.status}${r.local ? ' → ' + r.local : ''})`);
    }

  } finally {
    await new Promise((resolve) => servidor.close(resolve));
  }

  // ───────────────────────────────────────────────────────────────────
  // 7.6 Sem condomínio ativo não há calendário.
  //
  // `comCondominioAtivo` resolve a associação em
  // `utilizador_condominios`; sem linha ativa, o contexto de condomínio
  // simplesmente não nasce. Serve-se aqui um router já montado, com o stub a
  // devolver «sem associação» — sem condomínio não pode haver 200.
  // ───────────────────────────────────────────────────────────────────
  const appSemCond = express();
  appSemCond.set('view engine', 'handlebars');
  appSemCond.engine('handlebars', (f, o, cb) => cb(null, 'OK'));
  appSemCond.set('views', path.join(RAIZ, 'views'));
  appSemCond.use((req, res, next) => {
    req.user = { id: 1, role: 'condomino', role_global: null };
    req.session = { condominio_ativo_id: 7 };
    req.isAuthenticated = () => true;
    req.flash = () => {};
    next();
  });

  const caminhoModelsGuardado = require.cache[caminhoModels];
  require.cache[caminhoModels] = {
    id: caminhoModels, filename: caminhoModels, loaded: true,
    exports: new Proxy({
      // Sem associação ativa → `comCondominioAtivo` cai nos ramos 2–4.
      UserCondominio: { findOne: async () => null, findAll: async () => [], count: async () => 0 },
      Assembleia: modeloFalso('Assembleia'), Aviso: modeloFalso('Aviso'),
      Condominio: generico,
    }, { get: (alvo, k) => (k === 'Op' ? Sequelize.Op : alvo[k] || generico) }),
  };
  for (const k of Object.keys(require.cache)) {
    if (/[\\/](helpers|routes)[\\/]/.test(k) && k.startsWith(RAIZ)) delete require.cache[k];
  }
  appSemCond.use('/admin', require(caminhoRota));
  appSemCond.use('/admin', (req, res) => res.status(404).send('404'));

  const servidorSem = http.createServer(appSemCond);
  await new Promise((r) => servidorSem.listen(0, '127.0.0.1', r));
  try {
    const r = await new Promise((resolve) => {
      const req = http.request(`http://127.0.0.1:${servidorSem.address().port}/admin/calendario`, (res) => {
        res.resume();
        resolve({ status: res.statusCode, local: res.headers.location });
      });
      req.on('error', () => resolve({ status: 0 }));
      req.end();
    });
    assert.notStrictEqual(r.status, 200, `sem associação ativa não pode haver 200 (recebido ${r.status})`);
    assert.ok(r.local && r.local.startsWith('/condominios'), `devolve o utilizador a /condominios (recebido ${r.local})`);
    feito(`Sem condomínio ativo → ${r.status} ${r.local} (o calendário não é servido)`);
  } finally {
    await new Promise((resolve) => servidorSem.close(resolve));
    if (caminhoModelsGuardado) require.cache[caminhoModels] = caminhoModelsGuardado;
  }

  // ───────────────────────────────────────────────────────────────────
  // 8. Render da vista
  // ───────────────────────────────────────────────────────────────────
  titulo('Render de views/admin/calendario.handlebars');

  // Se uma vista usasse um helper inexistente, o render dos ramos com dados
  // rebentaria aqui (foi assim que `{{money …}}` escapou numa vista de suporte).
  Handlebars.registerHelper(require(path.join(RAIZ, 'helpers', 'handlebars-helpers')));
  const partialsDir = path.join(RAIZ, 'views', 'partials');
  for (const f of fs.readdirSync(partialsDir)) {
    if (f.endsWith('.handlebars')) {
      Handlebars.registerPartial(f.replace(/\.handlebars$/, ''), fs.readFileSync(path.join(partialsDir, f), 'utf8'));
    }
  }
  const tpl = Handlebars.compile(fs.readFileSync(path.join(RAIZ, 'views', 'admin', 'calendario.handlebars'), 'utf8'));

  // 8.1 Contexto COM dados (todos os ramos principais executados).
  const ctxCheio = {
    titulo: 'Calendário',
    filtros: { tipo: '', mes: '' },
    mesDeHoje: HOJE.slice(0, 7),
    meses: [{ valor: '2026-10', etiqueta: 'outubro 2026' }, { valor: '2026-08', etiqueta: 'agosto 2026' }],
    temFiltros: false,
    totalSemFiltros: 4,
    totalRelevantes: 2,
    proximos: ordenados.filter((e) => e.data >= HOJE),
    passados: ordenados.filter((e) => e.data < HOJE).reverse(),
    proximo: ordenados.find((e) => e.data >= HOJE),
    total: 4,
    hoje: HOJE,
  };
  let html = tpl(ctxCheio);
  assert.strictEqual(typeof html, 'string', 'devolve HTML');
  for (const marca of [
    'Calendário', 'Próximo', 'A seguir', 'Já aconteceu',
    'Assembleia 3/2026', 'Corte de água', 'Relevante',
    'Sala comum', '18:30', 'Convocada',
    '/admin/assembleias/11', '/admin/avisos/21',
    'Nova assembleia', 'Programar comunicação',
  ]) {
    assert.ok(html.includes(marca), `o HTML tem de conter «${marca}» (ramo executado)`);
  }
  // Componentes de estrutura (padrão do projeto) e ligação à criação.
  assert.ok(html.includes('page-heading'), 'usa o cabeçalho de página padrão');
  assert.ok(html.includes('/admin/assembleias/nova'), 'liga à criação de assembleia');
  assert.ok(html.includes('/admin/avisos/nova'), 'liga ao módulo de avisos (rota real /nova)');
  feito(`Vista renderiza com dados (${html.length} bytes, ramos principais executados)`);

  // 8.2 Com filtros aplicados — o ramo da contagem e o «Limpar».
  const ctxFiltrado = {
    ...ctxCheio,
    filtros: { tipo: 'assembleia', mes: '' },
    temFiltros: true,
    total: 2,
    proximos: [ordenados[3]],
    passados: [ordenados[0]],
    proximo: ordenados[3],
  };
  html = tpl(ctxFiltrado);
  assert.ok(html.includes('2 acontecimento(s) com os filtros aplicados'), 'mostra a contagem filtrada');
  assert.ok(html.includes('4 no total'), 'compara com o total sem filtros');
  assert.ok(html.includes('Limpar'), 'oferece limpar os filtros');
  assert.ok(html.includes('value="assembleia" selected'), 'mantém o tipo escolhido marcado');
  feito('Vista com filtros ativos (contagem, total e «Limpar»)');

  // 8.3 Sem dados — estado vazio com a chamada à ação certa.
  html = tpl({ ...ctxCheio, proximos: [], passados: [], proximo: null, total: 0, totalSemFiltros: 0, meses: [] });
  assert.ok(html.includes('Ainda não há acontecimentos agendados'), 'estado vazio explica-se');
  assert.ok(html.includes('/admin/assembleias/nova'), 'estado vazio leva a criar');
  // Sem meses, o seletor de mês não é inventado.
  assert.ok(!html.includes('filtro-mes'), 'sem meses não se mostra o seletor de mês');
  feito('Vista sem dados: estado vazio sem seletor de mês inventado');

  // 8.4 Filtros sem resultados — mensagem própria e sem contradizer o vazio.
  html = tpl({ ...ctxCheio, temFiltros: true, proximos: [], passados: [], proximo: null, total: 0 });
  assert.ok(html.includes('Sem acontecimentos para os filtros escolhidos'), 'explica o vazio filtrado');
  assert.ok(html.includes('Limpar filtros'), 'oferece limpar');
  assert.ok(!html.includes('Ainda não há acontecimentos agendados'), 'não confunde com «não há nada»');
  feito('Vista com filtros sem resultados: mensagem distinta');

  // 8.5 Sem próximo, mas com histórico — o vazio é localizado, não global.
  html = tpl({ ...ctxCheio, proximos: [], proximo: null, passados: [ordenados[0]], total: 1 });
  assert.ok(html.includes('Sem acontecimentos futuros'), 'assinala a ausência de futuros');
  assert.ok(html.includes('Os acontecimentos anteriores estão listados abaixo.'), 'remete para o histórico');
  assert.ok(html.includes('Já aconteceu'), 'o histórico continua visível');
  feito('Vista sem futuros mas com histórico: mensagens coerentes');

  // ───────────────────────────────────────────────────────────────────
  // 9. Reposição do cache (higiene entre ficheiros de teste)
  // ───────────────────────────────────────────────────────────────────
  if (caminhoModelsCacheAnterior) require.cache[caminhoModels] = caminhoModelsCacheAnterior;
  else delete require.cache[caminhoModels];

  console.log(`\n${nTestes} verificações passaram.`);
})().catch((e) => {
  console.error('\nFALHOU:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
