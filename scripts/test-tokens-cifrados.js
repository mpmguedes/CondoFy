// ═══════════════════════════════════════════════════════════════════
// Cifragem das credenciais de armazenamento (sem rede/BD)
//
// Verifica que os tokens OAuth (Google Drive, Dropbox, OneDrive) são
// guardados CIFRADOS em `configuracoes`, com migração transparente dos valores
// antigos em texto simples, isolamento por condomínio/plataforma e
// comportamento seguro quando falta a chave da instalação.
//
// Nenhuma credencial real é usada: a "base de dados" é uma loja em memória e a
// chave de teste é gerada aleatoriamente em cada execução.
// Utilização: node scripts/test-tokens-cifrados.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const crypto = require('crypto');

// ── Duplos de teste: BD e configurações em memória ──────────────────
const loja = new Map();
// Reproduz as linhas de `configuracoes` a partir da loja em memória (para a
// inicialização e a migração poderem percorrer as chaves reais).
function linhasDaLoja(filtro = null) {
  const like = filtro && filtro.where && filtro.where.chave && filtro.where.chave.like;
  const prefixo = like ? String(like).replace(/%/g, '') : null;
  return [...loja.entries()]
    .filter(([chave]) => !prefixo || chave.startsWith(prefixo))
    .map(([chave, valor]) => ({
      chave,
      valor,
      update: async ({ valor: novo }) => { loja.set(chave, novo); return { chave, valor: novo }; },
    }));
}

const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: {
    Configuracao: {
      findAll: async (opcoes) => linhasDaLoja(opcoes),
      findOne: async ({ where }) => (loja.has(where.chave) ? { chave: where.chave, valor: loja.get(where.chave) } : null),
      findOrCreate: async () => [{ valor: null, save: async () => {} }],
    },
    Condominio: { findByPk: async () => null, findOne: async () => null, update: async () => {} },
    Documento: { findOne: async () => null },
  },
};

const configPath = require.resolve('../helpers/config');
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true, children: [], paths: [],
  exports: {
    getConfig: async (chave, defeito = null) => (loja.has(chave) ? loja.get(chave) : defeito),
    setConfig: async (chave, valor) => { loja.set(chave, valor); return { chave, valor }; },
  },
};

const cifra = require('../helpers/armazenamento/cifra');
const ligacoes = require('../helpers/armazenamento/ligacoes');

const CHAVE_TESTE = crypto.randomBytes(32).toString('base64');
const CHAVE_TESTE_2 = crypto.randomBytes(32).toString('base64');
const TOKEN_EXEMPLO = { access_token: 'access-abc', refresh_token: 'refresh-xyz', expiry_date: 1893456000000, conta: 'conta@exemplo.pt' };
const CHAVE_COND_1 = ligacoes.chaveTokens('dropbox', 1);
const CHAVE_PLATAFORMA = ligacoes.chaveTokensPlataforma('dropbox');

function comChave(chave) {
  if (chave) process.env.ENCRYPTION_KEY = chave;
  else delete process.env.ENCRYPTION_KEY;
}

function reiniciar() {
  loja.clear();
  ligacoes.limparCache();
}

// ── 1-4. Cifra/decifra e autenticação ───────────────────────────────
function testarCifra() {
  comChave(CHAVE_TESTE);
  process.env.ENCRYPTION_KEY_OLD = '';

  // 1. Cifrar
  const valor = JSON.stringify(TOKEN_EXEMPLO);
  const c1 = cifra.cifrar(valor, { contexto: CHAVE_COND_1 });
  assert.ok(cifra.estaCifrado(c1), '1. valor cifrado no formato versionado');
  assert.ok(c1.startsWith('enc:v1:'), '1. formato enc:v1:<kid>:<iv>:<tag>:<ct>');
  assert.strictEqual(c1.split(':').length, 6, '1. formato com 6 segmentos');
  assert.ok(!c1.includes('access-abc') && !c1.includes('refresh-xyz'), '1. ciphertext não contém o token');
  assert.ok(!valor.split('').every((ch) => c1.includes(ch)), '1. ciphertext ilegível');

  // 2. Decifrar devolve exatamente o original
  const d = cifra.decifrar(c1, { contexto: CHAVE_COND_1 });
  assert.strictEqual(d.ok, true, '2. decifra sem erro');
  assert.strictEqual(d.texto, valor, '2. valor original exato');
  assert.strictEqual(d.cifrado, true, '2. assinalado como cifrado');

  // 3. Dois valores iguais → ciphertexts diferentes (IV/nonce novo por valor)
  const c2 = cifra.cifrar(valor, { contexto: CHAVE_COND_1 });
  assert.notStrictEqual(c1, c2, '3. nonce aleatório por cifragem');
  const iv1 = c1.split(':')[3];
  const iv2 = c2.split(':')[3];
  assert.notStrictEqual(iv1, iv2, '3. IV diferente');
  assert.strictEqual(cifra.decifrar(c2, { contexto: CHAVE_COND_1 }).texto, valor, '3. ambos decifram');

  // 4. Alterar o ciphertext → falha de autenticação (GCM)
  const partes = c1.split(':');
  const ctAlterado = Buffer.from(partes[5], 'base64url');
  ctAlterado[0] = ctAlterado[0] ^ 0xff;
  const adulterado = [partes[0], partes[1], partes[2], partes[3], partes[4], ctAlterado.toString('base64url')].join(':');
  assert.throws(() => cifra.decifrar(adulterado, { contexto: CHAVE_COND_1 }), /decifrar as credenciais/i, '4. ciphertext alterado → falha');

  const tagAlterada = partes.slice();
  const tag = Buffer.from(partes[4], 'base64url');
  tag[0] = tag[0] ^ 0xff;
  tagAlterada[4] = tag.toString('base64url');
  assert.throws(() => cifra.decifrar(tagAlterada.join(':'), { contexto: CHAVE_COND_1 }), /decifrar as credenciais/i, '4. tag alterada → falha');

  // AAD: o mesmo valor noutro contexto (outro condomínio) não decifra.
  assert.throws(
    () => cifra.decifrar(c1, { contexto: ligacoes.chaveTokens('dropbox', 2) }),
    /decifrar as credenciais/i,
    '4. token copiado para outro condomínio não decifra (AAD)'
  );

  // Chave errada → falha de autenticação (não devolve lixo).
  comChave(CHAVE_TESTE_2);
  assert.throws(() => cifra.decifrar(c1, { contexto: CHAVE_COND_1 }), /decifrar as credenciais/i, '4. chave errada → falha');
  comChave(CHAVE_TESTE);
}

// ── 5-6. Migração transparente dos valores antigos ──────────────────
async function testarMigracao() {
  comChave(CHAVE_TESTE);
  reiniciar();

  // 5. Valor antigo em texto simples é reconhecido (não rebenta).
  loja.set(CHAVE_COND_1, JSON.stringify(TOKEN_EXEMPLO));
  const d = cifra.decifrar(loja.get(CHAVE_COND_1), { contexto: CHAVE_COND_1 });
  assert.strictEqual(d.cifrado, false, '5. reconhecido como texto simples');
  assert.strictEqual(d.formato, 'texto-simples', '5. formato assinalado');
  assert.deepStrictEqual(JSON.parse(d.texto), TOKEN_EXEMPLO, '5. conteúdo ainda legível');

  // 6. Ao ler pela camada de ligações, é migrado automaticamente.
  const r = await ligacoes.lerTokens('dropbox', 1);
  assert.strictEqual(r.tokens.refresh_token, 'refresh-xyz', '6. tokens lidos corretamente');
  assert.strictEqual(r.origem, 'condominio', '6. origem do condomínio');
  const guardado = loja.get(CHAVE_COND_1);
  assert.ok(cifra.estaCifrado(guardado), '6. valor na BD passou a estar cifrado');
  assert.ok(!guardado.includes('refresh-xyz'), '6. a BD deixou de conter o token em texto simples');
  assert.deepStrictEqual(cifra.decifrar(guardado, { contexto: CHAVE_COND_1 }).texto && JSON.parse(cifra.decifrar(guardado, { contexto: CHAVE_COND_1 }).texto), TOKEN_EXEMPLO, '6. conteúdo preservado');

  // 6.1 A migração não perde o refresh_token nem altera o que a app usa.
  await ligacoes.guardarTokens('dropbox', 1, { access_token: 'novo-access' });
  const depois = await ligacoes.lerTokens('dropbox', 1);
  assert.strictEqual(depois.tokens.refresh_token, 'refresh-xyz', '6.1 refresh_token preservado na gravação');
  assert.strictEqual(depois.tokens.access_token, 'novo-access', '6.1 access_token atualizado');
  assert.ok(cifra.estaCifrado(loja.get(CHAVE_COND_1)), '6.1 gravação continua cifrada');

  // 6.2 Migração de um só valor (helper usado pela migração explícita).
  loja.set(CHAVE_PLATAFORMA, JSON.stringify({ refresh_token: 'plataforma-legado' }));
  const m = await ligacoes.migrarSeNecessario(CHAVE_PLATAFORMA, loja.get(CHAVE_PLATAFORMA));
  assert.strictEqual(m.alterado, true, '6.2 migração assinalada');
  assert.ok(cifra.estaCifrado(loja.get(CHAVE_PLATAFORMA)), '6.2 valor de plataforma cifrado');
  assert.strictEqual(cifra.decifrar(loja.get(CHAVE_PLATAFORMA), { contexto: CHAVE_PLATAFORMA }).texto, JSON.stringify({ refresh_token: 'plataforma-legado' }), '6.2 conteúdo preservado');
  const m2 = await ligacoes.migrarSeNecessario(CHAVE_PLATAFORMA, loja.get(CHAVE_PLATAFORMA));
  assert.strictEqual(m2.alterado, false, '6.2 migração é idempotente');

  // 7. OAuth continua a funcionar pela camada existente: gravar → ler → cache.
  const gravados = await ligacoes.guardarTokens('dropbox', 1, { refresh_token: 'r-oauth', conta: 'a@x.pt' });
  assert.strictEqual(gravados.conta, 'a@x.pt', '7. conta guardada');
  assert.ok(cifra.estaCifrado(loja.get(CHAVE_COND_1)), '7. credenciais OAuth cifradas');
  const lidos = await ligacoes.lerTokens('dropbox', 1);
  assert.deepStrictEqual(lidos.tokens, gravados, '7. leitura devolve exatamente o que foi gravado');
  assert.deepStrictEqual(ligacoes.tokensSync('dropbox', 1).tokens, gravados, '7. cache síncrona com os mesmos tokens');
}

// ── 8-9. Isolamento de condomínios e da plataforma ──────────────────
async function testarIsolamento() {
  comChave(CHAVE_TESTE);
  reiniciar();

  await ligacoes.guardarTokens('dropbox', 1, { refresh_token: 'tok-c1' });
  await ligacoes.guardarTokens('dropbox', 2, { refresh_token: 'tok-c2' });
  await ligacoes.guardarTokens('dropbox', null, { refresh_token: 'tok-plataforma' });

  // 8. Cada condomínio lê apenas o seu token.
  assert.strictEqual((await ligacoes.lerTokens('dropbox', 1)).tokens.refresh_token, 'tok-c1', '8. condomínio 1');
  assert.strictEqual((await ligacoes.lerTokens('dropbox', 2)).tokens.refresh_token, 'tok-c2', '8. condomínio 2');
  assert.strictEqual((await ligacoes.lerTokens('dropbox', 3)).tokens, null, '8. condomínio sem ligação não herda token');

  // 9. Plataforma separada dos condomínios (e usada só quando pedida).
  assert.strictEqual((await ligacoes.lerTokens('dropbox', null, { plataforma: true })).tokens.refresh_token, 'tok-plataforma', '9. tokens de plataforma');
  assert.notStrictEqual(
    (await ligacoes.lerTokens('dropbox', 1)).tokens.refresh_token,
    (await ligacoes.lerTokens('dropbox', null, { plataforma: true })).tokens.refresh_token,
    '9. plataforma ≠ condomínio'
  );

  // 8.1 Copiar o valor cifrado de um condomínio para outro não dá acesso.
  loja.set(ligacoes.chaveTokens('dropbox', 4), loja.get(ligacoes.chaveTokens('dropbox', 1)));
  const copiado = await ligacoes.lerTokens('dropbox', 4);
  assert.strictEqual(copiado.tokens, null, '8.1 token copiado para outro condomínio não é utilizável');
  assert.ok(ligacoes.estadoCifra().erroOperacional, '8.1 falha registada para o administrador');

  // 8.2 Cada valor na BD está cifrado e é diferente (mesmo com tokens iguais).
  await ligacoes.guardarTokens('dropbox', 5, { refresh_token: 'igual' });
  await ligacoes.guardarTokens('dropbox', 6, { refresh_token: 'igual' });
  const v5 = loja.get(ligacoes.chaveTokens('dropbox', 5));
  const v6 = loja.get(ligacoes.chaveTokens('dropbox', 6));
  assert.ok(cifra.estaCifrado(v5) && cifra.estaCifrado(v6), '8.2 ambos cifrados');
  assert.notStrictEqual(v5, v6, '8.2 ciphertexts diferentes para o mesmo conteúdo');
}

// ── 10. Sem chave: comportamento seguro ─────────────────────────────
async function testarSemChave() {
  reiniciar();
  comChave(CHAVE_TESTE);
  await ligacoes.guardarTokens('dropbox', 7, { refresh_token: 'segredo-cifrado' });
  const valorCifrado = loja.get(ligacoes.chaveTokens('dropbox', 7));

  // Remove a chave (simula instalação sem ENCRYPTION_KEY).
  comChave(null);
  ligacoes.limparCache();

  // 10.1 Não é possível guardar: falha com mensagem administrativa.
  await assert.rejects(
    () => ligacoes.guardarTokens('dropbox', 7, { refresh_token: 'novo' }),
    (err) => {
      assert.strictEqual(err.codigo, 'sem_chave', '10.1 código de erro próprio');
      assert.ok(/ENCRYPTION_KEY/.test(err.message), '10.1 mensagem indica a chave');
      assert.ok(!/segredo|token|refresh/i.test(err.message), '10.1 mensagem sem segredos');
      return true;
    },
    '10.1 sem chave não se guarda nada'
  );

  // 10.2 Não é possível usar um valor cifrado (não aparece texto simples).
  const lido = await ligacoes.lerTokens('dropbox', 7);
  assert.strictEqual(lido.tokens, null, '10.2 sem chave não devolve tokens');
  assert.strictEqual(ligacoes.tokensSync('dropbox', 7).tokens, null, '10.2 cache sem tokens');
  assert.strictEqual(loja.get(ligacoes.chaveTokens('dropbox', 7)), valorCifrado, '10.2 valor na BD não foi alterado');

  // 10.3 Um valor antigo em texto simples também não é usado sem chave.
  loja.set(CHAVE_PLATAFORMA, JSON.stringify({ refresh_token: 'plataforma-texto-simples' }));
  const lidoPlataforma = await ligacoes.lerTokens('dropbox', null, { plataforma: true });
  assert.strictEqual(lidoPlataforma.tokens, null, '10.3 texto simples não é usado sem chave');
  assert.strictEqual(loja.get(CHAVE_PLATAFORMA), JSON.stringify({ refresh_token: 'plataforma-texto-simples' }), '10.3 nada foi cifrado sem chave');

  // 10.4 O estado para a interface explica o problema (mensagem administrativa).
  const estado = ligacoes.estadoCifra();
  assert.strictEqual(estado.configurada, false, '10.4 chave não configurada');
  assert.ok(/ENCRYPTION_KEY/.test(estado.mensagem), '10.4 mensagem administrativa');

  // 10.5 Chave inválida (entropia insuficiente) é recusada.
  comChave('chave-curta');
  const estadoInvalido = cifra.estado();
  assert.strictEqual(estadoInvalido.configurada, false, '10.5 chave inválida recusada');
  assert.ok(/32 bytes/.test(estadoInvalido.erro || ''), '10.5 explica o requisito de 32 bytes');
  assert.throws(() => cifra.cifrar('x', { contexto: 'k' }), /32 bytes/, '10.5 não cifra com chave inválida');

  comChave(CHAVE_TESTE);
}

// ── 11-12. BD sem texto simples, sem exposição ──────────────────────
async function testarSemExposicao() {
  comChave(CHAVE_TESTE);
  reiniciar();

  // Dados realistas em texto simples (simula instalação antes da migração).
  const tokensDrive = { refresh_token: 'drive-refresh-secreto', access_token: 'drive-access-secreto', conta: 'drive@exemplo.pt' };
  const tokensOneDrive = { refresh_token: 'od-refresh-secreto', conta: 'od@exemplo.pt' };
  loja.set(CHAVE_TOKENS_LEGADO_PARA_TESTE(), JSON.stringify(tokensDrive)); // plataforma Drive (chave histórica)
  loja.set(ligacoes.chaveTokens('onedrive', 9), JSON.stringify(tokensOneDrive));
  loja.set(ligacoes.chaveTokens('dropbox', 9), JSON.stringify({ refresh_token: 'dbx-secreto' }));

  // 11. Depois de inicializar, nada fica em texto simples.
  await ligacoes.inicializar();
  for (const chave of [CHAVE_TOKENS_LEGADO_PARA_TESTE(), ligacoes.chaveTokens('onedrive', 9), ligacoes.chaveTokens('dropbox', 9)]) {
    const v = loja.get(chave);
    assert.ok(cifra.estaCifrado(v), `11. ${chave} está cifrado`);
    assert.ok(!/secreto/.test(v), `11. ${chave} não contém o token em claro`);
  }
  // E continuam a poder ser usados normalmente (ligação preservada).
  assert.strictEqual((await ligacoes.lerTokens('onedrive', 9)).tokens.refresh_token, 'od-refresh-secreto', '11. ligação preservada após migração');
  assert.strictEqual((await ligacoes.lerTokens('google_drive', null, { plataforma: true })).tokens.refresh_token, 'drive-refresh-secreto', '11. ligação de plataforma preservada');

  // 12. Nada do que é devolvido/registado expõe tokens ou a chave.
  const resumo = ligacoes.resumo();
  const texto = JSON.stringify(resumo);
  assert.ok(!/secreto/.test(texto), '12. resumo sem tokens');
  assert.ok(!texto.includes(CHAVE_TESTE), '12. resumo sem a chave');
  assert.ok(!texto.includes('enc:v1:'), '12. resumo sem ciphertexts');

  const estado = ligacoes.estadoCifra();
  const estadoTxt = JSON.stringify(estado);
  assert.ok(!/secreto/.test(estadoTxt) && !estadoTxt.includes(CHAVE_TESTE), '12. estado sem segredos');
  assert.strictEqual(estado.kid.length, 6, '12. apenas a impressão curta da chave (kid) é exposta');

  // 12.1 As mensagens de erro nunca incluem o valor nem a chave.
  loja.set(ligacoes.chaveTokens('dropbox', 11), 'enc:v1:abcdef:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:AAAA');
  const lido = await ligacoes.lerTokens('dropbox', 11);
  assert.strictEqual(lido.tokens, null, '12.1 valor inválido não devolve tokens');
  const erro = ligacoes.estadoCifra().erroOperacional || '';
  assert.ok(!erro.includes('AAAAAAAA'), '12.1 mensagem sem ciphertext');
  assert.ok(!erro.includes(CHAVE_TESTE), '12.1 mensagem sem a chave');

  // 12.2 O módulo de cifra não expõe a chave em nenhuma função de estado.
  assert.ok(!JSON.stringify(cifra.estado()).includes(CHAVE_TESTE), '12.2 cifra.estado() sem chave');
  assert.strictEqual(cifra.identificador(Buffer.from(CHAVE_TESTE, 'base64')).length, 6, '12.2 identificador curto');
}

// A chave histórica do Drive (evita repetir a string em vários sítios).
function CHAVE_TOKENS_LEGADO_PARA_TESTE() {
  return ligacoes.CHAVE_TOKENS_LEGADO;
}

// ── 13. Rotação de chave ────────────────────────────────────────────
async function testarRotacao() {
  reiniciar();
  comChave(CHAVE_TESTE);
  process.env.ENCRYPTION_KEY_OLD = '';
  await ligacoes.guardarTokens('dropbox', 12, { refresh_token: 'tok-rotacao' });
  const comChaveAntiga = loja.get(ligacoes.chaveTokens('dropbox', 12));
  assert.strictEqual(cifra.precisaRecifrar(comChaveAntiga), false, '13. valor com a chave atual não precisa recifrar');

  // Troca de chave (mantendo a antiga disponível para decifrar).
  comChave(CHAVE_TESTE_2);
  process.env.ENCRYPTION_KEY_OLD = CHAVE_TESTE;
  ligacoes.limparCache();

  assert.strictEqual(cifra.precisaRecifrar(comChaveAntiga), true, '13. valor antigo assinalado para recifragem');
  const lido = await ligacoes.lerTokens('dropbox', 12);
  assert.strictEqual(lido.tokens.refresh_token, 'tok-rotacao', '13. valor antigo continua legível durante a rotação');

  const r = await ligacoes.migrarSeNecessario(ligacoes.chaveTokens('dropbox', 12), loja.get(ligacoes.chaveTokens('dropbox', 12)));
  assert.strictEqual(r.alterado, true, '13. recifrado com a chave nova');
  assert.strictEqual(cifra.precisaRecifrar(loja.get(ligacoes.chaveTokens('dropbox', 12))), false, '13. deixa de precisar recifragem');
  assert.deepStrictEqual(
    JSON.parse(cifra.decifrar(loja.get(ligacoes.chaveTokens('dropbox', 12)), { contexto: ligacoes.chaveTokens('dropbox', 12) }).texto),
    { access_token: null, refresh_token: 'tok-rotacao', expiry_date: null, conta: null },
    '13. conteúdo preservado após rotação'
  );

  // Sem a chave antiga, o valor recifrado continua legível (só a nova é usada).
  process.env.ENCRYPTION_KEY_OLD = '';
  ligacoes.limparCache();
  assert.strictEqual((await ligacoes.lerTokens('dropbox', 12)).tokens.refresh_token, 'tok-rotacao', '13. só a chave nova é necessária');
  comChave(CHAVE_TESTE);
  process.env.ENCRYPTION_KEY_OLD = '';
}

(async () => {
  testarCifra();
  await testarMigracao();
  await testarIsolamento();
  await testarSemChave();
  await testarSemExposicao();
  await testarRotacao();
  console.log('✓ Testes da cifragem das credenciais de armazenamento passaram (sem rede/BD).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
