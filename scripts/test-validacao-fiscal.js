// Testes dos validadores de NIF e IBAN portugueses e da formatação automática.
// Sem base de dados, sem rede, sem dependências externas.
//
// Utilização: node scripts/test-validacao-fiscal.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const V = require('../public/js/validacao-fiscal');

// ─────────────────────────── NIF ───────────────────────────

function testarNifValido() {
  // Prefixos representativos: 1/2 singulares, 5 coletivas, 6 públicas,
  // 7 outras entidades, 8 empresário individual, 9 condomínios.
  for (const nif of ['123456789', '213456788', '501964843', '600000001', '700000003', '800000005', '900000007', '250000008']) {
    const r = V.validarNif(nif);
    assert.strictEqual(r.ok, true, `NIF ${nif} deve ser válido`);
    assert.strictEqual(r.valor, nif, `NIF ${nif} normalizado é igual`);
    assert.strictEqual(r.mensagem, '', `NIF ${nif} válido não tem mensagem`);
  }

  // Formatações de introdução equivalentes ao mesmo NIF.
  for (const entrada of ['123 456 789', '123.456.789', '123-456-789', '  123456789  ', '123/456/789']) {
    const r = V.validarNif(entrada);
    assert.strictEqual(r.ok, true, `NIF com separadores "${entrada}" deve ser válido`);
    assert.strictEqual(r.valor, '123456789', `"${entrada}" normaliza para 123456789`);
  }
}

function testarNifInvalido() {
  // Dígito de controlo errado.
  const controlo = V.validarNif('123456788');
  assert.strictEqual(controlo.ok, false, 'dígito de controlo errado é inválido');
  assert.strictEqual(controlo.motivo, 'controlo');
  assert.strictEqual(controlo.mensagem, V.MENSAGEM_NIF, 'mensagem única e não técnica');

  // Comprimento errado.
  for (const nif of ['12345678', '1234567890', '1', '1234567890123']) {
    const r = V.validarNif(nif);
    assert.strictEqual(r.ok, false, `comprimento inválido: ${nif}`);
    assert.strictEqual(r.motivo, 'formato');
  }

  // Caracteres não numéricos.
  for (const nif of ['12A456789', '12345678X', 'abcdefghi', '123 456 78a']) {
    const r = V.validarNif(nif);
    assert.strictEqual(r.ok, false, `caracteres inválidos: ${nif}`);
    assert.strictEqual(r.motivo, 'formato');
  }

  // Prefixos não aceites (0 e 4 sem ser 45).
  for (const nif of ['012345678', '412345678', '400000000', '099999999']) {
    const r = V.validarNif(nif);
    assert.strictEqual(r.ok, false, `prefixo não aceite: ${nif}`);
    assert.strictEqual(r.motivo, 'prefixo');
  }

  // Não inventa um NIF válido a partir de lixo (não descarta letras).
  assert.strictEqual(V.validarNif('123456789ABC').ok, false, 'lixo depois do NIF é inválido');
  assert.strictEqual(V.validarNif('A123456789').ok, false, 'lixo antes do NIF é inválido');
}

function testarNifVazio() {
  for (const valor of ['', '   ', null, undefined]) {
    const r = V.validarNif(valor);
    assert.strictEqual(r.ok, true, 'NIF vazio é aceite (campo opcional)');
    assert.strictEqual(r.valor, '', 'NIF vazio normaliza para string vazia');
  }
}

// ─────────────────────────── IBAN ───────────────────────────

function testarIbanValido() {
  const esperados = ['PT50000201231234567890154', 'PT25003300004509105427093'];
  for (const iban of esperados) {
    const r = V.validarIban(iban);
    assert.strictEqual(r.ok, true, `IBAN PT ${iban} deve ser válido`);
    assert.strictEqual(r.valor, iban, 'normalizado igual ao valor sem espaços');
    assert.strictEqual(r.pais, 'PT', 'país detetado');
  }

  // Formas de introdução equivalentes.
  for (const entrada of [
    'PT50 0002 0123 1234 5678 9015 4',
    'pt50000201231234567890154',
    'Pt50 0002 0123 1234 5678 9015 4',
    '  PT50-0002-0123-1234-5678-9015-4  ',
  ]) {
    const r = V.validarIban(entrada);
    assert.strictEqual(r.ok, true, `IBAN "${entrada}" deve ser válido`);
    assert.strictEqual(r.valor, 'PT50000201231234567890154', `"${entrada}" normaliza sem espaços`);
  }

  // IBAN estrangeiros válidos (um condomínio pode ter conta fora de PT).
  for (const iban of ['DE89370400440532013000', 'ES9121000418450200051332']) {
    const r = V.validarIban(iban);
    assert.strictEqual(r.ok, true, `IBAN estrangeiro válido: ${iban}`);
  }
}

function testarIbanInvalido() {
  // Dígitos de controlo errados.
  const controlo = V.validarIban('PT50000201231234567890153');
  assert.strictEqual(controlo.ok, false, 'MOD-97 inválido é rejeitado');
  assert.strictEqual(controlo.motivo, 'controlo');
  assert.strictEqual(controlo.mensagem, V.MENSAGEM_IBAN, 'mensagem não técnica');

  // Comprimento errado (PT tem de ter 25).
  for (const iban of ['PT500002012312345678901', 'PT500002012312345678901544', 'PT50']) {
    const r = V.validarIban(iban);
    assert.strictEqual(r.ok, false, `comprimento inválido: ${iban}`);
  }

  // País incorreto quando se exige PT.
  const es = V.validarIban('ES9121000418450200051332', { exigirPT: true });
  assert.strictEqual(es.ok, false, 'exigirPT rejeita país estrangeiro');
  assert.strictEqual(es.motivo, 'pais');

  // Caracteres inválidos.
  for (const iban of ['PT50 0002 0123 1234 5678 901! 4', 'PT50#000201231234567890154', 'PT50 0002 0123 1234 5678 9015 €']) {
    const r = V.validarIban(iban);
    assert.strictEqual(r.ok, false, `caracteres inválidos: ${iban}`);
    assert.strictEqual(r.motivo, 'formato');
  }

  // Comprimento genérico fora do intervalo 15-34.
  assert.strictEqual(V.validarIban('PT123').ok, false, 'curto demais');
  assert.strictEqual(V.validarIban('XX00' + '1'.repeat(40)).ok, false, 'longo demais');
}

function testarIbanVazio() {
  for (const valor of ['', '   ', null, undefined]) {
    const r = V.validarIban(valor);
    assert.strictEqual(r.ok, true, 'IBAN vazio é aceite (campo opcional)');
    assert.strictEqual(r.valor, '', 'IBAN vazio normaliza para string vazia');
  }
}

// ─────────────────────── formatação/normalização ───────────────────────

function testarFormatacao() {
  assert.strictEqual(
    V.formatarIban('PT50000201231234567890154'),
    'PT50 0002 0123 1234 5678 9015 4',
    'IBAN formatado em grupos de 4'
  );
  assert.strictEqual(
    V.formatarIban('pt50 0002 0123 1234 5678 9015 4'),
    'PT50 0002 0123 1234 5678 9015 4',
    'formatação normaliza maiúsculas e espaços duplicados'
  );
  assert.strictEqual(V.formatarIban('PT50000201231234567890154'), V.formatarIban('PT50 0002 0123 1234 5678 9015 4'), 'idempotente');
  assert.strictEqual(V.formatarIban('PT5000020123'), 'PT50 0002 0123', 'formatação parcial (durante a escrita)');
  assert.strictEqual(V.formatarIban(''), '', 'vazio formata para vazio');

  assert.strictEqual(V.formatarNif('123456789'), '123 456 789', 'NIF formatado em grupos de 3');
  assert.strictEqual(V.formatarNif('123 456 789'), '123 456 789', 'NIF formatado é idempotente');
  assert.strictEqual(V.formatarNif('12345'), '12345', 'NIF incompleto não é formatado');

  // Normalização usada antes de gravar.
  assert.strictEqual(V.normalizarNif('123 456 789'), '123456789', 'NIF guardado com 9 dígitos');
  assert.strictEqual(V.normalizarIban('PT50 0002 0123 1234 5678 9015 4'), 'PT50000201231234567890154', 'IBAN guardado sem espaços');
}

// ─────────────────────── integração frontend/backend ───────────────────────

function testarIntegracao() {
  const camposEsperados = [
    ['views/admin/condominos/form.handlebars', 'name="nif"', 'data-validar="nif"'],
    ['views/admin/configuracao/index.handlebars', 'name="nif"', 'data-validar="nif"'],
    ['views/admin/configuracao/index.handlebars', 'name="iban_principal"', 'data-validar="iban"'],
    ['views/admin/fornecedores/form.handlebars', 'name="nif"', 'data-validar="nif"'],
    ['views/admin/fornecedores/form.handlebars', 'name="iban"', 'data-validar="iban"'],
    ['views/admin/fornecedores/pagamento-novo.handlebars', 'name="iban_utilizado"', 'data-validar="iban"'],
    ['views/admin/contas/form.handlebars', 'name="iban"', 'data-validar="iban"'],
  ];
  for (const [ficheiro, campo, atributo] of camposEsperados) {
    const src = fs.readFileSync(path.join(raiz, ficheiro), 'utf8');
    const linha = src.split('\n').find((l) => l.includes(campo) && l.includes('<input'));
    assert.ok(linha, `${ficheiro}: campo ${campo} existe`);
    assert.ok(linha.includes(atributo), `${ficheiro}: ${campo} tem ${atributo}`);
  }

  const layout = fs.readFileSync(path.join(raiz, 'views/layouts/main.handlebars'), 'utf8');
  assert.ok(layout.includes('/js/validacao-fiscal.js'), 'layout carrega o módulo de validação');

  // O backend usa os mesmos validadores e normaliza antes de gravar.
  const rotas = {
    'routes/admin.js': ['validarNif', 'nif: nifValidado.valor || null'],
    'routes/configuracao.js': ['validarNif', 'validarIban', 'nif: nifValidado.valor || null', 'iban_principal: ibanValidado.valor || null'],
    'routes/financeiro.js': ['validarIban', 'iban: ibanValidado.valor || null'],
    'routes/fornecedores.js': ['validarNif', 'validarIban', 'dados.nif = nif.valor || null', 'dados.iban = iban.valor || null', 'iban_utilizado: ibanUtilizado.valor || null'],
    'routes/condominios.js': ['validarNif', 'nif: nifValidado.valor || null'],
    'routes/global-admin.js': ['validarNif', 'nif: nifValidado.valor || null'],
  };
  for (const [ficheiro, marcas] of Object.entries(rotas)) {
    const src = fs.readFileSync(path.join(raiz, ficheiro), 'utf8');
    assert.ok(src.includes("require('../public/js/validacao-fiscal')"), `${ficheiro}: usa o módulo partilhado`);
    for (const marca of marcas) {
      assert.ok(src.includes(marca), `${ficheiro}: contém "${marca}"`);
    }
  }

  // A validação tem de acontecer ANTES da escrita na base de dados.
  const ordens = [
    ['routes/configuracao.js', 'const nifValidado = validarNif(', 'await condominio.update(dados)'],
    ['routes/financeiro.js', 'const ibanValidado = validarIban(iban)', 'const conta = await ContaBancaria.create('],
    ['routes/fornecedores.js', 'const nif = validarNif(dados.nif)', 'const fornecedor = await Fornecedor.create('],
    ['routes/fornecedores.js', 'const ibanUtilizado = validarIban(', 'const pagamento = await PagamentoFornecedor.create('],
    ['routes/condominios.js', 'const nifValidado = validarNif(req.body.nif)', 'const condominio = await Condominio.create('],
    ['routes/global-admin.js', 'const nifValidado = validarNif(req.body.nif)', 'const condominio = await Condominio.create('],
  ];
  for (const [ficheiro, validacao, escrita] of ordens) {
    const src = fs.readFileSync(path.join(raiz, ficheiro), 'utf8');
    const posValidacao = src.indexOf(validacao);
    const posEscrita = src.indexOf(escrita);
    assert.ok(posValidacao >= 0, `${ficheiro}: contém a validação "${validacao}"`);
    assert.ok(posEscrita >= 0, `${ficheiro}: contém a escrita "${escrita}"`);
    assert.ok(posValidacao < posEscrita, `${ficheiro}: valida antes de gravar (${validacao} antes de ${escrita})`);
  }

  // Nunca registar NIF/IBAN completos em logs ou auditoria.
  for (const ficheiro of Object.keys(rotas)) {
    const linhas = fs.readFileSync(path.join(raiz, ficheiro), 'utf8').split('\n');
    linhas.forEach((linha, i) => {
      if (/\b(nif|iban|iban_utilizado|iban_principal)\b/i.test(linha) && /console\.|audit\(/.test(linha)) {
        assert.fail(`${ficheiro}:${i + 1} não pode registar NIF/IBAN: ${linha.trim()}`);
      }
    });
  }

  // Sem duplicação de algoritmo: já não existe validador local de IBAN.
  const fornecedores = fs.readFileSync(path.join(raiz, 'routes/fornecedores.js'), 'utf8');
  assert.ok(!/function validarIban\(/.test(fornecedores), 'routes/fornecedores.js não tem validador local duplicado');
}

function testarSemDependenciasNemRede() {
  const src = fs.readFileSync(path.join(raiz, 'public/js/validacao-fiscal.js'), 'utf8');
  // Remove comentários para não confundir exemplos de documentação com código.
  const codigo = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\brequire\(/.test(codigo), 'módulo não faz require de dependências');
  assert.ok(!/\bfetch\(|XMLHttpRequest|axios|https?:\/\//.test(codigo), 'módulo não faz chamadas de rede');
  // Mensagens de interface não mencionam algoritmo/módulo/MOD-97.
  assert.ok(!/MOD-?97|algoritmo|checksum|módulo 11/i.test(V.MENSAGEM_NIF + V.MENSAGEM_IBAN), 'mensagens não são técnicas');
}

// ─────────────────────────── execução ───────────────────────────

testarNifValido();
testarNifInvalido();
testarNifVazio();
testarIbanValido();
testarIbanInvalido();
testarIbanVazio();
testarFormatacao();
testarIntegracao();
testarSemDependenciasNemRede();

console.log('✓ Testes de validação de NIF/IBAN e formatação passaram (sem base de dados, sem rede).');
