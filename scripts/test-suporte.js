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

  // Eventos de auditoria gravados (AuditLog). O stub é ESTADEFUL para que os
  // testes possam provar que a expiração e o término por sessão AUDITAM — e que
  // não duplicam o evento quando vários pedidos chegam depois do prazo.
  const auditoria = [];
  const AuditLog = {
    async create(dados) {
      auditoria.push(dados);
      return dados;
    },
  };

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

  return { AcessoSuporte, UserCondominio, AuditLog, acessos, definirAssociacoes: UserCondominio.definir, auditoria };
}

// ── Injeção dos stubs ANTES de carregar os helpers ───────────────────
const stubs = criarStubs();
const modelosReais = require.resolve(path.join(RAIZ, 'models'));

// `helpers/audit.js` faz `require('../models')` no TOPO e desestrutura
// `AuditLog`. Se estiver em cache ANTES da injeção, guardou a referência aos
// modelos REAIS e a auditoria passaria a escrever na BD (ou, sem BD, a falhar em
// silêncio dentro do `try/catch` — e os testes de auditoria mediriam nada).
// Remove-se do cache para que volte a ler o stub injetado abaixo.
delete require.cache[require.resolve(path.join(RAIZ, 'helpers/audit'))];

require.cache[modelosReais] = {
  id: modelosReais,
  filename: modelosReais,
  loaded: true,
  exports: {
    AcessoSuporte: stubs.AcessoSuporte,
    UserCondominio: stubs.UserCondominio,
    AuditLog: stubs.AuditLog,
    // O condomínio tem de estar ATIVO: `suporte.iniciar` recusa abrir um acesso
    // a um condomínio desativado (Fase 2), e as validações de entrada que este
    // teste mede (motivo, nível, duração) só são alcançadas depois dessa. Um
    // stub com `null` faria a validação de estado disparar primeiro e o teste
    // mediria a coisa errada.
    Condominio: {
      findOne: async () => null,
      findByPk: async () => ({ id: 1, estado: 'ativo' }),
    },
    User: { findByPk: async () => null },
  },
};

const suporte = require(path.join(RAIZ, 'helpers/suporte'));
const tenant = require(path.join(RAIZ, 'helpers/tenant'));

// ── Verificação da injeção da auditoria ──────────────────────────────
// Ponto de falha SILENCIOSO: `audit.js` engole qualquer erro num `console.error`
// e devolve `undefined`; se estivesse ligado aos modelos REAIS (ou a um stub
// incompleto), todos os testes de auditoria passariam a medir nada sem falhar.
// A sonda atravessa o caminho real (`helpers/audit`) e confirma que o evento
// chega ao registo do stub.
const AUDIT = require.resolve(path.join(RAIZ, 'helpers/audit'));
delete require.cache[AUDIT]; // garante que relê o stub injetado acima
{
  const sonda = { userId: 1, acao: 'sonda_auditoria', detalhes: { sonda: true } };
  require(AUDIT).audit(sonda);
  const ultimo = stubs.auditoria[stubs.auditoria.length - 1];
  if (!ultimo || ultimo.acao !== 'sonda_auditoria') {
    throw new Error(
      'audit.js não está ligado ao stub de AuditLog: os testes de auditoria mediriam nada em silêncio'
    );
  }
  stubs.auditoria.length = 0; // a sonda não conta como evento
}

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
  //
  // NOTA: `iniciar` grava o `session_id` do pedido que o abre e `vigente`
  // exige que coincida com o `req.sessionID` de quem o usa (vinculação à
  // sessão). Por isso o arranque é feito NA MESMA sessão (`sess-1`) em que o
  // acesso vai ser exercitado — abri-lo numa sessão sem id e usá-lo noutra
  // seria (corretamente) recusado como acesso sem prova de vínculo.
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
  // Arranca na sessão `sess-1` (a mesma em que será exercitado) para que a
  // vinculação à sessão não seja a causa da recusa — o que aqui se prova é o
  // PRAZO, não o vínculo.
  const passado = await suporte.iniciar({
    req: reqBase({ sessionID: 'sess-1' }),
    condominioId: 40,
    motivo: 'expirado',
    nivel: 'diagnostico',
    duracaoMinutos: 15,
  });
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

  // (e2) VINCULAÇÃO À SESSÃO: o acesso só vale na sessão para que foi aberto.
  // Um acesso iniciado na sessão `sess-1` não autoriza noutra sessão, mesmo com
  // o `acesso_suporte_id` correto na sessão — o id sozinho não é prova.
  const vinculo = await suporte.iniciar({
    req: reqBase({ sessionID: 'sess-origem' }),
    condominioId: 31,
    motivo: 'vinculo',
    nivel: 'diagnostico',
    duracaoMinutos: 60,
  });
  const idVinc = vinculo.acesso.id;
  // (i) mesma sessão → autoriza
  let vigVinc = await suporte.vigente(reqBase({ sessionID: 'sess-origem', session: { [suporte.CHAVE_SESSAO]: idVinc } }), 31);
  assert.ok(vigVinc, 'a MESMA sessão autoriza');
  // (ii) sessão diferente → recusa
  const reqOutra = reqBase({ sessionID: 'sess-atacante', session: { [suporte.CHAVE_SESSAO]: idVinc } });
  vigVinc = await suporte.vigente(reqOutra, 31);
  assert.strictEqual(vigVinc, null, 'sessão diferente NÃO autoriza');
  assert.strictEqual(reqOutra.session[suporte.CHAVE_SESSAO], undefined, 'sessão intrusa é limpa');
  // (iii) sem session_id no acesso → falha fechada
  stubs.acessos.find((a) => a.id === idVinc).session_id = null;
  vigVinc = await suporte.vigente(reqBase({ sessionID: 'sess-origem', session: { [suporte.CHAVE_SESSAO]: idVinc } }), 31);
  assert.strictEqual(vigVinc, null, 'acesso sem session_id NÃO autoriza (falha fechada)');
  // (iv) sem sessionID no pedido → falha fechada
  stubs.acessos.find((a) => a.id === idVinc).session_id = 'sess-origem';
  vigVinc = await suporte.vigente(reqBase({ sessionID: undefined, session: { [suporte.CHAVE_SESSAO]: idVinc } }), 31);
  assert.strictEqual(vigVinc, null, 'pedido sem sessionID NÃO autoriza (falha fechada)');
  feito('session_id vinculativo: só a sessão de origem autoriza');

  // (e3) ÂMBITO OBRIGATÓRIO: `vigente` sem condomínio deixa de ser um caminho
  // de autorização válido. Antes, `vigente(req, null)` autorizava sem filtro.
  const semAmbito = await suporte.vigente(reqBase({ session: { [suporte.CHAVE_SESSAO]: id } }), null);
  assert.strictEqual(semAmbito, null, 'vigente(req, null) NÃO autoriza');
  const semAmbito2 = await suporte.vigente(reqBase({ session: { [suporte.CHAVE_SESSAO]: id } }), undefined);
  assert.strictEqual(semAmbito2, null, 'vigente(req, undefined) NÃO autoriza');
  const semAmbito3 = await suporte.vigente(reqBase({ session: { [suporte.CHAVE_SESSAO]: id } }), 0);
  assert.strictEqual(semAmbito3, null, 'vigente(req, 0) NÃO autoriza');
  feito('âmbito obrigatório: não existe caminho «qualquer condomínio»');

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
// 4b. Expiração: auditoria e não-duplicação
// ═════════════════════════════════════════════════════════════════════
titulo('Auditoria da expiração');

async function testarAuditoriaExpiracao() {
  stubs.definirAssociacoes([]);

  // Todas as chamadas usam a sessão `sess-1`, e os acessos são abertos NESSA
  // sessão: a vinculação à sessão é um pré-requisito do acesso, não aquilo que
  // esta secção mede. (Se o vínculo falhasse primeiro, `vigente` recusaria sem
  // nunca avaliar o prazo — e o teste de expiração não mediria nada.)
  const sessao = 'sess-1';
  const pedido = (over = {}) => reqBase({ sessionID: sessao, ...over });

  function eventosExpiracao(id) {
    return stubs.auditoria.filter(
      (e) => e.acao === 'suporte_expirado' && e.detalhes && JSON.parse(e.detalhes).acesso_suporte_id === id
    );
  }

  // (a) `agora < expira_em` → ativo (nada expira, nada é auditado).
  const futuro = await suporte.iniciar({ req: pedido(), condominioId: 200, motivo: 'futuro', nivel: 'diagnostico', duracaoMinutos: 60 });
  let vig = await suporte.vigente(pedido({ session: { [suporte.CHAVE_SESSAO]: futuro.acesso.id } }), 200);
  assert.ok(vig, 'agora < expira_em → ativo, autoriza');
  assert.strictEqual(eventosExpiracao(futuro.acesso.id).length, 0, 'sem expiração não há auditoria de expiração');
  feito('agora < expira_em → ativo (sem evento)');

  // (b) `agora === expira_em` → expirado (o prazo é até, não inclusive).
  const limite = await suporte.iniciar({ req: pedido(), condominioId: 201, motivo: 'limite', nivel: 'diagnostico', duracaoMinutos: 60 });
  stubs.acessos.find((a) => a.id === limite.acesso.id).expira_em = new Date(); // == agora
  vig = await suporte.vigente(pedido({ session: { [suporte.CHAVE_SESSAO]: limite.acesso.id } }), 201);
  assert.strictEqual(vig, null, 'agora === expira_em → expirado');
  assert.strictEqual(stubs.acessos.find((a) => a.id === limite.acesso.id).estado, 'expirado', 'estado formalizado');
  feito('agora === expira_em → expirado');

  // (c) `agora > expira_em` → expirado, e o evento é ÚNICO.
  const passado = await suporte.iniciar({ req: pedido(), condominioId: 202, motivo: 'passado', nivel: 'diagnostico', duracaoMinutos: 60 });
  stubs.acessos.find((a) => a.id === passado.acesso.id).expira_em = new Date(Date.now() - 5000);
  const vigPassado = await suporte.vigente(pedido({ session: { [suporte.CHAVE_SESSAO]: passado.acesso.id } }), 202);
  assert.strictEqual(vigPassado, null, 'agora > expira_em → expirado');
  const ev1 = eventosExpiracao(passado.acesso.id);
  assert.strictEqual(ev1.length, 1, 'exatamente UM evento de expiração');
  const detalhes = JSON.parse(ev1[0].detalhes);
  assert.strictEqual(detalhes.acesso_suporte_id, passado.acesso.id, 'evento tem acesso_suporte_id');
  assert.strictEqual(Number(detalhes.condominio_id), 202, 'evento tem condominio_id');
  assert.strictEqual(detalhes.nivel, 'diagnostico', 'evento tem nivel');
  assert.strictEqual(detalhes.motivo, 'passado', 'evento tem motivo');
  assert.ok(detalhes.expira_em, 'evento tem expira_em');
  assert.ok(ev1[0].user_id, 'evento tem o utilizador');
  feito('agora > expira_em → expirado e audita quem/onde/porquê/prazo');

  // (d) Vários pedidos DEPOIS do prazo não duplicam o evento.
  for (let i = 0; i < 5; i += 1) {
    await suporte.vigente(pedido({ session: { [suporte.CHAVE_SESSAO]: passado.acesso.id } }), 202);
  }
  assert.strictEqual(eventosExpiracao(passado.acesso.id).length, 1, 'nova chamada NÃO duplica o evento');
  feito('chamadas repetidas não duplicam o evento de expiração');
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

  // O término por sessão é AUDITADO, com a origem explícita.
  const ev = stubs.auditoria.filter(
    (e) => e.acao === 'suporte_terminado' && e.detalhes && JSON.parse(e.detalhes).acesso_suporte_id === a.acesso.id
  );
  assert.strictEqual(ev.length, 1, 'o término por sessão gera um evento de auditoria');
  assert.strictEqual(JSON.parse(ev[0].detalhes).origem, 'logout', 'origem explícita = logout');
  feito('o término por logout é auditado com origem explícita');

  // As origens distinguem-se (logout ≠ inatividade ≠ conta desativada).
  const a2 = await suporte.iniciar({ req: reqBase(), condominioId: 101, motivo: 'inatividade', nivel: 'diagnostico', duracaoMinutos: 60 });
  await suporte.terminarPorSessao(reqBase({ session: { [suporte.CHAVE_SESSAO]: a2.acesso.id } }), suporte.ORIGEM.INATIVIDADE);
  const ev2 = stubs.auditoria.filter(
    (e) => e.acao === 'suporte_terminado' && e.detalhes && JSON.parse(e.detalhes).acesso_suporte_id === a2.acesso.id
  );
  assert.strictEqual(JSON.parse(ev2[0].detalhes).origem, 'inatividade', 'origem distinta por inatividade');
  const a3 = await suporte.iniciar({ req: reqBase(), condominioId: 102, motivo: 'conta', nivel: 'diagnostico', duracaoMinutos: 60 });
  await suporte.terminarPorSessao(reqBase({ session: { [suporte.CHAVE_SESSAO]: a3.acesso.id } }), suporte.ORIGEM.CONTA_DESATIVADA);
  const ev3 = stubs.auditoria.filter(
    (e) => e.acao === 'suporte_terminado' && e.detalhes && JSON.parse(e.detalhes).acesso_suporte_id === a3.acesso.id
  );
  assert.strictEqual(JSON.parse(ev3[0].detalhes).origem, 'conta_desativada', 'origem distinta por conta desativada');
  feito('as três origens de término por sessão são distinguíveis na auditoria');

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

  // ── ALLOW-LIST do suporte (read-only explícita) ───────────────────
  // A superfície de suporte é um conjunto FECHADO, enumerado por caminho. Desde
  // a extração, a lista vive em `helpers/suporte-allowlist.js` (fonte única,
  // consumida por TODOS os routers de `/admin`); o CONTRATO estrutural que se
  // verifica aqui é: existe UM ponto de entrada por módulo
  // (`router.use(allowlistSuporte.soDiagnostico('<modulo>'))`), a lista é
  // consultada por PADRÃO COMPLETO (âncora, nunca por prefixo), exige o nível
  // `diagnostico` e aplica o crivo de leitura por MÉTODO.
  const condominoSrc = ler('routes/condomino.js');
  const allowlistSrc = ler('helpers/suporte-allowlist.js');

  // 1. A lista é a fonte única e o guard monta-a por módulo.
  assert.ok(/router\.use\(allowlistSuporte\.soDiagnostico\('admin'\)\)/.test(adminSrc),
    'admin.js: a allow-list é montada num único ponto (soDiagnostico(\'admin\'))');
  assert.ok(/const allowlistSuporte = require\('\.\.\/helpers\/suporte-allowlist'\)/.test(adminSrc),
    'admin.js: a allow-list vem do módulo partilhado');
  feito('admin.js: allow-list montada num único ponto, vinda do módulo partilhado');

  // 2. O contrato das quatro condições vive no módulo partilhado.
  //
  // O caminho é verificado contra a lista (por PADRÃO completo, nunca por
  // prefixo). A admissão do módulo `admin` usa `caminhoAdmitidoEmAlgumModulo`
  // porque esse router é o PRIMEIRO montado sob `/admin` e a sua guarda de papel
  // corre para todos os caminhos — se só conhecesse a lista de `admin`,
  // estrangulava a admissão dos routers montados depois dele. A `LISTA` continua
  // a ser o conjunto fechado (a união não admite nada de novo).
  assert.ok(/caminhoAdmitido\(modulo, caminho\)/.test(allowlistSrc)
    && /entradas\.some\(\(e\) => e\.padrao\.test\(caminho\)\)/.test(allowlistSrc),
    'suporte-allowlist.js: o caminho é verificado contra a lista (não por prefixo)');
  assert.ok(/caminhoAdmitidoEmAlgumModulo\(caminho\)/.test(allowlistSrc)
    && /MODULOS\.some\(\(m\) => caminhoAdmitido\(m, caminho\)\)/.test(allowlistSrc),
    'suporte-allowlist.js: a admissão do router `admin` aceita a união da lista (senão estrangula os routers seguintes)');
  assert.ok(/if \(!admitir\(req\.path\)\) return next\(\)/.test(allowlistSrc),
    'suporte-allowlist.js: o crivo de admissão consulta a lista pelo caminho real do pedido');
  assert.ok(/comSuporte\(NIVEIS_ADMITIDOS\)/.test(allowlistSrc) && /NIVEIS_ADMITIDOS = \['diagnostico'\]/.test(allowlistSrc),
    'suporte-allowlist.js: a allow-list exige o nível `diagnostico`');
  assert.ok(/somenteLeitura\(req, res/.test(allowlistSrc),
    'suporte-allowlist.js: a allow-list exige um MÉTODO de leitura');
  assert.ok(/ADMITIDO_SUPORTE = Symbol\.for\(/.test(allowlistSrc),
    'suporte-allowlist.js: a marca de admissão é um Symbol GLOBAL (partilhada entre routers)');
  assert.ok(/allowlistSuporte\.comPapelOuSuporteAdmitido\('gestor'\)/.test(adminSrc),
    'admin.js: a guarda de papel é CONDICIONAL (delegada no helper)');
  feito('suporte-allowlist.js: caminho + nível + método, marca global e guarda condicional');

  // 3. A lista fecha as rotas que NÃO podem ser admitidas (estrutura, não máscara).
  assert.ok(!/padrao: \/\^\\\/fracoes\\\/\\d\+\$/.test(allowlistSrc),
    'suporte-allowlist.js: /fracoes/:id NÃO está na lista (ficha que junta identidade e finanças)');
  assert.ok(!/documentos\\\//.test(allowlistSrc.match(/documentos:[\s\S]*?\n\n/)[0]),
    'suporte-allowlist.js: nenhuma rota de /documentos além de /documentos (sem ficheiro/token/pasta)');
  feito('a lista exclui /fracoes/:id e todas as sub-rotas de documentos');

  // 4. Cada caminho da lista de `admin` corresponde a um GET real do router.
  //    (`/fracoes/:id` deixou de ser admitido — a verificação passou a exigir a
  //    sua AUSÊNCIA da lista, acima.)
  for (const rota of ['/', '/fracoes', '/condominos', '/tarefas']) {
    const escape = rota.replace(/\//g, '\\/');
    assert.ok(new RegExp(`router\\.get\\('${escape}'`).test(adminSrc),
      `admin.js: a rota permitida ${rota} existe e é GET`);
  }
  feito('cada caminho da allow-list de admin corresponde a uma rota GET real');

  // O portal do condómino está FECHADO ao suporte (router inteiro).
  assert.ok(/router\.use\(tenant\.semSuporte\)/.test(condominoSrc),
    'condomino.js: o portal recusa o acesso de suporte (montagem no router)');
  feito('condomino.js: portal do condómino fechado ao suporte (router inteiro)');

  // Cada router de `/condomino` declara a negação explícita (defesa em
  // profundidade) e `app.js` monta a guarda GLOBAL antes das montagens.
  for (const f of ['condomino.js', 'condomino-conta.js', 'condomino-recomendacoes.js', 'saida-condominio.js']) {
    assert.ok(/router\.use\(tenant\.semSuporte\)/.test(ler('routes/' + f)),
      `${f}: declara tenant.semSuporte (defesa em profundidade)`);
  }
  const appSrcGuard = ler('app.js');
  // A guarda global NÃO pode ler `req.suporte`: `comCondominioAtivo` (que o
  // cria) é montado DENTRO de cada router, pelo que a esta altura do pipeline
  // ele ainda não existe — e a guarda deixaria passar. Lê a marca da SESSÃO
  // (`suporte_ativo_id`), a única coisa que a sessão de suporte guarda. A
  // leitura da sessão e o destino vivem em `tenant.bloqueioSuporteNaSessao`.
  assert.ok(/app\.use\('\/condomino', tenant\.bloqueioSuporteNaSessao\)/.test(appSrcGuard),
    'app.js: guarda GLOBAL em /condomino montada ANTES de todos os routers do portal');
  const tenantSrcGD = ler('helpers/tenant.js');
  assert.ok(/function bloqueioSuporteNaSessao\(req, res, next\)[\s\S]*?req\.session\[suporte\.CHAVE_SESSAO\][\s\S]*?redirect\(DESTINO_PAINEL\)/.test(tenantSrcGD),
    'tenant.bloqueioSuporteNaSessao: lê a marca de suporte da SESSÃO e redireciona para o painel (/admin)');
  feito('todos os routers de /condomino fechados + guarda global em app.js');

  // A guarda de papel mantém-se montada (a allow-list não a substituiu nem
  // duplicou: um `router.use(comPapel('gestor'))` incondicional a seguir
  // recusaria outra vez o pedido de suporte admitido).
  assert.ok(
    /router\.use\(tenant\.comPapel\('gestor'\)\)/.test(adminSrc) ||
    /router\.use\(\(req, res, next\) => \{[\s\S]*?tenant\.comPapel\('gestor'\)\(req, res, next\)/.test(adminSrc) ||
    /router\.use\(allowlistSuporte\.comPapelOuSuporteAdmitido\('gestor'\)\)/.test(adminSrc),
    'admin.js: a guarda de papel continua montada no router');
  feito('admin.js: guarda de papel intacta (a allow-list passa por cima dela)');
}

// ═════════════════════════════════════════════════════════════════════
// 9. ACHADO-02 — auditoria da CONSULTA (`suporte_consulta`)
//
// O que se prova: um GET admitido em suporte deixa um evento `suporte_consulta`
// com o envelope mínimo; fora de suporte não deixa nenhum; a query string NUNCA
// entra; e a agregação é por (acesso, rota).
//
// ⚠️ O conjunto de deduplicação vive no MÓDULO, pelo que sobrevive entre
// blocos. Cada bloco usa um `acessoId` PRÓPRIO (nunca reciclado) para que a
// medição comece sempre do zero, sem tocar no estado interno.
// ═════════════════════════════════════════════════════════════════════
titulo('Auditoria da consulta de suporte (ACHADO-02)');

async function testarAuditoriaConsulta() {
  const eventos = () => stubs.auditoria.filter((e) => e.acao === 'suporte_consulta');
  const detalhes = (e) => (e && e.detalhes ? JSON.parse(e.detalhes) : null);
  const pedidoSuporte = (acessoId, condominioId, caminho, over = {}) =>
    reqBase({
      method: 'GET',
      path: caminho,
      suporte: { id: acessoId, condominioId, nivel: 'diagnostico', motivo: 'x', expiraEm: new Date() },
      ...over,
    });

  // ── (A) consulta admitida gera evento ───────────────────────────
  stubs.auditoria.length = 0;
  tenant.auditarConsulta(pedidoSuporte(9001, 501, '/documentos'));
  let ev = eventos();
  assert.strictEqual(ev.length, 1, 'um GET admitido em suporte produz exatamente 1 suporte_consulta');
  assert.strictEqual(ev[0].acao, 'suporte_consulta', 'acao = suporte_consulta');
  assert.strictEqual(ev[0].entidade, 'Condominio', 'entidade = Condominio');
  assert.strictEqual(ev[0].entidade_id, 501, 'entidade_id = condomínio do acesso');
  const d = detalhes(ev[0]);
  assert.strictEqual(d.acesso_suporte_id, 9001, 'detalhes.acesso_suporte_id correto');
  assert.strictEqual(d.condominio_id, 501, 'detalhes.condominio_id correto');
  assert.strictEqual(d.rota, '/documentos', 'detalhes.rota correta');
  feito('A. consulta admitida → suporte_consulta com envelope mínimo');

  // ── (C) a query string é ELIMINADA ──────────────────────────────
  // O pedido REAL tem query string, mas `auditarConsulta` lê `req.path` (que a
  // não tem). Aqui simula-se o que o Express entrega: `path` sem query.
  stubs.auditoria.length = 0;
  tenant.auditarConsulta(pedidoSuporte(9002, 501, '/documentos', {
    url: '/documentos?pasta=recibos&ano=2026',
    originalUrl: '/documentos?pasta=recibos&ano=2026',
    query: { pasta: 'recibos', ano: '2026' },
  }));
  ev = eventos();
  assert.strictEqual(ev.length, 1, 'a variante com query produz 1 evento');
  const dq = detalhes(ev[0]);
  assert.strictEqual(dq.rota, '/documentos', 'rota registada é /documentos (sem query string)');
  const serializado = JSON.stringify(dq);
  assert.ok(!serializado.includes('recibos'), '«recibos» NÃO aparece nos detalhes');
  assert.ok(!serializado.includes('2026'), '«2026» NÃO aparece nos detalhes');
  assert.deepStrictEqual(Object.keys(dq).sort(), ['acesso_suporte_id', 'condominio_id', 'rota'],
    'os detalhes têm EXATAMENTE as três chaves do envelope');
  feito('C. query string eliminada (rota sem parâmetros; detalhes sem «recibos»/«2026»)');

  // ── (D) SEM AGREGAÇÃO: N pedidos à mesma rota → N eventos ───────
  // Contrato decidido: registar CADA consulta admitida. A agregação por
  // (acesso, rota) existiu numa primeira versão (conjunto em memória) e foi
  // REMOVIDA — um evento em falta, por restart ou por vários processos, seria
  // um falso negativo silencioso, indistinguível de «não houve consulta».
  // Numa auditoria de segurança, repetir é benigno; perder não é.
  stubs.auditoria.length = 0;
  for (let i = 0; i < 4; i += 1) tenant.auditarConsulta(pedidoSuporte(9003, 501, '/documentos'));
  assert.strictEqual(eventos().length, 4,
    '4 pedidos à mesma rota (e mesmo acesso) → 4 eventos (sem agregação)');
  assert.deepStrictEqual([...new Set(eventos().map((e) => detalhes(e).rota))], ['/documentos'],
    'os 4 eventos são da mesma rota');
  assert.deepStrictEqual([...new Set(eventos().map((e) => detalhes(e).acesso_suporte_id))], [9003],
    'os 4 eventos são do mesmo acesso');
  feito('D. sem agregação: 4 pedidos à mesma rota → 4 eventos');

  // ── (D2) rotas diferentes → eventos diferentes ──────────────────
  stubs.auditoria.length = 0;
  tenant.auditarConsulta(pedidoSuporte(9004, 501, '/documentos'));
  tenant.auditarConsulta(pedidoSuporte(9004, 501, '/quotas'));
  tenant.auditarConsulta(pedidoSuporte(9004, 501, '/fracoes'));
  assert.strictEqual(eventos().length, 3, 'três rotas diferentes → três eventos');
  assert.deepStrictEqual(
    eventos().map((e) => detalhes(e).rota).sort(),
    ['/documentos', '/fracoes', '/quotas'],
    'as três rotas ficam registadas'
  );
  feito('D2. rotas diferentes no mesmo acesso → eventos distintos');

  // ── (E) acessos diferentes não colidem ─────────────────────────
  stubs.auditoria.length = 0;
  tenant.auditarConsulta(pedidoSuporte(10, 501, '/admin/documentos'));
  tenant.auditarConsulta(pedidoSuporte(11, 501, '/admin/documentos'));
  const eventosDocs = eventos().filter((e) => detalhes(e).rota === '/admin/documentos');
  assert.strictEqual(eventosDocs.length, 2, 'o MESMO caminho em DOIS acessos → dois eventos');
  assert.deepStrictEqual(
    eventosDocs.map((e) => detalhes(e).acesso_suporte_id).sort((a, b) => a - b),
    [10, 11],
    'cada evento fica associado ao seu acesso'
  );
  feito('E. acesso 10 e acesso 11 não colidem (2 eventos distintos)');

  // ── (B) contexto normal NÃO gera evento ────────────────────────
  stubs.auditoria.length = 0;
  tenant.auditarConsulta(reqBase({ method: 'GET', path: '/documentos' })); // sem req.suporte
  tenant.auditarConsulta(reqBase({ method: 'GET', path: '/documentos', suporte: null }));
  tenant.auditarConsulta({ method: 'GET', path: '/documentos' }); // sem contexto nenhum
  assert.strictEqual(eventos().length, 0, 'sem contexto de suporte não há suporte_consulta');
  feito('B. utilizador normal / sem suporte → nenhum evento');

  // ── Envelope: nunca dados de linha nem query ───────────────────
  stubs.auditoria.length = 0;
  tenant.auditarConsulta(pedidoSuporte(9005, 501, '/quotas', { body: { nome: 'Ana Silva' }, params: { id: '7' } }));
  const dLinha = detalhes(eventos()[0]);
  assert.ok(!JSON.stringify(dLinha).includes('Ana'), 'nenhum nome de pessoa no evento');
  assert.strictEqual(dLinha.rota, '/quotas', 'rota é o caminho, não o id do pedido');
  assert.strictEqual(Object.keys(dLinha).length, 3, 'só o envelope mínimo (3 campos)');
  feito('sem dados de linha, sem PII, sem ids de recurso nos detalhes');

  // ── Sem acesso identificado ou sem rota: não se inventa evento ─
  stubs.auditoria.length = 0;
  assert.strictEqual(suporte.registarConsulta({ acessoId: null, condominioId: 501, rota: '/x' }), false,
    'sem acesso_suporte_id → false, nada gravado');
  assert.strictEqual(suporte.registarConsulta({ acessoId: 0, condominioId: 501, rota: '/x' }), false,
    'acesso 0 é inválido → false');
  assert.strictEqual(suporte.registarConsulta({ acessoId: 9006, condominioId: 501, rota: '' }), false,
    'sem rota → false');
  assert.strictEqual(suporte.registarConsulta({ acessoId: 9006, condominioId: 501 }), false,
    'sem rota (undefined) → false');
  assert.strictEqual(eventos().length, 0, 'nenhum evento inventado com campos nulos');
  feito('falha fechada: sem acesso ou sem rota não se grava nada');

  // ── (F) falha da auditoria NÃO derruba o pedido ────────────────
  {
    const createOriginal = stubs.AuditLog.create;
    stubs.AuditLog.create = async () => { throw new Error('BD em baixo'); };
    let rebentou = false;
    try {
      tenant.auditarConsulta(pedidoSuporte(9007, 501, '/documentos'));
      // deixa o `catch` do registo correr
      await new Promise((r) => setTimeout(r, 10));
    } catch (e) {
      rebentou = true;
    }
    stubs.AuditLog.create = createOriginal;
    assert.strictEqual(rebentou, false, 'AuditLog.create a lançar NÃO propaga exceção');
    feito('F. falha da auditoria é silenciosa (o pedido não é derrubado)');
  }

  // ── (G) sem agregação, o id reutilizado continua a registar ────
  // A versão anterior tinha `esquecerConsultas(id)` para libertar o id no fim do
  // acesso. Sem agregação esse mecanismo deixou de existir — e este teste fixa
  // que a reutilização de um id NÃO suprime eventos (era o risco que a limpeza
  // tentava evitar; deixou de ser possível).
  stubs.auditoria.length = 0;
  suporte.registarConsulta({ acessoId: 9008, condominioId: 501, rota: '/a' });
  suporte.registarConsulta({ acessoId: 9008, condominioId: 501, rota: '/a' });
  assert.strictEqual(eventos().length, 2, 'a mesma rota no mesmo acesso registada duas vezes → 2 eventos');
  assert.strictEqual(typeof suporte.esquecerConsultas, 'undefined',
    'o mecanismo de esquecimento (agregação) foi REMOVIDO — não deve existir');
  feito('G. sem agregação: reutilizar um acesso nunca suprime eventos');

  // ── O guard de admissão é o PONTO ÚNICO ────────────────────────
  // A prova estática de que o registo vive no guard e não em 24 handlers.
  const allowlistSrc = ler('helpers/suporte-allowlist.js');
  assert.ok(/tenant\.auditarConsulta\(req\)/.test(allowlistSrc),
    'soDiagnostico chama tenant.auditarConsulta(req) no ponto único pós-admissão');
  assert.ok(!/require\(['"]\.\.\/models['"]\)/.test(allowlistSrc),
    'o allow-list NÃO carrega modelos no topo (os testes offline injetam stubs)');
  // o registo TEM de estar DEPOIS da marca de admissão
  const posMarca = allowlistSrc.indexOf('req[ADMITIDO_SUPORTE] = true');
  const posAudit = allowlistSrc.indexOf('tenant.auditarConsulta(req)');
  assert.ok(posMarca >= 0 && posAudit > posMarca,
    'o registo vem DEPOIS da admissão (só suporte realmente admitido é auditado)');
  feito('ponto único no guard, após a admissão; allow-list sem modelos no topo');

  // ── (G) as 8 ações de CICLO DE VIDA continuam a existir ────────
  // A auditoria registou que os eventos de ciclo de vida «são escritos no
  // código mas não há teste que os verifique afirmativamente» (coluna
  // «Parcialmente coberto»). Aqui fixam-se as OITO, num inventário FECHADO:
  // uma ação removida ou renomeada faz falhar o teste — a telemetria da
  // consulta (esta secção) não pode ter substituído nada.
  const ACOES_CICLO_VIDA = [
    'suporte_iniciado',
    'suporte_pendente_autorizacao',
    'suporte_autorizado',
    'suporte_recusado',
    'suporte_terminado',
    'suporte_revogado',
    'suporte_revogado_pelo_condominio',
    'suporte_expirado',
  ];
  const fontesAuditoria = ['helpers/suporte.js', 'routes/admin.js', 'routes/global-admin.js']
    .map((f) => ler(f))
    .join('\n');
  for (const acao of ACOES_CICLO_VIDA) {
    assert.ok(fontesAuditoria.includes(`'${acao}'`),
      `a ação de ciclo de vida «${acao}» continua a ser escrita no código`);
  }
  // E o evento NOVO não colide com nenhum deles.
  assert.ok(!ACOES_CICLO_VIDA.includes('suporte_consulta'),
    'suporte_consulta é uma ação NOVA, distinta das oito de ciclo de vida');
  feito(`G. as ${ACOES_CICLO_VIDA.length} ações de ciclo de vida continuam intactas`);

  // ── As 8 ações são as ÚNICAS de ciclo de vida (inventário fechado) ──
  // Colhe todas as ações `suporte_*` escritas no código e compara com a lista
  // esperada + a nova ação de consulta. Uma ação nova (ou removida) obriga a
  // uma decisão consciente aqui.
  //
  // `suporte_ativo_id` NÃO é uma ação de auditoria — é a chave da SESSÃO
  // (`CHAVE_SESSAO`), que o padrão `'suporte_...'` apanha por coincidência.
  // Exclui-se por NOME, explicitamente, em vez de afrouxar a asserção.
  const NAO_E_ACAO = ['suporte_ativo_id'];
  const acoesNoCodigo = new Set();
  for (const f of ['helpers/suporte.js', 'routes/admin.js', 'routes/global-admin.js']) {
    (ler(f).match(/'(suporte_[a-z_]+)'/g) || []).forEach((s) => {
      const acao = s.replace(/'/g, '');
      if (!NAO_E_ACAO.includes(acao)) acoesNoCodigo.add(acao);
    });
  }
  assert.deepStrictEqual(
    [...acoesNoCodigo].sort(),
    [...ACOES_CICLO_VIDA, 'suporte_consulta'].sort(),
    'o conjunto de ações suporte_* é exatamente: 8 de ciclo de vida + suporte_consulta'
  );
  feito('inventário fechado: 8 ações de ciclo de vida + suporte_consulta (nada mais)');
}

// ═════════════════════════════════════════════════════════════════════
async function main() {
  await testarInicio();
  await testarHibrido();
  await testarVigente();
  await testarAuditoriaExpiracao();
  await testarEncerramento();
  await testarLogout();
  await testarInvariante();
  await testarAuditoriaConsulta();
  testarEstaticas();
  console.log(`\n✓ Testes do acesso de suporte passaram (${nTestes} verificações, sem base de dados).`);
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
