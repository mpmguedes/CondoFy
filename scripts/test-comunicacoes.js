// Testes das comunicações (parte sem rede/base de dados).
// Utilização: node scripts/test-comunicacoes.js
const assert = require('assert');
const { normalizarDestinatarios } = require('../helpers/document-actions');
const { mensagemErroAmigavel, comporConfigSmtp } = require('../helpers/mailer');

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
  // HTML preparado não é escapado; o texto simples não tem tags.
  assert.ok(recibo.html.includes('<strong>') && !recibo.html.includes('&lt;strong'), 'HTML <strong> renderizado sem escapar');
  assert.ok(!recibo.text.includes('<strong>'), 'versão texto sem tags HTML');

  const quotaT = compor('quota', { condominio: 'Condomínio X', periodo: 'Outubro 2026', valor: 61.23, destinatarioNome: 'Martinho' });
  assert.ok(quotaT.html.includes('<strong>Outubro 2026</strong>'), 'quota: período a negrito sem escapar');
  assert.ok(quotaT.html.includes('<strong>Valor: 61,23 €</strong>'), 'quota: valor PT-PT a negrito');
  assert.ok(!quotaT.html.includes('&lt;strong'), 'quota: sem HTML escapado');
  assert.ok(!quotaT.text.includes('<strong>'), 'quota: texto sem tags');
  assert.ok(quotaT.text.includes('61,23 €'), 'quota: valor PT-PT no texto');
  const semAnexo = compor('recibo', { condominio: 'X', destinatarioNome: 'Ana', urlOnline: 'https://gescondu.xyz/r', anexo: false });
  assert.ok(!semAnexo.text.includes('em anexo'), 'sem anexo não afirma anexo');
  assert.ok(semAnexo.text.includes('Consultar recibo online'), 'sem anexo mantém link');
  assert.strictEqual(saudacao(''), 'Exmo./Exma. Senhor(a),', 'saudação neutra');
  assert.strictEqual(nomeFicheiro('recibo', { numero: '2026/002' }), 'Recibo_2026_002.pdf', 'nome de ficheiro normalizado');
  assert.strictEqual(nomeFicheiro('quota', { ano: '2026', mes: 9, fracao: 'Fração A' }), 'Quota_2026_09_Fracao_A.pdf', 'ficheiro de quota sem acentos');
  const t2 = compor('generico', { condominio: 'Condomínio X', destinatarioNome: 'Maria', mensagem: 'Informamos ainda que...' });
  assert.ok(t2.text.includes('Maria'), 'genérico personalizado');
  assert.ok(!t2.text.includes('CondoFy'), 'genérico sem CondoFy');

  // 4. Resolução SMTP: BD sem smtp_pass + SMTP_PASS no .env → fallback por campo
  const env = {
    host: 'smtp.gmail.com',
    port: '587',
    user: 'condominio@gmail.com',
    pass: 'app-password-do-env',
    tls: 'true',
    from: 'condominio@gmail.com',
    fromName: 'Administração (env)',
  };
  const dbSemPass = {
    smtp_host: 'smtp.gmail.com',
    smtp_port: '587',
    smtp_user: 'condominio@gmail.com',
    smtp_tls: 'true',
    smtp_from: 'condominio@gmail.com',
    smtp_from_name: 'Administração do Condomínio',
    // sem smtp_pass
  };
  const cfg1 = comporConfigSmtp(dbSemPass, env);
  assert.strictEqual(cfg1.pass, 'app-password-do-env', 'BD sem smtp_pass → usa SMTP_PASS do .env');
  assert.strictEqual(cfg1.fromName, 'Administração do Condomínio', 'BD from_name tem prioridade');
  assert.strictEqual(cfg1.tls, 'true', 'BD tls mantido');
  assert.strictEqual(cfg1.from, 'condominio@gmail.com', 'BD from mantido');

  // smtp_pass vazio na BD → também usa o .env
  const cfg2 = comporConfigSmtp({ ...dbSemPass, smtp_pass: '' }, env);
  assert.strictEqual(cfg2.pass, 'app-password-do-env', 'smtp_pass vazio na BD → .env');

  // smtp_pass preenchido na BD → a BD tem prioridade
  const cfg3 = comporConfigSmtp({ ...dbSemPass, smtp_pass: 'app-password-da-bd' }, env);
  assert.strictEqual(cfg3.pass, 'app-password-da-bd', 'smtp_pass na BD tem prioridade');

  // Sem configuração na BD → .env completo
  const cfg4 = comporConfigSmtp({}, env);
  assert.strictEqual(cfg4.host, 'smtp.gmail.com', 'fallback .env host');
  assert.strictEqual(cfg4.pass, 'app-password-do-env', 'fallback .env pass');

  // A password nunca é incluída em saídas de estado/devoluções
  const estadoMailer = { configurado: Boolean(cfg1.host), servidor: cfg1.host, temPassword: Boolean(cfg1.pass) };
  assert.ok(!JSON.stringify(estadoMailer).includes(cfg1.pass), 'password não exposta no estado');

  console.log('✓ Testes de comunicações passaram (sem rede).');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
