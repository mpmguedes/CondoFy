// ═══════════════════════════════════════════════════════════════════
// Tips contextuais — ROTA DE DISPENSA (segurança e isolamento).
//
// Aqui corre o que o motor (scripts/test-tips-isolamento.js) não pode cobrir:
// a rota HTTP REAL (`routes/admin-tips.js`), com as guardas REAIS do
// `helpers/tenant.js` e o modelo `RecomendacaoEstado` em duplo com memória.
//
// O que se prova, e porquê:
//  1. dispensar grava a chave COM o condomínio da SESSÃO — e um
//     `condominioId` enviado pelo browser é ignorado (não muda o âmbito);
//  2. dispensar num condomínio não esconde o mesmo tip noutro;
//  3. a dispensa é POR CONTA: o registo de um utilizador não serve outro;
//  4. um identificador manipulado é recusado e nada é escrito;
//  5. o papel é verificado pela guarda real (`comPapel('gestor')`);
//  6. o caminho de regresso (`voltar`) é validado contra uma lista FECHADA —
//     um URL externo nunca é seguido nem devolvido no `Location`;
//  7. a ação/destino de cada tip vem do SERVIDOR (definição), nunca do browser.
//
// Utilização: node scripts/test-rotas-tips.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const RAIZ = path.join(__dirname, '..');
const DIA = 24 * 60 * 60 * 1000;

// ── Utilizadores ───────────────────────────────────────────────────
const UTILIZADORES = {
  42: { id: 42, nome: 'Ana Silva', email: 'ana@exemplo.pt', role_global: null, ativo: true },
  43: { id: 43, nome: 'Bruno Costa', email: 'bruno@exemplo.pt', role_global: null, ativo: true },
  44: { id: 44, nome: 'Carla Dias', email: 'carla@exemplo.pt', role_global: null, ativo: true },
  45: { id: 45, nome: 'Duarte Reis', email: 'duarte@exemplo.pt', role_global: null, ativo: true },
};

// Associações reais (utilizador ↔ condomínio ↔ papel). O 44 é `leitura` no
// condomínio 1 (vê o backoffice mas não escreve); o 45 não tem associação
// nenhuma (não deve entrar).
const ASSOCIACOES = [
  { utilizador_id: 42, condominio_id: 1, role: 'admin' },
  { utilizador_id: 42, condominio_id: 2, role: 'admin' },
  { utilizador_id: 43, condominio_id: 1, role: 'gestor' },
  { utilizador_id: 44, condominio_id: 1, role: 'leitura' },
];

// ── Memória da tabela `recomendacao_estados` ───────────────────────
// Duplo do modelo com comportamento a sério (create/findOne/update/findAll),
// para a dispensa ser realmente persistida entre pedidos. NÃO tem
// `condominio_id` — tal como a tabela real (migração 20260101000073).
const linhas = [];
let proximoId = 1;
const RecomendacaoEstado = {
  async findAll({ where }) {
    return linhas.filter((l) => l.user_id === where.user_id).map((l) => ({ ...l }));
  },
  async findOne({ where }) {
    const l = linhas.find((x) => x.user_id === where.user_id && x.recomendacao === where.recomendacao);
    if (!l) return null;
    return { ...l, async update(campos) { Object.assign(l, campos); return l; } };
  },
  async create(campos) {
    const linha = { id: proximoId, ...campos };
    proximoId += 1;
    linhas.push(linha);
    return linha;
  },
  async destroy({ where }) {
    let removidas = 0;
    for (let i = linhas.length - 1; i >= 0; i -= 1) {
      if (linhas[i].user_id === where.user_id && linhas[i].recomendacao === where.recomendacao) {
        linhas.splice(i, 1);
        removidas += 1;
      }
    }
    return removidas;
  },
};

// ── Duplos dos modelos ────────────────────────────────────────────
const CONDOMINIOS = { 1: { id: 1, estado: 'ativo' }, 2: { id: 2, estado: 'ativo' }, 3: { id: 3, estado: 'inativo' } };
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: {
    RecomendacaoEstado,
    User: { findByPk: async (id) => UTILIZADORES[Number(id)] || null, findAll: async () => Object.values(UTILIZADORES) },
    Condominio: { findByPk: async (id) => CONDOMINIOS[Number(id)] || null },
    // Associação ATIVA: só devolve papel quando o par (utilizador, condomínio)
    // existe em `ASSOCIACOES` — é o que a guarda real consulta.
    UserCondominio: {
      findOne: async ({ where }) => ASSOCIACOES.find(
        (a) => a.utilizador_id === where.utilizador_id && a.condominio_id === where.condominio_id
      ) || null,
      findAll: async ({ where }) => ASSOCIACOES.filter((a) => a.utilizador_id === where.utilizador_id),
    },
    AuditLog: { create: async () => ({}) },
  },
};

// ── Duplos de helpers ────────────────────────────────────────────
const auditados = [];
const stubs = {
  '../helpers/audit': {
    audit: async (registo) => { auditados.push(registo); return registo; },
    auditSafe: async (registo) => { auditados.push(registo); return registo; },
  },
  // `suporte.vigente` devolve sempre `null`: neste teste não há contexto de
  // suporte, pelo que a única via de acesso é a associação real. É o que
  // permite afirmar que «sem associação → recusado» (e não mascarado por um
  // acesso de suporte que não existe).
  '../helpers/suporte': {
    vigente: async () => null,
    paraContexto: () => null,
  },
};
for (const [rel, valor] of Object.entries(stubs)) {
  const p = require.resolve(path.join(RAIZ, rel.replace('../', '')));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}

// ── Aplicação de teste (rota REAL, guardas REAIS) ────────────────
const app = express();
app.set('view engine', 'handlebars');
app.set('views', path.join(RAIZ, 'views'));
app.use(session({ secret: 'teste', resave: false, saveUninitialized: true, rolling: false }));
app.use(express.urlencoded({ extended: true }));
app.use(flash());

// Utilizador e condomínio ativo da vez: vêm de cookies do teste, para se poder
// fazer pedidos como contas diferentes. O condomínio ativo é da SESSÃO — é
// exatamente o que a rota deve usar, e não o que o browser puser no corpo.
app.use((req, res, next) => {
  const marcaUser = /__sessao\.(\d+)/.exec(req.headers.cookie || '');
  const marcaCond = /__cond\.(\d+)/.exec(req.headers.cookie || '');
  req.user = UTILIZADORES[marcaUser ? Number(marcaUser[1]) : 42] || null;
  req.isAuthenticated = () => Boolean(req.user);
  req.session.condominio_ativo_id = marcaCond ? Number(marcaCond[1]) : 1;
  res.locals.success_msg = [];
  res.locals.error_msg = [];
  res.locals.error = [];
  next();
});

app.use('/admin', require('../routes/admin-tips'));
app.use((err, req, res, next) => {
  res.status(500).send('ERRO_NO_HANDLER: ' + err.message);
});

// ── Cliente HTTP ─────────────────────────────────────────────────
function pedir(caminho, { metodo = 'GET', utilizador = 42, condominio = 1, corpo = null } = {}) {
  return new Promise((resolve, reject) => {
    const servidor = app.listen(0, '127.0.0.1', () => {
      const cabecalhos = {
        Cookie: `__sessao.${utilizador}; __cond.${condominio}`,
      };
      let dados = null;
      if (corpo != null) {
        dados = new URLSearchParams(corpo).toString();
        cabecalhos['Content-Type'] = 'application/x-www-form-urlencoded';
        cabecalhos['Content-Length'] = Buffer.byteLength(dados);
      }
      const req = http.request({
        host: '127.0.0.1', port: servidor.address().port, path: caminho, method: metodo, headers: cabecalhos,
      }, (res) => {
        let corpoResposta = '';
        res.on('data', (d) => { corpoResposta += d; });
        res.on('end', () => {
          servidor.close();
          resolve({ status: res.statusCode, html: corpoResposta, local: res.headers.location || null });
        });
      });
      req.on('error', (e) => { servidor.close(); reject(e); });
      if (dados != null) req.write(dados);
      req.end();
    });
  });
}

const chaves = () => linhas.map((l) => `${l.user_id}|${l.recomendacao}`);
const TEM_CONDOMINIO_ID = (l) => Object.prototype.hasOwnProperty.call(l, 'condominio_id');

(async () => {
  const tips = require('../helpers/tips');

  // ── 1. Dispensa com papel adequado grava a chave com o âmbito ───
  const r1 = await pedir('/admin/tips/fracoes_por_definir/dispensar', { metodo: 'POST' });
  assert.strictEqual(r1.status, 302, 'dispensar: responde com redirecionamento');
  assert.strictEqual(r1.local, '/admin', 'dispensar: volta ao painel por omissão');
  assert.strictEqual(linhas.length, 1, 'dispensar: uma linha persistida');
  assert.strictEqual(linhas[0].user_id, 42, 'dispensar: gravado para a conta do pedido');
  assert.strictEqual(linhas[0].recomendacao, 'tip:fracoes_por_definir@c1',
    'dispensar: a chave inclui o condomínio da sessão');
  assert.ok(!TEM_CONDOMINIO_ID(linhas[0]), 'dispensar: NENHUM `condominio_id` é escrito');
  assert.strictEqual(linhas[0].intervalo_dias, 30, 'dispensar: intervalo de 30 dias');
  const dif = new Date(linhas[0].dispensada_ate).getTime() - new Date(linhas[0].dispensada_em).getTime();
  assert.strictEqual(Math.round(dif / DIA), 30, 'dispensar: fim do intervalo a 30 dias');
  const registo = auditados.find((a) => a.acao === 'tip_dispensado');
  assert.ok(registo, 'dispensar: registado na auditoria');
  assert.strictEqual(registo.detalhes.condominioId, 1, 'auditoria: condomínio da sessão');
  assert.strictEqual(registo.detalhes.tip, 'fracoes_por_definir', 'auditoria: tip correto');

  // ── 2. O condomínio vem da SESSÃO, nunca do browser ─────────────
  // Um `condominioId` forjado no corpo e na query não pode mudar o âmbito.
  const r2 = await pedir('/admin/tips/permilagem_incompleta/dispensar?condominioId=99', {
    metodo: 'POST', corpo: { condominioId: '99', voltar: '/admin' },
  });
  assert.strictEqual(r2.status, 302, 'condomínio forjado: responde com redirecionamento');
  assert.ok(chaves().includes('42|tip:permilagem_incompleta@c1'),
    'condomínio forjado: a chave usa o condomínio da SESSÃO (c1)');
  assert.ok(!chaves().some((k) => k.endsWith('@c99')), 'condomínio forjado: NUNCA se grava o valor do browser');
  assert.ok(!chaves().some((k) => k.endsWith('@c0')), 'condomínio forjado: nenhum âmbito inválido é gravado');

  // ── 3. Isolamento por condomínio ────────────────────────────────
  // Com a dispensa de `permilagem_incompleta` feita só no c1, o mesmo tip tem
  // de continuar elegível no c2 (o condomínio B não herda a decisão de A).
  const ctxEstrutura = (condominioId) => ({
    condominioId,
    papel: 'admin',
    fracoes: { n: 5, permilagemOk: false, permilagemTotal: 900 },
  });
  const dispensas42 = await tips.carregarDispensas(42);
  const idsC1 = tips.elegiveis(ctxEstrutura(1), dispensas42).map((t) => t.id);
  const idsC2 = tips.elegiveis(ctxEstrutura(2), dispensas42).map((t) => t.id);
  assert.ok(!idsC1.includes('permilagem_incompleta'), 'isolamento: dispensado no c1 → escondido no c1');
  assert.ok(idsC2.includes('permilagem_incompleta'), 'isolamento: dispensado no c1 → VISÍVEL no c2');

  // Agora dispensa-se no c2 (mesma conta) e passa a haver duas chaves distintas.
  const r3 = await pedir('/admin/tips/permilagem_incompleta/dispensar', { metodo: 'POST', condominio: 2 });
  assert.strictEqual(r3.status, 302, 'isolamento: dispensa no c2 responde com redirecionamento');
  assert.ok(chaves().includes('42|tip:permilagem_incompleta@c2'), 'isolamento: chave do c2 gravada');
  assert.strictEqual(
    linhas.filter((l) => l.recomendacao.startsWith('tip:permilagem_incompleta@')).length, 2,
    'isolamento: duas chaves distintas (c1 e c2), uma linha cada'
  );
  const dispensas42b = await tips.carregarDispensas(42);
  assert.ok(!tips.elegiveis(ctxEstrutura(2), dispensas42b).map((t) => t.id).includes('permilagem_incompleta'),
    'isolamento: depois de dispensar no c2, escondido no c2');

  // ── 4. Isolamento por conta ─────────────────────────────────────
  // O mesmo tip, o mesmo condomínio, OUTRA conta: a dispensa do 43 não pode
  // refletir-se na conta 42 (e vice-versa).
  const antes43 = linhas.length;
  const r4 = await pedir('/admin/tips/fracoes_por_definir/dispensar', { metodo: 'POST', utilizador: 43 });
  assert.strictEqual(r4.status, 302, 'outra conta (gestor): pode dispensar');
  assert.strictEqual(linhas.length, antes43 + 1, 'outra conta: grava uma linha própria');
  const linha43 = linhas[linhas.length - 1];
  assert.strictEqual(linha43.user_id, 43, 'outra conta: gravado para a conta CERTA');
  assert.strictEqual(linha43.recomendacao, 'tip:fracoes_por_definir@c1', 'outra conta: mesma chave de âmbito');
  const dispensas43 = await tips.carregarDispensas(43);
  const dispensas42c = await tips.carregarDispensas(42);
  assert.ok(dispensas42c['tip:fracoes_por_definir@c1'], 'conta 42: tem a sua própria dispensa');
  assert.ok(dispensas43['tip:fracoes_por_definir@c1'], 'conta 43: tem a sua própria dispensa');
  assert.notStrictEqual(
    dispensas42c['tip:fracoes_por_definir@c1'].id, dispensas43['tip:fracoes_por_definir@c1'].id,
    'conta 42 e conta 43: linhas DISTINTAS (uma dispensa não serve a outra)'
  );

  // ── 5. Papel insuficiente é recusado pela guarda real ───────────
  const antesLeitura = linhas.length;
  const r5 = await pedir('/admin/tips/fracoes_por_definir/dispensar', { metodo: 'POST', utilizador: 44 });
  assert.strictEqual(r5.status, 302, 'leitura: recusado com redirecionamento');
  assert.strictEqual(r5.local, '/', 'leitura: a guarda manda para a raiz');
  assert.strictEqual(linhas.length, antesLeitura, 'leitura: NADA é escrito');

  // ── 6. Sem associação ao condomínio é recusado ──────────────────
  const antesSemAssoc = linhas.length;
  const r6 = await pedir('/admin/tips/fracoes_por_definir/dispensar', { metodo: 'POST', utilizador: 45 });
  assert.strictEqual(r6.status, 302, 'sem associação: recusado com redirecionamento');
  assert.strictEqual(r6.local, '/condominios', 'sem associação: escolhe um condomínio primeiro');
  assert.strictEqual(linhas.length, antesSemAssoc, 'sem associação: NADA é escrito');

  // ── 7. Identificador manipulado é recusado ──────────────────────
  const HOSTIS = [
    'nao_existe', '../../etc/passwd', 'tip:fracoes_por_definir@c1',
    '2fa_ativo', 'fracoes_por_definir@c99', '${7*7}', '<script>', 'a'.repeat(120),
    'backup_ultimo_falhou ', ' fracoes_por_definir', 'tip:', '@c1',
  ];
  const antesHostis = linhas.length;
  for (const id of HOSTIS) {
    // eslint-disable-next-line no-await-in-loop
    const r = await pedir(`/admin/tips/${encodeURIComponent(id)}/dispensar`, { metodo: 'POST' });
    assert.strictEqual(r.status, 302, `manipulado (${JSON.stringify(id)}): recusado com redirecionamento`);
    assert.ok(!/^https?:/i.test(r.local || ''), `manipulado (${JSON.stringify(id)}): destino interno, nunca externo`);
    assert.strictEqual(r.local, '/admin', `manipulado (${JSON.stringify(id)}): volta ao painel`);
  }
  assert.strictEqual(linhas.length, antesHostis, 'manipulado: NENHUM identificador hostil é escrito');
  // O identificador do motor do portal NÃO é aceite pelo motor dos tips.
  assert.ok(!chaves().some((k) => k.endsWith('|2fa_ativo')), 'manipulado: um id do outro motor nunca é aceite');

  // ── 8. `voltar` é validado contra uma lista fechada ─────────────
  // Um URL externo no corpo não pode ser seguido nem devolvido no `Location`.
  const EXTERNOS = ['https://exemplo-malicioso.pt/x', '//exemplo-malicioso.pt', '/admin/../..', '/admin/tips', '', 'javascript:alert(1)'];
  for (const alvo of EXTERNOS) {
    // eslint-disable-next-line no-await-in-loop
    const r = await pedir('/admin/tips/fracoes_por_definir/dispensar', { metodo: 'POST', corpo: { voltar: alvo } });
    assert.strictEqual(r.status, 302, `voltar (${JSON.stringify(alvo)}): responde com redirecionamento`);
    assert.strictEqual(r.local, '/admin', `voltar (${JSON.stringify(alvo)}): valor recusado → /admin`);
  }
  // Um destino da lista fechada é honrado.
  const rOk = await pedir('/admin/tips/fracoes_por_definir/dispensar', {
    metodo: 'POST', corpo: { voltar: '/admin/config/armazenamento' },
  });
  assert.strictEqual(rOk.local, '/admin/config/armazenamento', 'voltar: destino da lista fechada é honrado');

  // ── 9. A ação/destino de cada tip vem do SERVIDOR ───────────────
  // Nenhuma definição pode apontar para fora nem para um valor dinâmico; e o
  // motor recusa dispensar tudo o que não esteja no registo.
  for (const d of tips.definicoes()) {
    const def = tips.porId(d.id);
    assert.ok(def && def.acao && typeof def.acao.url === 'string', `ação (${d.id}): definida`);
    assert.ok(/^\//.test(def.acao.url), `ação (${d.id}): destino interno (começa por /)`);
    assert.ok(!/^https?:|^\/\//i.test(def.acao.url), `ação (${d.id}): nunca externo`);
  }
  assert.strictEqual(tips.podeDispensar('https://exemplo-malicioso.pt'), false, 'ação: id externo não é dispensável');
  assert.strictEqual(tips.podeDispensar('fracoes_por_definir'), true, 'ação: id do registo é dispensável');

  // ── 10. Resumo ──────────────────────────────────────────────────
  console.log('  ✓ dispensar grava a chave com o condomínio da sessão (sem `condominio_id`)');
  console.log('  ✓ um `condominioId` enviado pelo browser é ignorado');
  console.log('  ✓ a dispensa é por condomínio (não vaza de A para B)');
  console.log('  ✓ a dispensa é por conta (não vaza de um utilizador para outro)');
  console.log('  ✓ papel insuficiente e falta de associação → recusado, nada escrito');
  console.log('  ✓ identificador manipulado → recusado; nunca escrito');
  console.log('  ✓ `voltar` validado: URL externo nunca seguido nem devolvido');
  console.log('  ✓ a ação/destino de cada tip vem do registo do servidor');
  console.log('\n✓ Testes da rota de dispensa dos Tips passaram (sem base de dados).');
})().catch((e) => {
  console.error('\n✗ FALHOU: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
