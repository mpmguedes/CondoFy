// Testes das vistas da Nova Convocatória (Handlebars) — sem base de dados.
// Utilização: node scripts/test-vistas.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const helpers = require('../helpers/handlebars-helpers');
const { construirDocumento } = require('../helpers/convocatoria');

const ROOT = path.join(__dirname, '..', 'views');

function ler(relativa) {
  return fs.readFileSync(path.join(ROOT, relativa), 'utf8');
}

Object.keys(helpers).forEach((k) => handlebars.registerHelper(k, helpers[k]));

const parciais = {
  '_flash': ler('partials/_flash.handlebars'),
  '_empty-state': ler('partials/_empty-state.handlebars'),
  '_convocatoria-documento': ler('partials/_convocatoria-documento.handlebars'),
  '_convocatoria-editor': ler('partials/_convocatoria-editor.handlebars'),
};
Object.keys(parciais).forEach((k) => handlebars.registerPartial(k, parciais[k]));

const layout = handlebars.compile(ler('layouts/main.handlebars'));
const nova = handlebars.compile(ler('admin/convocatorias/nova.handlebars'));
const editor = handlebars.compile(parciais['_convocatoria-editor']);
const documento = handlebars.compile(parciais['_convocatoria-documento']);

const valores = {
  edificio_nome: 'Condomínio do Edifício Residencial Vista Mar',
  morada: 'Rua Doutor António José de Almeida, 1234',
  codigo_postal: '1000-000',
  cidade: 'Lisboa',
  administracao_nome: 'Gestcondomínio, Unipessoal Lda.',
  reuniao_numero: '2026/1',
  tipo: 'ordinaria',
  data: '2026-09-04',
  hora: '19:47',
  local: 'Salão de festas do edifício, piso 0',
  data_emissao: '2026-08-28',
  email_autorizado: true,
  pontos: ['Aprovação do orçamento para 2027', 'Apresentação e aprovação das contas', 'Eleição da administração'],
};

const previa = construirDocumento({
  edificioNome: valores.edificio_nome,
  morada: valores.morada,
  codigoPostal: valores.codigo_postal,
  cidade: valores.cidade,
  administracaoNome: valores.administracao_nome,
  numero: valores.reuniao_numero,
  tipo: valores.tipo,
  data: valores.data,
  hora: valores.hora,
  local: valores.local,
  dataEmissao: valores.data_emissao,
  emailAutorizado: valores.email_autorizado,
  pontos: valores.pontos,
});

const contexto = {
  titulo: 'Nova Convocatória',
  valores,
  previa: null,
  user: { nome: 'Admin', email: 'admin@exemplo.pt' },
  isAdmin: true,
  condominio: { designacao: valores.edificio_nome },
  currentPath: '/admin/convocatorias/nova',
};

// 1. Modo edição
let html = nova(contexto);
assert.ok(html.includes('Nova Convocatória'), 'título presente');
assert.ok(html.includes('name="edificio_nome"'), 'campo edifício');
assert.ok(html.includes('name="pontos[]"'), 'inputs de pontos');
assert.ok(html.includes('name="_acao" value="preview"'), 'botão pré-visualizar');
assert.ok(html.includes('name="_acao" value="pdf"'), 'botão gerar PDF');

// 2. Modo pré-visualização
html = nova({ ...contexto, previa });
assert.ok(html.includes('cv-preview-papel'), 'zona de pré-visualização');
assert.ok(html.includes('Convocatória para Assembleia Geral Ordinária'), 'título do documento');
assert.ok(html.includes('20:17'), '2.ª convocatória calculada visível');
assert.ok(html.includes('Reunião n.º 2026/1'), 'número da reunião');
assert.ok(html.includes('Gestcondomínio'), 'administração presente');
assert.ok(html.includes('Aprovação do orçamento para 2027'), 'ponto da ordem de trabalhos');
assert.ok(html.includes('500 permilagens'), 'quórum 500 permilagens');
assert.ok(html.includes('250 permilagens'), 'quórum 250 permilagens');
assert.ok(html.includes('Comunicação por email autorizada em assembleia anterior.'), 'rodapé email');

// 3. Extraordinária
const previaExtra = construirDocumento({ ...previa, tipo: 'extraordinaria', numero: '2026/2' });
html = documento({ doc: previaExtra });
assert.ok(html.includes('Convocatória para Assembleia Geral Extraordinária'), 'título extraordinária');

// 4. Editor isolado (render sem erros, mantém valores)
html = editor({ v: valores });
assert.ok(html.includes('value="19:47"'), 'hora preservada no editor');

// 5. Layout principal integra o item de navegação
html = layout({ body: 'ok', user: contexto.user, isAdmin: true, condominio: contexto.condominio, currentPath: '/admin/convocatorias/nova' });
assert.ok(html.includes('/admin/convocatorias/nova'), 'link de navegação Convocatórias');

console.log('✓ Todas as vistas da convocatória renderizam corretamente.');
