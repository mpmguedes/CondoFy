// ═══════════════════════════════════════════════════════════════════
// P54-1 — Validação da configuração SMTP.
//
// Duas partes, com fronteiras diferentes:
//
//   A. O VALIDADOR PURO (`helpers/smtp-validacao`) — casos positivos e
//      negativos por regra (V1–V8). Não precisa de duplos: o módulo não lê BD.
//
//   B. A INTEGRAÇÃO (`helpers/mailer.guardarConfigSmtp`) — prova que a
//      validação acontece ANTES de qualquer escrita, que uma entrada inválida
//      deixa a BD intacta, e o comportamento de estado V13/V14.
//
// ⛔ Regra de ouro deste ficheiro: a password de teste NUNCA aparece numa
//    mensagem de erro, num aviso, num resultado, nem no stdout. Há uma secção
//    que o verifica explicitamente (varrendo as serializações).
//
// Utilização: node scripts/test-smtp-validacao.js
// ═══════════════════════════════════════════════════════════════════
'use strict';
const assert = require('assert');
const path = require('path');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');

let n = 0;
const feito = (nome) => { n += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// Segredo usado nos testes. Nunca é impresso — só a sua PRESENÇA é procurada.
const PASSWORD = 'segredo-de-teste-123';
const PASSWORD_CURTA = 'ab';

// ── Duplos: `models` e `segredos` ────────────────────────────────────
// Injetados ANTES de carregar o mailer (que os exige no topo).
function duplo(rel, valor) {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: valor };
}

const loja = new Map(); // `configuracoes` em memória

// O `where` é HONRADO (com `Op.like`): um duplo que devolvesse tudo faria as
// regras de estado (V1 parte 2, V8, V13, V14) medirem o que não deviam.
const Configuracao = {
  async findAll({ where } = {}) {
    let linhas = [...loja.entries()].map(([chave, valor]) => ({ chave, valor }));
    const cond = where && where.chave;
    if (cond && cond[Op.like]) {
      const re = new RegExp(
        `^${String(cond[Op.like]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`
      );
      linhas = linhas.filter((l) => re.test(l.chave));
    }
    return linhas;
  },
  async findOrCreate({ where, defaults }) {
    if (!loja.has(where.chave)) loja.set(where.chave, defaults ? defaults.valor : null);
    const reg = {
      chave: where.chave,
      get valor() { return loja.get(where.chave); },
      set valor(v) { loja.set(where.chave, v); },
      async save() {},
    };
    return [reg, false];
  },
};

// `segredos` controlado: `protegerPasswordSmtp` marca o valor e
// `lerPasswordSmtp` sabe reconhecer um valor ILEGÍVEL (prefixo `ILEGIVEL`),
// que é o que V13 tem de detetar sem apagar.
const MARCA_CIFRADA = 'cifrado:';
const segredos = {
  protegerPasswordSmtp: (v) => `${MARCA_CIFRADA}${v}`,
  lerPasswordSmtp: (v) => {
    if (v === null || v === undefined || v === '') return { valor: '', cifrado: false, precisaErro: false, erro: null };
    const bruto = String(v);
    if (bruto.startsWith(`${MARCA_CIFRADA}ILEGIVEL`)) {
      return { valor: null, cifrado: true, precisaMigrar: false, erro: new Error('chave diferente') };
    }
    return { valor: bruto.replace(MARCA_CIFRADA, ''), cifrado: true, precisaMigrar: false, erro: null };
  },
};

duplo('models', { Configuracao });
duplo('helpers/segredos', segredos);

const validacao = require(path.join(RAIZ, 'helpers/smtp-validacao'));
const mailer = require(path.join(RAIZ, 'helpers/mailer'));

const codigos = (lista) => lista.map((x) => x.codigo);
const limparLoja = () => loja.clear();

// ═════════════════════════════════════════════════════════════════════
// A. VALIDADOR PURO
// ═════════════════════════════════════════════════════════════════════
console.log('P54-1 — validação da configuração SMTP');

titulo('A1. V1 — host');
{
  const ok = (host) => validacao.validarConfigSmtp({ host }).ok;
  assert.strictEqual(ok('smtp.exemplo.pt'), true, 'hostname válido aceite');
  assert.strictEqual(ok('mail.sub.dominio.co.uk'), true, 'subdomínios aceites');
  assert.strictEqual(ok('192.168.1.10'), true, 'IPv4 válido aceite');
  assert.strictEqual(ok('smtp-1.exemplo.pt'), true, 'hífen interior aceite');

  assert.strictEqual(ok('a b c'), false, 'espaços recusados');
  assert.strictEqual(ok('https://x/y'), false, 'URL recusada (não é host)');
  assert.strictEqual(ok('-comeca-com-hifen'), false, 'rótulo a começar por hífen recusado');
  assert.strictEqual(ok('999.999.999.999'), false, 'IPv4 fora de 0–255 recusado');
  // ⚠️ Um rótulo isolado tem limite PRÓPRIO de 63 caracteres, pelo que um host
  // longo só pode ser construído com vários rótulos válidos — é isso que se
  // testa aqui (o limite TOTAL de 253), e não o limite do rótulo.
  const hostLongo = (ultimo) => `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(ultimo)}`;
  assert.strictEqual(hostLongo(61).length, 253, 'o host de teste tem exatamente 253 caracteres');
  assert.strictEqual(ok(hostLongo(61)), true, 'host com exatamente 253 aceite (limite)');
  assert.strictEqual(hostLongo(62).length, 254, 'o host de teste tem exatamente 254 caracteres');
  assert.strictEqual(ok(hostLongo(62)), false, 'host com 254 recusado');
  assert.strictEqual(ok('a'.repeat(64)), false, 'rótulo acima de 63 recusado');
  feito('V1 host: formato, IPv4 e limites (rótulo 63, total 253)');

  // CR/LF no host é injeção de cabeçalho — código próprio, para a mutação morder.
  const r = validacao.validarConfigSmtp({ host: 'smtp.exemplo.pt\r\nBcc: evil@x.pt' });
  assert.deepStrictEqual(codigos(r.erros), ['host_com_quebra_de_linha'], 'CR/LF no host recusado');
  assert.strictEqual(validacao.validarConfigSmtp({ host: 'a\tb' }).ok, false, 'TAB no host recusado');
  feito('V1 host: CR/LF e TAB recusados');

  // Ausente ≠ inválido: um formulário parcial não é recusado por omissão.
  assert.strictEqual(validacao.validarConfigSmtp({}).ok, true, 'sem campos ⇒ nada a validar');
  assert.strictEqual(validacao.validarConfigSmtp({ host: '' }).ok, true, 'host vazio sozinho não é erro');
  feito('V1 host: ausente/vazio não bloqueiam sozinhos');

  // V1 parte 2 — obrigatório quando há remetente/utilizador.
  const rSemHost = validacao.validarConfigSmtp({ from: 'a@exemplo.pt' });
  assert.deepStrictEqual(codigos(rSemHost.erros), ['host_obrigatorio'], 'from sem host ⇒ erro');
  const rSemHost2 = validacao.validarConfigSmtp({ user: 'u@exemplo.pt' });
  assert.deepStrictEqual(codigos(rSemHost2.erros), ['host_obrigatorio'], 'user sem host ⇒ erro');
  // …mas um formulário parcial sobre uma config que JÁ tem host não é recusado.
  const rParcial = validacao.validarConfigSmtp({ from: 'novo@exemplo.pt' }, { atual: { host: 'smtp.guardado.pt' } });
  assert.strictEqual(rParcial.ok, true, 'alterar só o from com host guardado é aceite');
  feito('V1 host: obrigatório se from/user efetivos, tolerante em formulário parcial');
}

titulo('A2. V2 — porta');
{
  const p = (v) => validacao.validarConfigSmtp({ port: v });
  assert.strictEqual(p('587').ok, true, '587 aceite');
  assert.strictEqual(p(587).ok, true, 'número aceite');
  assert.strictEqual(p(' 465 ').ok, true, 'com espaços é normalizado');
  assert.strictEqual(p('1').ok, true, 'limite inferior aceite');
  assert.strictEqual(p('65535').ok, true, 'limite superior aceite');
  assert.strictEqual(p('587').valores.port, '587', 'normalizado para string');

  assert.strictEqual(p('0').ok, false, '0 recusado (fora de 1–65535)');
  assert.strictEqual(p('65536').ok, false, '65536 recusado');
  assert.strictEqual(p('-1').ok, false, 'negativo recusado');
  assert.strictEqual(p('abc').ok, false, '⛔ não-numérico recusado (antes virava NaN)');
  assert.strictEqual(p('58.7').ok, false, 'decimal recusado');
  assert.strictEqual(p('1e3').ok, false, 'notação científica recusada');
  assert.deepStrictEqual(codigos(p('abc').erros), ['porta_invalida'], 'código porta_invalida');
  feito('V2 porta: 1–65535, inteiro, sem NaN');

  // Retrocompatibilidade: vazio cai na porta padrão (comportamento anterior).
  assert.strictEqual(validacao.validarConfigSmtp({ port: '' }).valores.port, '587', 'vazio ⇒ 587');
  assert.strictEqual(validacao.validarConfigSmtp({}).valores.port, undefined, 'ausente ⇒ não mexe');
  feito('V2 porta: vazio ⇒ padrão; ausente ⇒ não mexe');
}

titulo('A3. V3 — utilizador');
{
  // `user` presente sem `host` dispara a regra V1 (host obrigatório), pelo que
  // os casos de CAMPO trazem um host válido: isola o campo em teste.
  const u = (d) => validacao.validarConfigSmtp({ host: 'smtp.exemplo.pt', ...d });
  assert.strictEqual(u({ user: 'conta@exemplo.pt' }).ok, true, 'utilizador válido aceite');
  assert.strictEqual(u({ user: '  conta@exemplo.pt  ' }).valores.user, 'conta@exemplo.pt', 'trim aplicado');
  assert.deepStrictEqual(codigos(u({ user: 'a\r\nb' }).erros), ['user_com_quebra_de_linha'], 'CR/LF recusado');
  assert.deepStrictEqual(codigos(u({ user: 'a'.repeat(256) }).erros), ['user_muito_longo'], 'acima de 255 recusado');
  assert.strictEqual(u({ user: 'a'.repeat(255) }).ok, true, '255 aceite (limite)');
  feito('V3 utilizador: trim, sem CR/LF, máx. 255');
}

titulo('A4. V4 — remetente');
{
  const f = (d) => validacao.validarConfigSmtp({ host: 'smtp.exemplo.pt', ...d });
  assert.strictEqual(f({ from: 'geral@exemplo.pt' }).ok, true, 'email válido aceite');
  assert.strictEqual(f({ from: 'geral+tag@exemplo.pt' }).ok, true, 'etiqueta + aceite');
  assert.strictEqual(f({ from: ' g@exemplo.pt ' }).valores.from, 'g@exemplo.pt', 'trim aplicado');

  assert.deepStrictEqual(codigos(f({ from: '' }).erros), ['from_obrigatorio'], 'vazio recusado');
  assert.deepStrictEqual(codigos(f({ from: 'nao-email' }).erros), ['from_invalido'], 'sem @ recusado');
  assert.deepStrictEqual(codigos(f({ from: 'a@b' }).erros), ['from_invalido'], 'sem domínio recusado');
  assert.deepStrictEqual(codigos(f({ from: 'a@exemplo.pt\x00' }).erros), ['from_com_controle'], 'caractere de controlo recusado');
  assert.deepStrictEqual(codigos(f({ from: 'a@exemplo.pt\r\nBcc: x@y.pt' }).erros), ['from_com_controle'], 'CR/LF recusado (controlo)');
  feito('V4 remetente: obrigatório, email válido, sem controlo');
}

titulo('A5. V5 — nome do remetente (saneado, não recusado)');
{
  assert.strictEqual(validacao.validarConfigSmtp({ fromName: 'Administração' }).ok, true, 'nome simples aceite');
  assert.strictEqual(validacao.validarConfigSmtp({ fromName: '  Administração  ' }).valores.fromName, 'Administração', 'trim aplicado');

  // ⛔ Injeção de cabeçalho: o CR/LF é REMOVIDO do valor.
  const r = validacao.validarConfigSmtp({ fromName: 'Ana\r\nBcc: evil@x.pt' });
  assert.strictEqual(r.ok, true, 'o nome com CR/LF NÃO bloqueia a gravação');
  assert.ok(!/[\r\n]/.test(r.valores.fromName), '⛔ o valor saneado não tem \\r nem \\n');
  assert.ok(!r.valores.fromName.includes('Bcc:\r'), 'o corte de cabeçalho foi destruído');
  assert.deepStrictEqual(codigos(r.avisos), ['from_name_saneado'], 'o saneamento é ASSINALADO (não é silencioso)');

  const so = validacao.validarConfigSmtp({ fromName: 'a\nb\rc' });
  assert.strictEqual(so.valores.fromName, 'abc', 'todos os \\r e \\n removidos');
  assert.deepStrictEqual(codigos(validacao.validarConfigSmtp({ fromName: 'a'.repeat(121) }).erros), ['from_name_muito_longo'], 'acima de 120 recusado');
  assert.strictEqual(validacao.validarConfigSmtp({ fromName: 'a'.repeat(120) }).ok, true, '120 aceite (limite)');
  feito('V5 nome: CR/LF removido, aviso emitido, máx. 120');
}

titulo('A6. V6 — TLS (conjunto fechado, sem conversão silenciosa)');
{
  // Todo o conjunto aceite, com a normalização esperada.
  for (const [entrada, esperado] of [[true, 'true'], ['true', 'true'], ['on', 'true'], [false, 'false'], ['false', 'false'], ['off', 'false']]) {
    const r = validacao.validarConfigSmtp({ tls: entrada });
    assert.strictEqual(r.ok, true, `tls=${JSON.stringify(entrada)} aceite`);
    assert.strictEqual(r.valores.tls, esperado, `tls=${JSON.stringify(entrada)} ⇒ '${esperado}'`);
  }
  feito('V6 TLS: conjunto fechado normalizado (true/on ⇒ true; false/off ⇒ false)');

  // ⛔ O fecho do L3: nada de 'false' silencioso.
  for (const mau of ['1', 'yes', 'TRUE', 'ligado', '', 'sim', 0, 1, null]) {
    const r = validacao.validarConfigSmtp({ tls: mau });
    if (mau === null) {
      assert.strictEqual(r.ok, true, 'tls=null é «ausente» — não mexe');
      continue;
    }
    assert.strictEqual(r.ok, false, `⛔ tls=${JSON.stringify(mau)} tem de ser ERRO, não 'false'`);
    assert.deepStrictEqual(codigos(r.erros), ['tls_invalido'], `código tls_invalido para ${JSON.stringify(mau)}`);
  }
  feito('⛔ V6 TLS: valor inesperado ⇒ ERRO (nunca desliga o TLS em silêncio)');
}

titulo('A7. V7 — password');
{
  assert.strictEqual(validacao.validarConfigSmtp({ pass: PASSWORD }).ok, true, 'password normal aceite');
  assert.strictEqual(validacao.validarConfigSmtp({ pass: PASSWORD }).passDefinida, true, 'marcada como definida');
  assert.deepStrictEqual(codigos(validacao.validarConfigSmtp({ pass: PASSWORD_CURTA }).erros), ['password_curta'], 'curta recusada');
  assert.deepStrictEqual(codigos(validacao.validarConfigSmtp({ pass: 'abcd\r\n' }).erros), ['password_com_quebra_de_linha'], 'CR/LF recusada');
  // Vazio ⇒ não mexe (o comportamento de sempre, provado na integração).
  assert.strictEqual(validacao.validarConfigSmtp({ pass: '' }).passDefinida, false, 'vazia ⇒ não definida');
  assert.strictEqual(validacao.validarConfigSmtp({ pass: '   ' }).passDefinida, false, 'só espaços ⇒ não definida');
  // ⛔ A password NUNCA sai no resultado.
  const r = validacao.validarConfigSmtp({ pass: PASSWORD });
  assert.strictEqual(r.valores.pass, undefined, '⛔ a password não vem em `valores`');
  assert.ok(!JSON.stringify(r).includes(PASSWORD), '⛔ a password não aparece na serialização do resultado');
  feito('V7 password: mínimo, sem CR/LF, e nunca devolvida');
}

titulo('A8. V8 — coerência TLS/porta (AVISO, não bloqueio)');
{
  const incoerente = validacao.validarConfigSmtp({ tls: 'true', port: '2526' });
  assert.strictEqual(incoerente.ok, true, 'V8 NÃO bloqueia a gravação');
  assert.deepStrictEqual(codigos(incoerente.avisos), ['tls_porta_incoerente'], 'avisa');
  for (const p of [465, 587, 25, 2525]) {
    assert.deepStrictEqual(codigos(validacao.validarConfigSmtp({ tls: 'true', port: String(p) }).avisos), [], `porta ${p} não avisa`);
  }
  assert.deepStrictEqual(codigos(validacao.validarConfigSmtp({ tls: 'false', port: '2526' }).avisos), [], 'sem TLS não há aviso');
  feito('V8 coerência TLS/porta: avisa sem bloquear');
}

titulo('A9. Normalização compatível com valores legados válidos');
{
  // Valores que a interface sempre enviou continuam a passar, normalizados.
  const r = validacao.validarConfigSmtp({
    host: '  smtp.gmail.com  ', port: ' 587 ', user: ' conta@gmail.com ',
    tls: 'on', from: ' geral@gmail.com ', fromName: ' Administração ',
  });
  assert.strictEqual(r.ok, true, 'config típica da interface aceite');
  assert.deepStrictEqual(r.valores, {
    host: 'smtp.gmail.com', port: '587', user: 'conta@gmail.com',
    tls: 'true', from: 'geral@gmail.com', fromName: 'Administração',
  }, 'trim coerente em todos os campos');
  feito('A9 trim/normalização não parte valores legados');
}

// ═════════════════════════════════════════════════════════════════════
// B. INTEGRAÇÃO — guardarConfigSmtp
// ═════════════════════════════════════════════════════════════════════
const CONFIG_VALIDA = {
  host: 'smtp.exemplo.pt', port: '587', user: 'conta@exemplo.pt',
  tls: 'true', from: 'geral@exemplo.pt', fromName: 'Administração',
};

async function testarIntegracao() {
  titulo('B1. Configuração válida é gravada e devolve os nomes alterados (V14)');
  {
    limparLoja();
    const r = await mailer.guardarConfigSmtp({ ...CONFIG_VALIDA, pass: PASSWORD });
    assert.strictEqual(r.ok, true, 'gravação aceite');
    assert.strictEqual(loja.get('smtp_host'), 'smtp.exemplo.pt', 'host gravado');
    assert.strictEqual(loja.get('smtp_port'), '587', 'porta gravada');
    assert.strictEqual(loja.get('smtp_tls'), 'true', 'tls gravado normalizado');
    assert.strictEqual(loja.get('smtp_from_name'), 'Administração', 'nome gravado');
    assert.ok(String(loja.get('smtp_pass')).startsWith(MARCA_CIFRADA), 'password gravada cifrada');
    assert.ok(!String(loja.get('smtp_pass')).includes('cifrado:cifrado'), 'não cifra duas vezes');
    // V14 — nomes dos campos alterados, ordenados pela ordem de CHAVES.
    assert.deepStrictEqual(r.alterados, ['host', 'port', 'user', 'pass', 'tls', 'from', 'fromName'],
      'todos os campos fornecidos entram na lista de alterados');
    feito('B1 config válida gravada; `alterados` lista nomes (V14)');
  }

  titulo('B2. V14 — só os campos que MUDARAM entram na lista');
  {
    // Nada muda: mesmos valores outra vez.
    const r = await mailer.guardarConfigSmtp({ ...CONFIG_VALIDA });
    assert.deepStrictEqual(r.alterados, [], 'repetir os mesmos valores não altera nada');
    // Muda só o host.
    const r2 = await mailer.guardarConfigSmtp({ host: 'smtp.novo.pt' });
    assert.deepStrictEqual(r2.alterados, ['host'], 'só o host mudou');
    // Fornecer password nova conta como alteração, sem nunca expor o valor.
    const r3 = await mailer.guardarConfigSmtp({ pass: `${PASSWORD}-nova` });
    assert.deepStrictEqual(r3.alterados, ['pass'], 'password nova ⇒ alterado');
    assert.ok(!JSON.stringify(r3).includes(PASSWORD), '⛔ o resultado não contém a password');
    feito('B2 V14: nomes alterados exatos, sem valores');
  }

  titulo('B3. ⛔ Entrada inválida NÃO escreve nada (validação antes da escrita)');
  {
    const invalidos = [
      ['porta não numérica', { port: 'abc' }, 'porta_invalida'],
      ['porta fora do intervalo', { port: '70000' }, 'porta_invalida'],
      ['remetente inválido', { from: 'nao-email' }, 'from_invalido'],
      ['remetente com CRLF', { from: 'a@b.pt\r\nBcc: x@y.pt' }, 'from_com_controle'],
      ['tls inesperado', { tls: 'yes' }, 'tls_invalido'],
      ['host com espaços', { host: 'a b c' }, 'host_invalido'],
      ['password curta', { pass: PASSWORD_CURTA }, 'password_curta'],
    ];
    for (const [nome, dados, esperado] of invalidos) {
      limparLoja();
      // Semeia uma configuração boa para provar que ela fica INTACTA.
      await mailer.guardarConfigSmtp({ ...CONFIG_VALIDA });
      const antes = JSON.stringify([...loja.entries()].sort());

      let apanhado = null;
      try { await mailer.guardarConfigSmtp(dados); } catch (e) { apanhado = e; }

      assert.ok(apanhado, `${nome}: tem de lançar`);
      assert.strictEqual(apanhado.name, 'ErroValidacaoSmtp', `${nome}: erro de validação`);
      assert.strictEqual(apanhado.validacao, true, `${nome}: marcado como validação`);
      assert.deepStrictEqual(codigos(apanhado.erros), [esperado], `${nome}: código ${esperado}`);
      assert.strictEqual(JSON.stringify([...loja.entries()].sort()), antes,
        `⛔ ${nome}: a BD tem de ficar EXATAMENTE como estava`);
    }
    feito(`${invalidos.length} entradas inválidas recusadas sem tocar na BD`);
  }

  titulo('B4. ⛔ Nenhuma password em erros, avisos, resultados ou stdout');
  {
    limparLoja();
    // Password curta: o erro fala do CAMPO, nunca do valor.
    let e1 = null;
    try { await mailer.guardarConfigSmtp({ pass: PASSWORD_CURTA }); } catch (e) { e1 = e; }
    assert.ok(e1, 'password curta recusada');
    const serializado = `${e1.message}|${JSON.stringify(e1.erros)}|${JSON.stringify(e1.stack || '')}`;
    assert.ok(!serializado.includes(PASSWORD_CURTA), '⛔ o erro não ecoa a password curta');
    assert.ok(!/pass.*=.*['"]/.test(e1.message), 'a mensagem não interpola valores');

    // Password com CRLF: idem.
    let e2 = null;
    try { await mailer.guardarConfigSmtp({ pass: 'senha\r\nvalida-longa' }); } catch (e) { e2 = e; }
    assert.ok(e2, 'password com CRLF recusada');
    assert.ok(!`${e2.message}${JSON.stringify(e2.erros)}`.includes('senha'), '⛔ o erro não ecoa a password');

    // Resultado de uma gravação boa: os avisos não trazem valores.
    limparLoja();
    const bom = await mailer.guardarConfigSmtp({ ...CONFIG_VALIDA, pass: PASSWORD });
    assert.ok(!JSON.stringify(bom).includes(PASSWORD), '⛔ o resultado não contém a password');
    assert.ok(!JSON.stringify(bom).includes('smtp.exemplo.pt'), 'os avisos/alterados não trazem valores');

    // As mensagens do catálogo são FIXAS — nenhuma tem interpolação de valor.
    for (const [codigo, msg] of Object.entries(validacao.MENSAGENS)) {
      assert.strictEqual(typeof msg, 'string', `mensagem de ${codigo} é string`);
      assert.ok(!/[=:]\s*['"]/.test(msg), `mensagem de ${codigo} não interpola valores`);
    }
    feito('B4 a password nunca aparece em erros, avisos, resultados nem no catálogo');
  }

  titulo('B5. V13 — segredo ilegível: preservado, com aviso');
  {
    limparLoja();
    await mailer.guardarConfigSmtp({ ...CONFIG_VALIDA });
    // Simula um valor que não pode ser decifrado (chave diferente).
    loja.set('smtp_pass', `${MARCA_CIFRADA}ILEGIVEL`);
    const antes = loja.get('smtp_pass');

    const r = await mailer.guardarConfigSmtp({ host: 'smtp.outro.pt' }); // sem password
    assert.strictEqual(r.ok, true, 'a gravação prossegue');
    assert.strictEqual(loja.get('smtp_pass'), antes, '⛔ o segredo ilegível NÃO foi apagado');
    const aviso = r.avisos.find((a) => a.codigo === 'password_ilegivel_preservada');
    assert.ok(aviso, 'V13 emite aviso');
    assert.strictEqual(aviso.campo, 'pass', 'o aviso aponta o campo');
    assert.ok(!aviso.mensagem.includes(MARCA_CIFRADA), 'o aviso não revela o valor guardado');

    // Com uma password nova, o valor ilegível é substituído e o aviso desaparece.
    const r2 = await mailer.guardarConfigSmtp({ pass: `${PASSWORD}-substituta` });
    assert.ok(!r2.avisos.some((a) => a.codigo === 'password_ilegivel_preservada'), 'sem aviso quando há password nova');
    assert.ok(String(loja.get('smtp_pass')).includes('substituta'), 'a password nova substituiu a ilegível');
    feito('B5 V13: ilegível preservado + aviso; substituído quando há password nova');
  }

  titulo('B6. Retrocompatibilidade — o comportamento anterior mantém-se');
  {
    limparLoja();
    // Campo ausente ⇒ não mexe (contrato dos chamadores parciais).
    await mailer.guardarConfigSmtp({ ...CONFIG_VALIDA });
    const hostAntes = loja.get('smtp_host');
    const fromAntes = loja.get('smtp_from');
    await mailer.guardarConfigSmtp({ pass: `${PASSWORD}-2` });
    assert.strictEqual(loja.get('smtp_host'), hostAntes, 'host ausente não foi tocado');
    assert.strictEqual(loja.get('smtp_from'), fromAntes, 'from ausente não foi tocado');

    // Vazio preserva a password existente (proteção C da spec).
    const passAntes = loja.get('smtp_pass');
    await mailer.guardarConfigSmtp({ pass: '' });
    assert.strictEqual(loja.get('smtp_pass'), passAntes, 'password vazia preserva a existente');

    // Porta vazia ⇒ padrão 587 (comportamento anterior).
    limparLoja();
    await mailer.guardarConfigSmtp({ host: 'smtp.exemplo.pt', port: '' });
    assert.strictEqual(loja.get('smtp_port'), '587', 'porta vazia ⇒ 587');

    // Sem chamada de campos ⇒ não rebenta.
    limparLoja();
    const vazio = await mailer.guardarConfigSmtp({});
    assert.strictEqual(vazio.ok, true, 'gravação sem campos não rebenta');
    feito('B6 retrocompatibilidade: ausente não mexe, vazio preserva, padrão mantido');
  }

  titulo('B7. A interface continua a passar exatamente os mesmos campos');
  {
    // O contrato do formulário (select tls ⇒ 'true'/'false') é aceite tal e qual.
    limparLoja();
    const r = await mailer.guardarConfigSmtp({
      host: 'smtp.gmail.com', port: '465', user: 'conta@gmail.com', pass: PASSWORD,
      tls: 'true', from: 'geral@gmail.com', fromName: 'Administração do Condomínio',
    });
    assert.strictEqual(r.ok, true, 'payload real do formulário aceite');
    assert.deepStrictEqual(r.avisos, [], 'sem avisos num payload normal (porta 465 com TLS)');
    const rSemTls = await mailer.guardarConfigSmtp({ tls: 'false' });
    assert.strictEqual(rSemTls.ok, true, 'tls=false do select aceite');
    assert.strictEqual(loja.get('smtp_tls'), 'false', 'gravado como false');
    feito('B7 payload real do formulário (tls true/false) aceite sem avisos');
  }
}

(async () => {
  await testarIntegracao();
  console.log(`\n✓ Validação SMTP (P54-1) passou: ${n} verificações, sem base de dados.`);
})().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
