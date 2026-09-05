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

  // 3. Templates de email profissionais (recibo e genérico)
  const { compor, saudacao, nomeFicheiro } = require('../helpers/email-templates');
  const recibo = compor('recibo', {
    destinatarioNome: 'João Silva',
    condominio: 'Condomínio Jardim das Flores',
    administracao: 'Gestão de Condomínios ABC',
    valor: '45,20 €',
    referencia: '2026/002',
    urlOnline: 'https://gescondu.xyz/recibo/1',
  });
  assert.ok(recibo.assunto.includes('Recibo de pagamento') && recibo.assunto.includes('Jardim das Flores'), 'assunto recibo');
  assert.ok(recibo.text.includes('Exmo./Exma. Senhor(a) João Silva'), 'saudação personalizada');
  assert.ok(recibo.html.includes('Consultar recibo online'), 'link no HTML');
  assert.ok(recibo.html.includes('45,20 €'), 'valor no corpo');
  assert.ok(!recibo.html.includes('CondoFy'), 'sem referência a CondoFy');
  const semAnexo = compor('recibo', { condominio: 'X', destinatarioNome: 'Ana', urlOnline: 'https://gescondu.xyz/r', anexo: false });
  assert.ok(!semAnexo.text.includes('em anexo'), 'sem anexo não afirma anexo');
  assert.ok(semAnexo.text.includes('Consultar recibo online'), 'sem anexo mantém link');
  assert.strictEqual(saudacao(''), 'Exmo./Exma. Senhor(a),', 'saudação neutra');
  assert.strictEqual(nomeFicheiro('recibo', { numero: '2026/002' }), 'Recibo_2026_002.pdf', 'nome de ficheiro normalizado');
  assert.strictEqual(nomeFicheiro('quota', { ano: '2026', mes: 9, fracao: 'Fração A' }), 'Quota_2026_09_Fracao_A.pdf', 'ficheiro de quota sem acentos');
  const t2 = compor('generico', { condominio: 'Condomínio X', destinatarioNome: 'Maria', mensagem: 'Informamos ainda que...' });
  assert.ok(t2.text.includes('Maria'), 'genérico personalizado');
  assert.ok(!t2.text.includes('CondoFy'), 'genérico sem CondoFy');

  console.log('✓ Testes de comunicações passaram (sem rede).');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
