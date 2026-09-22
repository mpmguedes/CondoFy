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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pastaHelpers = path.join(__dirname, '..', 'helpers');
const pastaRotas = path.join(__dirname, '..', 'routes');

// Todos os `.js` de uma pasta (recursivo). Usado para provar que o texto legal
// do quórum não está duplicado em dois geradores de convocatórias.
function ficheirosJs(pasta) {
  const out = [];
  for (const e of fs.readdirSync(pasta, { withFileTypes: true })) {
    const p = path.join(pasta, e.name);
    if (e.isDirectory()) out.push(...ficheirosJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

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

  // ─────────────────────────────────────────────────────────────────
  // 9. P27 — UM ÚNICO gerador de convocatórias (não duas vias paralelas)
  // ─────────────────────────────────────────────────────────────────
  // `helpers/pdf.js` não compõe a carta: `gerarConvocatoriaPDF` é um ADAPTADOR
  // que delega em `helpers/pdf-convocatoria.js`. Prova-se por INTERCEÇÃO —
  // substitui-se o motor no `require.cache` e verifica-se que é ele que corre
  // (e que o wrapper devolve o buffer dele, sem compor nada por si).
  const caminhoMotor = require.resolve('../helpers/pdf-convocatoria');
  const caminhoWrapper = require.resolve('../helpers/pdf');
  const motorReal = require.cache[caminhoMotor];
  const chamadas = [];
  require.cache[caminhoMotor] = {
    id: caminhoMotor,
    filename: caminhoMotor,
    loaded: true,
    children: [],
    paths: [],
    exports: {
      gerarConvocatoriaCartaPDF: async (cond, d) => {
        chamadas.push({ cond, d });
        return Buffer.from('%PDF-INTERCETADO');
      },
    },
  };
  delete require.cache[caminhoWrapper];
  const pdfIntercetado = require('../helpers/pdf');

  const doWrapper = await pdfIntercetado.gerarConvocatoriaPDF(COND, {
    numero: '2026/6',
    tipo: 'Assembleia Geral Extraordinária',
    data: '2026-11-20',
    hora: '21:00',
    horaSegunda: '21:30',
    local: 'Salão de festas',
    ordemTrabalhos: ['Aprovação do orçamento anual'],
  });
  assert.strictEqual(chamadas.length, 1, 'o wrapper chama o motor UMA única vez');
  assert.strictEqual(doWrapper.toString(), '%PDF-INTERCETADO', 'o wrapper devolve o buffer do MOTOR (não compõe nada)');
  assert.strictEqual(chamadas[0].cond, COND, 'o condomínio é entregue ao motor tal e qual');
  assert.strictEqual(chamadas[0].d.tipo, 'extraordinaria', '«Assembleia Geral Extraordinária» → tipo do motor');
  assert.deepStrictEqual(chamadas[0].d.ordemTrabalhos, ['Aprovação do orçamento anual'], 'a ordem de trabalhos chega ao motor');

  await pdfIntercetado.gerarConvocatoriaPDF(COND, { tipo: 'Urgência' });
  assert.strictEqual(chamadas[1].d.tipo, 'extraordinaria', '«Urgência» também é extraordinária no motor');
  await pdfIntercetado.gerarConvocatoriaPDF(COND, {});
  assert.strictEqual(chamadas[2].d.tipo, 'ordinaria', 'sem tipo indicado assume ordinária');

  // A data de emissão NÃO é inventada pelo adaptador: quem a omite fica com a
  // omissão do motor (`hojeInput()`, data LOCAL em ISO) e quem a indica é
  // respeitado. O adaptador injetava `new Date()`, que `isoData`
  // (`String(valor).slice(0,10)`) truncava para «Tue Sep 22» — e a carta saía
  // com «22 de setembro de 2001».
  await pdfIntercetado.gerarConvocatoriaPDF(COND, { numero: '2026/8' });
  assert.strictEqual(chamadas[3].d.dataEmissao, undefined, 'sem data de emissão, o adaptador NÃO injeta um `Date`');
  await pdfIntercetado.gerarConvocatoriaPDF(COND, { numero: '2026/9', dataEmissao: '2026-08-28' });
  assert.strictEqual(chamadas[4].d.dataEmissao, '2026-08-28', 'a data de emissão indicada é entregue tal e qual');

  // Repõe o motor real para o resto do teste.
  require.cache[caminhoMotor] = motorReal;
  delete require.cache[caminhoWrapper];
  const pdfReal = require('../helpers/pdf');

  // ─────────────────────────────────────────────────────────────────
  // 10. Equivalência — os DOIS pontos de entrada dão o MESMO documento
  // ─────────────────────────────────────────────────────────────────
  // É esta igualdade que garante que a convocatória gerada a partir da
  // assembleia é exatamente a do módulo Convocatórias (e não uma variante).
  const ENTRADA = {
    numero: '2026/7',
    tipo: 'ordinaria',
    data: '2026-09-04',
    hora: '21:00',
    horaSegunda: '21:30',
    local: 'Hall de entrada do edifício',
    ordemTrabalhos: ['Aprovação do orçamento anual', 'Eleição do administrador', 'Outros assuntos'],
  };
  const directo = await gerarConvocatoriaCartaPDF(COND, ENTRADA);
  const viaWrapper = await pdfReal.gerarConvocatoriaPDF(COND, { ...ENTRADA, tipo: 'Ordinária' });
  // Cada PDF leva dois elementos que mudam a cada geração e que NÃO são
  // conteúdo: o identificador do documento (`/ID`, aleatório por documento) e,
  // quando existir, a data dos metadados. Tudo o resto tem de coincidir.
  const semMetadados = (b) =>
    b
      .toString('latin1')
      .replace(/\/(CreationDate|ModDate)\s*\(D:[^)]*\)/g, '')
      .replace(/\/ID\s*\[[^\]]*\]/g, '');
  const resumo = (s) => crypto.createHash('sha256').update(s, 'latin1').digest('hex');
  assert.strictEqual(viaWrapper.length, directo.length, 'assembleia e Convocatórias: mesmo tamanho de PDF');
  assert.strictEqual(
    resumo(semMetadados(viaWrapper)),
    resumo(semMetadados(directo)),
    'assembleia e Convocatórias geram o MESMO documento (byte a byte, fora o /ID e a data dos metadados)'
  );

  // ─────────────────────────────────────────────────────────────────
  // 11. Anti-duplicação ao nível do código
  // ─────────────────────────────────────────────────────────────────
  // Duas vias de convocatória a sério trariam DUAS cópias do texto legal do
  // quórum (art. 1432.º CC) — e uma delas ficaria desatualizada. O texto vive
  // num único ficheiro de `helpers/`.
  const comTextoLegal = ficheirosJs(pastaHelpers)
    .filter((f) => fs.readFileSync(f, 'utf8').includes('1432.º'))
    .map((f) => path.relative(pastaHelpers, f).replace(/\\/g, '/'));
  assert.deepStrictEqual(comTextoLegal, ['convocatoria.js'], 'o texto legal do quórum existe num único ficheiro');

  // E nenhuma rota compõe a carta à mão: o PDF só nasce no motor partilhado.
  for (const rota of ['assembleias.js', 'convocatorias.js']) {
    const fonte = fs.readFileSync(path.join(pastaRotas, rota), 'utf8');
    assert.ok(!fonte.includes('new PDFDocument'), `routes/${rota} não constrói PDFs (usa o motor partilhado)`);
    assert.ok(/helpers\/pdf/.test(fonte), `routes/${rota} consome um gerador partilhado`);
  }

  console.log('✓ Todos os testes da convocatória passaram.');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
