// ═══════════════════════════════════════════════════════════════════
// P58 / ACHADO-04 — UM só acesso de suporte VIGENTE por (utilizador, condomínio).
//
// Antes: `iniciar()` criava sempre um registo novo e deixava o anterior `ativo`
// até expirar. `ativosDe(cid)` mostrava dois «operadores» em diagnóstico quando
// só havia um, e o anterior ficava inalcançável (a sessão guarda um id só).
//
// Este teste fixa a invariante e o ciclo de vida, SEM base de dados:
//
//   · os stubs são ESTADEFUL e — ponto central — o `create` do stub IMPÕE a
//     MESMA restrição que o índice UNIQUE da migration 20260101000081 impõe ao
//     MariaDB. Sem essa imposição, o cenário de corrida (caso 10) não provaria
//     nada: o stub aceitaria dois vigentes e o teste passaria por vacuidade.
//
//   · o `findAll` honra `Op.notIn`, que é o filtro real do helper. Um stub que
//     ignorasse o operador devolveria zero linhas e o teste mediria nada.
//
// Utilização: node scripts/test-suporte-unicidade.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

let nTestes = 0;
const feito = (nome) => { nTestes += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// Os estados terminais vêm do PRÓPRIO helper (não de uma cópia à mão), para que
// a lista não possa divergir em silêncio. O `require` do helper é feito DEPOIS
// da injeção dos stubs (ver abaixo) — carregá-lo aqui ligaria o módulo antes de
// `../models` estar substituído.
let suporte;
let TERMINAIS;
const eTerminal = (e) => TERMINAIS.includes(e);

// ─────────────────────────────────────────────────────────────────────
// Stubs de modelo — ESTADEFUL, e com a CONSTRAINT da BD.
// ─────────────────────────────────────────────────────────────────────
function criarStubs() {
  const acessos = [];
  const auditoria = [];
  let seq = 0;
  let associacoes = [];
  let aoCriar = null; // hook one-shot: simula uma transação concorrente
  let imporConstraint = true; // desligável: prova a defesa em profundidade (caso 11)

  const corresponde = (a, where) => {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const lista = v[Op.notIn] !== undefined ? v[Op.notIn] : v[Op.in];
        if (lista !== undefined) {
          const dentro = lista.some((x) => String(x) === String(a[k]));
          return v[Op.notIn] !== undefined ? !dentro : dentro;
        }
        if (v[Op.lte] !== undefined) return new Date(a[k]).getTime() <= new Date(v[Op.lte]).getTime();
      }
      if (k === 'id' || k === 'utilizador_id' || k === 'condominio_id') return Number(a[k]) === Number(v);
      return a[k] === v;
    });
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

  const AcessoSuporte = {
    async create(dados) {
      // Uma transação concorrente pode ter COMETIDO antes deste INSERT.
      if (aoCriar) { const h = aoCriar; aoCriar = null; h(); }

      // ⛔ A constraint: índice UNIQUE (utilizador_id, condominio_id,
      // vigente_chave). Como `vigente_chave` é NULL nos terminais e NULL não
      // colide com NULL, o efeito é: no máximo UM vigente por par.
      const novoVigente = !eTerminal(dados.estado);
      const colide = imporConstraint && novoVigente && acessos.some(
        (a) => Number(a.utilizador_id) === Number(dados.utilizador_id)
          && Number(a.condominio_id) === Number(dados.condominio_id)
          && !eTerminal(a.estado)
      );
      if (colide) {
        const err = new Error('Duplicate entry for key acessos_suporte_um_vigente_por_par');
        err.name = 'SequelizeUniqueConstraintError';
        err.parent = { code: 'ER_DUP_ENTRY' };
        throw err;
      }

      seq += 1;
      const registo = { id: seq, ...dados };
      acessos.push(registo);
      return wrap(registo);
    },
    async findOne({ where }) { return wrap(acessos.find((a) => corresponde(a, where)) || null); },
    async findByPk(id) { return wrap(acessos.find((a) => Number(a.id) === Number(id)) || null); },
    async findAll({ where } = {}) { return acessos.filter((a) => corresponde(a, where)).map(wrap); },
    async count({ where } = {}) { return acessos.filter((a) => corresponde(a, where)).length; },
    async update(patch, { where } = {}) {
      const alvo = acessos.filter((a) => corresponde(a, where));
      alvo.forEach((a) => Object.assign(a, patch));
      return [alvo.length];
    },
  };

  const UserCondominio = {
    async findOne({ where }) {
      return associacoes.find((a) => Object.entries(where).every(
        ([k, v]) => (Number.isNaN(Number(v)) ? a[k] === v : Number(a[k]) === Number(v))
      )) || null;
    },
    async count({ where }) {
      return associacoes.filter((a) => Object.entries(where).every(
        ([k, v]) => (Number.isNaN(Number(v)) ? a[k] === v : Number(a[k]) === Number(v))
      )).length;
    },
  };

  const AuditLog = { async create(d) { auditoria.push(d); return d; } };

  return {
    AcessoSuporte,
    UserCondominio,
    AuditLog,
    acessos,
    auditoria,
    definirAssociacoes: (l) => { associacoes = l; },
    aoCriar: (h) => { aoCriar = h; },
    imporConstraint: (v) => { imporConstraint = v; },
  };
}

// ── Injeção dos stubs ANTES de carregar os helpers ───────────────────
const stubs = criarStubs();
const modelosReais = require.resolve(path.join(RAIZ, 'models'));
delete require.cache[require.resolve(path.join(RAIZ, 'helpers/audit'))];

require.cache[modelosReais] = {
  id: modelosReais,
  filename: modelosReais,
  loaded: true,
  exports: {
    AcessoSuporte: stubs.AcessoSuporte,
    UserCondominio: stubs.UserCondominio,
    AuditLog: stubs.AuditLog,
    Condominio: { findByPk: async () => ({ id: 1, estado: 'ativo' }) },
    User: { findByPk: async () => null },
  },
};

const AUDIT = require.resolve(path.join(RAIZ, 'helpers/audit'));
delete require.cache[AUDIT];

// ── Só AGORA se carrega o helper, com os modelos já substituídos ─────
suporte = require(path.join(RAIZ, 'helpers/suporte'));
TERMINAIS = suporte.ESTADOS_TERMINAIS;

// ── Sonda: a auditoria está mesmo ligada ao stub? ────────────────────
// Sem isto, uma injeção mal feita faria todos os testes de auditoria medirem
// nada em silêncio (`audit.js` engole qualquer erro).
{
  require(AUDIT).audit({ userId: 1, acao: 'sonda_auditoria', detalhes: { sonda: true } });
  const ultimo = stubs.auditoria[stubs.auditoria.length - 1];
  if (!ultimo || ultimo.acao !== 'sonda_auditoria') {
    throw new Error('audit.js não está ligado ao stub de AuditLog: os testes de auditoria mediriam nada');
  }
  stubs.auditoria.length = 0;
}

// ── Acessores de leitura ─────────────────────────────────────────────
const estadoDe = (id) => (stubs.acessos.find((a) => Number(a.id) === Number(id)) || {}).estado;
const registoDe = (id) => stubs.acessos.find((a) => Number(a.id) === Number(id));
const vigentesDoPar = (u, c) => stubs.acessos.filter(
  // «Vigente» vem da DEFINIÇÃO DE PRODUÇÃO (`suporte.eEstadoVigente`), não de uma
  // cópia local: se a noção de «vivo» mudar no helper, a asserção da invariante
  // acompanha-a em vez de continuar a medir o critério antigo.
  (a) => Number(a.utilizador_id) === Number(u) && Number(a.condominio_id) === Number(c)
    && suporte.eEstadoVigente(a.estado)
);
const eventos = (acao) => stubs.auditoria
  .filter((e) => e.acao === acao)
  .map((e) => ({ ...e, detalhes: e.detalhes ? JSON.parse(e.detalhes) : null }));

const U = 9; // operador
const U2 = 77; // segundo operador
const SESSAO = 'sess-1';
const reqBase = (over = {}) => ({
  isAuthenticated: () => true,
  user: { id: U, role_global: 'super_admin' },
  session: {},
  sessionID: SESSAO,
  flash: () => {},
  method: 'GET',
  get: () => '/',
  ...over,
});
const pedido = (u = U) => reqBase({ user: { id: u, role_global: 'super_admin' } });

// ═════════════════════════════════════════════════════════════════════
async function testarUnicidade() {
  stubs.definirAssociacoes([]); // sem admin no condomínio → inicia direto (ativo)

  // ── 1. primeiro acesso → criado e ativo ─────────────────────────
  titulo('1. primeiro acesso → criado e ATIVO');
  const C1 = 1;
  const a1 = await suporte.iniciar({ req: pedido(), condominioId: C1, motivo: 'primeiro', nivel: 'diagnostico', duracaoMinutos: 60 });
  assert.strictEqual(a1.ok, true, 'o primeiro acesso é criado');
  assert.strictEqual(a1.acesso.estado, 'ativo', 'e nasce ativo');
  assert.strictEqual(a1.anteriores.total, 0, 'não havia nada para fechar');
  assert.strictEqual(vigentesDoPar(U, C1).length, 1, 'fica exatamente um vigente');
  feito('primeiro acesso criado e ativo');

  // ── 2. segundo acesso do mesmo par → primeiro FECHADO, segundo ativo ──
  titulo('2. segundo acesso do mesmo par → primeiro FECHADO, segundo ATIVO');
  const req2 = pedido();
  const a2 = await suporte.iniciar({ req: req2, condominioId: C1, motivo: 'segundo', nivel: 'diagnostico', duracaoMinutos: 60 });
  assert.strictEqual(a2.ok, true, 'o segundo acesso é criado');
  assert.strictEqual(estadoDe(a1.acesso.id), 'terminado', 'o ANTERIOR fica terminado');
  assert.ok(registoDe(a1.acesso.id).terminado_em, 'o anterior ganha terminado_em');
  assert.strictEqual(a2.acesso.estado, 'ativo', 'o NOVO fica ativo');
  assert.strictEqual(a2.anteriores.total, 1, 'reportou 1 anterior');
  assert.strictEqual(a2.anteriores.terminados, 1, 'e fechou-o');
  assert.strictEqual(vigentesDoPar(U, C1).length, 1, '⛔ existe exatamente UM vigente para o par');
  assert.strictEqual(vigentesDoPar(U, C1)[0].id, a2.acesso.id, 'e é o novo');
  // A sessão aponta para o NOVO — nunca para um acesso já terminado.
  assert.strictEqual(req2.session[suporte.CHAVE_SESSAO], a2.acesso.id, 'a sessão aponta para o acesso novo');
  // Auditoria: o fecho do anterior tem origem própria.
  const evFecho = eventos('suporte_terminado').filter(
    (e) => e.detalhes && Number(e.detalhes.acesso_suporte_id) === Number(a1.acesso.id)
  );
  assert.strictEqual(evFecho.length, 1, 'o fecho do anterior foi auditado');
  assert.strictEqual(evFecho[0].detalhes.origem, 'substituido', 'com origem «substituido»');
  feito('segundo acesso fecha o primeiro (auditado como «substituido»)');

  // ── 3. novo acesso depois de o anterior já estar encerrado ──────
  titulo('3. novo acesso com o anterior já encerrado → criado normalmente');
  const a3 = await suporte.iniciar({ req: pedido(), condominioId: C1, motivo: 'terceiro', nivel: 'diagnostico', duracaoMinutos: 60 });
  assert.strictEqual(a3.ok, true, 'criado');
  assert.strictEqual(a3.acesso.estado, 'ativo', 'ativo');
  assert.strictEqual(estadoDe(a2.acesso.id), 'terminado', 'o anterior (a2) foi fechado');
  assert.strictEqual(a3.anteriores.total, 1, 'fechou exatamente o a2');
  assert.strictEqual(vigentesDoPar(U, C1).length, 1, 'um só vigente');
  feito('novo acesso fecha o anterior e fica sozinho');

  // ── 4. acesso EXPIRADO não bloqueia um novo ─────────────────────
  titulo('4. acesso expirado → não bloqueia novo acesso');
  const C4 = 4;
  const b1 = await suporte.iniciar({ req: pedido(), condominioId: C4, motivo: 'vai expirar', nivel: 'diagnostico', duracaoMinutos: 60 });
  // Formaliza a expiração como a expiração lazy faria (estado TERMINAL).
  registoDe(b1.acesso.id).estado = 'expirado';
  const b2 = await suporte.iniciar({ req: pedido(), condominioId: C4, motivo: 'depois de expirar', nivel: 'diagnostico', duracaoMinutos: 60 });
  assert.strictEqual(b2.ok, true, 'o novo acesso é criado');
  assert.strictEqual(b2.anteriores.total, 0, 'um acesso TERMINAL não é «anterior vivo» — não há nada a fechar');
  assert.strictEqual(estadoDe(b1.acesso.id), 'expirado', 'o expirado permanece expirado (não é reescrito)');
  assert.strictEqual(vigentesDoPar(U, C4).length, 1, 'um só vigente');
  feito('expirado não bloqueia e não é reescrito');

  // ── 5. mesmo utilizador em condomínios DIFERENTES → independentes ──
  titulo('5. mesmo utilizador, condomínios diferentes → independentes');
  const CX = 50, CY = 51;
  const x = await suporte.iniciar({ req: pedido(), condominioId: CX, motivo: 'X', nivel: 'diagnostico', duracaoMinutos: 60 });
  const y = await suporte.iniciar({ req: pedido(), condominioId: CY, motivo: 'Y', nivel: 'diagnostico', duracaoMinutos: 60 });
  assert.strictEqual(estadoDe(x.acesso.id), 'ativo', 'o acesso a X continua ativo');
  assert.strictEqual(estadoDe(y.acesso.id), 'ativo', 'e o acesso a Y nasce ativo');
  assert.strictEqual(y.anteriores.total, 0, 'abrir em Y não fechou nada em X');
  assert.strictEqual(vigentesDoPar(U, CX).length, 1, 'X tem o seu vigente');
  assert.strictEqual(vigentesDoPar(U, CY).length, 1, 'Y tem o seu vigente');
  feito('condomínios diferentes não se fecham entre si');

  // ── 6. utilizadores DIFERENTES no mesmo condomínio → independentes ──
  titulo('6. utilizadores diferentes no mesmo condomínio → independentes');
  const CZ = 60;
  const p = await suporte.iniciar({ req: pedido(U), condominioId: CZ, motivo: 'operador A', nivel: 'diagnostico', duracaoMinutos: 60 });
  const q = await suporte.iniciar({ req: pedido(U2), condominioId: CZ, motivo: 'operador B', nivel: 'diagnostico', duracaoMinutos: 60 });
  assert.strictEqual(estadoDe(p.acesso.id), 'ativo', 'o acesso do operador A continua ativo');
  assert.strictEqual(estadoDe(q.acesso.id), 'ativo', 'e o do operador B nasce ativo');
  assert.strictEqual(q.anteriores.total, 0, 'abrir por B não fechou o de A');
  assert.strictEqual(vigentesDoPar(U, CZ).length, 1, 'A tem o seu vigente em Z');
  assert.strictEqual(vigentesDoPar(U2, CZ).length, 1, 'B tem o seu vigente em Z');
  feito('operadores diferentes no mesmo condomínio são independentes');

  // ── 7. múltiplos vigentes históricos → TODOS fechados ───────────
  titulo('7. múltiplos acessos vigentes do mesmo par → todos fechados');
  const C7 = 70;
  const futuro = new Date(Date.now() + 3600 * 1000);
  // Dados LEGADOS: três vigentes do mesmo par, como podiam existir antes desta
  // correção (a tabela não tinha índice único). Semeiam-se diretamente.
  for (const id of [7001, 7002, 7003]) {
    stubs.acessos.push({
      id, utilizador_id: U, condominio_id: C7, estado: 'ativo', nivel: 'diagnostico',
      motivo: 'legado', expira_em: futuro, iniciado_em: new Date(), session_id: SESSAO,
    });
  }
  assert.strictEqual(vigentesDoPar(U, C7).length, 3, 'o cenário de partida tem 3 vigentes');
  const c7 = await suporte.iniciar({ req: pedido(), condominioId: C7, motivo: 'depois do legado', nivel: 'diagnostico', duracaoMinutos: 60 });
  assert.strictEqual(c7.ok, true, 'o novo acesso é criado');
  assert.strictEqual(c7.anteriores.total, 3, 'apanhou os três anteriores');
  assert.strictEqual(c7.anteriores.terminados, 3, 'e fechou os três');
  for (const id of [7001, 7002, 7003]) {
    assert.strictEqual(estadoDe(id), 'terminado', `o legado ${id} foi fechado`);
  }
  assert.strictEqual(vigentesDoPar(U, C7).length, 1, 'sobra exatamente UM vigente');
  feito('três vigentes legados fechados de uma vez');

  // ── 8. encerrar() mantém o ciclo de vida correto ────────────────
  titulo('8. encerrar() mantém o ciclo de vida correto');
  const C8 = 80;
  const d1 = await suporte.iniciar({ req: pedido(), condominioId: C8, motivo: 'encerrar', nivel: 'diagnostico', duracaoMinutos: 60 });
  const reqT = reqBase({ session: { [suporte.CHAVE_SESSAO]: d1.acesso.id } });
  const rT = await suporte.terminar({ acessoId: d1.acesso.id, req: reqT });
  assert.strictEqual(rT.ok, true, 'terminar aceita');
  assert.strictEqual(rT.acesso.estado, 'terminado', 'estado terminado');
  assert.ok(registoDe(d1.acesso.id).terminado_em, 'terminado_em preenchido');
  assert.strictEqual(reqT.session[suporte.CHAVE_SESSAO], undefined, 'a sessão é limpa');
  assert.strictEqual(await suporte.vigente(reqBase({ session: { [suporte.CHAVE_SESSAO]: d1.acesso.id } }), C8), null,
    'um acesso terminado não autoriza');
  // Depois de encerrado, abrir outro não encontra nada para fechar.
  const d2 = await suporte.iniciar({ req: pedido(), condominioId: C8, motivo: 'depois de encerrar', nivel: 'diagnostico', duracaoMinutos: 60 });
  assert.strictEqual(d2.anteriores.total, 0, 'não havia vigentes (o anterior foi encerrado a sério)');
  assert.strictEqual(estadoDe(d1.acesso.id), 'terminado', 'o encerrado continua terminado');
  feito('encerrar() fecha, limpa a sessão e não deixa lixo para fechar');

  // ── 9. expiração mantém o ciclo de vida correto ─────────────────
  titulo('9. expiração mantém o ciclo de vida correto');
  const C9 = 90;
  const e1 = await suporte.iniciar({ req: pedido(), condominioId: C9, motivo: 'prazo passado', nivel: 'diagnostico', duracaoMinutos: 60 });
  // Prazo no PASSADO, mas ainda `ativo`: é o estado real entre o vencimento e a
  // formalização lazy. Um novo acesso tem de o fechar como EXPIRADO.
  registoDe(e1.acesso.id).expira_em = new Date(Date.now() - 60 * 1000);
  const e2 = await suporte.iniciar({ req: pedido(), condominioId: C9, motivo: 'novo', nivel: 'diagnostico', duracaoMinutos: 60 });
  assert.strictEqual(e2.ok, true, 'o novo acesso é criado');
  assert.strictEqual(estadoDe(e1.acesso.id), 'expirado',
    'o anterior fora do prazo é formalizado como EXPIRADO (não «terminado»: o fim real foi o prazo)');
  assert.strictEqual(vigentesDoPar(U, C9).length, 1, 'um só vigente');
  const evExp = eventos('suporte_expirado').filter(
    (e) => e.detalhes && Number(e.detalhes.acesso_suporte_id) === Number(e1.acesso.id)
  );
  assert.strictEqual(evExp.length, 1, 'a expiração foi auditada como suporte_expirado');
  const evTerm = eventos('suporte_terminado').filter(
    (e) => e.detalhes && Number(e.detalhes.acesso_suporte_id) === Number(e1.acesso.id)
  );
  assert.strictEqual(evTerm.length, 0, 'e NÃO como suporte_terminado (a razão do fim é o prazo)');
  assert.strictEqual(await suporte.vigente(reqBase({ session: { [suporte.CHAVE_SESSAO]: e1.acesso.id } }), C9), null,
    'o expirado não autoriza');
  feito('acesso fora do prazo é fechado como expirado, com a auditoria certa');

  // ── 10. tentativa CONCORRENTE → nunca dois vigentes ─────────────
  titulo('10. corrida real: a constraint da BD arbitra e o código recupera');
  const C10 = 100;
  // Simula a outra transação a COMETER entre a limpeza e o INSERT deste pedido.
  // É exatamente o intervalo que a limpeza não cobre.
  stubs.aoCriar(() => {
    stubs.acessos.push({
      id: 9999, utilizador_id: U, condominio_id: C10, estado: 'ativo', nivel: 'diagnostico',
      motivo: 'transação concorrente', expira_em: new Date(Date.now() + 3600 * 1000),
      iniciado_em: new Date(), session_id: 'outra-sessao',
    });
  });
  const req10 = pedido();
  const r10 = await suporte.iniciar({ req: req10, condominioId: C10, motivo: 'perdedor da corrida', nivel: 'diagnostico', duracaoMinutos: 60 });
  assert.strictEqual(r10.ok, true, 'recupera da violação de unicidade e conclui');
  assert.strictEqual(vigentesDoPar(U, C10).length, 1, '⛔ NUNCA ficam dois vigentes — ficou exatamente um');
  assert.strictEqual(estadoDe(9999), 'terminado', 'o acesso da transação concorrente foi fechado');
  assert.strictEqual(vigentesDoPar(U, C10)[0].id, r10.acesso.id, 'e o vigente é o deste pedido');
  assert.strictEqual(req10.session[suporte.CHAVE_SESSAO], r10.acesso.id, 'a sessão aponta para o vigente');
  feito('corrida resolvida pela constraint: um só vigente no fim');

  // ── 11. SEM a constraint da BD, a aplicação sozinha mantém a invariante ──
  // Prova a DEFESA EM PROFUNDIDADE. O índice único é a rede de segurança, mas a
  // lógica da aplicação tem de bastar-se a si própria: com a constraint
  // desligada, um segundo `iniciar()` que não fechasse o anterior deixaria DOIS
  // vigentes. É esta a secção que torna essa regressão impossível de passar
  // despercebida — sem ela, a rede da BD mascararia a remoção da lógica.
  titulo('11. sem a constraint da BD, a aplicação sozinha mantém a invariante');
  stubs.imporConstraint(false);
  const C11 = 110;
  const g1 = await suporte.iniciar({ req: pedido(), condominioId: C11, motivo: 'g1', nivel: 'diagnostico', duracaoMinutos: 60 });
  const g2 = await suporte.iniciar({ req: pedido(), condominioId: C11, motivo: 'g2', nivel: 'diagnostico', duracaoMinutos: 60 });
  assert.strictEqual(g2.ok, true, 'o segundo acesso é criado');
  assert.strictEqual(g2.anteriores.terminados, 1, 'a aplicação fechou o anterior por si');
  assert.strictEqual(estadoDe(g1.acesso.id), 'terminado', 'o anterior ficou terminado');
  assert.strictEqual(vigentesDoPar(U, C11).length, 1,
    '⛔ sem a rede da BD, a aplicação SOZINHA mantém um só vigente por par');
  stubs.imporConstraint(true);
  feito('defesa em profundidade: a aplicação sozinha não deixa dois vigentes');

  // ── Invariante GLOBAL sobre todo o estado acumulado ─────────────
  titulo('Invariante global: nenhum par com mais de um vigente');
  const porPar = new Map();
  for (const a of stubs.acessos) {
    if (eTerminal(a.estado)) continue;
    const k = `${a.utilizador_id}:${a.condominio_id}`;
    porPar.set(k, (porPar.get(k) || 0) + 1);
  }
  for (const [k, n] of porPar) {
    assert.strictEqual(n, 1, `o par ${k} tem ${n} acessos vigentes (o máximo é 1)`);
  }
  feito(`invariante verificada em ${porPar.size} pares com acesso vigente`);
}

// ═════════════════════════════════════════════════════════════════════
// Migration — a mesma regra ao nível da BD.
// ═════════════════════════════════════════════════════════════════════
function testarMigration() {
  titulo('Migration — unicidade imposta pela BD');

  const ficheiros = fs.readdirSync(path.join(RAIZ, 'migrations')).filter((f) => f.endsWith('.js')).sort();
  const ALVO = '20260101000081-um-acesso-suporte-vigente.js';
  assert.ok(ficheiros.includes(ALVO), `existe a migration ${ALVO}`);

  // Próximo número disponível, sem reutilizar ids.
  const numeros = ficheiros.map((f) => Number((/^(\d+)/.exec(f) || [])[1] || 0));
  assert.strictEqual(new Set(numeros).size, numeros.length, 'não há números de migration reutilizados');
  const nAlvo = Number(/^(\d+)/.exec(ALVO)[1]);
  assert.strictEqual(nAlvo, Math.max(...numeros), 'a migration usa o PRÓXIMO número disponível');

  const src = ler(`migrations/${ALVO}`);
  assert.ok(/async up\(/.test(src), 'tem `up`');
  assert.ok(/async down\(/.test(src), 'tem `down`');

  // A coluna gerada e o índice único.
  assert.ok(/ADD COLUMN vigente_chave/.test(src), 'cria a coluna gerada `vigente_chave`');
  assert.ok(/PERSISTENT/.test(src), 'a coluna é PERSISTENT');
  assert.ok(/unique:\s*true/.test(src), 'o índice é UNIQUE');
  assert.ok(/utilizador_id',\s*'condominio_id',\s*'vigente_chave'/.test(src),
    'a chave do índice é (utilizador_id, condominio_id, vigente_chave)');

  // O `down` desfaz exatamente o que o `up` fez.
  assert.ok(/removeIndex\(/.test(src), 'o `down` remove o índice');
  assert.ok(/DROP COLUMN vigente_chave/.test(src), 'o `down` remove a coluna');

  // ⛔ ORDEM CRÍTICA: sem resolver os duplicados ANTES, criar o índice único
  // falharia num clone com dados e a migration ficaria a meio.
  const posDedup = src.indexOf('MAX(id)');
  const posColuna = src.indexOf('ADD COLUMN vigente_chave');
  const posIndice = src.indexOf('unique: true');
  assert.ok(posDedup > -1, 'o `up` resolve duplicados (MAX(id))');
  assert.ok(posColuna > -1 && posIndice > -1, 'coluna e índice presentes');
  assert.ok(posDedup < posIndice, '⛔ resolve os duplicados ANTES de exigir unicidade');
  assert.ok(posColuna < posIndice, 'a coluna é criada antes do índice que a usa');

  // Os estados terminais usados pela migration são os MESMOS do helper.
  for (const e of TERMINAIS) {
    assert.ok(src.includes(`'${e}'`), `a migration usa o estado terminal «${e}» do helper`);
  }
  feito('migration: número, coluna gerada + índice único, dedup antes, down coerente');

  // `up`/`down` são executáveis e emitem o SQL esperado (sem BD).
  const mig = require(path.join(RAIZ, 'migrations', ALVO));
  const emitido = [];
  const qi = {
    sequelize: { query: (s) => { emitido.push(s); return Promise.resolve(); } },
    addIndex: (t, c, o) => { emitido.push(`CREATE ${o.unique ? 'UNIQUE ' : ''}INDEX ${o.name} ON ${t} (${c.join(', ')})`); },
    removeIndex: (t, n) => { emitido.push(`DROP INDEX ${n} ON ${t}`); },
  };
  return (async () => {
    await mig.up(qi);
    assert.strictEqual(emitido.length, 3, 'o `up` emite 3 operações');
    assert.ok(/UPDATE acessos_suporte/.test(emitido[0]), '1.º: deduplicação');
    assert.ok(/ADD COLUMN vigente_chave/.test(emitido[1]), '2.º: coluna gerada');
    assert.ok(/^CREATE UNIQUE INDEX acessos_suporte_um_vigente_por_par/.test(emitido[2]), '3.º: índice único');
    emitido.length = 0;
    await mig.down(qi);
    assert.strictEqual(emitido.length, 2, 'o `down` emite 2 operações');
    assert.ok(/^DROP INDEX/.test(emitido[0]), 'o `down` começa por remover o índice');
    assert.ok(/DROP COLUMN vigente_chave/.test(emitido[1]), 'e depois a coluna');
    feito('up/down executam e emitem o SQL esperado (dedup → coluna → índice; inverso no down)');
  })();
}

// ═════════════════════════════════════════════════════════════════════
async function main() {
  console.log('P58 — um só acesso de suporte vigente por (utilizador, condomínio)');
  await testarUnicidade();
  await testarMigration();
  console.log(`\n✓ Testes de unicidade do acesso de suporte passaram (${nTestes} verificações, sem base de dados).`);
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
