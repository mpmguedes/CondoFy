// Testes de segurança (sem rede/base de dados).
// Utilização: node scripts/test-seguranca.js
const assert = require('assert');
const { createLimiter, protegerOrigem } = require('../helpers/seguranca');

function novoLimiter(max, janelaMs = 60 * 1000) {
  return createLimiter({ rotulo: `teste-${Math.random().toString(36).slice(2)}`, max, janelaMs, msg: 'limitado' });
}

function pedido(ip) {
  return { ip, originalUrl: '/login', flash: () => {} };
}
function resposta() {
  return {
    statusCode: 200,
    redirectUrl: null,
    status(c) { this.statusCode = c; return this; },
    redirect(u) { this.redirectUrl = u; },
  };
}

function testarLimite() {
  const lim = novoLimiter(2);
  let avancos = 0;
  const next = () => { avancos += 1; };

  const req1 = pedido('1.2.3.4');
  const res1 = resposta();
  lim(req1, res1, next);
  assert.strictEqual(avancos, 1, 'primeiro pedido avança');

  const req2 = pedido('1.2.3.4');
  const res2 = resposta();
  lim(req2, res2, next);
  assert.strictEqual(avancos, 2, 'segundo pedido (dentro do limite) avança');

  const req3 = pedido('1.2.3.4');
  const res3 = resposta();
  lim(req3, res3, next);
  assert.strictEqual(avancos, 2, 'pedido acima do limite NÃO avança');
  assert.strictEqual(res3.statusCode, 429, 'resposta 429');
  assert.strictEqual(res3.redirectUrl, '/login', 'redireciona para o login');

  // IP diferente não é afetado pelo limite do anterior.
  const outro = novoLimiter(1);
  let avancosOutro = 0;
  const nextO = () => { avancosOutro += 1; };
  outro(pedido('5.6.7.8'), resposta(), nextO);
  outro(pedido('5.6.7.9'), resposta(), nextO);
  assert.strictEqual(avancosOutro, 2, 'limites independentes por IP');
}

function testarCSRF() {
  const base = (extra) => ({
    method: 'POST',
    protocol: 'https',
    get: (h) => (h === 'host' ? 'gescondu.pt' : undefined),
    headers: {},
    ...extra,
  });
  const resposta403 = () => {
    const res = { enviado: null, status(c) { this.enviado = c; return this; }, send() {} };
    return res;
  };
  const verificaAvanco = (tipo) => (req) => {
    let avancou = false;
    protegerOrigem(req, resposta403(), () => { avancou = true; });
    assert.ok(avancou, `${tipo}: pedido avança`);
  };

  // Sem Origin/Referer → avança (SameSite cobre o CSRF clássico).
  verificaAvanco('sem origem')(base());
  // Origin igual ao host → avança.
  verificaAvanco('mesma origem')(base({ headers: { origin: 'https://gescondu.pt' } }));
  // Referer do próprio host → avança.
  verificaAvanco('referer próprio')(base({ headers: { referer: 'https://gescondu.pt/admin/quotas' } }));
  // GET nunca é bloqueado.
  verificaAvanco('GET')(base({ method: 'GET', headers: { origin: 'https://inimigo.example' } }));

  // Origem diferente → 403 e não avança.
  const reqMau = base({ headers: { origin: 'https://inimigo.example' } });
  let avancouMau = false;
  const resMau = { enviado: null, status(c) { this.enviado = c; return this; }, send() {} };
  protegerOrigem(reqMau, resMau, () => { avancouMau = true; });
  assert.strictEqual(avancouMau, false, 'origem diferente não avança');
  assert.strictEqual(resMau.enviado, 403, 'origem diferente → 403');
}

// ── Auditoria: uma falha NÃO pode ser silenciosa (P12) ───────────────
// `helpers/audit.js` nunca pode lançar (a operação auditada tem de continuar),
// mas a falha tem de ficar observável. Modelo falso injetado em `require.cache`
// antes de carregar o módulo — a base de dados não é tocada.
function testarAuditoria() {
  const caminhoModels = require.resolve('../models');
  const caminhoAudit = require.resolve('../helpers/audit');
  const modelsOriginal = require.cache[caminhoModels];
  const auditOriginal = require.cache[caminhoAudit];
  const erroOriginal = console.error;

  let falhar = true;
  const escritos = [];
  const registado = [];
  require.cache[caminhoModels] = {
    id: caminhoModels,
    filename: caminhoModels,
    loaded: true,
    exports: {
      AuditLog: {
        create: async (dados) => {
          registado.push(dados);
          if (falhar) throw new Error('BD indisponível (simulado)');
          return dados;
        },
      },
    },
  };
  delete require.cache[caminhoAudit];
  console.error = (...args) => { escritos.push(args.join(' ')); };

  const repor = () => {
    console.error = erroOriginal;
    delete require.cache[caminhoAudit];
    if (modelsOriginal) require.cache[caminhoModels] = modelsOriginal; else delete require.cache[caminhoModels];
    if (auditOriginal) require.cache[caminhoAudit] = auditOriginal;
  };

  const { audit, estadoAuditoria, LIMITE_AVISO } = require('../helpers/audit');

  assert.strictEqual(estadoAuditoria().saudavel, true, 'começa saudável');

  return audit({ userId: 1, acao: 'eliminar_fração', entidade: 'Fracao', entidadeId: 9, detalhes: { nif: '123456789' } })
    .then(() => {
      // 1. Não lançou — o fluxo principal continuou.
      // 2. Mas a falha é observável.
      const e = estadoAuditoria();
      assert.strictEqual(e.falhas, 1, 'falha contabilizada');
      assert.strictEqual(e.falhasSeguidas, 1, 'falhas seguidas contabilizadas');
      assert.strictEqual(e.saudavel, false, 'deixa de estar saudável');
      assert.match(e.ultimoErro, /indisponível/, 'guarda a causa');
      assert.ok(e.ultimaFalhaEm instanceof Date, 'guarda o momento');
      // 3. O log diz o QUÊ falhou (sem segredos) — e nunca os `detalhes`.
      assert.ok(escritos.some((l) => l.includes('eliminar_fração')), 'o log identifica a ação');
      assert.ok(escritos.every((l) => !l.includes('123456789')), 'os detalhes (NIF) nunca vão para o log');
      return audit({ acao: 'editar_fracao' });
    })
    .then(() => audit({ acao: 'criar_fracao' }))
    .then(() => {
      assert.strictEqual(estadoAuditoria().falhas, 3, 'terceira falha contabilizada');
      // 4. Rajada de falhas escalada — uma vez, não a cada falha.
      const atencoes = escritos.filter((l) => l.includes('ATENÇÃO'));
      assert.strictEqual(atencoes.length, 1, `aviso escalado uma só vez (a partir de ${LIMITE_AVISO} falhas seguidas)`);
      return audit({ acao: 'criar_fracao' });
    })
    .then(() => {
      assert.strictEqual(escritos.filter((l) => l.includes('ATENÇÃO')).length, 1, 'o aviso não se repete na mesma rajada');
      // 5. Um registo bem-sucedido volta a deixar a auditoria saudável.
      falhar = false;
      return audit({ acao: 'criar_fracao' });
    })
    .then(() => {
      const e = estadoAuditoria();
      assert.strictEqual(e.saudavel, true, 'um sucesso repõe a saúde');
      assert.strictEqual(e.falhasSeguidas, 0, 'a contagem de falhas seguidas reinicia');
      assert.strictEqual(e.falhas, 4, 'o total histórico não é apagado');
      assert.strictEqual(registado.length, 5, 'todas as tentativas chegaram ao modelo');
    })
    .finally(repor);
}

testarLimite();
testarCSRF();
testarAuditoria()
  .then(() => {
    console.log('✓ Testes de segurança (rate limiting, CSRF e auditoria) passaram (sem rede).');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });