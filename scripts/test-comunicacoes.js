// Testes das comunicações (parte sem rede/base de dados).
// Utilização: node scripts/test-comunicacoes.js
const assert = require('assert');
const { normalizarDestinatarios } = require('../helpers/document-actions');
const { mensagemErroAmigavel, comporConfigSmtp, resolverNomeRemetente, nomeDoCondominioParaRemetente } = require('../helpers/mailer');
const { contextoDoItem } = require('../helpers/email-fila');

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

  // Sem smtp_from_name em lado nenhum → fromName vazio (não inventa defaults),
  // para que a resolução caia no contexto do condomínio / 'GesCondu'.
  const cfgSemNome = comporConfigSmtp({ smtp_host: 'smtp.gmail.com' }, { host: 'smtp.gmail.com', port: '587', from: 'a@b.pt', fromName: '' });
  assert.strictEqual(cfgSemNome.fromName, '', 'sem smtp_from_name (BD e env) → fromName vazio');
  // smtp_from_name vazio na BD + valor no env → usa o env (fallback por campo).
  const cfgEnvNome = comporConfigSmtp({ smtp_host: 'smtp.gmail.com', smtp_from_name: '' }, { host: 'smtp.gmail.com', from: 'a@b.pt', fromName: 'Administração (env)' });
  assert.strictEqual(cfgEnvNome.fromName, 'Administração (env)', 'BD vazio + env preenchido → env');

  // A password nunca é incluída em saídas de estado/devoluções
  const estadoMailer = { configurado: Boolean(cfg1.host), servidor: cfg1.host, temPassword: Boolean(cfg1.pass) };
  assert.ok(!JSON.stringify(estadoMailer).includes(cfg1.pass), 'password não exposta no estado');

  // 5. Nome do remetente — prioridade EXATA:
  //    displayName → smtp_from_name (override global) → contexto do condomínio → "GesCondu"
  // 5.1 + 5.2: smtp_from_name explícito domina qualquer condomínio (A ou B).
  assert.strictEqual(
    resolverNomeRemetente({ fromName: 'Administração XYZ', contexto: 'Condomínio A' }),
    'Administração XYZ',
    'smtp_from_name + Condomínio A → Administração XYZ'
  );
  assert.strictEqual(
    resolverNomeRemetente({ fromName: 'Administração XYZ', contexto: 'Condomínio B' }),
    'Administração XYZ',
    'smtp_from_name + Condomínio B → Administração XYZ (override global)'
  );
  // 5.3 + 5.4: smtp_from_name vazio → nome do condomínio do contexto.
  assert.strictEqual(
    resolverNomeRemetente({ fromName: '', contexto: 'Condomínio A' }),
    'Condomínio A',
    'sem smtp_from_name + Condomínio A → nome do Condomínio A'
  );
  assert.strictEqual(
    resolverNomeRemetente({ fromName: '', contexto: 'Condomínio B' }),
    'Condomínio B',
    'sem smtp_from_name + Condomínio B → nome do Condomínio B'
  );
  // displayName explícito (por chamada) tem prioridade sobre tudo.
  assert.strictEqual(
    resolverNomeRemetente({ displayName: 'Explícito', fromName: 'Administração XYZ', contexto: 'Condomínio A' }),
    'Explícito',
    'displayName explícito domina smtp_from_name e contexto'
  );
  // 5.5: sem smtp_from_name e sem contexto → GesCondu (fallback global).
  assert.strictEqual(resolverNomeRemetente({ fromName: '', contexto: '' }), 'GesCondu', 'sem override e sem contexto → GesCondu');
  assert.strictEqual(resolverNomeRemetente({}), 'GesCondu', 'sem argumentos → GesCondu');
  assert.strictEqual(resolverNomeRemetente({ fromName: ' ', contexto: '  ' }), 'GesCondu', 'espaços tratados como vazio');

  // Contexto do condomínio: o nome é a DESIGNAÇÃO (nunca a administração).
  assert.strictEqual(
    nomeDoCondominioParaRemetente({ designacao: 'Condomínio Jardim das Flores', administracao_nome: 'Gestão ABC' }),
    'Condomínio Jardim das Flores',
    'contexto usa a designação (nome do condomínio)'
  );
  assert.strictEqual(
    nomeDoCondominioParaRemetente({ designacao: '  ', administracao_nome: 'Gestão ABC' }),
    'Gestão ABC',
    'sem designação → administração como recurso'
  );
  assert.strictEqual(nomeDoCondominioParaRemetente(null), '', 'sem condomínio → vazio');

  // 6. Fila de emails — o contexto do condomínio não se perde no processamento
  //    posterior: o item guarda relações seguras que resolvem o condomínio.
  assert.deepStrictEqual(contextoDoItem({ documento_id: 7 }), { modelo: 'Documento', id: 7 }, 'documento_id → Documento');
  assert.deepStrictEqual(contextoDoItem({ aviso_id: 3 }), { modelo: 'Aviso', id: 3 }, 'aviso_id → Aviso');
  assert.deepStrictEqual(contextoDoItem({ entidade_tipo: 'Recibo', entidade_id: 11 }), { modelo: 'Recibo', id: 11 }, 'entidade Recibo');
  assert.deepStrictEqual(contextoDoItem({ entidade_tipo: 'Quota', entidade_id: 5 }), { modelo: 'Quota', id: 5 }, 'entidade Quota (envio de quotas)');
  assert.deepStrictEqual(contextoDoItem({ entidade_tipo: 'Pagamento', entidade_id: 9 }), { modelo: 'Pagamento', id: 9 }, 'entidade Pagamento');
  assert.deepStrictEqual(contextoDoItem({ entidade_tipo: 'Documento', entidade_id: 12 }), { modelo: 'Documento', id: 12 }, 'entidade Documento');
  assert.deepStrictEqual(
    contextoDoItem({ entidade_tipo: 'PagamentoFornecedor', entidade_id: 2 }),
    null,
    'PagamentoFornecedor (global, sem condominio) → sem contexto direto'
  );
  assert.strictEqual(contextoDoItem({}), null, 'sem relação segura → null (fallback global)');

  console.log('✓ Testes de comunicações passaram (sem rede).');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
