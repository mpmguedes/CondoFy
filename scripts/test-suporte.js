#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Testes do ACESSO DE SUPORTE — sem base de dados.
//
// O acesso de suporte é o QUARTO eixo da autorização, distinto de:
//   GLOBAL      `users.role_global === 'super_admin'`
//   CONDOMÍNIO  `utilizador_condominios.role` (admin | gestor | leitura)
//   PORTAL      titularidade/fração
//
// Prova, sem base de dados, que:
//   1. um acesso de suporte NUNCA produz `req.papelCondominio` de admin/gestor
//      (logo, `comPapel(...)` e `apenasAdmin` recusam SEMPRE durante o suporte);
//   2. a BD é a fonte de verdade e a sessão guarda apenas o ID do acesso;
//   3. a expiração é ABSOLUTA — não se renova por atividade;
//   4. `pendente_autorizacao` NÃO autoriza nada (sem ativação automática);
//   5. `operacional` não pode ser concedido nesta fase;
//   6. o estado terminal (expirado/terminado/revogado) deixa de autorizar;
//   7. o âmbito é estrito ao condomínio concedido;
//   8. logout termina o acesso.
//
// Técnica: os modelos entram por `require.cache` antes de carregar os helpers
// (a injeção tem de acontecer antes do require — ver a nota em helpers/suporte.js).
//
// Utilização: node scripts/test-suporte.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => require('fs').readFileSync(path.join(RAIZ, rel), 'utf8');

let nTestes = 0;
const feito = (nome) => {
  nTestes += 1;
  console.log(`  ✓ ${nome}`);
};
const titulo = (t) => console.log(`\n── ${t}`);

// ─────────────────────────────────────────────────────────────────────
// Stubs de modelo — ESTADEFUL.
//
// Têm de ser estadeful porque o fluxo faz `create` e depois `findOne`/`findByPk`
// sobre o MESMO objeto: um stub que devolvesse sempre `null` provaria apenas que
// o código não rebenta, não que o estado é respeitado (armadilha conhecida).
// ─────────────────────────────────────────────────────────────────────
function criarStubs() {
  const acessos = [];
  let seq = 0;

  const achar = (where) => {
    if (!where) return null;
    return (
      acessos.find((a) => {
        for (const [k, v] of Object.entries(where)) {
          if (k === 'id' || k === 'utilizador_id' || k === 'condominio_id') {
            if (Number(a[k]) !== Number(v)) return false;
          } else if (a[k] !== v) return false;
        }
        return true;
      }) || null
    );
  };

  const wrap = (registo) => {
    if (!registo) return null;
    return {
      ...registo,
      async update(patch) {
        Object.assign(registo, patch);
        Object.assign(this, patch);
        return this;
      },
    };
  };

  // Estado das associações (utilizador ↔ condomínio), controlado pelo teste.
  let associacoes = [];

  const AcessoSuporte = {
    async create(dados) {
      seq += 1;
      const registo = { id: seq, ...dados };
      acessos.push(registo);
      return wrap(registo);
    },
    async findOne({ where }) {
      return wrap(achar(where));
    },
    async findByPk(id) {
      return wrap(acessos.find((a) => Number(a.id) === Number(id)) || null);
    },
    async findAll({ where } = {}) {
      return acessos.filter((a) => {
        if (!where) return true;
        return Object.entries(where).every(([k, v]) => {
          if (k === 'id' || k === 'utilizador_id' || k === 'condominio_id') return Number(a[k]) === Number(v);
          return a[k] === v;
        });
      }).map(wrap);
    },
    async count({ where } = {}) {
      const lista = await AcessoSuporte.findAll({ where });
      return lista.length;
    },
    async update(patch, { where } = {}) {
      const alvo = acessos.filter((a) => {
        if (!where) return true;
        return Object.entries(where).every(([k, v]) => {
          if (v && typeof v === 'object' && 'lte' in v) return new Date(a[k]).getTime() <= new Date(v.lte).getTime();
          if (k === 'id' || k === 'utilizador_id' || k === 'condominio_id') return Number(a[k]) === Number(v);
          return a[k] === v;
        });
      });
      alvo.forEach((a) => Object.assign(a, patch));
      return [alvo.length];
    },
  };

  const UserCondominio = {
    async findOne({ where }) {
      return (
        associacoes.find((a) =>
          Object.entries(where).every(([k, v]) => (Number.isNaN(Number(v)) ? a[k] === v : Number(a[k]) === Number(v)))
        ) || null
      );
    },
    async count({ where }) {
      return associacoes.filter((a) =>
        Object.entries(where).every(([k, v]) => (Number.isNaN(Number(v)) ? a[k] === v : Number(a[k]) === Number(v)))
      ).length;
    },
    async findAll() {
      return associacoes;
    },
    definir(lista) {
      associacoes = lista;
    },
  };

  return { AcessoSuporte, UserCondominio, acessos, definirAssociacoes: UserCondominio.definir };
}

// ── Injeção dos stubs ANTES de carregar os helpers ───────────────────
const stubs = criarStubs();
const modelosReais = require.resolve(path.join(RAIZ, 'models'));
require.cache[modelosReais] = {
  id: modelosReais,
  filename: modelosReais,
  loaded: true,
  exports: {
    AcessoSuporte: stubs.AcessoSuporte,
    UserCondominio: stubs.UserCondominio,
    Condominio: { findOne: async () => null, findByPk: async () => null },
    User: { findByPk: async () => null },
  },
};

const suporte = require(path.join(RAIZ, 'helpers/suporte'));
const tenant = require(path.join(RAIZ, 'helpers/tenant'));

// ── Utilitários de pedido ────────────────────────────────────────────
function reqBase(over = {}) {
  return {
    isAuthenticated: () => true,
    user: { id: 9, role_global: 'super_admin' },
    session: {},
    sessionID: 'sess-1',
    flash: () => {},
    method: 'GET',
    get: () => '/',
    ...over,
  };
}
function resBase() {
  return { redirectUrl: null, statusCode: null, redirect(u) { this.redirectUrl = u; return this; } };
}

// ═════════════════════════════════════════════════════════════════════
// 1. Constantes e níveis concedíveis
// ═════════════════════════════════════════════════════════════════════
titulo('Níveis e estado');

assert.deepStrictEqual(suporte.NIVEIS_CONCEDIVEIS, ['diagnostico'], 'só diagnostico é concedível nesta fase');
feito('NIVEIS_CONCEDIVEIS = [diagnostico]');

// `operacional` existe no modelo (evolução futura) mas o backend recusa.
assert.strictEqual(suporte.nivelConcedivel('operacional'), false, 'operacional NÃO é concedível');
feito('operacional recusado pelo backend');

assert.strictEqual(suporte.nivelConcedivel('diagnostico'), true, 'diagnostico é concedível');
feito('diagnostico aceite');

// Estados terminais.
for (const e of ['expirado', 'terminado', 'revogado']) {
  assert.strictEqual(suporte.eEstadoTerminal(e), true, `${e} é terminal`);
}
for (const e of ['ativo', 'pendente_autorizacao']) {
  assert.strictEqual(suporte.eEstadoTerminal(e), false, `${e} não é terminal`);
}
feito('estados terminais: expirado/terminado/revogado');

// Durações: lista fechada.
assert.ok(suporte.DURACOES_MINUTOS.includes(60), '60 min é uma duração válida');
assert.ok(!suporte.DURACOES_MINUTOS.includes(999999), 'valores arbitrários não constam da lista');
feito('durações em lista fechada');

// ═════════════════════════════════════════════════════════════════════
// 2. Início do acesso — validações de entrada
// ═════════════════════════════════════════════════════════════════════
titulo('iniciar() — validações');

async function testarInicio() {
  stubs.definirAssociacoes([]); // sem admin → inicia direto

  let r = await suporte.iniciar({ req: reqBase(), condominioId: 1, motivo: '   ', nivel: 'diagnostico', duracaoMinutos: 60 });
  assert.strictEqual(r.ok, false, 'motivo vazio recusado');
  assert.strictEqual(r.erro, 'motivo_obrigatorio', 'erro motivo_obrigatorio');
  feito('motivo é obrigatório (só espaços não conta)');

  r = await suporte.iniciar({ req: reqBase(), condominioId: 1, motivo: 'diagnóstico', nivel: 'operacional', duracaoMinutos: 60 });
  assert.strictEqual(r.ok, false, 'operacional recusado');
  assert.strictEqual(r.erro, 'nivel_nao_concedivel', 'erro nivel_nao_concedivel');
  feito('iniciar() recusa operacional — proteção no BACKEND, não só na UI');

  r = await suporte.iniciar({ req: reqBase(), condominioId: 1, motivo: 'diagnóstico', nivel: 'diagnostico', duracaoMinutos: 7 });
  assert.strictEqual(r.ok, false, 'duração fora da lista recusada');
  assert.strictEqual(r.erro, 'duracao_invalida', 'erro duracao_invalida');
  feito('duração fora da lista recusada');

  r = await suporte.iniciar({ req: reqBase(), condominioId: 1, motivo: 'diagnóstico', nivel: 'diagnostico', duracaoMinutos: '60abc' });
  assert.strictEqual(r.ok, false, 'duração não numérica recusada');
  feito('duração não numérica recusada');
}

// ═════════════════════════════════════════════════════════════════════
// 3. Fluxo híbrido (opção D)
// ═════════════════════════════════════════════════════════════════════
titulo('Consentimento híbrido (opção D)');

async function testarHibrido() {
  // (a) SEM admin ativo → inicia DIRETO, mas com motivo e prazo.
  stubs.definirAssociacoes([]);
  let req = reqBase();
  let r = await suporte.iniciar({ req, condominioId: 10, motivo: 'sem admin', nivel: 'diagnostico', duracaoMinutos: 30 });
  assert.strictEqual(r.ok, true, 'sem admin: inicia');
  assert.strictEqual(r.pendente, false, 'sem admin: não fica pendente');
  assert.strictEqual(r.acesso.estado, 'ativo', 'sem admin: estado ativo');
  assert.ok(r.acesso.motivo, 'sem admin: motivo registado');
  assert.ok(r.acesso.expira_em, 'sem admin: prazo registado');
  feito('sem administrador ativo → inicia diretamente (com motivo e prazo)');

  // E o id entra na sessão (é este o único caminho para a sessão).
  assert.strictEqual(req.session[suporte.CHAVE_SESSAO], r.acesso.id, 'acesso ativo entra na sessão');
  feito('acesso ativo: o ID entra na sessão');

  // (b) COM admin ativo → fica PENDENTE e NÃO entra na sessão.
  stubs.definirAssociacoes([{ utilizador_id: 50, condominio_id: 20, role: 'admin', estado: 'ativo' }]);
  req = reqBase();
  r = await suporte.iniciar({ req, condominioId: 20, motivo: 'com admin', nivel: 'diagnostico', duracaoMinutos: 30 });
  assert.strictEqual(r.ok, true, 'com admin: pedido criado');
  assert.strictEqual(r.pendente, true, 'com admin: fica pendente');
  assert.strictEqual(r.acesso.estado, 'pendente_autorizacao', 'com admin: estado pendente_autorizacao');
  assert.strictEqual(req.session[suporte.CHAVE_SESSAO], undefined, 'pendente NÃO entra na sessão');
  feito('com administrador ativo → pendente_autorizacao, sem contexto de sessão');

  // (c) Um acesso pendente NÃO autoriza — nem que o id esteja na sessão.
  const idPendente = r.acesso.id;
  req = reqBase({ session: { [suporte.CHAVE_SESSAO]: idPendente } });
  const vig = await suporte.vigente(req, 20);
  assert.strictEqual(vig, null, 'pendente_autorizacao não autoriza');
  feito('pendente_autorizacao NÃO autoriza (sem ativação automática)');

  // (d) Autorização explícita por um admin DO MESMO condomínio → ativo.
  req = reqBase();
  const aut = await suporte.autorizar({ acessoId: idPendente, adminUserId: 50, req });
  assert.strictEqual(aut.ok, true, 'admin do condomínio autoriza');
  assert.strictEqual(aut.acesso.estado, 'ativo', 'autorização promove a ativo');
  assert.strictEqual(aut.acesso.autorizado_por, 50, 'registo de quem autorizou');
  feito('autorização explícita promove a ativo (e regista quem autorizou)');

  // (e) Um admin de OUTRO condomínio NÃO autoriza.
  stubs.definirAssociacoes([]);
  stubs.definirAssociacoes([{ utilizador_id: 50, condominio_id: 20, role: 'admin', estado: 'ativo' }]);
  req = reqBase();
  const r2 = await suporte.iniciar({ req, condominioId: 20, motivo: 'outro', nivel: 'diagnostico', duracaoMinutos: 30 });
  assert.strictEqual(r2.pendente, true, 'novo pedido pendente');
  const aut2 = await suporte.autorizar({ acessoId: r2.acesso.id, adminUserId: 99, req });
  assert.strictEqual(aut2.ok, false, 'admin de outro condomínio recusado');
  assert.strictEqual(aut2.erro, 'sem_permissao', 'erro sem_permissao');
  feito('admin de outro condomínio NÃO autoriza (âmbito verificado na BD)');

  // (f) Um simples utilizador (não admin) não autoriza.
  stubs.definirAssociacoes([{ utilizador_id: 60, condominio_id: 20, role: 'gestor', estado: 'ativo' }]);
  const aut3 = await suporte.autorizar({ acessoId: r2.acesso.id, adminUserId: 60, req });
  assert.strictEqual(aut3.ok, false, 'gestor não autoriza');
  feito('gestor não autoriza (exige admin ativo do condomínio)');
}

// ═════════════════════════════════════════════════════════════════════
// 4. Isolamento, expiração e estados
// ═════════════════════════════════════════════════════════════════════
titulo('vigente() — isolamento e prazo');

async function testarVigente() {
  // Acesso ativo, futuro, no condomínio 30.
  stubs.definirAssociacoes([]);
  const reqDono = reqBase({ user: { id: 9, role_global: 'super_admin' } });
  const criado = await suporte.iniciar({ req: reqDono, condominioId: 30, motivo: 'diagnóstico', nivel: 'diagnostico', duracaoMinutos: 60 });
  const id = criado.acesso.id;

  // (a) O dono, no condomínio certo → autoriza.
  let req = reqBase({ session: { [suporte.CHAVE_SESSAO]: id } });
  let vig = await suporte.vigente(req, 30);
  assert.ok(vig, 'dono no condomínio concedido é autorizado');
  feito('autoriza o dono no condomínio concedido');

  // (b) Âmbito ESTRITO: outro condomínio → recusa (mesmo com o id na sessão).
  req = reqBase({ session: { [suporte.CHAVE_SESSAO]: id } });
  vig = await suporte.vigente(req, 31);
  assert.strictEqual(vig, null, 'acesso não vale noutro condomínio');
  feito('âmbito estrito: outro condomínio recusado');

  // (c) Outro utilizador com o id na sessão → recusa (e limpa a sessão).
  req = reqBase({ user: { id: 77, role_global: 'super_admin' }, session: { [suporte.CHAVE_SESSAO]: id } });
  vig = await suporte.vigente(req, 30);
  assert.strictEqual(vig, null, 'id de outro operador não serve');
  assert.strictEqual(req.session[suporte.CHAVE_SESSAO], undefined, 'sessão limpa');
  feito('acesso pertence ao OPERADOR: um id roubado não autoriza');

  // (d) Expiração ABSOLUTA: prazo no passado → recusa e formaliza `expirado`.
  const passado = await suporte.iniciar({ req: reqBase(), condominioId: 40, motivo: 'expirado', nivel: 'diagnostico', duracaoMinutos: 15 });
  stubs.acessos.find((a) => a.id === passado.acesso.id).expira_em = new Date(Date.now() - 1000);
  req = reqBase({ session: { [suporte.CHAVE_SESSAO]: passado.acesso.id } });
  vig = await suporte.vigente(req, 40);
  assert.strictEqual(vig, null, 'acesso expirado não autoriza');
  assert.strictEqual(req.session[suporte.CHAVE_SESSAO], undefined, 'sessão do expirado é limpa');
  const registo = stubs.acessos.find((a) => a.id === passado.acesso.id);
  assert.strictEqual(registo.estado, 'expirado', 'estado formalizado como expirado');
  feito('expiração absoluta: o pedido deixa de autorizar no próprio instante');

  // (e) Sem alteração do prazo por atividade: `vigente` NÃO toca em `expira_em`.
  const antes = new Date(stubs.acessos.find((a) => a.id === id).expira_em).getTime();
  req = reqBase({ session: { [suporte.CHAVE_SESSAO]: id } });
  await suporte.vigente(req, 30);
  const depois = new Date(stubs.acessos.find((a) => a.id === id).expira_em).getTime();
  assert.strictEqual(depois, antes, 'a atividade NÃO renova o prazo (expiração absoluta)');
  feito('a atividade não renova o prazo (ao contrário do idle da sessão)');

  // (f) Estados terminais.
  for (const estado of ['expirado', 'terminado', 'revogado']) {
    const a = await suporte.iniciar({ req: reqBase(), condominioId: 50, motivo: 'x', nivel: 'diagnostico', duracaoMinutos: 60 });
    stubs.acessos.find((r2) => r2.id === a.acesso.id).estado = estado;
    const rq = reqBase({ session: { [suporte.CHAVE_SESSAO]: a.acesso.id } });
    const v = await suporte.vigente(rq, 50);
    assert.strictEqual(v, null, `${estado} não autoriza`);
  }
  feito('estados terminais nunca autorizam');
}

// ═════════════════════════════════════════════════════════════════════
// 5. Encerramento: terminar, revogar, recusar
// ═════════════════════════════════════════════════════════════════════
titulo('Encerramento');

async function testarEncerramento() {
  stubs.definirAssociacoes([]);

  // terminar
  let a = await suporte.iniciar({ req: reqBase(), condominioId: 60, motivo: 'terminar', nivel: 'diagnostico', duracaoMinutos: 60 });
  let req = reqBase({ session: { [suporte.CHAVE_SESSAO]: a.acesso.id } });
  let r = await suporte.terminar({ acessoId: a.acesso.id, req });
  assert.strictEqual(r.ok, true, 'terminar ok');
  assert.strictEqual(r.acesso.estado, 'terminado', 'estado terminado');
  assert.strictEqual(req.session[suporte.CHAVE_SESSAO], undefined, 'sessão limpa ao terminar');
  let vig = await suporte.vigente(reqBase({ session: { [suporte.CHAVE_SESSAO]: a.acesso.id } }), 60);
  assert.strictEqual(vig, null, 'terminado não autoriza');
  feito('terminar fecha o acesso e mata o contexto');

  // terminar duas vezes → recusa
  r = await suporte.terminar({ acessoId: a.acesso.id, req: reqBase() });
  assert.strictEqual(r.ok, false, 'terminar de novo recusa');
  assert.strictEqual(r.erro, 'ja_terminado', 'erro ja_terminado');
  feito('terminar um acesso já fechado é recusado (idempotência explícita)');

  // revogar (admin do condomínio corta a meio)
  a = await suporte.iniciar({ req: reqBase(), condominioId: 70, motivo: 'revogar', nivel: 'diagnostico', duracaoMinutos: 60 });
  r = await suporte.revogar({ acessoId: a.acesso.id, revogadoPor: 500, req: reqBase() });
  assert.strictEqual(r.ok, true, 'revogar ok');
  assert.strictEqual(r.acesso.estado, 'revogado', 'estado revogado');
  assert.strictEqual(r.acesso.revogado_por, 500, 'registo de quem revogou');
  feito('revogar corta um acesso ativo e registra quem revogou');

  // recusar (pedido pendente)
  stubs.definirAssociacoes([{ utilizador_id: 80, condominio_id: 80, role: 'admin', estado: 'ativo' }]);
  a = await suporte.iniciar({ req: reqBase(), condominioId: 80, motivo: 'recusar', nivel: 'diagnostico', duracaoMinutos: 60 });
  assert.strictEqual(a.pendente, true, 'pedido pendente criado');
  r = await suporte.recusar({ acessoId: a.acesso.id, resgatadoPor: 80, req: reqBase() });
  assert.strictEqual(r.ok, true, 'recusar ok');
  assert.strictEqual(r.acesso.estado, 'revogado', 'recusado fica terminal');
  // Recusar um acesso já ativo (não pendente) é inválido.
  stubs.definirAssociacoes([]);
  a = await suporte.iniciar({ req: reqBase(), condominioId: 90, motivo: 'x', nivel: 'diagnostico', duracaoMinutos: 60 });
  r = await suporte.recusar({ acessoId: a.acesso.id, resgatadoPor: 80, req: reqBase() });
  assert.strictEqual(r.ok, false, 'recusar exige estado pendente');
  assert.strictEqual(r.erro, 'estado_invalido', 'erro estado_invalido');
  feito('recusar só vale para pedidos pendentes');
}

// ═════════════════════════════════════════════════════════════════════
// 6. Logout termina o suporte
// ═════════════════════════════════════════════════════════════════════
titulo('Logout');

async function testarLogout() {
  stubs.definirAssociacoes([]);
  const a = await suporte.iniciar({ req: reqBase(), condominioId: 100, motivo: 'logout', nivel: 'diagnostico', duracaoMinutos: 60 });
  const req = reqBase({ session: { [suporte.CHAVE_SESSAO]: a.acesso.id } });

  const r = await suporte.terminarPorSessao(req);
  assert.strictEqual(r.ok, true, 'terminarPorSessao ok');
  assert.strictEqual(r.acesso.estado, 'terminado', 'o acesso é terminado no logout');
  assert.strictEqual(req.session[suporte.CHAVE_SESSAO], undefined, 'sessão limpa');
  feito('terminarPorSessao termina o acesso associado à sessão');

  // Sem acesso na sessão → não rebenta.
  const r2 = await suporte.terminarPorSessao(reqBase());
  assert.strictEqual(r2.ok, false, 'sem acesso na sessão devolve ok:false');
  assert.strictEqual(r2.erro, 'sem_acesso', 'erro sem_acesso');
  feito('sem acesso de suporte, o logout não é afetado');
}

// ═════════════════════════════════════════════════════════════════════
// 7. Invariante central: suporte NUNCA dá papel de condomínio
// ═════════════════════════════════════════════════════════════════════
titulo('Invariante: suporte ≠ admin de condomínio');

async function testarInvariante() {
  stubs.definirAssociacoes([]);
  const a = await suporte.iniciar({ req: reqBase(), condominioId: 110, motivo: 'invariante', nivel: 'diagnostico', duracaoMinutos: 60 });

  const req = reqBase({ session: { condominio_ativo_id: 110, [suporte.CHAVE_SESSAO]: a.acesso.id } });
  let avancou = false;
  await tenant.comCondominioAtivo(req, resBase(), () => { avancou = true; });
  assert.ok(avancou, 'acesso vigente avança (tem contexto)');
  assert.strictEqual(req.contexto, 'suporte', 'contexto marcado como suporte');
  assert.strictEqual(req.papelCondominio, null, 'papelCondominio fica NULL');
  assert.notStrictEqual(req.papelCondominio, 'admin', 'não é admin');
  assert.notStrictEqual(req.papelCondominio, 'gestor', 'não é gestor');
  assert.strictEqual(req.condominioId, 110, 'condominioId vem do REGISTO');
  assert.ok(req.suporte, 'req.suporte preenchido');
  assert.strictEqual(req.suporte.nivel, 'diagnostico', 'nível exposto');
  assert.strictEqual(req.suporte.condominioId, 110, 'âmbito exposto');
  feito('comCondominioAtivo em suporte: papelCondominio === null');

  // comPapel recusa SEMPRE durante o suporte (o papel é null).
  for (const minimo of ['leitura', 'gestor', 'admin']) {
    const guarda = tenant.comPapel(minimo);
    const res = resBase();
    let passou = false;
    guarda(req, res, () => { passou = true; });
    assert.strictEqual(passou, false, `comPapel(${minimo}) recusa em suporte`);
    assert.strictEqual(res.redirectUrl, '/', `comPapel(${minimo}) redireciona`);
  }
  feito('comPapel(leitura|gestor|admin) recusa SEMPRE em suporte');

  // comSuporte aceita, e restringe por nível quando pedido.
  let ok = false;
  tenant.comSuporte()(req, resBase(), () => { ok = true; });
  assert.ok(ok, 'comSuporte() deixa passar');
  ok = false;
  tenant.comSuporte(['diagnostico'])(req, resBase(), () => { ok = true; });
  assert.ok(ok, 'comSuporte([diagnostico]) deixa passar');
  ok = false;
  let bloqueado = null;
  tenant.comSuporte(['operacional'])(req, { flash: () => {}, redirect: (u) => { bloqueado = u; } }, () => { ok = true; });
  assert.strictEqual(ok, false, 'comSuporte([operacional]) recusa o diagnóstico');
  assert.ok(bloqueado, 'comSuporte de nível errado redireciona');
  feito('comSuporte restringe pelo nível');

  // semSuporte recusa quem está em suporte.
  let livre = false;
  let destino = null;
  tenant.semSuporte(req, { flash: () => {}, redirect: (u) => { destino = u; } }, () => { livre = true; });
  assert.strictEqual(livre, false, 'semSuporte recusa em suporte');
  assert.ok(destino, 'semSuporte redireciona');
  // E deixa passar fora do suporte.
  livre = false;
  tenant.semSuporte({ suporte: null }, {}, () => { livre = true; });
  assert.ok(livre, 'semSuporte deixa passar fora do suporte');
  feito('semSuporte bloqueia apenas em contexto de suporte');

  // somenteLeitura: diagnóstico só lê.
  let passouLeitura = false;
  tenant.somenteLeitura({ suporte: { nivel: 'diagnostico' }, method: 'GET' }, {}, () => { passouLeitura = true; });
  assert.ok(passouLeitura, 'GET passa no diagnóstico');
  let bloqueouEscrita = null;
  tenant.somenteLeitura(
    { suporte: { nivel: 'diagnostico' }, method: 'POST', flash: () => {}, get: () => '/admin' },
    { flash: () => {}, redirect: (u) => { bloqueouEscrita = u; } },
    () => { throw new Error('não devia avançar'); }
  );
  assert.ok(bloqueouEscrita, 'POST é bloqueado no diagnóstico');
  // E o HEAD/GET continuam a passar (leitura).
  let passouHead = false;
  tenant.somenteLeitura({ suporte: { nivel: 'diagnostico' }, method: 'HEAD' }, {}, () => { passouHead = true; });
  assert.ok(passouHead, 'HEAD passa no diagnóstico');
  feito('somenteLeitura: diagnóstico é read-only POR MÉTODO');

  // Fora do suporte, as guardas do suporte não interferem.
  passouLeitura = false;
  tenant.somenteLeitura({ suporte: null, method: 'POST' }, {}, () => { passouLeitura = true; });
  assert.ok(passouLeitura, 'somenteLeitura não afeta quem não está em suporte');
  feito('guardas do suporte são inertes fora do suporte');

  // Sem associação e SEM acesso de suporte → recusa (a via antiga desapareceu).
  const reqSem = reqBase({ session: { condominio_ativo_id: 110 } });
  const resSem = resBase();
  await tenant.comCondominioAtivo(reqSem, resSem, () => { throw new Error('não devia avançar'); });
  assert.strictEqual(resSem.redirectUrl, '/condominios', 'sem associação nem suporte → /condominios');
  assert.strictEqual(reqSem.condominioId, undefined, 'não define condominioId');
  feito('sem associação nem suporte: nenhum contexto é criado');
}

// ═════════════════════════════════════════════════════════════════════
// 8. Invariantes estáticas (regressão)
// ═════════════════════════════════════════════════════════════════════
titulo('Invariantes estáticas');

function testarEstaticas() {
  const tenantSrc = ler('helpers/tenant.js');
  const suporteSrc = ler('helpers/suporte.js');
  const appSrc = ler('app.js');
  const adminSrc = ler('routes/admin.js');
  const globalSrc = ler('routes/global-admin.js');
  const authSrc = ler('routes/auth.js');
  const sessaoSrc = ler('helpers/sessao.js');
  const condSrc = ler('routes/condominios.js');

  // Nenhuma promoção implícita do eixo global no contexto de condomínio.
  assert.ok(
    !/papelCondominio\s*=\s*'admin'/.test(tenantSrc.replace(/\/\/.*$/gm, '')),
    'tenant.js: nenhuma atribuição de papelCondominio=admin'
  );
  assert.ok(!/eSuperAdmin\([^)]*\)\s*\)\s*return\s+'admin'/.test(tenantSrc), 'tenant.js: papelNoAtivo não promove super admin');
  feito('tenant.js: sem promoção implícita super_admin → admin de condomínio');

  // app.js: o contexto de suporte é resolvido por `vigente`, nunca por eSuperAdmin.
  assert.ok(/suporte\.vigente\(req, ativoId\)/.test(appSrc), 'app.js: resolve o suporte via suporte.vigente');
  assert.ok(!/eSuperAdmin/.test(appSrc.replace(/\/\/.*$/gm, '')), 'app.js: não usa eSuperAdmin para dar contexto');
  feito('app.js: o contexto de suporte passa por vigente() (BD é a fonte de verdade)');

  // A sessão guarda SÓ o id (nenhum campo de âmbito/prazo duplicado).
  assert.ok(/const CHAVE_SESSAO = 'suporte_ativo_id'/.test(suporteSrc), 'chave de sessão única');
  assert.ok(/req\.session\[CHAVE_SESSAO\] = acesso\.id/.test(suporteSrc), 'só o ID é gravado');
  feito('a sessão guarda apenas o ID do acesso');

  // Expiração absoluta: nunca há prolongamento do prazo.
  assert.ok(!/expira_em\s*:\s*new Date\(Date\.now\(\)\s*\+/.test(suporteSrc.replace(/iniciado_em[\s\S]*?expira_em: expira/, '')), 'suporte: sem renovação de prazo');
  assert.ok(/expira_em: expira/.test(suporteSrc), 'suporte: o prazo é calculado UMA vez, no início');
  feito('o prazo é calculado uma só vez, no início (sem renovação)');

  // Logout termina o suporte.
  assert.ok(/terminarSuporteDaSessao/.test(authSrc), 'auth.js: termina o suporte no logout');
  assert.ok(/terminarSuporteDaSessao/.test(sessaoSrc), 'sessao.js: expõe o encerramento do suporte');
  assert.ok(/suporte\.terminarPorSessao/.test(sessaoSrc), 'sessao.js: usa terminarPorSessao');
  feito('logout termina o acesso de suporte');

  // Rotas de suporte exigem apenasAdmin no backoffice do condomínio.
  const rotasSuporte = adminSrc.match(/router\.(get|post)\('\/suporte[^']*'\s*,\s*apenasAdmin/g) || [];
  assert.ok(rotasSuporte.length >= 4, `admin.js: rotas /suporte com apenasAdmin (encontradas ${rotasSuporte.length})`);
  feito('admin.js: /suporte exige apenasAdmin (o gestor não decide)');

  // O router global já não tem a rota de «entrar» (bypass).
  assert.ok(!/condominios\/:id\/entrar/.test(globalSrc), 'global-admin.js: sem rota de entrar');
  assert.ok(/suporte\.iniciar\(/.test(globalSrc), 'global-admin.js: cria pedidos de suporte');
  feito('global-admin.js: «Entrar (suporte)» substituído pelo pedido registado');

  // A criação de condomínio não associa o criador incondicionalmente.
  assert.ok(/const jaTinha = await tenant\.listarCondominios/.test(condSrc), 'condominios.js: verifica se é o primeiro');
  const criaAssoc = /if \(primeiro\) \{\s*await UserCondominio\.create/.test(condSrc);
  assert.ok(criaAssoc, 'condominios.js: associação do criador só no arranque');
  feito('criar condomínio não torna o criador membro (exceto no arranque)');

  // A view já não tem o botão antigo.
  const vistas = [ler('views/admin/global/condominios.handlebars'), ler('views/admin/global/condominio.handlebars')].join('\n');
  assert.ok(!/Entrar \(suporte\)/.test(vistas), 'vistas: sem botão «Entrar (suporte)»');
  assert.ok(/\/suporte/.test(vistas), 'vistas: passam pela página de suporte');
  feito('vistas: botão antigo removido, ligação à página de suporte');

  // Migração usa DATE (DATETIME na BD), não DATEONLY.
  const mig = ler('migrations/20260101000077-acessos-suporte.js');
  const blocos = mig.match(/iniciado_em[\s\S]{0,80}/) + mig.match(/expira_em[\s\S]{0,80}/);
  assert.ok(!/DATEONLY/.test(blocos), 'migração: sem DATEONLY (a precisão seria o dia)');
  assert.ok(/Sequelize\.DATE/.test(blocos), 'migração: DATE (DATETIME com hora)');
  feito('iniciado_em/expira_em são DATETIME, não DATE');
}

// ═════════════════════════════════════════════════════════════════════
async function main() {
  await testarInicio();
  await testarHibrido();
  await testarVigente();
  await testarEncerramento();
  await testarLogout();
  await testarInvariante();
  testarEstaticas();
  console.log(`\n✓ Testes do acesso de suporte passaram (${nTestes} verificações, sem base de dados).`);
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
