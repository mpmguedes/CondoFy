// Testes da convocatória (carta oficial A4) — sem base de dados.
// Utilização: node scripts/test-convocatoria.js
const assert = require('assert');
const {
  parseHora,
  somarMinutos,
  hojeInput,
  normalizarPontos,
  construirDocumento,
} = require('../helpers/convocatoria');
const { gerarConvocatoriaCartaPDF } = require('../helpers/pdf-convocatoria');
const pdf = require('../helpers/pdf'); // wrapper usado pelas assembleias

const COND = {
  designacao: 'Condomínio do Edifício Residencial Vista Mar',
  administracao_nome: 'Gestcondomínio, Unipessoal Lda.',
  morada: 'Rua Doutor António José de Almeida, 1234',
  codigo_postal: '1000-000',
  localidade: 'Lisboa',
};

const BASE = {
  edificioNome: COND.designacao,
  morada: COND.morada,
  codigoPostal: COND.codigo_postal,
  cidade: COND.localidade,
  administracaoNome: COND.administracao_nome,
  numero: '2026/1',
  tipo: 'ordinaria',
  data: '2026-09-04',
  hora: '19:47',
  local: 'Salão de festas do edifício, piso 0',
  dataEmissao: '2026-08-28',
  pontos: [
    'Aprovação do orçamento para o ano de 2027',
    'Apresentação e aprovação das contas do exercício anterior',
    'Eleição da administração',
    'Outros assuntos de interesse do condomínio',
  ],
};

function contarPaginas(buffer) {
  return (buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
}

async function main() {
  // 1. Horas — segunda convocatória = 1.ª + 30 min
  assert.strictEqual(somarMinutos('19:47', 30), '20:17', '19:47 + 30 = 20:17');
  assert.strictEqual(somarMinutos('23:45', 30), '00:15', 'roda a meia-noite');
  assert.strictEqual(somarMinutos('09:05', 30), '09:35', '9:05 + 30 = 9:35');
  assert.strictEqual(somarMinutos('', 30), '', 'hora vazia → vazio');
  assert.ok(parseHora('19:47'), '19:47 válida');
  assert.strictEqual(parseHora('25:00'), null, 'hora inválida');

  // 2. Pontos — limpeza de numeração manual e linhas
  assert.deepStrictEqual(normalizarPontos(['1. Aprovação do orçamento', '2) Eleição da administração', '', '3 - Outros assuntos']), [
    'Aprovação do orçamento',
    'Eleição da administração',
    'Outros assuntos',
  ], 'remove numeração manual');

  // 3. Composição do documento — textos dinâmicos
  const doc = construirDocumento(BASE);
  assert.strictEqual(doc.tipoLabel, 'Ordinária');
  assert.strictEqual(doc.horaSegunda, '20:17', '2.ª convocatória calculada');
  assert.strictEqual(doc.dataLonga, '4 de setembro de 2026');
  assert.strictEqual(doc.dia, 'sexta-feira', 'dia da semana automático');
  assert.ok(doc.textos.titulo.includes('Ordinária'), 'título com tipo');
  assert.ok(doc.textos.introducao.includes('no próximo dia sexta-feira, 4 de setembro de 2026'), 'introdução com data');
  assert.ok(doc.textos.introducao.includes('pelas 19:47'), 'introdução com hora');
  assert.ok(doc.textos.textoPrimeira.includes('500 permilagens'), '500 permilagens por extenso');
  assert.ok(doc.textos.textoSegunda.includes('250 permilagens') && doc.textos.textoSegunda.includes('20:17'), '250 permilagens + hora');
  assert.ok(doc.textos.linhaIdentificacao.includes('Reunião n.º 2026/1'), 'identificação da reunião');
  assert.strictEqual(doc.pontos.length, 4);

  // 4. PDF — carta oficial numa única página A4
  const carta = await gerarConvocatoriaCartaPDF(COND, BASE);
  assert.strictEqual(carta.slice(0, 5).toString(), '%PDF-', 'PDF válido');
  assert.strictEqual(contarPaginas(carta), 1, 'carta: única página A4');

  // 5. Extraordinária + autorização por email no rodapé
  const extra = await gerarConvocatoriaCartaPDF(COND, {
    ...BASE,
    numero: '2026/2',
    tipo: 'extraordinaria',
    data: '2026-11-20',
    emailAutorizado: true,
    dataEmissao: hojeInput(),
  });
  assert.strictEqual(contarPaginas(extra), 1, 'extraordinária: única página A4');

  // 6. Muitos pontos — continua numa única página (adaptação automática)
  const muitos = [];
  for (let i = 0; i < 20; i++) {
    muitos.push(`Ponto ${i + 1}: deliberação com texto longo para testar wrapping automático do layout`);
  }
  const comMuitos = await gerarConvocatoriaCartaPDF(COND, { ...BASE, numero: '2026/3', pontos: muitos });
  assert.strictEqual(contarPaginas(comMuitos), 1, 'carta: 20 pontos numa página');

  // 7. Pontos extensos (várias linhas) — nunca cria segunda página
  const longos = [];
  for (let i = 0; i < 10; i++) {
    longos.push(
      `Ponto ${i + 1}: apreciação e deliberação sobre o relatório detalhado de despesas ordinárias e extraordinárias, ` +
        'incluindo a apresentação dos comprovativos e a discussão das propostas apresentadas pelos condóminos.'
    );
  }
  const comLongos = await gerarConvocatoriaCartaPDF(COND, { ...BASE, numero: '2026/4', pontos: longos });
  assert.strictEqual(contarPaginas(comLongos), 1, 'carta: pontos extensos numa página');

  // 8. Wrapper usado pelas assembleias (pdf.gerarConvocatoriaPDF) mantém-se válido
  const wrapper = await pdf.gerarConvocatoriaPDF(COND, {
    numero: '2026/5',
    tipo: 'Ordinária',
    data: '2026-09-04',
    hora: '21:00',
    horaSegunda: '21:30',
    local: 'Hall de entrada do edifício',
    ordemTrabalhos: ['1. Aprovação do orçamento anual', 'Eleição do administrador', 'Outros assuntos'],
  });
  assert.strictEqual(wrapper.slice(0, 5).toString(), '%PDF-', 'wrapper: PDF válido');
  assert.strictEqual(contarPaginas(wrapper), 1, 'wrapper: única página A4');

  console.log('✓ Todos os testes da convocatória passaram.');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
