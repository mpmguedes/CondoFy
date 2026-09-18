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

  // Sem associação para ninguém nas alíneas (a) e (b): o lookup do tenant tem de
  // estar stubado ANTES de o exercitar. Antes, a alínea (b) não precisava disto
  // porque o ramo de super admin curto-circuitava o lookup — com o bypass
  // removido, `comCondominioAtivo` procura a associação em qualquer caso.
  models.UserCondominio.findOne = async () => null;

  // a) Sem condomínio ativo na sessão → redireciona para /condominios.
  let req = stubReq();
  let res = stubRes();
  await tenant.comCondominioAtivo(req, res, () => { throw new Error('não devia avançar'); });
  assert.strictEqual(res.redirectUrl, '/condominios', 'sem ativo → /condominios');

  // b) INVARIANTE CENTRAL — SUPER-ADMIN ≠ ADMIN DE CONDOMÍNIO.
  // Ter `condominio_ativo_id` na sessão NÃO dá contexto nenhum a um super admin
  // sem associação: não ganha `req.condominioId` nem, muito menos,
  // `req.papelCondominio = 'admin'`. Só o acesso de suporte (`acessos_suporte`),
  // iniciado explicitamente e com prazo, resolve o contexto — e mesmo esse
  // deixa `req.papelCondominio` a `null`.
  models.Condominio.findOne = async ({ where }) => (where.id === 3 && where.estado === 'ativo' ? { id: 3, estado: 'ativo' } : null);
  req = stubReq({ session: { condominio_ativo_id: 3 }, user: { id: 9, role_global: 'super_admin' } });
  res = stubRes();
  await tenant.comCondominioAtivo(req, res, () => { throw new Error('não devia avançar'); });
  assert.strictEqual(res.redirectUrl, '/condominios', 'super admin sem associação → /condominios (nunca entra)');
  assert.strictEqual(req.papelCondominio, undefined, 'super admin: NÃO recebe papel de condomínio');
  assert.strictEqual(req.condominioId, undefined, 'super admin: NÃO recebe condominioId');
  assert.strictEqual(req.session.condominio_ativo_id, undefined, 'super admin: ativo inválido é limpo');

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
  let avancou = false;
  await tenant.comCondominioAtivo(req, res, () => { avancou = true; });
  assert.ok(avancou, 'utilizador associado avança');
  assert.strictEqual(req.condominioId, 5, 'utilizador: condominioId definido');
  assert.strictEqual(req.papelCondominio, 'gestor', 'utilizador: papel da associação');
  assert.strictEqual(req.contexto, 'condominio', 'utilizador: contexto de condomínio');
  assert.strictEqual(req.suporte, null, 'utilizador: sem suporte no contexto normal');

  // d) Utilizador sem associação → redireciona e limpa a sessão.
  models.UserCondominio.findOne = async () => null;
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
//
// NOTA — `admin.js` é o backoffice COMUM de `admin` e `gestor`: o mínimo do
// router é `gestor` (é o destino que `tenant.destinoInicial()` dá a ambos).
// As operações que exigem estritamente admin usam um guard SEPARADO
// (`const apenasAdmin = tenant.comPapel('admin')`), aplicado rota a rota — ver
// a verificação dedicada em `testarGuardaDoBackoffice()`.
const COM_PAPEL = {
  'quotas-modulo.js': 'gestor',
  'documentos.js': 'gestor',
  'avisos.js': 'gestor',
  'extra-quotas.js': 'gestor',
  'convocatorias.js': 'gestor',
  'assembleias.js': 'gestor',
  'orcamento.js': 'gestor',
  'financeiro.js': 'gestor',
  'admin.js': 'gestor',
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
      // A guarda tem de ser um `router.use(tenant.comPapel('X'))` — a MONTAGEM do
      // mínimo no router, não uma ocorrência qualquer no ficheiro. Procurar só
      // `includes("comPapel('X')")` deixava passar um ficheiro cujo gate real
      // fosse outro (era o caso de admin.js, onde o comentário e o value
      // `apenasAdmin` satisfaziam a procura antiga).
      const esperado = new RegExp(
        `router\\.use\\(\\s*tenant\\.comPapel\\(\\s*'${COM_PAPEL[nome]}'\\s*\\)\\s*\\)`
      );
      assert.ok(esperado.test(src), `${nome}: o router monta tenant.comPapel('${COM_PAPEL[nome]}')`);
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

// ── 3-bis. Guarda do backoffice comum (`routes/admin.js`) ───────────
// `/admin` é o backoffice de `admin` E de `gestor` (é o destino que
// `tenant.destinoInicial()` dá a ambos), por isso o mínimo do router é
// `gestor`. O que exige estritamente admin fica num guard separado
// (`apenasAdmin`), aplicado rota a rota — não no `router.use`.
function testarGuardaDoBackoffice() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  const semComentarios = src.replace(/\/\/.*$/gm, '');

  // 1. O router monta o mínimo `gestor` (o gate efetivo corre em todos os pedidos).
  assert.ok(
    /router\.use\(\s*tenant\.comPapel\('gestor'\)\s*\)/.test(semComentarios),
    'admin.js: router.use(tenant.comPapel(\'gestor\')) — backoffice comum'
  );
  // 2. O gate do router NÃO pode voltar a ser `admin` (era a inconsistência
  //    que expulsava o gestor de `/admin` para `/`).
  assert.ok(
    !/router\.use\(\s*tenant\.comPapel\('admin'\)\s*\)/.test(semComentarios),
    'admin.js: router.use não exige admin (gestor entra no backoffice)'
  );
  // 3. As operações de administrador continuam protegidas pelo guard separado,
  //    definido UMA vez a partir de `comPapel('admin')`.
  assert.ok(
    /const\s+apenasAdmin\s*=\s*tenant\.comPapel\('admin'\)/.test(semComentarios),
    'admin.js: apenasAdmin = tenant.comPapel(\'admin\') (guard separado)'
  );
  // 4. E está realmente aplicado: as rotas de gestão de utilizadores passam por ele.
  const rotasUtilizadores = src.match(/router\.(get|post)\('\/utilizadores[^']*'\s*,\s*apenasAdmin/g) || [];
  assert.ok(
    rotasUtilizadores.length >= 10,
    `admin.js: rotas /utilizadores protegidas por apenasAdmin (encontradas ${rotasUtilizadores.length}, esperadas ≥10)`
  );
  // 5. Confirmação negativa: nenhuma rota com apenasAdmin perdeu o guard.
  const declaradas = (src.match(/router\.(get|post)\('\/utilizadores/g) || []).length;
  assert.strictEqual(
    declaradas,
    rotasUtilizadores.length,
    'admin.js: TODAS as rotas /utilizadores exigem apenasAdmin'
  );
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

// ── 5. Regressões de isolamento corrigidas ──────────────────────────
// Três pontos que não estavam cobertos e que ficam aqui guardados contra
// regressão: âmbito do resumo do orçamento, âmbito do envio de recibos em lote
// e validação do link externo de documentos.
async function testarRegressoesDeIsolamento() {
  const ler = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  // (a) Resumo do orçamento: orçamentado e executado só do condomínio indicado.
  const saldos = ler('helpers/saldos.js');
  assert.ok(/async function resumoOrcamento\(ano = new Date\(\)\.getFullYear\(\), condominioId = null\)/.test(saldos),
    'saldos: resumoOrcamento recebe o condomínio');
  assert.ok(/where: \{ condominio_id: condominioId, ano, estado: \{ \[Op\.ne\]: 'anulado' \} \}/.test(saldos),
    'saldos: orçamento filtrado pelo condomínio');
  assert.ok(/competencia_ano: ano, estado: \{ \[Op\.ne\]: 'anulada' \}, condominio_id: condominioId|condominio_id: condominioId, competencia_ano: ano/.test(saldos),
    'saldos: despesas filtradas pelo condomínio');
  assert.ok(!/OrcamentoItem\.sum/.test(saldos), 'saldos: não soma a tabela legada sem condomínio');

  const orcamentoVazio = await require('../helpers/saldos').resumoOrcamento(2026, null);
  assert.deepStrictEqual(orcamentoVazio, { ano: 2026, orcamentado: 0, executado: 0, percentagem: 0 },
    'saldos: sem condomínio definido devolve zeros (nunca a soma de todos)');

  // (b) Envio de recibos em lote: pagamentos do condomínio ativo, na listagem e no envio.
  const financeiro = ler('routes/financeiro.js');
  assert.ok(/async function contextoEnvioRecibos\(condominioId\)/.test(financeiro), 'recibos: contexto recebe o condomínio');
  assert.ok(/where: \{ estado: 'confirmado', condominio_id: condominioId \}/.test(financeiro),
    'recibos: pagamentos filtrados pelo condomínio');
  const chamadas = financeiro.match(/contextoEnvioRecibos\(req\.condominioId\)/g) || [];
  assert.strictEqual(chamadas.length, 2, 'recibos: GET e POST passam o condomínio ativo');
  assert.ok(!/contextoEnvioRecibos\(\)/.test(financeiro), 'recibos: nenhuma chamada sem âmbito');

  // (c) Link externo de documentos: só http/https chega ao href, em qualquer área.
  const { urlExternaSegura } = require('../helpers/urls');
  const helpers = require('../helpers/handlebars-helpers');
  for (const perigoso of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox', 'não é uma url', '']) {
    assert.strictEqual(urlExternaSegura(perigoso), null, `urls: ${perigoso.slice(0, 20)} recusada`);
    assert.strictEqual(helpers.urlDocumentoExterno({ url: perigoso }), null, 'urls: vista não recebe link inseguro');
  }
  assert.strictEqual(helpers.urlDocumentoExterno({ url: 'https://exemplo.pt/ata.pdf' }), 'https://exemplo.pt/ata.pdf',
    'urls: https válido passa');
  assert.strictEqual(helpers.urlDocumentoExterno({ url: 'http://exemplo.pt/x' }), 'http://exemplo.pt/x', 'urls: http válido passa');
  assert.strictEqual(helpers.urlDocumentoExterno({ url: 'https://exemplo.pt/x', drive_file_id: 'abc' }), null,
    'urls: com ficheiro guardado não há link externo');
  assert.strictEqual(helpers.urlDocumentoExterno(null), null, 'urls: sem documento, sem link');

  const documentos = ler('routes/documentos.js');
  assert.ok(/require\('\.\.\/helpers\/urls'\)/.test(documentos), 'documentos: usa a validação partilhada');
  assert.ok(!/function urlExternaSegura/.test(documentos), 'documentos: sem segunda implementação da regra');
  assert.ok(/url: urlExternaSegura\(doc\.url\)/.test(documentos), 'documentos: listagem de gestão valida a referência');
  assert.ok(/urlExterna: doc\.drive_file_id \? null : urlExternaSegura\(doc\.url\)/.test(documentos),
    'documentos: referência externa validada também na listagem');
}

// ── 6. Autorização do condómino: a conta só vê o que a relação lhe dá ──
// Regra (helpers/titularidades.js): a titularidade que nomeia a CONTA decide;
// a que nomeia apenas uma PESSOA só dá acesso a contas ligadas a essa pessoa
// (`users.pessoa_id`). Uma conta sem pessoa nunca herda acesso por existir uma
// titularidade de outra pessoa.
function testarRegraDeAutorizacaoDoCondomino() {
  const titularidades = require('../helpers/titularidades');
  const { eContaDaLigacao } = titularidades;

  // Tabela de decisão do "elo" entre a conta e a titularidade.
  const conta = { utilizadorId: 5, pessoaId: 9 };
  const casos = [
    [{ utilizador_id: 5, pessoa_id: null }, conta, true, 'titularidade nomeia esta conta'],
    [{ utilizador_id: 5, pessoa_id: 100 }, conta, true, 'conta nomeada manda sobre a pessoa'],
    [{ utilizador_id: 6, pessoa_id: 9 }, conta, false, 'conta nomeada noutra conta recusa'],
    [{ utilizador_id: null, pessoa_id: 9 }, conta, true, 'pessoa ligada à conta autoriza'],
    [{ utilizador_id: null, pessoa_id: 9 }, { utilizadorId: 5, pessoaId: null }, false, 'conta SEM pessoa não herda (caso central)'],
    [{ utilizador_id: null, pessoa_id: 9 }, { utilizadorId: 5, pessoaId: 8 }, false, 'conta ligada a outra pessoa não herda'],
    [{ utilizador_id: null, pessoa_id: null }, conta, false, 'titularidade órfã não autoriza'],
    [{ utilizador_id: null, pessoa_id: 9 }, { utilizadorId: null, pessoaId: null }, false, 'sem conta nem pessoa não autoriza'],
    [{ utilizador_id: '5', pessoa_id: null }, conta, true, 'ids em texto são normalizados'],
  ];
  for (const [titulo, quem, esperado, descricao] of casos) {
    assert.strictEqual(eContaDaLigacao(titulo, quem), esperado, `autorização: ${descricao}`);
  }
  assert.strictEqual(eContaDaLigacao(null, conta), false, 'autorização: sem titularidade não há acesso');

  // A decisão de estado da associação (acesso ao condomínio) nunca reativa por
  // omissão: é a garantia de que guardar o formulário não reabre o acesso.
  assert.strictEqual(titularidades.decidirEstadoAssociacao({ estadoAtual: 'inativo' }).estado, 'inativo',
    'reativação: guardar sem pedido mantém o acesso encerrado');
  assert.strictEqual(titularidades.decidirEstadoAssociacao({ estadoAtual: 'inativo', reativar: 'on' }).reativada, true,
    'reativação: só com pedido explícito');
  assert.strictEqual(titularidades.decidirEstadoAssociacao({ estadoAtual: 'ativo' }).estado, 'ativo',
    'reativação: utilizadores ativos não são afetados');
}

async function main() {
  await testarComCondominioAtivo();
  testarPapeis();
  testarRoutersIsolados();
  testarGuardaDoBackoffice();
  testarModelosComCondominio();
  await testarRegressoesDeIsolamento();
  testarRegraDeAutorizacaoDoCondomino();
  console.log('✓ Testes de isolamento/permissões passaram (sem base de dados).');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
