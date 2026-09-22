// ═══════════════════════════════════════════════════════════════════
// Estado SMTP para a interface — `helpers/mailer.obterEstadoSmtp()` (sem BD).
//
// Porque existe: o formulário «Configuração → Email / SMTP» tem de refletir o
// valor GUARDADO, e o contrato de que depende é este. O teste de configurações
// (`test-configuracoes.js`) SUBSTITUI o `obterEstadoSmtp` para poder correr o
// router; substituído o produtor, nada garante que ele devolva o campo. Aqui
// chama-se o mailer REAL, com a tabela `configuracoes` duplicada.
//
// O que se fixa (P50):
//
//   1. `tls` é devolvido como BOOLEANO — não apenas como a etiqueta
//      `seguranca`. Sem isto, o `<select name="tls">` da vista não tinha como
//      saber o valor guardado e ficava com uma opção fixa: gravar o formulário
//      (mesmo só para mudar a password) enviava `tls=true`, sobrepondo um
//      `smtp_tls='false'` guardado;
//   2. `seguranca` (a etiqueta mostrada) CONCORDA sempre com `tls`;
//   3. a password nunca sai no estado devolvido — só o indicador `temPassword`;
//   4. a BD tem prioridade sobre o `.env`, campo a campo, e a queda para o
//      `.env` funciona quando a tabela não responde.
//
// Utilização: node scripts/test-smtp-estado.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

// ── Duplo do modelo, instalado ANTES de carregar o mailer ──────────
function duplo(rel, valor) {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}

// Linhas da tabela `configuracoes` (chave-valor). `LANCAR` simula a BD em baixo.
let LINHAS = [];
let LANCAR = false;
const consultas = [];
duplo('models', {
  Configuracao: {
    findAll: async (opcoes) => {
      consultas.push(opcoes);
      if (LANCAR) throw new Error('BD indisponível (simulado)');
      return LINHAS.map((l) => ({ chave: l.chave, valor: l.valor }));
    },
  },
});

const mailer = require('../helpers/mailer');

let n = 0;
const feito = (nome) => { n += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// O ambiente não pode contaminar o teste: sem `SMTP_*` definidos, a queda para
// o `.env` é previsível. Guardam-se para repor no fim.
const envGuardado = {};
for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_TLS', 'SMTP_FROM', 'SMTP_FROM_NAME']) {
  envGuardado[k] = process.env[k];
  delete process.env[k];
}

const definido = (chave, valor) => {
  LINHAS = LINHAS.filter((l) => l.chave !== chave);
  LINHAS.push({ chave, valor });
};

async function main() {
  // ── 1. `tls` é BOOLEANO — a raiz de P50 ──────────────────────────
  titulo('obterEstadoSmtp — `tls` como booleano');
  LINHAS = [];
  definido('smtp_host', 'smtp.gmail.com');
  definido('smtp_port', '587');
  definido('smtp_user', 'condominio@gmail.com');
  definido('smtp_pass', 'segredo-de-app');
  definido('smtp_from', 'condominio@gmail.com');
  definido('smtp_from_name', 'Administração do Condomínio');

  definido('smtp_tls', 'true');
  let e = await mailer.obterEstadoSmtp();
  assert.strictEqual(typeof e.tls, 'boolean', 'P50: `tls` é devolvido como booleano (não string nem ausente)');
  assert.strictEqual(e.tls, true, 'P50: com smtp_tls=\'true\' guardado, tls é true');
  assert.strictEqual(e.seguranca, 'STARTTLS (587)', 'P50: a etiqueta concorda com o booleano (porta 587)');

  // O caso que originou o defeito: o TLS está DESLIGADO na BD. O formulário
  // tem de saber isso — senão assinalava «Usar TLS» e, ao gravar, religava-o.
  definido('smtp_tls', 'false');
  e = await mailer.obterEstadoSmtp();
  assert.strictEqual(e.tls, false, 'P50: com smtp_tls=\'false\' guardado, tls é false');
  assert.strictEqual(e.seguranca, 'Sem TLS', 'P50: a etiqueta concorda com o booleano desligado');
  feito('`tls` é booleano e concorda com a etiqueta `seguranca`, nos dois estados');

  // ── 2. A etiqueta distingue 587 (STARTTLS) de 465 (SSL/TLS direto) ──
  titulo('obterEstadoSmtp — porta distingue a modalidade');
  definido('smtp_tls', 'true');
  definido('smtp_port', '465');
  e = await mailer.obterEstadoSmtp();
  assert.strictEqual(e.tls, true, 'porta 465 com TLS: continua true');
  assert.strictEqual(e.seguranca, 'SSL/TLS (465)', 'porta 465 com TLS: etiqueta de SSL/TLS direto');
  definido('smtp_port', '587');
  feito('a etiqueta reflete a porta, sem alterar o booleano');

  // ── 3. A password nunca sai no estado ────────────────────────────
  titulo('obterEstadoSmtp — a password nunca é exposta');
  e = await mailer.obterEstadoSmtp();
  assert.strictEqual(e.temPassword, true, 'a password definida é sinalizada por indicador');
  const valores = Object.values(e).map((v) => String(v));
  assert.ok(!valores.includes('segredo-de-app'), 'P50: nenhum campo devolve a password guardada');
  assert.ok(!Object.prototype.hasOwnProperty.call(e, 'pass'), 'P50: não existe campo `pass` no estado');
  assert.ok(!JSON.stringify(e).includes('segredo-de-app'), 'P50: a password não aparece na serialização do estado');
  feito('indicador `temPassword` sem expor o segredo');

  // ── 4. `configurado` segue o host ────────────────────────────────
  titulo('obterEstadoSmtp — `configurado` segue o host');
  assert.strictEqual(e.configurado, true, 'com host guardado, está configurado');
  LINHAS = LINHAS.filter((l) => l.chave !== 'smtp_host');
  e = await mailer.obterEstadoSmtp();
  assert.strictEqual(e.configurado, false, 'sem host, não está configurado');
  assert.strictEqual(e.servidor, null, 'sem host, o servidor é null (a vista mostra «—»)');
  definido('smtp_host', 'smtp.gmail.com');
  feito('`configurado` reflete a presença do host');

  // ── 5. A BD tem prioridade; sem BD, cai no `.env` ────────────────
  titulo('obterEstadoSmtp — prioridade da BD e queda para o `.env`');
  // O `.env` diz uma coisa, a BD diz outra: ganha a BD (campo a campo).
  process.env.SMTP_TLS = 'true';
  process.env.SMTP_HOST = 'smtp.do.env';
  definido('smtp_tls', 'false');
  e = await mailer.obterEstadoSmtp();
  assert.strictEqual(e.tls, false, 'a BD ganha ao `.env` no campo tls');
  assert.strictEqual(e.servidor, 'smtp.gmail.com', 'a BD ganha ao `.env` no campo host');
  // Sem BD (erro simulado), a configuração vem do `.env`.
  LANCAR = true;
  e = await mailer.obterEstadoSmtp();
  LANCAR = false;
  assert.strictEqual(e.tls, true, 'sem BD, o `tls` vem do `.env` (SMTP_TLS=true)');
  assert.strictEqual(e.servidor, 'smtp.do.env', 'sem BD, o servidor vem do `.env`');
  assert.strictEqual(typeof e.tls, 'boolean', 'P50: a queda para o `.env` também devolve booleano');
  feito('prioridade da BD e queda para o `.env` — sempre com `tls` booleano');

  // A leitura à BD filtra pelas chaves `smtp_%` (não lê a tabela toda).
  assert.ok(consultas.length > 0, 'o estado é lido da tabela `configuracoes`');
  const filtro = consultas[0].where.chave;
  assert.ok(filtro && filtro[Object.getOwnPropertySymbols(filtro)[0]] === 'smtp_%',
    'a leitura restringe-se às chaves smtp_% (não lê configurações alheias)');
  feito('a leitura da BD é restrita às chaves `smtp_%`');

  console.log(`\n✓ Estado SMTP para a interface: ${n} verificações passaram (sem BD).`);
}

main()
  .catch((err) => {
    console.error('\n✗ ' + (err && err.message ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => {
    for (const [k, v] of Object.entries(envGuardado)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
