// ═══════════════════════════════════════════════════════════════════
// Recomendações contextuais — ROTAS e integração no Início (Fase 2G).
//
// Aqui corre o que o motor (scripts/test-motor-recomendacoes.js) não pode
// cobrir: o handler REAL do Início, o router REAL da dispensa e a PERSISTÊNCIA
// real (o modelo `RecomendacaoEstado` em duplo, com memória, para se poder
// dispensar e voltar a pedir a página — como na vida real).
//
// Utilização: node scripts/test-rotas-recomendacoes.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const flash = require('connect-flash');

const RAIZ = path.join(__dirname, '..');
const DIA = 24 * 60 * 60 * 1000;

// ── Utilizadores ───────────────────────────────────────────────────
const COND = { id: 1, designacao: 'Condomínio Exemplo', morada: 'Rua das Flores 1', codigo_postal: '1000-100', localidade: 'Lisboa', estado: 'ativo' };
const ANA = { id: 42, nome: 'Ana Silva', email: 'ana@exemplo.pt', role: 'condomino', role_global: null, pessoa_id: 7, ativo: true, email_confirmado: true, two_fa_ativo: false, two_fa_metodo: 'email' };
const BRUNO = { id: 43, nome: 'Bruno Costa', email: 'bruno@exemplo.pt', role: 'condomino', role_global: null, pessoa_id: 8, ativo: true, email_confirmado: true, two_fa_ativo: true, two_fa_metodo: 'totp' };

// ── Memória da tabela `recomendacao_estados` ───────────────────────
// Duplo do modelo com comportamento a sério (create/findOne/update/destroy),
// para a dispensa ser realmente persistida entre pedidos.
const linhas = [];
let proximoId = 1;
const RecomendacaoEstado = {
  async findAll({ where }) {
    return linhas
      .filter((l) => l.user_id === where.user_id)
      .map((l) => ({ ...l }));
  },
  async findOne({ where }) {
    const l = linhas.find((x) => x.user_id === where.user_id && x.recomendacao === where.recomendacao);
    if (!l) return null;
    return {
      ...l,
      async update(campos) {
        Object.assign(l, campos);
        return l;
      },
    };
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

// ── Duplos dos modelos usados pelo Início ─────────────────────────
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: {
    RecomendacaoEstado,
    User: { findByPk: async (id) => (Number(id) === 43 ? BRUNO : ANA), findAll: async () => [ANA], count: async () => 2 },
    Pessoa: { findOne: async () => ({ id: 7, nome: 'Ana Silva', condominio_id: 1 }), findAll: async () => [] },
    Fracao: { findAll: async () => [], findOne: async () => null, count: async () => 1 },
    Quota: { findAll: async () => [], findOne: async () => null, sum: async () => 0, count: async () => 0 },
    Pagamento: { findAll: async () => [], findOne: async () => null, sum: async () => 0 },
    PagamentoQuota: { findAll: async () => [] },
    PagamentoExtraParcela: { findAll: async () => [] },
    Recibo: { findAll: async () => [], findOne: async () => null, count: async () => 0 },
    ReciboQuota: { findAll: async () => [] },
    ReciboExtraParcela: { findAll: async () => [] },
    ExtraQuota: { findOne: async () => null, findAll: async () => [] },
    ExtraQuotaParcela: { findAll: async () => [] },
    Aviso: { findAll: async () => [], count: async () => 0 },
    Documento: { findAll: async () => [], findOne: async () => null },
    Assembleia: { findAll: async () => [], count: async () => 0 },
    Despesa: { findAll: async () => [], sum: async () => 0, count: async () => 0 },
    ContaBancaria: { findAll: async () => [] },
    MovimentoBancario: { findAll: async () => [], sum: async () => 0 },
    Orcamento: { findOne: async () => null, findAll: async () => [] },
    OrcamentoRubrica: { findAll: async () => [] },
    Categoria: { findAll: async () => [] },
    MetodoPagamento: { findAll: async () => [] },
    AgendaItem: { findAll: async () => [] },
  },
};

const auditados = [];
const stubs = {
  '../helpers/audit': {
    audit: async (registo) => { auditados.push(registo); return registo; },
    auditSafe: async (registo) => { auditados.push(registo); return registo; },
  },
  '../helpers/saldos': {
    estadoEfetivo: (q) => (q && q.estado) || null,
    resumoFracao: async () => ({ totalQuotas: 0, totalPago: 0, emDivida: 0, quotasPagas: 0, quotasPendentes: 0, quotasVencidas: 0, ultimoPagamento: null }),
    saldoConta: async () => 0,
    resumoCondominio: async () => ({ saldoContas: 0, fundoReserva: 0, receitas: 0, despesas: 0, emDividaGlobal: 0, contas: [] }),
    resumoOrcamento: async (ano) => ({ ano: ano || 2026, orcamentado: 0, executado: 0, percentagem: 0 }),
    resumoFinanceiro: async (ano) => ({
      ano, saldoContas: 0, receitasAno: 0, despesasAno: 0, saldoAno: 0, totalQuotas: 0, pagoQuotas: 0,
      emDivida: 0, cobrancaPct: 0, nFracoesEmAtraso: 0, nFracoes: 0, contas: [], fundoReserva: 0,
      orcamentado: 0, executadoC: 0, contasPorMes: Array(12).fill(0), despesasPorMes: Array(12).fill(0),
    }),
    evolucaoMensal: () => ({ meses: [], temMovimentos: false, mesesComMovimentos: 0, totalContas: 0, totalDespesas: 0 }),
    ESTADOS_PENDENTES: ['pendente', 'parcialmente_paga', 'vencida'],
  },
  '../helpers/titularidades': {
    fracoesDoUtilizador: async () => ({ origem: 'nenhuma', motivo: 'sem_relacao', fracoes: [] }),
    historicoDaPessoa: async () => [],
    estaAtiva: () => true,
  },
  '../helpers/tenant': {
    comCondominioAtivo: (req, res, next) => { req.condominioId = 1; next(); },
    // `routes/condomino.js` fecha a área do condómino ao acesso de suporte com
    // `tenant.semSuporte`. No duplo, o pedido não tem contexto de suporte, pelo
    // que o guard é um no-op (é o que acontece em produção fora do suporte).
    semSuporte: (req, res, next) => next(),
    listarCondominios: async () => ([{ id: 1, designacao: COND.designacao, role: 'leitura' }]),
    ativo: () => 1,
    entrarCondominio: async () => true,
    eSuperAdmin: () => false,
    associacaoAtiva: async () => ({ role: 'leitura' }),
    papelNoAtivo: async () => 'leitura',
    eAdminCondominio: async () => false,
    pertenceAoAtivo: () => true,
  },
  '../helpers/documentos-acesso': {
    autorizarAcessoDocumento: async () => ({ ok: false, estado: 404 }),
    servirDocumento: async () => ({ ok: false, estado: 404 }),
    verificarDocumento: async () => ({ ok: true }),
    responderRecusa: (res, r) => res.status((r && r.estado) || 404).send('recusado'),
  },
  '../helpers/documento-pastas': { mapaPastas: () => ({}) },
  '../helpers/condominio': { getCondominio: async () => COND },
  '../helpers/pdf': { gerarReciboPDF: async () => Buffer.from('pdf') },
  '../helpers/recibos': {
    pagoPorQuota: async () => new Map(),
    cobertoPorQuota: async () => new Map(),
    pagamentosDasQuotas: async () => [],
    periodoLabel: () => '',
    gerarReciboPDF: async () => Buffer.from('pdf'),
  },
};
for (const [rel, valor] of Object.entries(stubs)) {
  const p = require.resolve(path.join(RAIZ, rel.replace('../', '')));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}
require(path.join(RAIZ, 'config/passport'))(passport);

// ── Aplicação de teste (rotas REAIS, como no app.js) ──────────────
const { engine } = require('express-handlebars');
const app = express();
app.engine('handlebars', engine({
  defaultLayout: 'main',
  helpers: require('../helpers/handlebars-helpers'),
  layoutsDir: path.join(RAIZ, 'views', 'layouts'),
  partialsDir: path.join(RAIZ, 'views', 'partials'),
  runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
}));
app.set('view engine', 'handlebars');
app.set('views', path.join(RAIZ, 'views'));
app.use(session({ secret: 'teste', resave: false, saveUninitialized: false, rolling: false }));
app.use(express.urlencoded({ extended: true }));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// Utilizador da vez: vem do cookie de sessão do teste (`__sessao.<id>`).
app.use((req, res, next) => {
  const marca = /__sessao\.(\d+)/.exec(req.headers.cookie || '');
  const id = marca ? Number(marca[1]) : 42;
  req.user = id === 43 ? BRUNO : ANA;
  req.isAuthenticated = () => true;
  req.session.condominio_ativo_id = 1;
  res.locals.success_msg = [];
  res.locals.error_msg = [];
  res.locals.error = [];
  res.locals.user = req.user;
  res.locals.isAdmin = false;
  res.locals.meusCondominios = [];
  res.locals.condominioAtivo = { id: 1, designacao: COND.designacao, role: 'leitura' };
  res.locals.condominio = COND;
  res.locals.appName = 'GesCondu';
  res.locals.currentYear = 2026;
  res.locals.currentPath = req.path || '';
  res.locals.tarefas = { ativas: 0, emErro: 0 };
  res.locals.avisosRecentes = 0;
  res.locals.sessaoExpiraEm = Date.now() + 3600000;
  res.locals.sessaoAvisoMs = 120000;
  res.locals.sessaoIdleMs = 1800000;
  next();
});

app.get('/sessao/estado', (req, res) => res.json({ autenticado: true, expirada: false }));
app.use('/condomino', require('../routes/condomino'));
app.use('/condomino', require('../routes/condomino-recomendacoes'));
app.use((err, req, res, next) => {
  res.status(500).send('ERRO_NO_HANDLER: ' + err.message);
});

// ── Cliente HTTP (uma sessão por utilizador) ──────────────────────
const cookies = new Map();
function pedir(caminho, { metodo = 'GET', utilizador = 42 } = {}) {
  const chave = String(utilizador);
  return new Promise((resolve, reject) => {
    const servidor = app.listen(0, '127.0.0.1', () => {
      const cabecalhos = { Cookie: cookies.get(chave) || `__sessao.${utilizador}` };
      const req = http.request({
        host: '127.0.0.1', port: servidor.address().port, path: caminho, method: metodo, headers: cabecalhos,
      }, (res) => {
        if (res.headers['set-cookie']) {
          const sid = res.headers['set-cookie'].map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid'));
          if (sid) cookies.set(chave, `__sessao.${utilizador}; ${sid}`);
        }
        let corpo = '';
        res.on('data', (d) => { corpo += d; });
        res.on('end', () => {
          servidor.close();
          resolve({ status: res.statusCode, html: corpo, local: res.headers.location || null });
        });
      });
      req.on('error', (e) => { servidor.close(); reject(e); });
      req.end();
    });
  });
}

// O cartão da recomendação no HTML (o parcial tem de estar presente uma só vez).
const temCartao = (html) => /class="card portal-recomendacao/.test(html);

(async () => {
  // ── 1. Sem 2FA → o cartão aparece no Início ───────────────────
  const inicio = await pedir('/condomino');
  assert.strictEqual(inicio.status, 200, 'Início: responde 200');
  assert.ok(!/ERRO_NO_HANDLER/.test(inicio.html), 'Início: o handler não lança exceção');
  assert.ok(!/ReferenceError|is not defined/.test(inicio.html), 'Início: sem erros de referência');
  assert.ok(temCartao(inicio.html), 'Início: cartão de recomendação presente (2FA inativo)');
  assert.ok(/Reforce a segurança da sua conta com 2FA/.test(inicio.html), 'Início: título da recomendação');
  assert.ok(/A verificação em duas etapas/.test(inicio.html), 'Início: mensagem da recomendação');
  assert.ok(/href="\/conta\/seguranca"[\s\S]{0,120}Ativar 2FA/.test(inicio.html), 'Início: ação aponta para a segurança da conta');
  assert.ok(/Recomendação|Sugestão/.test(inicio.html), 'Início: rótulo discreto (não é um alerta)');
  // Uma só recomendação, sem duplicações.
  assert.strictEqual((inicio.html.match(/portal-recomendacao-titulo/g) || []).length, 1,
    'Início: uma só recomendação (sem sucessão de cartões)');
  // O cartão está ANTES do conteúdo principal do Início (é o primeiro bloco
  // dentro de `.portal-conteudo`).
  const posConteudo = inicio.html.indexOf('class="portal-conteudo"');
  const posCartao = inicio.html.indexOf('portal-recomendacao');
  assert.ok(posConteudo >= 0 && posCartao > posConteudo, 'Início: a recomendação está dentro do conteúdo');
  const primeiroBloco = inicio.html.slice(posConteudo, posConteudo + 800);
  assert.ok(/portal-recomendacao/.test(primeiroBloco), 'Início: a recomendação é o primeiro bloco do conteúdo');
  // O formulário de dispensa aponta para a rota da recomendação.
  assert.ok(/action="\/condomino\/recomendacoes\/2fa_ativo\/dispensar"/.test(inicio.html),
    'Início: dispensa aponta para a recomendação certa');
  assert.ok(/Dispensar/.test(inicio.html), 'Início: ação de dispensar apresentada');

  // ── 2. 2FA ativo (outro utilizador) → sem cartão ──────────────
  const inicioBruno = await pedir('/condomino', { utilizador: 43 });
  assert.strictEqual(inicioBruno.status, 200, 'Início (2FA ativo): responde 200');
  assert.ok(!temCartao(inicioBruno.html), 'Início: sem 2FA ativo não há recomendação');
  assert.ok(!/Ativar 2FA/.test(inicioBruno.html), 'Início: não se oferece ativar 2FA a quem já o tem');
  // E o resto do Início continua igual (a fase não altera as outras áreas).
  assert.ok(/A minha situação|Acesso rápido/.test(inicioBruno.html), 'Início: conteúdo normal mantém-se');

  // ── 3. Dispensar persiste (e o cartão desaparece) ─────────────
  const dispensar = await pedir('/condomino/recomendacoes/2fa_ativo/dispensar', { metodo: 'POST' });
  assert.strictEqual(dispensar.status, 302, 'dispensar: responde com redirecionamento');
  assert.strictEqual(dispensar.local, '/condomino', 'dispensar: volta ao Início');
  assert.strictEqual(linhas.length, 1, 'dispensar: uma linha persistida');
  assert.strictEqual(linhas[0].user_id, 42, 'dispensar: gravado para a conta do pedido');
  assert.strictEqual(linhas[0].recomendacao, '2fa_ativo', 'dispensar: gravado para a recomendação certa');
  assert.strictEqual(linhas[0].intervalo_dias, 30, 'dispensar: intervalo de 30 dias');
  const diferenca = new Date(linhas[0].dispensada_ate).getTime() - new Date(linhas[0].dispensada_em).getTime();
  assert.strictEqual(Math.round(diferenca / DIA), 30, 'dispensar: fim do intervalo a 30 dias');
  assert.ok(auditados.some((a) => a.acao === 'recomendacao_dispensada'), 'dispensar: registado na auditoria');

  const depoisDeDispensar = await pedir('/condomino');
  assert.ok(!temCartao(depoisDeDispensar.html), 'depois de dispensar: o cartão desaparece');

  // ── 4. A dispensa é por conta (não afeta outro utilizador) ────
  // O outro utilizador tem 2FA ativo, por isso o que se verifica é que o
  // registo não aparece associado a ele.
  assert.strictEqual(linhas.filter((l) => l.user_id === 43).length, 0,
    'dispensar: não cria estado para outra conta');

  // ── 5. Ainda dentro dos 30 dias → continua escondido ──────────
  assert.ok(linhas[0].dispensada_ate, 'estado: tem fim de intervalo');
  const aindaEscondido = await pedir('/condomino');
  assert.ok(!temCartao(aindaEscondido.html), 'dentro do intervalo: continua escondido (vários pedidos)');

  // ── 6. Dispensa expirada → volta a aparecer ───────────────────
  linhas[0].dispensada_ate = new Date(Date.now() - DIA);
  linhas[0].dispensada_em = new Date(Date.now() - 31 * DIA);
  const reaparece = await pedir('/condomino');
  assert.ok(temCartao(reaparece.html), 'passado o intervalo: a recomendação volta a aparecer');

  // ── 7. 2FA ativado → desaparece mesmo com dispensa expirada ───
  ANA.two_fa_ativo = true;
  try {
    const apos2fa = await pedir('/condomino');
    assert.ok(!temCartao(apos2fa.html), 'após ativação do 2FA: sem recomendação, mesmo com dispensa expirada');
    // E dispensar já não faz sentido: a rota recusa (condição deixou de existir
    // como recomendação elegível? Não: a rota valida o ID, não a elegibilidade).
    // O que se garante é que não se cria estado novo por engano num fluxo normal.
    const linhasAntes = linhas.length;
    const dispAposAtivacao = await pedir('/condomino/recomendacoes/2fa_ativo/dispensar', { metodo: 'POST' });
    assert.strictEqual(dispAposAtivacao.status, 302, 'após 2FA: dispensar continua a responder com redirecionamento');
    assert.strictEqual(linhas.length, linhasAntes, 'após 2FA: dispensar não cria uma segunda linha (já existia)');
  } finally {
    ANA.two_fa_ativo = false;
  }

  // ── 8. Recomendação inválida/manipulada → nada escrito ────────
  const linhasAntesInvasao = linhas.length;
  // Identificadores que um utilizador poderia tentar: inexistente, com barra a
  // tentar escapar do caminho, com maiúsculas, e uma URL (que nem corresponde a
  // nenhuma rota — o router responde 404 e nada é escrito).
  for (const id of ['inexistente', '2fa_ativo%2Fextra', '2FA_ATIVO']) {
    const resposta = await pedir(`/condomino/recomendacoes/${id}/dispensar`, { metodo: 'POST' });
    assert.strictEqual(resposta.status, 302, `id «${id}»: responde com redirecionamento`);
    assert.strictEqual(resposta.local, '/condomino', `id «${id}»: volta ao Início (não a um destino arbitrário)`);
  }
  const urlAbsoluta = await pedir('/condomino/recomendacoes/https://exemplo.pt/dispensar', { metodo: 'POST' });
  assert.strictEqual(urlAbsoluta.status, 404, 'URL absoluta como identificador: nem sequer corresponde a uma rota');
  assert.strictEqual(linhas.length, linhasAntesInvasao, 'id inválido: nenhuma linha criada');
  assert.ok(!auditados.some((a) => a.acao === 'recomendacao_dispensada' && a.detalhes && a.detalhes.recomendacao === 'inexistente'),
    'id inválido: nada registado na auditoria');

  // ── 9. Repor: a dispensa pode ser limpa (sem esperar 30 dias) ─
  const repor = await pedir('/condomino/recomendacoes/2fa_ativo/mostrar', { metodo: 'POST' });
  assert.strictEqual(repor.status, 302, 'repor: responde com redirecionamento');
  assert.strictEqual(linhas.length, 0, 'repor: remove o estado de dispensa da conta');
  const voltou = await pedir('/condomino');
  assert.ok(temCartao(voltou.html), 'repor: a recomendação volta a aparecer');
  // Idempotência: dispensar duas vezes não cria linhas paralelas.
  await pedir('/condomino/recomendacoes/2fa_ativo/dispensar', { metodo: 'POST' });
  await pedir('/condomino/recomendacoes/2fa_ativo/dispensar', { metodo: 'POST' });
  assert.strictEqual(linhas.length, 1, 'dispensar duas vezes: continua a haver uma só linha');

  // ── 10. O motor é a única fonte: nenhum template tem a condição ─
  const parcial = fs.readFileSync(path.join(RAIZ, 'views', 'partials', '_portal-recomendacao.handlebars'), 'utf8');
  assert.ok(!/two_fa_ativo|two_fa_metodo/.test(parcial), 'parcial: sem condições de 2FA no template');
  assert.ok(!/recomendacaoInventada|perfil_incompleto/.test(parcial), 'parcial: sem recomendações inventadas');
  const rotaInicio = fs.readFileSync(path.join(RAIZ, 'routes', 'condomino.js'), 'utf8');
  assert.strictEqual((rotaInicio.match(/two_fa_ativo/g) || []).length, 1,
    'Início: a condição de 2FA é lida uma só vez (passa o estado ao motor)');
  const routerRec = fs.readFileSync(path.join(RAIZ, 'routes', 'condomino-recomendacoes.js'), 'utf8');
  assert.ok(!/two_fa_ativo/.test(routerRec), 'router da dispensa: sem condições (a decisão é do motor)');
  assert.ok(/recomendacoes\.podeDispensar\(id\)/.test(routerRec), 'router: valida o identificador antes de escrever');
  // A área de consulta do condomínio continua sem escrita.
  assert.ok(!/router\.(post|put|patch|delete)\(/.test(rotaInicio), 'área do condomínio: continua sem rotas de escrita');

  console.log('✓ Testes das rotas de recomendações passaram (handlers reais, sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('✗ promessa rejeitada sem tratamento: ' + (err && err.message));
  process.exit(1);
});
