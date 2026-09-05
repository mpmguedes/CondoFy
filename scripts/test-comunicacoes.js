// Testes das comunicações (parte sem rede/base de dados).
// Utilização: node scripts/test-comunicacoes.js
const assert = require('assert');
const { normalizarDestinatarios } = require('../helpers/document-actions');
const { mensagemErroAmigavel } = require('../helpers/mailer');

async function main() {
  // 1. Normalização de destinatários (string, array, objetos)
  assert.deepStrictEqual(
    normalizarDestinatarios('a@x.pt,b@y.pt'),
    [{ email: 'a@x.pt', nome: null }, { email: 'b@y.pt', nome: null }],
    'lista separada por vírgulas'
  );
  assert.deepStrictEqual(
    normalizarDestinatarios([{ email: 'a@x.pt', nome: 'Ana' }, { email: 'a@x.pt', nome: 'Duplicado' }]).length,
    1,
    'deduplica emails'
  );
  assert.deepStrictEqual(normalizarDestinatarios(' '), [], 'vazio → sem destinatários');
  assert.deepStrictEqual(
    normalizarDestinatarios([{ email: '', nome: 'X' }, null]).length,
    0,
    'ignora sem email'
  );

  // 2. Mensagens de erro amigáveis (nunca mostram credenciais/tokens)
  const e1 = new Error('getaddrinfo ENOTFOUND smtp.gmail.com');
  assert.ok(mensagemErroAmigavel(e1).includes('Não foi possível ligar'), 'erro de rede amigável');
  const e2 = new Error('Invalid login: 535 5.7.8 Username and Password not accepted');
  assert.ok(mensagemErroAmigavel(e2).includes('autenticação'), 'erro de auth amigável');
  const e3 = new Error('self-signed certificate in certificate chain');
  assert.ok(mensagemErroAmigavel(e3).includes('TLS'), 'erro TLS amigável');
  const e4 = mensagemErroAmigavel(new Error('token secreto=abc123'));
  assert.ok(!e4.includes('abc123'), 'não expõe detalhes sensíveis na mensagem');

  console.log('✓ Testes de comunicações passaram (sem rede).');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
