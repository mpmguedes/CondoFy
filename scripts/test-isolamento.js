// Testes de isolamento multi-condomínio e permissões — sem base de dados.
// Utilização: node scripts/test-isolamento.js
//
// Cobre:
//  1. middleware comCondominioAtivo (sessão → associação/Super Admin) com stubs;
//  2. regras de papéis (podeEscrever/papelMaiorOuIgual/eSuperAdmin);
//  3. invariantes estáticas dos routers isolados: cada módulo declara
//     comCondominioAtivo e não volta a usar os auxiliares "primeiro condomínio"
//     (resumoCondominio()/getCondominio() sem id) dentro do módulo.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tenant = require('../helpers/tenant');
const models = require('../models');

// ── 1. comCondominioAtivo (stubs de BD) ─────────────────────────────
function stubRes() {
  return { redirectUrl: null, redirect(url) { this.redirectUrl = url; } };
}
function stubReq(over = {}) {
  const req = {
    isAuthenticated: () => true,
    user: { id: 7, role_global: null },
    session: {},
    flash: () => {},
    ...over,
  };
  return req;
}

async function testarComCondominioAtivo() {
  const origUC = models.UserCondominio.findOne;
  const origCond = models.Condominio.findOne;

  // a) Sem condomínio ativo na sessão → redireciona para /condominios.
  let req = stubReq();
  let res = stubRes();
  await tenant.comCondominioAtivo(req, res, () => { throw new Error('não devia avançar'); });
  assert.strictEqual(res.redirectUrl, '/condominios', 'sem ativo → /condominios');

  // b) Super Admin em modo suporte (sem associação) → entra se o condomínio existe/ativo.
  models.Condominio.findOne = async ({ where }) => (where.id === 3 && where.estado === 'ativo' ? { id: 3, estado: 'ativo' } : null);
  req = stubReq({ session: { condominio_ativo_id: 3 }, user: { id: 9, role_global: 'super_admin' } });
  res = stubRes();
  let avancou = null;
  await tenant.comCondominioAtivo(req, res, () => { avancou = true; });
  assert.ok(avancou, 'super admin com condomínio ativo avança');
  assert.strictEqual(req.condominioId, 3, 'super admin: condominioId definido');
  assert.strictEqual(req.papelCondominio, 'admin', 'super admin: papel admin (suporte)');

  // Super Admin sem condomínio válido → redireciona.
  req = stubReq({ session: { condominio_ativo_id: 99 }, user: { id: 9, role_global: 'super_admin' } });
  res = stubRes();
  await tenant.comCondominioAtivo(req, res, () => { throw new Error('não devia avançar'); });
  assert.strictEqual(res.redirectUrl, '/condominios', 'super admin com ativo inexistente → /condominios');

  // c) Utilizador com associação ativa → avança com o papel da associação.
  models.UserCondominio.findOne = async ({ where }) =>
    where.utilizador_id === 7 && where.condominio_id === 5 && where.estado === 'ativo'
      ? { condominio_id: 5, role: 'gestor', estado: 'ativo' }
      : null;
  req = stubReq({ session: { condominio_ativo_id: 5 } });
  res = stubRes();
  avancou = false;
  await tenant.comCondominioAtivo(req, res, () => { avancou = true; });
  assert.ok(avancou, 'utilizador associado avança');
  assert.strictEqual(req.condominioId, 5, 'utilizador: condominioId definido');
  assert.strictEqual(req.papelCondominio, 'gestor', 'utilizador: papel da associação');

  // d) Utilizador sem associação → redireciona e limpa a sessão.
  req = stubReq({ session: { condominio_ativo_id: 8 } });
  res = stubRes();
  await tenant.comCondominioAtivo(req, res, () => { throw new Error('não devia avançar'); });
  assert.strictEqual(res.redirectUrl, '/condominios', 'sem associação → /condominios');
  assert.strictEqual(req.session.condominio_ativo_id, undefined, 'sessão limpa sem associação');

  models.UserCondominio.findOne = origUC;
  models.Condominio.findOne = origCond;
}

// ── 2. Papéis ───────────────────────────────────────────────────────
function testarPapeis() {
  assert.strictEqual(tenant.eSuperAdmin({ role_global: 'super_admin' }), true, 'eSuperAdmin true');
  assert.strictEqual(tenant.eSuperAdmin({ role_global: null }), false, 'eSuperAdmin false');
  assert.strictEqual(tenant.papelMaiorOuIgual('admin', 'gestor'), true, 'admin >= gestor');
  assert.strictEqual(tenant.papelMaiorOuIgual('gestor', 'gestor'), true, 'gestor >= gestor');
  assert.strictEqual(tenant.papelMaiorOuIgual('leitura', 'gestor'), false, 'leitura < gestor');
  assert.strictEqual(tenant.podeEscrever('gestor'), true, 'gestor escreve');
  assert.strictEqual(tenant.podeEscrever('leitura'), false, 'leitura não escreve');

  // comPapel: usa req.papelCondominio (ou super admin).
  const comPapel = tenant.comPapel('gestor');
  let ok = null;
  comPapel({ papelCondominio: 'admin' }, {}, () => { ok = true; });
  assert.strictEqual(ok, true, 'comPapel admin passa');
  ok = null;
  let bloqueado = null;
  comPapel(
    { papelCondominio: 'leitura', flash: () => {} },
    { redirect: () => { bloqueado = true; } },
    () => { ok = true; }
  );
  assert.strictEqual(ok, null, 'comPapel leitura bloqueado');
  assert.ok(bloqueado, 'comPapel leitura redireciona');
}

// ── 3. Invariantes dos routers isolados ─────────────────────────────
const ISOLADOS = [
  'quotas-modulo.js',
  'documentos.js',
  'avisos.js',
  'extra-quotas.js',
  'convocatorias.js',
  'assembleias.js',
  'condomino.js',
  'admin.js',
  'orcamento.js',
  'configuracao.js',
  'financeiro.js',
  'emails.js',
  'fornecedores.js',
];

// Módulos com gate de papel (gestor ou admin conforme a operação de gestão).
const COM_PAPEL = {
  'quotas-modulo.js': 'gestor',
  'documentos.js': 'gestor',
  'avisos.js': 'gestor',
  'extra-quotas.js': 'gestor',
  'convocatorias.js': 'gestor',
  'assembleias.js': 'gestor',
  'orcamento.js': 'gestor',
  'financeiro.js': 'gestor',
  'admin.js': 'admin',
  'configuracao.js': 'admin',
  'emails.js': 'admin',
  'fornecedores.js': 'gestor',
};

function testarRoutersIsolados() {
  const root = path.join(__dirname, '..', 'routes');
  for (const nome of ISOLADOS) {
    const src = fs.readFileSync(path.join(root, nome), 'utf8');
    assert.ok(src.includes('comCondominioAtivo'), `${nome}: declara comCondominioAtivo`);
    assert.ok(!/getCondominio\(\)/.test(src), `${nome}: sem getCondominio() sem id`);
    assert.ok(!/resumoCondominio\(\)/.test(src), `${nome}: sem resumoCondominio() sem id`);
    if (COM_PAPEL[nome]) {
      assert.ok(src.includes(`comPapel('${COM_PAPEL[nome]}')`), `${nome}: gate de papel ${COM_PAPEL[nome]}`);
    }
    // Área do Condómino: toda a consulta filtra pelo condomínio ativo e pela
    // fração própria (IDs do browser nunca são suficientes) e o PDF de recibo
    // devolve 404 quando não pertence à fração autenticada.
    if (nome === 'condomino.js') {
      assert.ok(src.includes('condominio_id: req.condominioId'), 'condomino: consultas filtram por condominio_id');
      assert.ok(src.includes('fracao_id: { [Op.in]:'), 'condomino: frações restritas às do utilizador');
      assert.ok(src.includes('status(404)'), 'condomino: acesso indevido devolve 404');
      assert.ok(!src.includes('findByPk(req.params.id'), 'condomino: sem findByPk direto do browser');
    }

    // Central de Emails e Fornecedores: listagens/ações obrigatoriamente
    // filtradas pelo condomínio ativo; nenhum id do browser carrega por
    // findByPk sem escopo de condomínio.
    if (nome === 'emails.js' || nome === 'fornecedores.js') {
      assert.ok(src.includes('condominio_id: req.condominioId') || src.includes('escopoFornecedor(req') || src.includes('filtroFilaPorCondominio'),
        `${nome}: consultas filtram pelo condomínio ativo`);
      assert.ok(!src.includes('findByPk(req.params'), `${nome}: sem findByPk direto do id do browser`);
      if (nome === 'emails.js') {
        assert.ok(src.includes('filtroFilaPorCondominio'), 'emails: usa o filtro da fila por condomínio');
      }
      if (nome === 'fornecedores.js') {
        assert.ok(src.includes('condominio_id: req.condominioId'), 'fornecedores: cria/consulta com condominio_id ativo');
        assert.ok(src.includes('carregarFornecedor') || src.includes('carregarPagamento'), 'fornecedores: carregadores escopados');
      }
    }
  }
}

// ── 4. Invariantes de dados dos módulos recém-isolados ───────────────
function testarModelosComCondominio() {
  for (const [nome, Modelo] of [
    ['EmailFila', models.EmailFila],
    ['Fornecedor', models.Fornecedor],
    ['PagamentoFornecedor', models.PagamentoFornecedor],
  ]) {
    const attrs = Modelo && Modelo.rawAttributes ? Modelo.rawAttributes : {};
    assert.ok(attrs.condominio_id, `${nome}: modelo tem condominio_id`);
  }

  // Regra de ouro: um registo pertence ao condomínio quando os ids coincidem;
  // NULL/outro condomínio nunca pertence.
  const reqA = { condominioId: 1 };
  const reqB = { condominioId: 2 };
  assert.strictEqual(tenant.pertenceAoAtivo(1, reqA), true, 'email/fornecedor de A em A → pertence');
  assert.strictEqual(tenant.pertenceAoAtivo(1, reqB), false, 'email/fornecedor de A em B → não pertence');
  assert.strictEqual(tenant.pertenceAoAtivo(2, reqB), true, 'de B em B → pertence');
  assert.strictEqual(tenant.pertenceAoAtivo(null, reqA), false, 'registo órfão (NULL) → nunca pertence a um condomínio');
}

async function main() {
  await testarComCondominioAtivo();
  testarPapeis();
  testarRoutersIsolados();
  testarModelosComCondominio();
  console.log('✓ Testes de isolamento/permissões passaram (sem base de dados).');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
