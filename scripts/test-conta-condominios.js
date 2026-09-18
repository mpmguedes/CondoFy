// ═══════════════════════════════════════════════════════════════════
// Área pessoal do portal do condómino — execução REAL das rotas.
//
// Fase 2F: perfil («A minha conta») e «Os meus condomínios» dentro do portal,
// incluindo a única ação de sessão desta fase: entrar noutro condomínio.
//
// Ao contrário dos testes que só compilam vistas, aqui correm:
//  · o router real (routes/condomino-conta.js);
//  · o ajudante REAL de multi-condomínio (helpers/tenant.js) — é ele que
//    autoriza, por isso é ele que tem de ser exercitado;
//  · pedidos HTTP a sério, com sessão, para dois utilizadores diferentes.
//
// Cobre: isolamento entre utilizadores, id de condomínio inventado, associação
// inativa, conta sem condomínio ativo, 2FA ativo/inativo, uma e várias frações,
// e a garantia de que entrar noutro condomínio só muda `condominio_ativo_id`
// (nunca titularidades, frações, conta ou permissões).
//
// Utilização: node scripts/test-conta-condominios.js
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

// ── Dados de exemplo ───────────────────────────────────────────────
const COND_A = { id: 1, designacao: 'Condomínio A', morada: 'Rua A 1', codigo_postal: '1000-001', localidade: 'Lisboa', estado: 'ativo' };
const COND_B = { id: 2, designacao: 'Condomínio B', morada: null, codigo_postal: null, localidade: null, estado: 'ativo' };
const COND_C = { id: 3, designacao: 'Condomínio C (associação inativa)', morada: null, codigo_postal: null, localidade: null, estado: 'ativo' };

const ANA = { id: 42, nome: 'Ana Silva', email: 'ana@exemplo.pt', role: 'condomino', role_global: null, pessoa_id: 7, ativo: true, email_confirmado: true, telefone: '912345678', two_fa_ativo: false, two_fa_metodo: 'email', last_login_at: '2026-09-20T18:30:00.000Z' };
const BRUNO = { id: 43, nome: 'Bruno Costa', email: 'bruno@exemplo.pt', role: 'condomino', role_global: null, pessoa_id: 8, ativo: true, email_confirmado: true, telefone: null, two_fa_ativo: true, two_fa_metodo: 'totp', last_login_at: null };

// Associações: Ana em A (ativa), B (ativa) e C (INATIVA); Bruno só em B.
const ASSOCIACOES = [
  { id: 1, utilizador_id: 42, condominio_id: 1, role: 'leitura', estado: 'ativo', condominio: COND_A },
  { id: 2, utilizador_id: 42, condominio_id: 2, role: 'leitura', estado: 'ativo', condominio: COND_B },
  { id: 3, utilizador_id: 42, condominio_id: 3, role: 'leitura', estado: 'inativo', condominio: COND_C },
  { id: 4, utilizador_id: 43, condominio_id: 2, role: 'leitura', estado: 'ativo', condominio: COND_B },
];

const FRACAO_A1 = { id: 5, condominio_id: 1, designacao: '1.º Esq', toJSON() { return { ...this }; } };
const FRACAO_A2 = { id: 6, condominio_id: 1, designacao: '2.º Dto', toJSON() { return { ...this }; } };
const FRACAO_B1 = { id: 9, condominio_id: 2, designacao: 'R/C Dto', toJSON() { return { ...this }; } };

// Frações próprias por (utilizador, condomínio).
const MINHAS_FRACOES = new Map([
  ['42:1', [{ fracao: FRACAO_A1, vinculo: 'proprietario' }, { fracao: FRACAO_A2, vinculo: 'arrendatario' }]],
  ['42:2', [{ fracao: FRACAO_B1, vinculo: 'proprietario' }]],
  ['43:2', []],
]);

// ── Espiões ────────────────────────────────────────────────────────
const auditados = [];
const escritasModelo = [];
const alteracoesSessao = [];

function filtroSimples(linhas, where) {
  if (!where) return linhas;
  return linhas.filter((l) => Object.entries(where).every(([k, v]) => l[k] === v));
}

// ── Duplos dos modelos (antes de carregar as rotas/ajudantes) ──────
const CONDICIONAIS = { condominio_id: 1 };
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: {
    User: {
      findByPk: async (id) => (Number(id) === 43 ? BRUNO : ANA),
      // Qualquer escrita na conta é registada (e o teste exige que não exista).
      update: async () => { escritasModelo.push('User.update'); return [0]; },
      create: async () => { escritasModelo.push('User.create'); return ANA; },
    },
    UserCondominio: {
      findAll: async (o = {}) => {
        const todas = filtroSimples(ASSOCIACOES, o.where);
        if (process.env.DEBUG_2F === '1') console.log('DBG where', JSON.stringify(o.where), '→', todas.length);
        return todas.map((a) => ({ ...a, condominio: a.condominio }));
      },
      findOne: async (o = {}) => filtroSimples(ASSOCIACOES, o.where)[0] || null,
      create: async () => { escritasModelo.push('UserCondominio.create'); return {}; },
      update: async () => { escritasModelo.push('UserCondominio.update'); return [0]; },
      destroy: async () => { escritasModelo.push('UserCondominio.destroy'); return 0; },
    },
    Condominio: {
      findByPk: async (id) => [COND_A, COND_B, COND_C].find((c) => c.id === Number(id)) || null,
      findOne: async (o = {}) => { CONDICIONAIS.condominio_id = o.where && o.where.id; return [COND_A, COND_B, COND_C].find((c) => c.id === Number(o.where && o.where.id)) || null; },
      findAll: async () => [COND_A, COND_B, COND_C],
    },
    Fracao: {
      findAll: async (o = {}) => {
        const ids = (o.where && o.where.condominio_id && o.where.condominio_id.in) || [];
        const total = new Map([[1, 12], [2, 8], [3, 4]]);
        return ids.filter((id) => id !== 3).map((id) => ({ condominio_id: id, total: total.get(id) || 0 }));
      },
      findOne: async () => FRACAO_A1,
      count: async () => 12,
    },
    FracaoTitularidade: {
      findAll: async (o = {}) => {
        // A chave é o condomínio pedido; a lista de frações já vem por utilizador
        // do duplo de `titularidades.fracoesDoUtilizador` (abaixo), para o teste
        // se focar no isolamento por condomínio.
        return o && o.__minhas ? o.__minhas : [];
      },
    },
    FracaoPessoa: { findAll: async () => [] },
  },
};

// ── Duplos dos ajudantes ───────────────────────────────────────────
// IMPORTANTE: `helpers/tenant.js` NÃO é substituído — é o ajudante que autoriza
// a troca de condomínio e tem de correr a sério neste teste.
const TITULARIDADES = {
  fracoesDoUtilizador: async ({ condominioId, utilizadorId }) => {
    const chave = `${utilizadorId}:${condominioId}`;
    return { origem: 'titularidades', motivo: 'titularidade_em_vigor', fracoes: MINHAS_FRACOES.get(chave) || [] };
  },
  historicoDaPessoa: async () => [],
  estaAtiva: () => true,
};
const stubs = {
  '../helpers/audit': {
    audit: async (registo) => { auditados.push(registo); return registo; },
    auditSafe: async (registo) => { auditados.push(registo); return registo; },
  },
  '../helpers/titularidades': TITULARIDADES,
  '../helpers/eAdmin': {
    eAutenticado: (req, res, next) => (req.isAuthenticated() ? next() : res.redirect('/login')),
  },
};
for (const [rel, valor] of Object.entries(stubs)) {
  const p = require.resolve(path.join(RAIZ, rel.replace('../', '')));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}
require(path.join(RAIZ, 'config/passport'))(passport);

// O `tenant` real, com os modelos em duplo. Embrulha-se `entrarCondominio` para
// registar as chamadas: entrar num condomínio tem de passar SEMPRE por aqui.
const tenant = require(path.join(RAIZ, 'helpers/tenant'));
const entrarReal = tenant.entrarCondominio;
const chamadasEntrar = [];
tenant.entrarCondominio = async (req, condominioId) => {
  const antes = req.session.condominio_ativo_id;
  const resultado = await entrarReal(req, condominioId);
  chamadasEntrar.push({ condominioId, resultado, antes, depois: req.session.condominio_ativo_id });
  if (process.env.DEBUG_2F === '1') console.log('DBG entrar', condominioId, 'resultado', resultado, 'antes', antes, 'depois', req.session.condominio_ativo_id);
  return resultado;
};

// ── Aplicação de teste ─────────────────────────────────────────────
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

// Utilizador da vez. O id vem do COOKIE de sessão do teste (`__sessao.<id>`), na
// primeira utilização, e fica fixo nessa sessão — como na vida real, em que a
// sessão pertence a uma conta e não muda a meio. Sessões separadas por
// utilizador são o que permite testar o isolamento a sério.
app.use((req, res, next) => {
  const marca = req.headers.cookie || '';
  const encontrado = /__sessao\.(\d+)/.exec(marca);
  const id = encontrado ? Number(encontrado[1]) : 42;
  if (process.env.DEBUG_2F === '1') console.log('DBG sessão', id, 'rota', req.path);
  req.user = id === 43 ? BRUNO : ANA;
  req.isAuthenticated = () => true;
  if (!req.session.iniciada) {
    req.session.iniciada = true;
    req.session.sessaoTeste = id;
    // `CONDOFY_TESTE_SEM_ATIVO` cria uma sessão autenticada mas sem condomínio
    // ativo (o estado em que o utilizador ainda não escolheu onde trabalhar).
    if (process.env.CONDOFY_TESTE_SEM_ATIVO !== '1') {
      req.session.condominio_ativo_id = id === 43 ? 2 : 1;
    }
  }
  next();
});

// Registo das alterações à sessão (o que a fase só pode mudar é o condomínio ativo).
app.use((req, res, next) => {
  const antes = { ...req.session };
  res.on('finish', () => {
    for (const chave of ['condominio_ativo_id', 'pendente2faAtivar', 'totpAtivacao', 'codigosRecuperacao', 'pendente2faLogin']) {
      if (antes[chave] !== req.session[chave]) {
        alteracoesSessao.push({ chave, antes: antes[chave], depois: req.session[chave], rota: req.path });
      }
    }
  });
  next();
});

// Estado da sessão no fim do pedido: o que a fase só pode mudar é o condomínio
// ativo. Lê-se o `req.session` NO MOMENTO da resposta (o express-session
// substitui o objeto de sessão ao carregá-la, por isso uma cópia feita no
// início do pedido podia estar vazia).
const estadoFinalSessao = [];
app.use((req, res, next) => {
  const terminar = res.end.bind(res);
  res.end = (...args) => {
    estadoFinalSessao.push({
      rota: `${req.method} ${req.originalUrl}`,
      ativo: req.session ? req.session.condominio_ativo_id : null,
      iniciada: req.session ? req.session.iniciada : null,
      temSegredos: Boolean(req.session && (req.session.pendente2faAtivar || req.session.totpAtivacao || req.session.codigosRecuperacao)),
    });
    return terminar(...args);
  };
  next();
});

// `res.locals` como no app.js (o `isAdmin` decide quem vê o portal).
app.use((req, res, next) => {
  const ativoId = req.session.condominio_ativo_id || null;
  const meuAtivo = ativoId === 1 ? COND_A : (ativoId === 2 ? COND_B : null);
  res.locals.success_msg = [];
  res.locals.error_msg = [];
  res.locals.error = [];
  res.locals.user = req.user;
  res.locals.isAdmin = false;
  res.locals.meusCondominios = [];
  res.locals.condominioAtivo = meuAtivo ? { id: meuAtivo.id, designacao: meuAtivo.designacao, role: 'leitura' } : null;
  res.locals.condominio = meuAtivo;
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

app.use('/condomino', require('../routes/condomino-conta'));
app.use((err, req, res, next) => {
  res.status(500).send('ERRO_NO_HANDLER: ' + err.message);
});

// ── Cliente HTTP com uma sessão por utilizador ─────────────────────
// `sessao` é o id do utilizador dono da sessão (42 = Ana, 43 = Bruno); um
// sufixo extra permite começar sessões independentes dentro do mesmo teste.
const cookies = new Map();
function pedir(caminho, { metodo = 'GET', utilizador = 42, sessao = null, limpar = false, semAtivo = false } = {}) {
  const chave = sessao || String(utilizador);
  if (limpar) cookies.delete(chave);
  if (semAtivo) process.env.CONDOFY_TESTE_SEM_ATIVO = '1';
  return new Promise((resolve, reject) => {
    const servidor = app.listen(0, '127.0.0.1', () => {
      const cabecalhos = {};
      const cookie = cookies.get(chave);
      if (cookie) cabecalhos.Cookie = cookie;
      else cabecalhos.Cookie = `__sessao.${utilizador}`;
      const req = http.request({
        host: '127.0.0.1',
        port: servidor.address().port,
        path: caminho,
        method: metodo,
        headers: cabecalhos,
      }, (res) => {
        if (res.headers['set-cookie']) {
          const sid = res.headers['set-cookie'].map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid'));
          if (sid) cookies.set(chave, `__sessao.${utilizador}; ${sid}`);
        }
        let corpo = '';
        res.on('data', (d) => { corpo += d; });
        res.on('end', () => {
          servidor.close();
          delete process.env.CONDOFY_TESTE_SEM_ATIVO;
          if (process.env.DEBUG_2F === '1') console.log('DBG', metodo, caminho, '→', res.statusCode, res.headers.location || '');
          resolve({ status: res.statusCode, html: corpo, local: res.headers.location || null });
        });
      });
      req.on('error', (e) => {
        servidor.close();
        delete process.env.CONDOFY_TESTE_SEM_ATIVO;
        reject(e);
      });
      req.end();
    });
  });
}

(async () => {
  // ── 1. Perfil: dados do próprio e estado real da segurança ──────
  const perfil = await pedir('/condomino/perfil');
  assert.strictEqual(perfil.status, 200, 'perfil: responde 200');
  assert.ok(!/ERRO_NO_HANDLER/.test(perfil.html), 'perfil: o handler não lança exceção');
  assert.ok(/<h1>Meu perfil<\/h1>/.test(perfil.html), 'perfil: título da página');
  assert.ok(/ana@exemplo\.pt/.test(perfil.html) && /Ana Silva/.test(perfil.html), 'perfil: dados da conta do próprio');
  assert.ok(/912345678/.test(perfil.html), 'perfil: telefone do próprio');
  assert.ok(/Conta ativa/.test(perfil.html), 'perfil: estado da conta');
  assert.ok(perfil.html.includes('Condomínio A'), 'perfil: identifica o condomínio ativo');
  assert.ok(/1\.º Esq/.test(perfil.html) && /2\.º Dto/.test(perfil.html), 'perfil: as frações do próprio');
  assert.ok(/arrendatario/.test(perfil.html), 'perfil: o vínculo de cada fração');
  // Ana tem o 2FA inativo → tem de aparecer o convite e a ação de ativação.
  assert.ok(/Inativa/.test(perfil.html) && /Ativar 2FA/.test(perfil.html), 'perfil: 2FA inativo com ação de ativação');
  assert.ok(!/Gerir verificação em duas etapas/.test(perfil.html), 'perfil: sem ação de gestão com o 2FA inativo');
  // Nada de dados de terceiros nem de outro utilizador.
  assert.ok(!/bruno@exemplo\.pt/.test(perfil.html) && !/Bruno/.test(perfil.html), 'perfil: não expõe dados de outros utilizadores');
  assert.ok(!/Senha|password|palavra-passe/i.test(perfil.html), 'perfil: nunca mostra credenciais');

  // Bruno tem o 2FA ativo (TOTP) → estado e gestão, sem convite para ativar.
  const perfilBruno = await pedir('/condomino/perfil', { utilizador: 43 });
  assert.strictEqual(perfilBruno.status, 200, 'perfil (Bruno): responde 200');
  assert.ok(/Ativa/.test(perfilBruno.html) && /aplicação autenticadora/.test(perfilBruno.html),
    'perfil: 2FA ativo com o método real');
  assert.ok(/Gerir verificação em duas etapas/.test(perfilBruno.html), 'perfil: ação de gestão com o 2FA ativo');
  assert.ok(!/Ativar 2FA/.test(perfilBruno.html), 'perfil: com 2FA ativo não se oferece «Ativar 2FA»');

  // ── 2. Condomínios: só os do próprio, com o ativo assinalado ────
  const conds = await pedir('/condomino/condominios');
  assert.strictEqual(conds.status, 200, 'condomínios: responde 200');
  assert.ok(!/ERRO_NO_HANDLER/.test(conds.html), 'condomínios: o handler não lança exceção');
  assert.ok(/<h1>Os meus condomínios<\/h1>/.test(conds.html), 'condomínios: título da página');
  assert.ok(/Condomínio A/.test(conds.html) && /Condomínio B/.test(conds.html),
    'condomínios: lista os condomínios com associação ativa');
  assert.ok(!/Condomínio C/.test(conds.html),
    'condomínios: a associação INATIVA (C) não aparece como disponível');
  assert.strictEqual((conds.html.match(/Condomínio ativo/g) || []).length, 1, 'condomínios: um só ativo assinalado');
  assert.ok(/Entrar neste condomínio/.test(conds.html), 'condomínios: ação para entrar no outro');
  assert.ok(/action="\/condomino\/condominios\/2\/entrar"/.test(conds.html), 'condomínios: rota do portal para entrar no B');
  assert.ok(!/action="\/condomino\/condominios\/3\/entrar"/.test(conds.html), 'condomínios: não oferece entrar no condomínio sem associação ativa');
  assert.ok(/1\.º Esq/.test(conds.html) && /R\/C Dto/.test(conds.html), 'condomínios: frações próprias por condomínio');

  // Bruno não vê o condomínio A (não tem associação ativa lá).
  const condsBruno = await pedir('/condomino/condominios', { utilizador: 43 });
  assert.ok(/Condomínio B/.test(condsBruno.html), 'condomínios (Bruno): vê o seu condomínio');
  assert.ok(!/Condomínio A/.test(condsBruno.html) && !/Condomínio C/.test(condsBruno.html),
    'condomínios: utilizador B não vê condomínios do utilizador A');

  // ── 3. Entrar noutro condomínio (associação ativa) ─────────────
  const antesEntrar = chamadasEntrar.length;
  const entrar = await pedir('/condomino/condominios/2/entrar', { metodo: 'POST' });
  assert.strictEqual(entrar.status, 302, 'entrar: responde com redirecionamento');
  assert.strictEqual(entrar.local, '/condomino', 'entrar: volta ao Início do portal');
  assert.strictEqual(chamadasEntrar.length, antesEntrar + 1, 'entrar: passa pelo mecanismo de autorização existente (tenant)');
  const chamada = chamadasEntrar[chamadasEntrar.length - 1];
  assert.strictEqual(chamada.resultado, true, 'entrar: autorizado para quem tem associação ativa');
  assert.strictEqual(chamada.depois, 2, 'entrar: o condomínio ativo passa a ser o novo');
  assert.strictEqual(auditados.filter((a) => a.acao === 'entrar_condominio').length, 1, 'entrar: registado na auditoria');
  // Depois de entrar, a sessão fica no novo condomínio.
  const depoisDeEntrar = await pedir('/condomino/perfil');
  assert.ok(/Condomínio B/.test(depoisDeEntrar.html), 'entrar: o perfil passa a mostrar o novo condomínio ativo');
  assert.ok(/R\/C Dto/.test(depoisDeEntrar.html), 'entrar: as frações do novo condomínio aparecem');

  // ── 4. Isolamento: id inventado ou sem associação ativa ────────
  const antesInvasao = chamadasEntrar.length;
  const invasao = await pedir('/condomino/condominios/3/entrar', { metodo: 'POST' });
  assert.strictEqual(invasao.status, 302, 'invasão: responde com redirecionamento (sem entrar)');
  assert.strictEqual(invasao.local, '/condomino/condominios', 'invasão: volta à lista de condomínios');
  const chamadaInvasao = chamadasEntrar[chamadasEntrar.length - 1];
  assert.strictEqual(chamadasEntrar.length, antesInvasao + 1, 'invasão: a tentativa chega a ser avaliada');
  assert.strictEqual(chamadaInvasao.resultado, false, 'invasão: recusada (associação inativa)');
  assert.strictEqual(chamadaInvasao.depois, 2, 'invasão: o condomínio ativo NÃO muda (mantém-se no B)');

  const inventado = await pedir('/condomino/condominios/999/entrar', { metodo: 'POST' });
  assert.strictEqual(inventado.local, '/condomino/condominios', 'id inventado: volta à lista');
  assert.strictEqual(chamadasEntrar[chamadasEntrar.length - 1].resultado, false, 'id inventado: recusado');
  assert.strictEqual(chamadasEntrar[chamadasEntrar.length - 1].depois, 2, 'id inventado: o condomínio ativo não muda');

  const invalido = await pedir('/condomino/condominios/abc/entrar', { metodo: 'POST' });
  assert.strictEqual(invalido.local, '/condomino/condominios', 'id inválido: volta à lista sem rebentar');
  const semAcesso = await pedir('/condomino/condominios/1/entrar', { metodo: 'POST', utilizador: 43 });
  assert.strictEqual(chamadasEntrar[chamadasEntrar.length - 1].resultado, false, 'Bruno não entra no condomínio A');
  assert.strictEqual(chamadasEntrar[chamadasEntrar.length - 1].depois, 2, 'Bruno mantém o seu condomínio ativo');
  void semAcesso;

  // ── 5. Conta sem condomínio ativo: não fica sem caminho de volta ─
  // Sessões autenticadas mas ainda sem condomínio escolhido (é este o estado
  // antes da escolha, e é aqui que a lista de condomínios tem de funcionar).
  const semAtivoPerfil = await pedir('/condomino/perfil', { sessao: 'sem-ativo-ana', semAtivo: true });
  assert.strictEqual(semAtivoPerfil.status, 200, 'perfil: responde 200 mesmo sem condomínio ativo');
  assert.ok(/Sem condomínio ativo\./.test(semAtivoPerfil.html), 'perfil: explica que não há condomínio ativo');
  const semAtivoLista = await pedir('/condomino/condominios', { sessao: 'sem-ativo-ana' });
  assert.strictEqual(semAtivoLista.status, 200, 'condomínios: responde 200 sem condomínio ativo (é o caminho de volta)');
  assert.ok(/Entrar neste condomínio/.test(semAtivoLista.html), 'condomínios: permite entrar a partir daí');
  assert.strictEqual((semAtivoLista.html.match(/Condomínio ativo/g) || []).length, 0, 'condomínios: sem ativo não se assinala nenhum');

  // ── 6. Trocar de condomínio não altera mais nada ───────────────
  assert.deepStrictEqual(escritasModelo, [],
    'trocar de condomínio não escreve em User/UserCondominio (só a sessão muda)');
  // Só o condomínio ativo é tocado na sessão; nenhum segredo de 2FA passa por aqui.
  for (const estado of estadoFinalSessao) {
    assert.ok(!estado.temSegredos, `sessão: esta fase não mexe em dados de 2FA (${estado.rota})`);
  }
  const finais = new Map(estadoFinalSessao.map((e) => [e.rota, e.ativo]));
  assert.strictEqual(finais.get('POST /condomino/condominios/2/entrar'), 2,
    'sessão: a entrada autorizada deixa o condomínio ativo no novo');
  // Cada tentativa recusada tem de deixar o condomínio ativo exatamente como estava.
  for (const chamadaRecusada of chamadasEntrar.filter((c) => c.resultado === false)) {
    const registo = estadoFinalSessao.find((e) => e.rota === `POST /condomino/condominios/${chamadaRecusada.condominioId}/entrar`
      || e.rota === `POST /condomino/condominios/${chamadaRecusada.condominioId}/entrar`);
    if (!registo) continue;
    assert.strictEqual(registo.ativo, chamadaRecusada.antes,
      `sessão: entrada recusada em ${chamadaRecusada.condominioId} não muda o condomínio ativo`);
  }
  assert.strictEqual(finais.get('POST /condomino/condominios/3/entrar'), 2,
    'sessão: a entrada recusada deixa o condomínio ativo onde estava');
  assert.strictEqual(finais.get('POST /condomino/condominios/999/entrar'), 2,
    'sessão: um id inventado não muda o condomínio ativo');
  assert.ok(alteracoesSessao.length >= 1, 'sessão: houve registo da alteração de condomínio');
  for (const alt of alteracoesSessao) {
    assert.strictEqual(alt.chave, 'condominio_ativo_id',
      `sessão: esta fase não altera «${alt.chave}» (rota ${alt.rota})`);
  }

  // ── 7. 2FA: a implementação existente continua a ser a única ───
  const rotaConta = fs.readFileSync(path.join(RAIZ, 'routes', 'condomino-conta.js'), 'utf8');
  assert.ok(!/2fa\/(ativar|desativar|totp|iniciar)/.test(rotaConta), 'conta: não cria passos de 2FA no portal');
  const auth = fs.readFileSync(path.join(RAIZ, 'routes', 'auth.js'), 'utf8');
  assert.ok(/router\.get\('\/conta\/seguranca'/.test(auth) && /router\.post\('\/conta\/2fa\/ativar'/.test(auth),
    '2FA: a gestão continua nas rotas existentes de /conta');
  assert.ok(!/two_fa_recovery_hash/.test(rotaConta) && !/two_fa_totp_secret/.test(rotaConta),
    'conta: não lê nem escreve segredos de 2FA');

  // ── 8. Perfil de quem não tem frações (estado neutro) ──────────
  const semFracoes = await pedir('/condomino/perfil', { utilizador: 43, ativo: 2 });
  assert.ok(/Sem frações associadas neste condomínio\./.test(semFracoes.html),
    'perfil: sem frações mostra estado neutro');
  assert.ok(!/Fração R\/C Dto/.test(semFracoes.html), 'perfil: sem titularidade não inventa frações');

  console.log('✓ Testes da conta/perfil e condomínios do condómino passaram (rotas reais, sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
