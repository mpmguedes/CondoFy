// Testes dos contactos inline na ficha do condómino — sem base de dados.
// Cobre: parsing da ficha, sincronização idempotente (sincronizarContactosPessoa),
// regras de principal (→ pessoas.email/telefone), compatibilidade com os valores
// legados e a resolução de destinatários (email principal apenas).
// Utilização: node scripts/test-contactos.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const helpers = require('../helpers/handlebars-helpers');

const {
  parseContactosForm,
  validarContactos,
  sincronizarContactosPessoa,
  emailPreferido,
  telefonePreferido,
  emailsPreferidosPorPessoa,
} = require('../helpers/contactos');

// ── Stubs da BD (contactos_pessoa / pessoas) ───────────────────────
const models = require('../models');
const orig = {
  destroy: models.ContactoPessoa.destroy,
  bulkCreate: models.ContactoPessoa.bulkCreate,
  findAllCP: models.ContactoPessoa.findAll,
  findOneCP: models.ContactoPessoa.findOne,
  findAllPessoa: models.Pessoa.findAll,
};

const estadoBD = { destruicoes: [], criados: [] };

// Stub findAll que emula a ordenação da query real (principal primeiro).
function stubFindAllOrdenado(rows) {
  return async () =>
    rows.slice().sort((a, b) => {
      if (Boolean(b.principal) !== Boolean(a.principal)) return b.principal ? 1 : -1;
      return (a.id || 0) - (b.id || 0);
    });
}

function reiniciarBDStub() {
  estadoBD.destruicoes = [];
  estadoBD.criados = [];
  models.ContactoPessoa.destroy = async (opts) => {
    estadoBD.destruicoes.push(opts);
    estadoBD.criados = []; // substituição: apagar tudo antes de recriar
  };
  models.ContactoPessoa.bulkCreate = async (linhas) => {
    estadoBD.criados.push(...linhas);
    return linhas.map((l, i) => ({ id: 5000 + estadoBD.criados.length - linhas.length + i, ...l }));
  };
}

function criarPessoa(id = 7) {
  const pessoa = {
    id,
    email: null,
    telefone: null,
    atualizacoes: null,
    async update(campos) {
      this.atualizacoes = campos;
      if (campos && 'email' in campos) this.email = campos.email;
      if (campos && 'telefone' in campos) this.telefone = campos.telefone;
    },
  };
  return pessoa;
}

// ── 1. Parsing da ficha (campos contactos[email]/contactos[telefone]) ──
function testParsing() {
  // Vários emails com etiquetas e principal no índice 1
  const body = {
    nome: 'João',
    contactos: {
      email: {
        valor: ['joao@exemplo.pt', 'trabalho@empresa.pt', ''],
        etiqueta: ['Pessoal', 'Trabalho', ''],
        principal: '1',
      },
      telefone: {
        valor: ['912 345 678', '210000000'],
        etiqueta: ['Telemóvel', ''],
        principal: '0',
      },
    },
  };
  const { emails, telefones } = parseContactosForm(body);
  assert.strictEqual(emails.length, 2, 'linhas vazias de email ignoradas');
  assert.strictEqual(emails[0].valor, 'joao@exemplo.pt');
  assert.strictEqual(emails[0].principal, false, 'principal segue o índice do radio');
  assert.strictEqual(emails[1].valor, 'trabalho@empresa.pt');
  assert.strictEqual(emails[1].etiqueta, 'Trabalho');
  assert.strictEqual(emails[1].principal, true, 'email do índice 1 é principal');
  assert.strictEqual(telefones.length, 2, 'vários telefones');
  assert.strictEqual(telefones[0].principal, true, 'telefone do índice 0 é principal');
  assert.strictEqual(telefones[1].etiqueta, '');

  // Sem grupos → lista vazia (removeu tudo / formulário sem contactos)
  assert.deepStrictEqual(parseContactosForm({ nome: 'X' }), { emails: [], telefones: [] }, 'sem grupos → vazio');

  // Valores avulsos (uma linha só) são tratados como lista
  const um = parseContactosForm({ contactos: { email: { valor: 'a@x.pt', principal: '0' } } });
  assert.strictEqual(um.emails.length, 1);
  assert.strictEqual(um.emails[0].valor, 'a@x.pt');
  assert.strictEqual(um.emails[0].principal, true, 'linha única com radio marcado');

  // Ficha antiga (campos únicos) → convertidos em contacto principal
  const legado = parseContactosForm({ nome: 'Maria', email: 'maria@x.pt', telefone: '915000000' });
  assert.strictEqual(legado.emails.length, 1);
  assert.strictEqual(legado.emails[0].valor, 'maria@x.pt');
  assert.strictEqual(legado.emails[0].principal, true, 'legado vira principal');
  assert.strictEqual(legado.telefones.length, 1);
  assert.strictEqual(legado.telefones[0].valor, '915000000');
  // Campos legados vazios → sem contactos
  const legadoVazio = parseContactosForm({ email: '   ', telefone: '' });
  assert.deepStrictEqual(legadoVazio, { emails: [], telefones: [] }, 'legado vazio ignorado');

  // Espaços em branco à volta são removidos
  const comEspacos = parseContactosForm({ contactos: { email: { valor: ['  a@x.pt  '], principal: '0' } } });
  assert.strictEqual(comEspacos.emails[0].valor, 'a@x.pt', 'valor normalizado');
}

// ── 2. Validação (email só quando preenchido; telefone permissivo) ──
function testValidacao() {
  assert.strictEqual(validarContactos({ emails: [{ valor: 'a@x.pt' }], telefones: [{ valor: '912345678' }] }), null, 'email válido passa');
  assert.strictEqual(validarContactos({ emails: [{ valor: 'sem-arroba' }] }), 'Email inválido: sem-arroba', 'email sem @ é inválido');
  assert.strictEqual(validarContactos({ emails: [{ valor: 'a@x' }] }), 'Email inválido: a@x', 'email sem domínio é inválido');
  assert.strictEqual(validarContactos({ emails: [], telefones: [{ valor: '(+351) 912-345-678' }] }), null, 'telefone com formato variado aceite');
  assert.strictEqual(validarContactos({}), null, 'sem contactos válido');
}

// ── 3. sincronizarContactosPessoa (regras de principal + idempotência) ──
async function testSincronizar() {
  // 3a. Criar com um email e um telefone
  reiniciarBDStub();
  const p1 = criarPessoa();
  await sincronizarContactosPessoa(p1, [{ valor: 'joao@exemplo.pt', etiqueta: 'Pessoal', principal: true }], [{ valor: '912345678', etiqueta: '', principal: true }]);
  assert.strictEqual(estadoBD.criados.length, 2, 'cria email + telefone');
  const emailLinha = estadoBD.criados.find((c) => c.tipo === 'email');
  const telLinha = estadoBD.criados.find((c) => c.tipo === 'telefone');
  assert.strictEqual(emailLinha.valor, 'joao@exemplo.pt');
  assert.strictEqual(emailLinha.principal, true);
  assert.strictEqual(emailLinha.etiqueta, 'Pessoal');
  assert.strictEqual(telLinha.principal, true);
  assert.strictEqual(p1.atualizacoes.email, 'joao@exemplo.pt', 'principal sincroniza para pessoas.email');
  assert.strictEqual(p1.atualizacoes.telefone, '912345678', 'principal sincroniza para pessoas.telefone');

  // 3b. Vários emails e vários telefones (um principal por tipo)
  reiniciarBDStub();
  const p2 = criarPessoa();
  await sincronizarContactosPessoa(
    p2,
    [
      { valor: 'um@x.pt', etiqueta: '', principal: false },
      { valor: 'dois@x.pt', etiqueta: 'Trabalho', principal: true },
      { valor: 'tres@x.pt', etiqueta: '', principal: false },
    ],
    [
      { valor: '910000000', etiqueta: '', principal: true },
      { valor: '211000000', etiqueta: 'Casa', principal: false },
    ]
  );
  const emails2 = estadoBD.criados.filter((c) => c.tipo === 'email');
  const tels2 = estadoBD.criados.filter((c) => c.tipo === 'telefone');
  assert.strictEqual(emails2.length, 3, 'três emails criados');
  assert.strictEqual(tels2.length, 2, 'dois telefones criados');
  assert.strictEqual(emails2.filter((c) => c.principal).length, 1, 'apenas um email principal');
  assert.strictEqual(tels2.filter((c) => c.principal).length, 1, 'apenas um telefone principal');
  assert.strictEqual(emails2.find((c) => c.valor === 'dois@x.pt').principal, true, 'principal é o marcado');
  assert.strictEqual(p2.atualizacoes.email, 'dois@x.pt', 'pessoas.email = principal');
  assert.strictEqual(p2.atualizacoes.telefone, '910000000', 'pessoas.telefone = principal');

  // 3c. Alterar principal (gravar de novo com outro principal)
  reiniciarBDStub();
  const p3 = criarPessoa();
  await sincronizarContactosPessoa(p3, [{ valor: 'um@x.pt', principal: true }, { valor: 'dois@x.pt', principal: false }], []);
  assert.strictEqual(p3.atualizacoes.email, 'um@x.pt');
  reiniciarBDStub();
  await sincronizarContactosPessoa(p3, [{ valor: 'um@x.pt', principal: false }, { valor: 'dois@x.pt', principal: true }], []);
  const emails3 = estadoBD.criados.filter((c) => c.tipo === 'email');
  assert.strictEqual(estadoBD.destruicoes.length, 1, 'volta a substituir (destrói primeiro)');
  assert.strictEqual(emails3.length, 2);
  assert.strictEqual(emails3.find((c) => c.valor === 'dois@x.pt').principal, true, 'novo principal após alteração');
  assert.strictEqual(p3.atualizacoes.email, 'dois@x.pt');

  // 3d. Sem principal marcado → o primeiro contacto fica principal
  reiniciarBDStub();
  const p4 = criarPessoa();
  await sincronizarContactosPessoa(p4, [{ valor: 'primeiro@x.pt', principal: false }, { valor: 'segundo@x.pt', principal: false }], []);
  const emails4 = estadoBD.criados.filter((c) => c.tipo === 'email');
  assert.strictEqual(emails4.find((c) => c.valor === 'primeiro@x.pt').principal, true, 'primeiro promovido a principal');
  assert.strictEqual(p4.atualizacoes.email, 'primeiro@x.pt');

  // 3e. Remover todos os emails (fica só telefone) → pessoas.email limpo
  reiniciarBDStub();
  const p5 = criarPessoa();
  p5.email = 'antigo@x.pt';
  await sincronizarContactosPessoa(p5, [], [{ valor: '912000000', principal: true }]);
  assert.strictEqual(estadoBD.criados.length, 1, 'apenas o telefone é criado');
  assert.strictEqual(estadoBD.criados[0].tipo, 'telefone');
  assert.strictEqual(p5.atualizacoes.email, null, 'sem emails → campo legado limpo');
  assert.strictEqual(p5.atualizacoes.telefone, '912000000');

  // 3f. Remover todos os telefones → pessoas.telefone limpo
  reiniciarBDStub();
  const p6 = criarPessoa();
  p6.telefone = '912000000';
  await sincronizarContactosPessoa(p6, [{ valor: 'a@x.pt', principal: true }], []);
  assert.strictEqual(estadoBD.criados.length, 1);
  assert.strictEqual(estadoBD.criados[0].tipo, 'email');
  assert.strictEqual(p6.atualizacoes.telefone, null, 'sem telefones → campo legado limpo');

  // 3g. Guardar várias vezes a mesma lista → nunca duplica
  reiniciarBDStub();
  const p7 = criarPessoa();
  const lista = [
    { valor: 'um@x.pt', etiqueta: 'Pessoal', principal: true },
    { valor: 'dois@x.pt', etiqueta: 'Trabalho', principal: false },
  ];
  await sincronizarContactosPessoa(p7, lista, []);
  const primeira = estadoBD.criados.length;
  await sincronizarContactosPessoa(p7, lista, []);
  const segunda = estadoBD.criados.length;
  assert.strictEqual(primeira, 2);
  assert.strictEqual(segunda, 2, 'gravações repetidas não acumulam contactos');
  assert.strictEqual(estadoBD.destruicoes.length, 2, 'cada gravação substitui os anteriores');
}

// ── 4. Resolução de preferidos (contactos) e fallback legado ──
async function testPreferidos() {
  // 4a. Dois emails → apenas o principal é escolhido
  models.ContactoPessoa.findAll = stubFindAllOrdenado([
    { id: 10, pessoa_id: 1, valor: 'secundario@x.pt', principal: false, ativo: true, tipo: 'email' },
    { id: 11, pessoa_id: 1, valor: 'principal@x.pt', principal: true, ativo: true, tipo: 'email' },
  ]);
  const mapa = await emailsPreferidosPorPessoa([1]);
  assert.strictEqual(mapa.get(1), 'principal@x.pt', 'email principal preferido');

  // 4b. emailPreferido devolve o principal dos contactos
  const pessoaComContactos = { id: 1, email: 'legado@x.pt' };
  assert.strictEqual(await emailPreferido(pessoaComContactos), 'principal@x.pt', 'preferido vem dos contactos, não do legado');

  // 4c. Sem contactos → valor legado de pessoa.email
  models.ContactoPessoa.findAll = stubFindAllOrdenado([]);
  assert.strictEqual(await emailPreferido(pessoaComContactos), 'legado@x.pt', 'sem contactos usa pessoa.email');

  // 4d. telefonePreferido com contacto
  models.ContactoPessoa.findOne = async () => ({ pessoa_id: 1, valor: '912 000 000', ativo: true, tipo: 'telefone' });
  const pessoaComTelefone = { id: 1, telefone: '210000000' };
  assert.strictEqual(await telefonePreferido(pessoaComTelefone), '912 000 000', 'telefone preferido dos contactos');

  // 4e. Sem contacto de telefone → legado
  models.ContactoPessoa.findOne = async () => null;
  assert.strictEqual(await telefonePreferido(pessoaComTelefone), '210000000', 'sem contactos usa pessoa.telefone');
}

// ── 5. resolverDestinatarios continua a escolher apenas o email principal ──
async function testResolverDestinatarios() {
  const { resolverDestinatarios } = require('../helpers/avisos');

  // Duas pessoas ativas: uma com emails (principal + secundário), outra sem email
  models.Pessoa.findAll = async () => [
    { id: 1, nome: 'Ana', email: 'ana-legado@x.pt' },
    { id: 2, nome: 'Bruno', email: null },
  ];
  models.ContactoPessoa.findAll = stubFindAllOrdenado([
    { id: 20, pessoa_id: 1, valor: 'ana.secundario@x.pt', principal: false, ativo: true, tipo: 'email' },
    { id: 21, pessoa_id: 1, valor: 'ana.principal@x.pt', principal: true, ativo: true, tipo: 'email' },
  ]);

  const destinatarios = await resolverDestinatarios({ modo: 'todos' });
  assert.strictEqual(destinatarios.length, 1, 'apenas quem tem email é destinatário');
  assert.strictEqual(destinatarios[0].pessoa_id, 1);
  assert.strictEqual(destinatarios[0].email, 'ana.principal@x.pt', 'usado apenas o email principal');
  assert.ok(destinatarios[0].email !== 'ana.secundario@x.pt', 'nunca envia para emails secundários');
}

// ── 6. Vista da ficha (render) ──
function testVista() {
  Object.entries(helpers).forEach(([k, v]) => handlebars.registerHelper(k, v));
  const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'condominos', 'form.handlebars'), 'utf8');
  const tpl = handlebars.compile(src);
  const base = { titulo: 'X', fracoes: [], pessoa: null, edicao: false };

  // 6a. Nova ficha: uma linha vazia de cada tipo, sem campos únicos
  let html = tpl({
    ...base,
    contactosForm: {
      emails: [{ id: null, valor: '', etiqueta: '', principal: true }],
      telefones: [{ id: null, valor: '', etiqueta: '', principal: true }],
    },
  });
  assert.ok(html.includes('name="contactos[email][valor][]"'), 'input de email repetível presente');
  assert.ok(html.includes('name="contactos[email][etiqueta][]"'), 'etiqueta de email presente');
  assert.ok(html.includes('name="contactos[telefone][valor][]"'), 'input de telefone repetível presente');
  assert.ok(html.includes('name="contactos[telefone][principal]"'), 'radio principal de telefone presente');
  assert.ok(html.includes('Adicionar email'), 'botão adicionar email');
  assert.ok(html.includes('Adicionar telefone'), 'botão adicionar telefone');
  assert.ok(html.includes('Pessoal') && html.includes('Empresa'), 'etiquetas sugeridas');
  assert.ok(!/"name="email"|name='email'/.test(html), 'sem campo único email antigo');
  assert.ok(!/"name="telefone"|name='telefone'/.test(html), 'sem campo único telefone antigo');

  // 6b. Edição com contactos existentes (múltiplos emails/telefones, principal marcado)
  html = tpl({
    ...base,
    edicao: true,
    pessoa: { id: 3, nome: 'João Silva', ativo: true },
    contactosForm: {
      emails: [
        { id: 1, valor: 'joao@exemplo.pt', etiqueta: 'Pessoal', principal: true },
        { id: 2, valor: 'trabalho@empresa.pt', etiqueta: 'Trabalho', principal: false },
      ],
      telefones: [{ id: 3, valor: '912 345 678', etiqueta: 'Telemóvel', principal: true }],
    },
  });
  assert.ok(html.includes('value="joao@exemplo.pt"'), 'email existente aparece');
  assert.ok(html.includes('value="trabalho@empresa.pt"'), 'segundo email aparece');
  assert.ok(html.includes('value="912 345 678"'), 'telefone existente aparece');
  assert.ok(html.includes('value="0"'), 'radio principal com índice 0');
  assert.ok(html.includes('/admin/condominos/3'), 'form aponta para a edição');

  // 6c. Compatibilidade: apenas legado pessoa.email/telefone → mostrado na ficha
  html = tpl({
    ...base,
    edicao: true,
    pessoa: { id: 5, nome: 'Maria', ativo: true },
    contactosForm: {
      emails: [{ id: null, valor: 'maria@x.pt', etiqueta: '', principal: true, legado: true }],
      telefones: [{ id: null, valor: '915000000', etiqueta: '', principal: true, legado: true }],
    },
  });
  assert.ok(html.includes('value="maria@x.pt"'), 'valor legado do email aparece na ficha');
  assert.ok(html.includes('value="915000000"'), 'valor legado do telefone aparece na ficha');
}

async function main() {
  testParsing();
  testValidacao();
  await testSincronizar();
  await testPreferidos();
  await testResolverDestinatarios();
  testVista();

  // Restauro dos métodos originais (higiéne, embora o processo termine)
  models.ContactoPessoa.destroy = orig.destroy;
  models.ContactoPessoa.bulkCreate = orig.bulkCreate;
  models.ContactoPessoa.findAll = orig.findAllCP;
  models.ContactoPessoa.findOne = orig.findOneCP;
  models.Pessoa.findAll = orig.findAllPessoa;

  console.log('✓ Testes de contactos inline passaram (sem base de dados).');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
