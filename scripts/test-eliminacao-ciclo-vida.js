// ═══════════════════════════════════════════════════════════════════
// Ciclo de vida do condomínio — ATIVO · INATIVO · ELIMINAÇÃO (sem BD, sem rede).
//
// Cobre o que a Fase 2 corrigiu, e cobre-o por COMPORTAMENTO (não por asserção
// estática sobre o texto do código):
//
//   1. Desativar um condomínio corta quem JÁ ESTÁ dentro (o defeito central:
//      a desativação era cosmética — a lista escondia-o, o middleware não).
//   2. Um condomínio desativado não pode ser ESCOLHIDO (`entrarCondominio`).
//   3. Um acesso de SUPORTE a um condomínio desativado deixa de autorizar.
//   4. Desativar exige MOTIVO, e a tentativa sem motivo é AUDITADA.
//   5. Desativar exige estar ATIVO; reativar exige estar INATIVO (e a tentativa
//      inválida é auditada). Isto é o que impede um duplo-submit de REVERTER a
//      operação — o defeito do antigo toggle cego.
//   6. A desativação TERMINA os acessos de suporte vigentes DESSE condomínio,
//      com um evento de auditoria por acesso, e NÃO toca nos de outros.
//   7. Eliminar exige `ELIMINAR` e o estado inativo; a recusa é auditada.
//   8. ISOLAMENTO: em nenhuma das operações o condomínio vizinho é afetado.
//
// Os duplos de modelo são ESTADEFUL: as rotas leem o estado, mudam-no e voltam
// a lê-lo (desativar → o segundo pedido tem de ver o novo estado). Um duplo
// sem estado faria o teste 5 passar por acidente — não observaria a transição.
//
// Utilização: node scripts/test-eliminacao-ciclo-vida.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');

const RAIZ = path.join(__dirname, '..');

let nTestes = 0;
const feito = (nome) => { nTestes += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// ── BD em memória ───────────────────────────────────────────────────
// Dois condomínios, para o isolamento ser observável em todas as operações.
const CID_A = 11;
const CID_B = 22;

function criarBD() {
  return {
    condominios: [
      { id: CID_A, designacao: 'Condomínio A', estado: 'ativo', drive_folder_id: null },
      { id: CID_B, designacao: 'Condomínio B', estado: 'ativo', drive_folder_id: null },
    ],
    acessos_suporte: [],
    auditoria: [],
  };
}

// ── Duplos de modelo ESTADEFUL ──────────────────────────────────────
// Firmam-se na BD em memória: cada leitura reflete as escritas anteriores.
// É o que permite testar transições de estado (e a recusa da transição
// repetida) em vez de apenas um instante.
function modeloCondominio(bd) {
  const linha = (id) => bd.condominios.find((c) => Number(c.id) === Number(id)) || null;
  const comMetodos = (c) => {
    if (!c) return null;
    return {
      ...c,
      async update(patch) {
        Object.assign(c, patch);
        return this;
      },
      toJSON() { return { ...c }; },
    };
  };
  return {
    async findByPk(id, opcoes) {
      const c = linha(id);
      if (!c) return null;
      // `attributes` estreito: devolve só o que foi pedido (como o Sequelize).
      if (opcoes && Array.isArray(opcoes.attributes)) {
        const filtr = {};
        for (const a of opcoes.attributes) filtr[a] = c[a];
        return comMetodos(Object.assign(Object.create(Object.getPrototypeOf(c)), c, filtr));
      }
      return comMetodos(c);
    },
    async findOne(opcoes) {
      const w = (opcoes && opcoes.where) || {};
      const c = bd.condominios.find((x) => (!w.id || Number(x.id) === Number(w.id))
        && (!w.estado || x.estado === w.estado)) || null;
      return comMetodos(c);
    },
    async findAll() { return bd.condominios.map(comMetodos); },
    async count() { return bd.condominios.length; },
  };
}

function modeloAcesso(bd) {
  const comMetodos = (a) => (a ? Object.assign(a, {
    async update(patch) { Object.assign(a, patch); return this; },
    toJSON() { return { ...a }; },
  }) : null);
  const casa = (a, where) => {
    if (!where) return false;
    if (where.id !== undefined && where.id !== null && Number(a.id) !== Number(where.id)) return false;
    if (where.condominio_id !== undefined && where.condominio_id !== null
      && Number(a.condominio_id) !== Number(where.condominio_id)) return false;
    if (where.estado !== undefined && where.estado !== null && a.estado !== where.estado) return false;
    return true;
  };
  return {
    async findByPk(id) { return comMetodos(bd.acessos_suporte.find((a) => Number(a.id) === Number(id)) || null); },
    async findOne(opcoes) {
      const w = (opcoes && opcoes.where) || {};
      return comMetodos(bd.acessos_suporte.find((a) => casa(a, w)) || null);
    },
    async findAll(opcoes) {
      const w = (opcoes && opcoes.where) || {};
      return bd.acessos_suporte.filter((a) => casa(a, w)).map(comMetodos);
    },
    async count(opcoes) {
      const w = (opcoes && opcoes.where) || {};
      return bd.acessos_suporte.filter((a) => casa(a, w)).length;
    },
  };
}

function modeloAssoc(bd) {
  // `associacaoAtiva` faz um `findOne` com `include` do condomínio a exigir
  // `estado: 'ativo'`. O duplo REPRODUZ esse filtro — sem ele, o teste 11
  // passaria por acidente (devolveria sempre uma associação e o middleware
  // concederia contexto mesmo com o condomínio desativado).
  return {
    async findOne(opcoes) {
      const w = (opcoes && opcoes.where) || {};
      const incl = (opcoes && opcoes.include) || [];
      const filtroCond = incl.find((i) => i.as === 'condominio');
      const c = bd.condominios.find((x) => Number(x.id) === Number(w.condominio_id));
      if (!c) return null;
      if (w.estado && w.estado !== 'ativo') return null;
      if (filtroCond && filtroCond.where && filtroCond.where.estado
        && c.estado !== filtroCond.where.estado) return null;
      return {
        utilizador_id: w.utilizador_id, condominio_id: c.id, role: 'admin', estado: 'ativo',
        condominio: { ...c },
        async update(patch) { Object.assign(this, patch); return this; },
      };
    },
    async findAll() { return []; },
    async count() { return 0; },
    async destroy() { return 0; },
  };
}

// Duplo de auditoria OBSERVÁVEL: grava a linha real, como o `audit` verdadeiro.
// (Um no-op faria os testes de auditoria medirem sempre 0 e «passarem».)
function duploAuditoria(bd) {
  return {
    audit: async (evento) => {
      bd.auditoria.push({
        user_id: evento.userId || null,
        acao: evento.acao,
        entidade: evento.entidade || null,
        entidade_id: evento.entidadeId || null,
        detalhes: evento.detalhes ? JSON.parse(JSON.stringify(evento.detalhes)) : null,
      });
    },
  };
}

// ── Injeção dos duplos via require.cache ────────────────────────────
const modelsPath = require.resolve(path.join(RAIZ, 'models'));
const auditPath = require.resolve(path.join(RAIZ, 'helpers', 'audit'));

function injetar(bd) {
  require.cache[modelsPath] = {
    id: modelsPath, filename: modelsPath, loaded: true,
    exports: {
      Condominio: modeloCondominio(bd),
      AcessoSuporte: modeloAcesso(bd),
      UserCondominio: modeloAssoc(bd),
      AuditLog: { async create() { return {}; } },
      User: { async findByPk() { return null; } },
    },
  };
  require.cache[auditPath] = {
    id: auditPath, filename: auditPath, loaded: true,
    exports: duploAuditoria(bd),
  };
  // Limpar os módulos que já capturaram os modelos.
  for (const rel of ['helpers/tenant.js', 'helpers/suporte.js', 'routes/global-admin.js']) {
    delete require.cache[require.resolve(path.join(RAIZ, rel))];
  }
}

// ── Servidor mínimo com o router REAL ───────────────────────────────
// Só o necessário para exercitar `routes/global-admin.js` por HTTP: um
// utilizador super_admin, sessão e flash falsos, e o guard global.
function criarApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.user = { id: 1, role_global: 'super_admin' };
    req.session = {};
    req.isAuthenticated = () => true;
    req.flash = () => {};
    next();
  });
  app.use('/global', (req, res, next) => {
    // GUARDA REAL do router (super admin) — replicada aqui porque o router
    // não a monta sozinho nesta bancada.
    if (!req.user || req.user.role_global !== 'super_admin') {
      return res.status(403).json({ erro: 'sem_acesso_global' });
    }
    return next();
  });
  app.use('/global', require(path.join(RAIZ, 'routes', 'global-admin.js')));
  // Terminador: os handlers terminam em redirect; capturamos o destino.
  app.use((req, res) => res.status(404).json({ erro: 'sem_rota', caminho: req.path }));
  return app;
}

const pedir = (base, caminho, corpo) => new Promise((resolve) => {
  const dados = new URLSearchParams(corpo || {}).toString();
  const req = http.request(`${base}${caminho}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(dados),
    },
  }, (res) => {
    resolve({ status: res.statusCode, localizacao: res.headers.location || null });
  });
  req.on('error', () => resolve({ status: 0, localizacao: null }));
  req.end(dados);
});

// Convenção ÚNICA da área global: `/global/...`. O router declara caminhos
// RELATIVOS à montagem (`/condominios`, `/utilizadores`…) e está montado em
// `/global` (app.js), pelo que o URL real é `/global` + o caminho declarado.
//
// Este helper deriva o prefixo da MONTAGEM real em vez de o escrever à mão:
// antes escrevia `/global/global`, o que codificava o defeito do prefixo
// duplicado e fazia o teste passar com a área global inalcançável. Ver a
// verificação «o router não volta a duplicar o prefixo», mais abaixo.
const PREFIXO_MONTAGEM = '/global';
const rota = (resto) => `${PREFIXO_MONTAGEM}${resto}`;

// Guarda de regressão: nenhum caminho declarado no router pode começar por
// `/global`, senão o prefixo duplica-se outra vez (é somado ao da montagem).
{
  const router = require(path.join(RAIZ, 'routes', 'global-admin.js'));
  const duplicados = router.stack
    .filter((l) => l.route)
    .map((l) => l.route.path)
    .filter((p) => p === '/global' || p.startsWith('/global/'));
  assert.strictEqual(
    duplicados.length,
    0,
    `routes/global-admin.js volta a declarar caminhos com o prefixo /global (duplica com a montagem em ${PREFIXO_MONTAGEM}): ${duplicados.join(', ')}`
  );
}

// ── Auxiliares ──────────────────────────────────────────────────────
const estadoDe = (bd, id) => (bd.condominios.find((c) => Number(c.id) === Number(id)) || {}).estado;
const eventos = (bd, acao) => bd.auditoria.filter((l) => l.acao === acao);
const eventosDoCondominio = (bd, acao, id) =>
  eventos(bd, acao).filter((l) => Number(l.entidade_id) === Number(id));

async function comServidor(fn) {
  const app = criarApp();
  const servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => servidor.close(r));
  }
}

// ── Testes ──────────────────────────────────────────────────────────
async function main() {
  console.log('═══ Ciclo de vida do condomínio — testes offline ═══');

  // ── 1. Desativar exige MOTIVO ─────────────────────────────────────
  titulo('1. Desativar exige motivo (e a recusa é auditada)');
  {
    const bd = criarBD();
    injetar(bd);
    await comServidor(async (base) => {
      const r = await pedir(base, rota(`/condominios/${CID_A}/desativar`), {});
      assert.strictEqual(estadoDe(bd, CID_A), 'ativo', 'sem motivo o estado NÃO pode mudar');
      assert.ok(r.localizacao, 'tem de redirecionar com flash');
      const recusas = eventosDoCondominio(bd, 'condominio_desativacao_recusada', CID_A);
      assert.strictEqual(recusas.length, 1, 'a tentativa sem motivo tem de ser auditada');
      assert.strictEqual(recusas[0].detalhes.motivo, 'motivo_obrigatorio');
      assert.strictEqual(recusas[0].detalhes.resultado, 'recusado');
      feito('sem motivo: estado intacto + evento de recusa auditado');
    });
  }

  // ── 2. Desativar com motivo: transição + auditoria com o motivo ────
  titulo('2. Desativar com motivo: transição e auditoria');
  {
    const bd = criarBD();
    injetar(bd);
    await comServidor(async (base) => {
      await pedir(base, rota(`/condominios/${CID_A}/desativar`), { motivo: 'Obras estruturais' });
      assert.strictEqual(estadoDe(bd, CID_A), 'inativo', 'estado tem de passar a inativo');
      assert.strictEqual(estadoDe(bd, CID_B), 'ativo', 'o vizinho NÃO pode ser afetado');

      const ev = eventosDoCondominio(bd, 'condominio_desativado', CID_A);
      assert.strictEqual(ev.length, 1, 'um evento de desativação');
      assert.strictEqual(ev[0].detalhes.motivo, 'Obras estruturais', 'o MOTIVO tem de constar');
      assert.strictEqual(ev[0].detalhes.designacao, 'Condomínio A');
      feito('estado → inativo, motivo registado, vizinho intacto');
    });
  }

  // ── 3. DUPLO-SUBMIT não reverte (o defeito do toggle cego) ─────────
  titulo('3. Duplo-submit NÃO reverte a operação');
  {
    const bd = criarBD();
    injetar(bd);
    await comServidor(async (base) => {
      await pedir(base, rota(`/condominios/${CID_A}/desativar`), { motivo: 'Manutenção' });
      assert.strictEqual(estadoDe(bd, CID_A), 'inativo');
      // Segundo pedido idêntico (o F5 / o duplo-clique).
      await pedir(base, rota(`/condominios/${CID_A}/desativar`), { motivo: 'Manutenção' });
      assert.strictEqual(estadoDe(bd, CID_A), 'inativo',
        'o segundo pedido NÃO pode reativar (era o defeito do toggle cego)');
      const recusas = eventosDoCondominio(bd, 'condominio_desativacao_recusada', CID_A);
      assert.strictEqual(recusas.length, 1, 'a segunda tentativa é recusada e auditada');
      assert.strictEqual(recusas[0].detalhes.motivo, 'estado_invalido');
      assert.strictEqual(recusas[0].detalhes.estado_atual, 'inativo');
      feito('duplo-submit: continua inativo, recusa auditada');
    });
  }

  // ── 4. Reativar exige INATIVO; reativar um ativo é recusado ────────
  titulo('4. Reativar exige estado inativo');
  {
    const bd = criarBD();
    injetar(bd);
    await comServidor(async (base) => {
      // A está ATIVO: reativar tem de ser recusado (não é transição).
      await pedir(base, rota(`/condominios/${CID_A}/reativar`), {});
      assert.strictEqual(estadoDe(bd, CID_A), 'ativo');
      const recusas = eventosDoCondominio(bd, 'condominio_reativacao_recusada', CID_A);
      assert.strictEqual(recusas.length, 1, 'reativar um ativo é recusado e auditado');
      assert.strictEqual(recusas[0].detalhes.motivo, 'estado_invalido');

      // Agora desativa e reativa: o ciclo completo tem de funcionar.
      await pedir(base, rota(`/condominios/${CID_A}/desativar`), { motivo: 'Teste do ciclo' });
      assert.strictEqual(estadoDe(bd, CID_A), 'inativo');
      await pedir(base, rota(`/condominios/${CID_A}/reativar`), {});
      assert.strictEqual(estadoDe(bd, CID_A), 'ativo', 'reativar tem de funcionar');

      const ev = eventosDoCondominio(bd, 'condominio_reativado', CID_A);
      assert.strictEqual(ev.length, 1, 'um evento de reativação');
      // Reativar NÃO exige motivo (decisão de produto) — e não o inventa.
      assert.ok(!ev[0].detalhes.motivo, 'reativar não regista motivo (não foi pedido)');
      feito('reativar um ativo recusado; ciclo desativar→reativar completo');
    });
  }

  // ── 5. Rota antiga /estado deixou de ser um toggle cego ────────────
  titulo('5. Rota antiga /:id/estado: sem `acao` explícita, recusa');
  {
    const bd = criarBD();
    injetar(bd);
    await comServidor(async (base) => {
      const r = await pedir(base, rota(`/condominios/${CID_A}/estado`), {});
      assert.strictEqual(estadoDe(bd, CID_A), 'ativo',
        'sem `acao` o estado NÃO pode mudar (fechar em vez de adivinhar)');
      assert.ok(r.localizacao);
      const recusas = eventosDoCondominio(bd, 'condominio_estado_recusado', CID_A);
      assert.strictEqual(recusas.length, 1, 'a chamada ambígua é auditada');
      assert.strictEqual(recusas[0].detalhes.motivo, 'acao_ausente_ou_invalida');
      feito('sem `acao`: nada muda, recusa auditada');
    });
  }

  // ── 6. Rota antiga COM `acao` delega na lógica nova ────────────────
  titulo('6. Rota antiga /:id/estado com `acao` explícita delega');
  {
    const bd = criarBD();
    injetar(bd);
    await comServidor(async (base) => {
      await pedir(base, rota(`/condominios/${CID_A}/estado`), { acao: 'desativar', motivo: 'Via antiga' });
      assert.strictEqual(estadoDe(bd, CID_A), 'inativo', 'delega na desativação');
      assert.strictEqual(eventosDoCondominio(bd, 'condominio_desativado', CID_A).length, 1);

      // Sem motivo, mesmo com `acao`, continua a exigir motivo.
      await pedir(base, rota(`/condominios/${CID_B}/estado`), { acao: 'desativar' });
      assert.strictEqual(estadoDe(bd, CID_B), 'ativo', 'a via antiga também exige motivo');

      await pedir(base, rota(`/condominios/${CID_A}/estado`), { acao: 'reativar' });
      assert.strictEqual(estadoDe(bd, CID_A), 'ativo', 'delega na reativação');
      feito('`acao: desativar|reativar` delega e mantém as validações');
    });
  }

  // ── 7. A desativação TERMINA os acessos de suporte DESSE condomínio ─
  titulo('7. Desativar termina os acessos de suporte do condomínio (e só dele)');
  {
    const bd = criarBD();
    bd.acessos_suporte.push(
      { id: 101, utilizador_id: 1, condominio_id: CID_A, estado: 'ativo', nivel: 'diagnostico', motivo: 'Diagnóstico A' },
      { id: 102, utilizador_id: 1, condominio_id: CID_A, estado: 'ativo', nivel: 'diagnostico', motivo: 'Outro A' },
      { id: 103, utilizador_id: 1, condominio_id: CID_A, estado: 'terminado', nivel: 'diagnostico', motivo: 'Já terminado' },
      { id: 201, utilizador_id: 1, condominio_id: CID_B, estado: 'ativo', nivel: 'diagnostico', motivo: 'Diagnóstico B' },
    );
    injetar(bd);
    await comServidor(async (base) => {
      await pedir(base, rota(`/condominios/${CID_A}/desativar`), { motivo: 'Desativação com suporte aberto' });

      const a = (id) => bd.acessos_suporte.find((x) => x.id === id);
      assert.strictEqual(a(101).estado, 'terminado', 'acesso vigente de A tem de ser terminado');
      assert.strictEqual(a(102).estado, 'terminado', 'o segundo acesso de A também');
      assert.strictEqual(a(103).estado, 'terminado', 'o já terminado permanece terminado');
      assert.strictEqual(a(201).estado, 'ativo',
        'ISOLAMENTO: o acesso do condomínio B NÃO pode ser tocado');

      // UM evento por acesso terminado, com a origem certa.
      const termos = eventosDoCondominio(bd, 'suporte_terminado', CID_A);
      assert.strictEqual(termos.length, 2, 'um evento por acesso EFETIVAMENTE terminado (2)');
      for (const ev of termos) {
        assert.strictEqual(ev.detalhes.origem, 'condominio_desativado',
          'a origem tem de dizer que foi a desativação');
        assert.strictEqual(ev.detalhes.condominio_id, CID_A);
      }
      const idsTerminados = termos.map((e) => e.detalhes.acesso_suporte_id).sort();
      assert.deepStrictEqual(idsTerminados, [101, 102], 'os dois acessos vigentes, e só eles');

      // Nenhum evento de término do condomínio B.
      assert.strictEqual(eventosDoCondominio(bd, 'suporte_terminado', CID_B).length, 0,
        'nenhum acesso de B pode aparecer nos términos');

      // O número fica no evento da desativação, para leitura rápida.
      const ev = eventosDoCondominio(bd, 'condominio_desativado', CID_A)[0];
      assert.strictEqual(ev.detalhes.acessos_suporte_terminados, 2);
      feito('2 acessos de A terminados (1 evento cada), 0 de B afetados');
    });
  }

  // ── 8. Eliminar exige ELIMINAR; a recusa é auditada ────────────────
  titulo('8. Eliminar: confirmação e estado inativo (recusas auditadas)');
  {
    const bd = criarBD();
    injetar(bd);
    await comServidor(async (base) => {
      // (a) condomínio ATIVO + confirmação correta → recusado (não está inativo)
      await pedir(base, rota(`/condominios/${CID_A}/eliminar`), { confirmo: 'ELIMINAR' });
      assert.ok(bd.condominios.find((c) => c.id === CID_A), 'não pode ser eliminado estando ativo');
      const r1 = eventosDoCondominio(bd, 'condominio_eliminacao_recusada', CID_A);
      assert.strictEqual(r1.length, 1);
      assert.strictEqual(r1[0].detalhes.motivo, 'nao_esta_desativado');
      assert.strictEqual(r1[0].detalhes.estado_atual, 'ativo');

      // (b) confirmação errada → recusado, mesmo estando inativo
      await pedir(base, rota(`/condominios/${CID_A}/desativar`), { motivo: 'Preparar eliminação' });
      await pedir(base, rota(`/condominios/${CID_A}/eliminar`), { confirmo: 'eliminar' });
      assert.ok(bd.condominios.find((c) => c.id === CID_A), 'confirmação errada não elimina');
      const r2 = eventosDoCondominio(bd, 'condominio_eliminacao_recusada', CID_A);
      assert.strictEqual(r2.length, 2, 'a segunda recusa também é auditada');
      assert.strictEqual(r2[1].detalhes.motivo, 'confirmacao_invalida');

      assert.strictEqual(estadoDe(bd, CID_B), 'ativo', 'o vizinho nunca é tocado');
      feito('eliminar recusado (ativo; confirmação errada) e ambas as recusas auditadas');
    });
  }

  // ── 9. ISOLAMENTO global: desativar A não altera nada de B ─────────
  titulo('9. Isolamento: desativar A não altera nenhum aspeto de B');
  {
    const bd = criarBD();
    bd.acessos_suporte.push(
      { id: 301, utilizador_id: 1, condominio_id: CID_B, estado: 'ativo', nivel: 'diagnostico', motivo: 'Suporte B' },
    );
    injetar(bd);
    await comServidor(async (base) => {
      const antesB = JSON.stringify(bd.condominios.find((c) => c.id === CID_B));
      await pedir(base, rota(`/condominios/${CID_A}/desativar`), { motivo: 'Só o A' });
      await pedir(base, rota(`/condominios/${CID_A}/eliminar`), { confirmo: 'NAO' });

      const depoisB = JSON.stringify(bd.condominios.find((c) => c.id === CID_B));
      assert.strictEqual(depoisB, antesB, 'o registo de B tem de ficar byte a byte idêntico');
      assert.strictEqual(bd.acessos_suporte.find((a) => a.id === 301).estado, 'ativo',
        'o acesso de suporte de B permanece vigente');

      // Nenhum evento de auditoria com entidade_id = B.
      const evB = bd.auditoria.filter((l) => Number(l.entidade_id) === Number(CID_B));
      assert.strictEqual(evB.length, 0, 'nenhum evento de auditoria pode referir B');
      feito('B intacto byte a byte; nenhum evento de auditoria toca em B');
    });
  }

  // ── 10. Condomínio inexistente: sem efeitos colaterais ─────────────
  titulo('10. Condomínio inexistente não produz efeitos');
  {
    const bd = criarBD();
    injetar(bd);
    await comServidor(async (base) => {
      const r = await pedir(base, rota('/condominios/9999/desativar'), { motivo: 'Não existe' });
      assert.ok(r.localizacao, 'redireciona com erro');
      assert.strictEqual(bd.auditoria.length, 0, 'nenhum evento para um id inexistente');
      assert.strictEqual(estadoDe(bd, CID_A), 'ativo');
      feito('id inexistente: sem auditoria e sem alterações');
    });
  }

  // ── 11. O MIDDLEWARE corta quem já está dentro (o defeito central) ─
  // Sem isto, todo o resto é cosmético: desativar esconderia o condomínio da
  // lista mas deixaria quem lá está a trabalhar normalmente.
  titulo('11. comCondominioAtivo corta quem já está num condomínio desativado');
  {
    const bd = criarBD();
    injetar(bd);
    const tenant = require(path.join(RAIZ, 'helpers', 'tenant.js'));

    const reqBase = () => ({
      user: { id: 1, role_global: null },
      session: { condominio_ativo_id: CID_A },
      isAuthenticated: () => true,
      flash: () => {},
    });
    const correr = async (req) => {
      let resultado = 'sem_next';
      await tenant.comCondominioAtivo(
        req,
        { redirect: (u) => { resultado = `redirect:${u}`; return {}; } },
        () => { resultado = 'next'; }
      );
      return resultado;
    };

    // A está ATIVO → passa (controlo: o middleware não bloqueia por defeito).
    assert.strictEqual(await correr(reqBase()), 'next',
      'com o condomínio ativo, o contexto tem de ser concedido');

    // Desativar A e repetir: tem de CORTAR.
    bd.condominios.find((c) => c.id === CID_A).estado = 'inativo';
    const req2 = reqBase();
    const r2 = await correr(req2);
    assert.strictEqual(r2, 'redirect:/condominios',
      'com o condomínio desativado, o contexto tem de ser REFUSADO');
    assert.strictEqual(req2.session.condominio_ativo_id, undefined,
      'o contexto tem de ser limpo da sessão (não repetir a tentativa em cada pedido)');
    assert.strictEqual(req2.condominioId, undefined,
      'req.condominioId NUNCA pode ser exposto para um condomínio desativado');

    // E a entrada explícita também tem de ser recusada.
    const ok = await tenant.entrarCondominio({ user: { id: 1 }, session: {} }, CID_A);
    assert.strictEqual(ok, false, 'entrarCondominio tem de recusar um condomínio desativado');

    // ISOLAMENTO: o mesmo utilizador continua a entrar em B (ativo).
    const reqB = { user: { id: 1 }, session: {} };
    const okB = await tenant.entrarCondominio(reqB, CID_B);
    assert.strictEqual(okB, true, 'ISOLAMENTO: B continua acessível ao mesmo utilizador');
    feito('corta o desativado, limpa o contexto, mantém os restantes condomínios');
  }

  // ── 12. vigente() recusa um condomínio desativado ─────────────────
  titulo('12. vigente() recusa acesso de suporte a condomínio desativado');
  {
    const bd = criarBD();
    bd.acessos_suporte.push({
      id: 401, utilizador_id: 1, condominio_id: CID_A, estado: 'ativo',
      nivel: 'diagnostico', motivo: 'Diagnóstico', expira_em: new Date(Date.now() + 3600e3),
      session_id: 'sess-1',
    });
    injetar(bd);
    const suporte = require(path.join(RAIZ, 'helpers', 'suporte.js'));

    const req = () => ({
      user: { id: 1, role_global: 'super_admin' },
      session: { suporte_ativo_id: 401 },
      sessionID: 'sess-1',
    });

    // A ativo → autoriza.
    const r1 = await suporte.vigente(req(), CID_A);
    assert.ok(r1, 'com o condomínio ativo, o acesso tem de continuar vigente');

    // A desativado → deixa de autorizar (2.ª camada, independente do término).
    bd.condominios.find((c) => c.id === CID_A).estado = 'inativo';
    const r2 = await suporte.vigente(req(), CID_A);
    assert.strictEqual(r2, null, 'com o condomínio desativado, vigente() tem de recusar');

    // B não é tocado por nada disto.
    bd.acessos_suporte.push({
      id: 402, utilizador_id: 1, condominio_id: CID_B, estado: 'ativo',
      nivel: 'diagnostico', motivo: 'Diagnóstico B', expira_em: new Date(Date.now() + 3600e3),
      session_id: 'sess-1',
    });
    const reqB = { user: { id: 1, role_global: 'super_admin' }, session: { suporte_ativo_id: 402 }, sessionID: 'sess-1' };
    assert.ok(await suporte.vigente(reqB, CID_B),
      'ISOLAMENTO: o acesso ao condomínio ativo continua a autorizar');
    feito('vigente(): condomínio desativado recusado, condomínio ativo intacto');
  }

  // ── 13. Não se ABRE um acesso de suporte a um condomínio desativado ─
  titulo('13. iniciar() recusa abrir suporte num condomínio desativado');
  {
    const bd = criarBD();
    bd.condominios.find((c) => c.id === CID_A).estado = 'inativo';
    injetar(bd);
    const suporte = require(path.join(RAIZ, 'helpers', 'suporte.js'));
    const r = await suporte.iniciar({
      req: { user: { id: 1 }, session: {}, sessionID: 's' },
      condominioId: CID_A,
      motivo: 'Tentar abrir num inativo',
      nivel: 'diagnostico',
      duracaoMinutos: 15,
    });
    assert.strictEqual(r.ok, false, 'não pode ser concedido');
    assert.strictEqual(r.erro, 'condominio_inativo');
    assert.strictEqual(bd.acessos_suporte.length, 0, 'não pode ficar registo nenhum criado');
    feito('iniciar(): recusado e sem registo criado');
  }

  console.log(`\n✓ Testes do ciclo de vida do condomínio passaram (${nTestes} verificações, sem BD).`);
}

main().catch((e) => {
  console.error('\n✗ FALHA:', e && e.message ? e.message : e);
  if (e && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
