// ═══════════════════════════════════════════════════════════════════
// Segredos de autenticação em repouso (sem rede/BD)
//
// Cobre as duas frentes de P13/P14:
//
//   · P13 — os tokens de uso único (convite, reposição de palavra-passe) são
//     guardados como DIGEST SHA-256, nunca em claro, e o segredo TOTP do 2FA é
//     guardado CIFRADO (AES-256-GCM). Os valores antigos em texto simples
//     continuam a funcionar e são convertidos no momento em que são usados.
//
//   · P14 — a password SMTP é guardada CIFRADA em `configuracoes`, na mesma
//     proteção das credenciais de armazenamento, sem alterar o formulário nem
//     o contrato de `obterEstadoSmtp`.
//
// O que este teste fixa (e que uma regressão tem de fazer falhar):
//
//   1. `helpers/tokens` — digest determinístico; pesquisa por digest; aceitação
//      e conversão de tokens antigos; nada rebenta quando a conversão falha.
//   2. `models/User` — o getter/setter do TOTP, exercitado com um Sequelize
//      REAL (`User.build`), pelo que o que se prova é o comportamento que o
//      framework entrega — não apenas a presença do código.
//   3. `helpers/mailer` — gravar → guardar cifrado → ler → decifrar → a
//      password EM CLARO chega ao transporte SMTP (nodemailer duplicado).
//   4. Sem ENCRYPTION_KEY nada se cifra e nada se perde (sem regressão).
//
// Nenhum segredo real é usado e nenhuma chave é impressa.
// Utilização: node scripts/test-segredos-repouso.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

// ── Duplos de teste ─────────────────────────────────────────────────
function duplo(rel, valor) {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}

// `configuracoes` em memória (usada pelo mailer).
const loja = new Map();
duplo('models', {
  Configuracao: {
    findAll: async () =>
      [...loja.entries()].map(([chave, valor]) => ({ chave, valor })),
    findOrCreate: async ({ where, defaults }) => {
      if (!loja.has(where.chave)) loja.set(where.chave, defaults ? defaults.valor : null);
      const reg = {
        chave: where.chave,
        get valor() { return loja.get(where.chave); },
        set valor(v) { loja.set(where.chave, v); },
        save: async () => {},
      };
      return [reg, false];
    },
  },
});

// `nodemailer` duplicado: captura as opções do transporte para se poder provar
// qual password chega efetivamente ao servidor SMTP.
let transporteCapturado = null;
duplo('node_modules/nodemailer', {
  createTransport: (opcoes) => {
    transporteCapturado = opcoes;
    return {
      sendMail: async () => ({ messageId: 'teste@local', response: '250 OK' }),
      verify: async () => true,
    };
  },
});

const cifra = require('../helpers/armazenamento/cifra');
const segredos = require('../helpers/segredos');
const tokens = require('../helpers/tokens');
const mailer = require('../helpers/mailer');

const CHAVE_TESTE = crypto.randomBytes(32).toString('base64');
const CHAVE_OUTRA = crypto.randomBytes(32).toString('base64');
const SEGREDO_TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD_SMTP = 'password-de-app-secreta';

const envGuardado = {
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  ENCRYPTION_KEY_OLD: process.env.ENCRYPTION_KEY_OLD,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PASS: process.env.SMTP_PASS,
};

function comChave(chave) {
  if (chave) process.env.ENCRYPTION_KEY = chave;
  else delete process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY_OLD = '';
}

let n = 0;
const feito = (nome) => { n += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// ── 1. Digest dos tokens de uso único ───────────────────────────────
function testarDigest() {
  titulo('helpers/tokens — digest');

  const d = tokens.digest('abc');
  assert.strictEqual(d, crypto.createHash('sha256').update('abc').digest('hex'), '1.1 SHA-256 em hexadecimal');
  assert.strictEqual(d.length, 64, '1.2 digest com 64 caracteres (cabe em STRING(255))');
  assert.ok(tokens.ehDigest(d), '1.3 reconhecido como digest');
  assert.strictEqual(tokens.digest('abc'), d, '1.4 determinístico (o mesmo token dá o mesmo digest)');
  assert.notStrictEqual(tokens.digest('abd'), d, '1.5 tokens diferentes → digests diferentes');
  assert.strictEqual(tokens.digest('abc').includes('abc'), false, '1.6 o digest não contém o token');
  assert.ok(!tokens.ehDigest('ABC'), '1.7 hexadecimal maiúsculo não é o formato gravado');
  assert.ok(!tokens.ehDigest('curto'), '1.8 valor curto não é digest');
  feito('digest determinístico, 64 hex minúsculos, sem o token');
}

// ── 2. Pesquisa por token (com conversão dos antigos) ───────────────
async function testarPesquisaPorToken() {
  titulo('helpers/tokens — pesquisa e conversão dos tokens antigos');

  const TEXTO = 'a'.repeat(48);           // token de convite (48 hex)
  const RESET = 'b'.repeat(64);           // token de reposição (64 hex)
  const utilizadores = [];
  const consultas = [];

  const User = {
    findOne: async ({ where }) => {
      consultas.push(where);
      const [campo, valor] = Object.entries(where)[0];
      return utilizadores.find((u) => u[campo] === valor) || null;
    },
  };
  const novo = (dados) => ({
    ...dados,
    atualizacoes: [],
    async update(v) { Object.assign(this, v); this.atualizacoes.push(v); return this; },
  });

  // 2.1 Token já guardado como digest → encontrado, sem reescrever nada.
  const comDigest = novo({ id: 1, convite_token: tokens.digest(TEXTO) });
  utilizadores.push(comDigest);
  const r1 = await tokens.utilizadorPorToken(User, 'convite_token', TEXTO);
  assert.strictEqual(r1, comDigest, '2.1 token em digest é encontrado');
  assert.strictEqual(comDigest.atualizacoes.length, 0, '2.1 nada é reescrito quando já está em digest');
  assert.strictEqual(consultas[0].convite_token, tokens.digest(TEXTO), '2.1 a consulta usa o DIGEST, não o token');

  // 2.2 Token antigo em texto simples → encontrado e CONVERTIDO.
  utilizadores.length = 0;
  consultas.length = 0;
  const legado = novo({ id: 2, convite_token: TEXTO });
  utilizadores.push(legado);
  const r2 = await tokens.utilizadorPorToken(User, 'convite_token', TEXTO);
  assert.strictEqual(r2, legado, '2.2 token antigo continua a ser aceite');
  assert.strictEqual(legado.convite_token, tokens.digest(TEXTO), '2.2 convertido para digest');
  assert.ok(!legado.convite_token.includes(TEXTO), '2.2 o token em claro desapareceu do registo');
  assert.strictEqual(legado.atualizacoes.length, 1, '2.2 conversão feita uma única vez');

  // 2.3 Depois da conversão, a pesquisa encontra pelo digest (sem nova escrita).
  const r3 = await tokens.utilizadorPorToken(User, 'convite_token', TEXTO);
  assert.strictEqual(r3, legado, '2.3 continua a ser encontrado');
  assert.strictEqual(legado.atualizacoes.length, 1, '2.3 conversão idempotente');

  // 2.4 O mesmo vale para o token de reposição de palavra-passe.
  utilizadores.length = 0;
  const resetLegado = novo({ id: 3, reset_token: RESET });
  utilizadores.push(resetLegado);
  const r4 = await tokens.utilizadorPorToken(User, 'reset_token', RESET);
  assert.strictEqual(r4, resetLegado, '2.4 token de reposição antigo é aceite');
  assert.strictEqual(resetLegado.reset_token, tokens.digest(RESET), '2.4 token de reposição convertido');

  // 2.5 Token desconhecido → null (nunca devolve um registo alheio).
  utilizadores.length = 0;
  utilizadores.push(novo({ id: 4, convite_token: tokens.digest('outro') }));
  assert.strictEqual(await tokens.utilizadorPorToken(User, 'convite_token', TEXTO), null, '2.5 token desconhecido → null');

  // 2.6 Token vazio não consulta a BD.
  consultas.length = 0;
  assert.strictEqual(await tokens.utilizadorPorToken(User, 'convite_token', ''), null, '2.6 token vazio → null');
  assert.strictEqual(await tokens.utilizadorPorToken(User, 'convite_token', undefined), null, '2.6 token ausente → null');
  assert.strictEqual(consultas.length, 0, '2.6 sem token não há consulta');

  // 2.7 Se a conversão falhar, o fluxo NÃO rebenta e o token continua válido.
  utilizadores.length = 0;
  const falhaConversao = {
    id: 5,
    convite_token: TEXTO,
    atualizacoes: [],
    async update() { throw new Error('BD indisponível (simulado)'); },
  };
  utilizadores.push(falhaConversao);
  const r5 = await tokens.utilizadorPorToken(User, 'convite_token', TEXTO);
  assert.strictEqual(r5, falhaConversao, '2.7 falha na conversão não invalida o token');
  assert.strictEqual(falhaConversao.convite_token, TEXTO, '2.7 valor mantém-se utilizável até nova tentativa');

  feito('pesquisa por digest, conversão transparente e tolerância a falhas');
}

// ── 3. Segredo TOTP no modelo User (Sequelize real) ─────────────────
function testarTotpNoModelo() {
  titulo('models/User — segredo TOTP cifrado, acesso transparente');

  const { Sequelize } = require('sequelize');
  // Instância real, sem ligação: `define`/`build` são operações em memória.
  const seq = new Sequelize('bd', 'utilizador', 'password', { dialect: 'mysql', logging: false });
  const User = require('../models/User')(seq);

  comChave(CHAVE_TESTE);
  const u = User.build({ nome: 'Teste', email: 'teste@exemplo.pt', two_fa_totp_secret: SEGREDO_TOTP });

  // 3.1 O acesso devolve SEMPRE o segredo em claro (é o que o 2FA verifica).
  assert.strictEqual(u.two_fa_totp_secret, SEGREDO_TOTP, '3.1 leitura devolve o segredo em claro');

  // 3.2 O que fica para gravação está cifrado e não contém o segredo.
  const bruto = u.getDataValue('two_fa_totp_secret');
  assert.ok(cifra.estaCifrado(bruto), '3.2 o valor guardado está no formato cifrado');
  assert.ok(!bruto.includes(SEGREDO_TOTP), '3.2 o valor guardado não contém o segredo');
  assert.ok(bruto.length <= 255, '3.2 cabe na coluna STRING(255)');

  // 3.3 O segredo é recuperável (o TOTP continua a poder ser verificado).
  assert.strictEqual(segredos.lerTotp(bruto).valor, SEGREDO_TOTP, '3.3 segredo recuperável a partir do valor guardado');

  // 3.4 Duas escritas do mesmo segredo → valores guardados diferentes (IV novo).
  const v2 = User.build({ nome: 'Teste', email: 't2@exemplo.pt', two_fa_totp_secret: SEGREDO_TOTP });
  assert.notStrictEqual(v2.getDataValue('two_fa_totp_secret'), bruto, '3.4 nonce aleatório por escrita');
  assert.strictEqual(v2.two_fa_totp_secret, SEGREDO_TOTP, '3.4 ambos decifram para o mesmo segredo');

  // 3.5 Valor antigo em texto simples continua a ser lido (sem regressão).
  const antigo = User.build({ nome: 'Teste', email: 't3@exemplo.pt' });
  antigo.setDataValue('two_fa_totp_secret', SEGREDO_TOTP);
  assert.strictEqual(antigo.two_fa_totp_secret, SEGREDO_TOTP, '3.5 texto simples antigo é lido como está');

  // 3.6 Desativar o 2FA escreve null (não cifra a ausência de segredo).
  const desativado = User.build({ nome: 'Teste', email: 't4@exemplo.pt', two_fa_totp_secret: null });
  assert.strictEqual(desativado.getDataValue('two_fa_totp_secret'), null, '3.6 null mantém-se null');
  assert.strictEqual(desativado.two_fa_totp_secret, null, '3.6 leitura de null é null');

  // 3.7 Segredo ilegível (chave diferente) nunca é devolvido às cegas.
  comChave(CHAVE_OUTRA);
  const ilegivel = User.build({ nome: 'Teste', email: 't5@exemplo.pt' });
  ilegivel.setDataValue('two_fa_totp_secret', bruto);
  assert.strictEqual(ilegivel.two_fa_totp_secret, null, '3.7 chave diferente → não devolve lixo (2FA falha fechado)');
  comChave(CHAVE_TESTE);

  feito('TOTP guardado cifrado e lido em claro, pelo próprio modelo');
}

// ── 4. Password SMTP cifrada em repouso ─────────────────────────────
async function testarPasswordSmtp() {
  titulo('helpers/mailer — password SMTP cifrada em repouso');

  // Ambiente limpo: sem SMTP_* do processo, o `.env` não interfere.
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PASS;
  loja.clear();
  mailer.limparCache();

  // 4.1 SEM chave: comportamento anterior, sem regressão (texto simples).
  comChave(null);
  await mailer.guardarConfigSmtp({
    host: 'smtp.exemplo.pt',
    user: 'conta@exemplo.pt',
    from: 'a@exemplo.pt',
    pass: PASSWORD_SMTP,
  });
  assert.strictEqual(loja.get('smtp_pass'), PASSWORD_SMTP, '4.1 sem chave guarda em texto simples (sem regressão)');
  let estado = await mailer.obterEstadoSmtp();
  assert.strictEqual(estado.temPassword, true, '4.1 a password continua a ser detetada');
  assert.ok(!Object.values(estado).map(String).includes(PASSWORD_SMTP), '4.1 a password nunca sai no estado');

  // 4.2 COM chave: a leitura migra o valor antigo para cifrado, sem o perder.
  comChave(CHAVE_TESTE);
  mailer.limparCache();
  estado = await mailer.obterEstadoSmtp();
  assert.strictEqual(estado.temPassword, true, '4.2 a password sobrevive à migração');
  const migrado = loja.get('smtp_pass');
  assert.ok(cifra.estaCifrado(migrado), '4.2 o valor em repouso passou a estar cifrado');
  assert.ok(!migrado.includes(PASSWORD_SMTP), '4.2 o texto simples desapareceu da BD');
  assert.strictEqual(segredos.lerPasswordSmtp(migrado).valor, PASSWORD_SMTP, '4.2 conteúdo preservado');

  // 4.3 Gravar com chave → fica cifrado (e o formulário não muda).
  await mailer.guardarConfigSmtp({ pass: 'password-nova-do-admin' });
  const guardado = loja.get('smtp_pass');
  assert.ok(cifra.estaCifrado(guardado), '4.3 gravação cifrada');
  assert.ok(!guardado.includes('password-nova-do-admin'), '4.3 a BD não contém a password em claro');

  // 4.4 Prova ponta a ponta: a password EM CLARO chega ao transporte SMTP.
  transporteCapturado = null;
  const envio = await mailer.sendMail({ to: 'dest@exemplo.pt', subject: 'Assunto', text: 'Corpo' });
  assert.strictEqual(envio.enviado, true, '4.4 o envio é aceite pelo transporte');
  assert.ok(transporteCapturado, '4.4 o transporte foi construído');
  assert.strictEqual(transporteCapturado.auth.pass, 'password-nova-do-admin', '4.4 a password decifrada chega ao SMTP');
  assert.strictEqual(transporteCapturado.host, 'smtp.exemplo.pt', '4.4 o host guardado é respeitado');

  // 4.5 Chave diferente → a password guardada não é usada às cegas.
  comChave(CHAVE_OUTRA);
  mailer.limparCache();
  process.env.SMTP_PASS = 'password-do-env';
  estado = await mailer.obterEstadoSmtp();
  assert.strictEqual(estado.temPassword, true, '4.5 a queda para o `.env` mantém o envio a funcionar');
  transporteCapturado = null;
  await mailer.sendMail({ to: 'dest@exemplo.pt', subject: 'Assunto', text: 'Corpo' });
  assert.strictEqual(transporteCapturado.auth.pass, 'password-do-env', '4.5 valor ilegível → usa-se o `.env`, nunca o ciphertext');
  assert.notStrictEqual(transporteCapturado.auth.pass, guardado, '4.5 o ciphertext nunca é usado como password');

  delete process.env.SMTP_PASS;
  comChave(CHAVE_TESTE);
  mailer.limparCache();

  // 4.6 Sem chave e sem password → não há password (indicador coerente).
  loja.delete('smtp_pass');
  comChave(null);
  mailer.limparCache();
  estado = await mailer.obterEstadoSmtp();
  assert.strictEqual(estado.temPassword, false, '4.6 sem password guardada o indicador é false');

  feito('password SMTP cifrada em repouso, decifrada no envio, sem regressão sem chave');
}

// ── 5. Sem chave nada se perde (degradação controlada) ──────────────
function testarDegradacao() {
  titulo('helpers/segredos — degradação sem chave');

  comChave(null);
  assert.strictEqual(segredos.cifraDisponivel(), false, '5.1 sem chave, a cifra não está disponível');

  const valor = segredos.protegerTotp(SEGREDO_TOTP);
  assert.strictEqual(valor, SEGREDO_TOTP, '5.2 sem chave guarda em texto simples (sem regressão)');

  const lido = segredos.lerTotp(SEGREDO_TOTP);
  assert.strictEqual(lido.valor, SEGREDO_TOTP, '5.3 sem chave lê o texto simples');
  assert.strictEqual(lido.precisaMigrar, false, '5.3 sem chave não há nada a migrar');

  comChave(CHAVE_TESTE);
  const lidoComChave = segredos.lerTotp(SEGREDO_TOTP);
  assert.strictEqual(lidoComChave.valor, SEGREDO_TOTP, '5.4 com chave, o valor antigo continua legível');
  assert.strictEqual(lidoComChave.precisaMigrar, true, '5.4 com chave, o valor antigo é assinalado para migração');

  // Contextos separados: um segredo copiado de outro campo não decifra.
  const doTotp = segredos.protegerTotp(SEGREDO_TOTP);
  const comoSmtp = segredos.lerPasswordSmtp(doTotp);
  assert.strictEqual(comoSmtp.valor, null, '5.5 segredo de outro campo não decifra (AAD)');
  assert.ok(comoSmtp.erro, '5.5 a falha é assinalada, não silenciada');

  assert.strictEqual(segredos.protegerTotp(null), null, '5.6 null mantém-se null');
  assert.strictEqual(segredos.protegerTotp(''), '', '5.7 vazio mantém-se vazio');
  assert.throws(() => segredos.proteger('x', 'contexto-inventado'), /Contexto de segredo desconhecido/, '5.8 contexto desconhecido é recusado');

  const e = segredos.estado();
  assert.strictEqual(e.cifra, true, '5.9 estado indica a cifra disponível');
  assert.ok(!JSON.stringify(e).includes(CHAVE_TESTE), '5.10 o estado nunca expõe a chave');
  assert.ok(!JSON.stringify(e).includes(SEGREDO_TOTP), '5.10 o estado nunca expõe segredos');

  feito('degradação sem chave e isolamento por contexto');
}

// ── 6. Os fluxos reais deixaram de gravar tokens em claro ───────────
function testarFluxosReais() {
  titulo('rotas — a gravação passa pelo digest');

  const auth = fs.readFileSync(path.join(RAIZ, 'routes', 'auth.js'), 'utf8');
  const admin = fs.readFileSync(path.join(RAIZ, 'routes', 'admin.js'), 'utf8');

  // 6.1 Nenhuma pesquisa por token em claro.
  assert.ok(!/where:\s*\{\s*reset_token:/.test(auth), '6.1 auth.js não pesquisa reset_token em claro');
  assert.ok(!/where:\s*\{\s*convite_token:/.test(auth), '6.1 auth.js não pesquisa convite_token em claro');

  // 6.2 Toda a atribuição a essas colunas recebe um DIGEST (ou null) — nunca o
  // token. Verifica-se a EXPRESSÃO atribuída, e não a mera presença da palavra.
  const soDigestOuNull = (fonte, campo) => {
    const exprs = [...fonte.matchAll(new RegExp(`${campo}:\\s*([^,\\n]+)`, 'g'))].map((m) => m[1].trim());
    assert.ok(exprs.length > 0, `6.2 ${campo}: há pelo menos uma atribuição`);
    for (const expr of exprs) {
      assert.ok(
        /tokens\.digest\(/.test(expr) || expr === 'null',
        `6.2 ${campo} só recebe digest ou null (obtido: ${expr})`
      );
    }
    return exprs;
  };
  soDigestOuNull(admin, 'convite_token');
  soDigestOuNull(auth, 'reset_token');

  // 6.3 A leitura passa pelo helper (aceita o digest e converte o legado).
  assert.ok(/tokens\.utilizadorPorToken\(User, 'convite_token'/.test(auth), '6.3 convite lido pelo digest');
  assert.ok(/tokens\.utilizadorPorToken\(User, 'reset_token'/.test(auth), '6.3 reposição lida pelo digest');

  // 6.4 O 2FA continua a verificar com o mesmo código (o modelo é transparente).
  assert.ok(/doisFatores\.verificarTOTP\(user\.two_fa_totp_secret, codigo\)/.test(auth), '6.4 verificação TOTP inalterada');

  feito('nenhum ponto dos fluxos reais grava ou procura tokens em claro');
}

(async () => {
  try {
    testarDigest();
    await testarPesquisaPorToken();
    testarTotpNoModelo();
    await testarPasswordSmtp();
    testarDegradacao();
    testarFluxosReais();
    console.log(`\n✓ Segredos de autenticação em repouso: ${n} verificações passaram (sem rede/BD).`);
  } finally {
    for (const [k, v] of Object.entries(envGuardado)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
})().catch((err) => {
  console.error('\n✗ ' + (err && err.message ? err.message : err));
  if (err && err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
