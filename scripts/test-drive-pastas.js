// Testes do isolamento físico no Google Drive por condomínio — sem rede/BD.
//
// Verifica, na camada de planeamento (nomes da hierarquia = fonte única usada
// pelos resolvedores reais em helpers/drive.js), que:
//  · cada condomínio tem a sua própria árvore (A ≠ B para o mesmo tipo/ano);
//  · recibos/documentos de condomínios diferentes nunca partilham pasta;
//  · o mapeamento tipo → subpasta se mantém (recibo→Recibos, etc.);
//  · fornecedores (comprovativos) ficam dentro da árvore do condomínio;
//  · a pasta do condomínio usa o NOME amigável (nunca o id no nome).
//
// Utilização: node scripts/test-drive-pastas.js
const assert = require('assert');
const {
  nomePastaCondominio,
  subpastaDoTipo,
  caminhoPastaDocumento,
  caminhoPastaFornecedor,
  linkPastaDrive,
} = require('../helpers/drive');

const RAIZ = 'GesCondu';
const A = 'Condomínio Jardim das Flores';
const B = 'Condomínio Quinta do Sol';

function testarNomePastaCondominio() {
  assert.strictEqual(nomePastaCondominio({ id: 17, designacao: 'Condomínio Jardim das Flores' }), 'Condomínio Jardim das Flores', 'nome amigável preservado');
  assert.strictEqual(nomePastaCondominio({ id: 17, designacao: '  Jardim   ' }), 'Jardim', 'designação limpa de espaços');
  // Nunca "17 - ..." nem "condominio_17".
  assert.ok(!nomePastaCondominio({ id: 17, designacao: 'X' }).includes('17'), 'sem id no nome');
  // Nome puramente numérico (colidiria com pastas de anos antigas) é prefixado.
  assert.strictEqual(nomePastaCondominio({ id: 3, designacao: '2026' }), 'Condomínio 2026', 'nome numérico prefixado');
  assert.strictEqual(nomePastaCondominio({ id: 9, designacao: '' }), 'Condomínio 9', 'sem designação → fallback com id');
  assert.strictEqual(nomePastaCondominio({}), 'Condomínio', 'sem dados → genérico');
}

function testarSubpastaPorTipo() {
  assert.strictEqual(subpastaDoTipo('recibo'), 'Recibos', 'recibo → Recibos');
  assert.strictEqual(subpastaDoTipo('aviso_quota'), 'Quotas', 'aviso de quota → Quotas');
  assert.strictEqual(subpastaDoTipo('ata'), 'Assembleias', 'ata → Assembleias');
  assert.strictEqual(subpastaDoTipo('convocatoria'), 'Assembleias', 'convocatória → Assembleias');
  assert.strictEqual(subpastaDoTipo('fatura'), 'Despesas', 'fatura → Despesas');
  assert.strictEqual(subpastaDoTipo('contrato'), 'Contratos', 'contrato → Contratos');
  assert.strictEqual(subpastaDoTipo('relatorio'), 'Outros', 'relatório → Outros');
  assert.strictEqual(subpastaDoTipo('orcamento'), 'Outros', 'orçamento → Outros');
  assert.strictEqual(subpastaDoTipo('outro'), 'Outros', 'outro → Outros');
  assert.strictEqual(subpastaDoTipo('desconhecido'), 'Outros', 'tipo desconhecido → Outros');
}

function testarIsolamentoDocumentos() {
  // Mesmo tipo, mesmo ano, condomínios diferentes → árvores diferentes.
  const reciboA = caminhoPastaDocumento({ raiz: RAIZ, condominioNome: A, ano: 2026, tipo: 'recibo' });
  const reciboB = caminhoPastaDocumento({ raiz: RAIZ, condominioNome: B, ano: 2026, tipo: 'recibo' });
  assert.deepStrictEqual(reciboA, [RAIZ, A, '2026', 'Recibos'], 'recibo A → A/2026/Recibos');
  assert.deepStrictEqual(reciboB, [RAIZ, B, '2026', 'Recibos'], 'recibo B → B/2026/Recibos');
  assert.notDeepStrictEqual(reciboA, reciboB, 'A ≠ B no mesmo ano/tipo');

  // Documentos genéricos no mesmo ano também ficam separados.
  const docA = caminhoPastaDocumento({ raiz: RAIZ, condominioNome: A, ano: 2026, tipo: 'ata' });
  const docB = caminhoPastaDocumento({ raiz: RAIZ, condominioNome: B, ano: 2026, tipo: 'ata' });
  assert.notDeepStrictEqual(docA, docB, 'documentos de A e B separados');

  // Dois tipos dentro do MESMO condomínio partilham o prefixo mas diferem na subpasta.
  const recibo = caminhoPastaDocumento({ raiz: RAIZ, condominioNome: A, ano: 2025, tipo: 'recibo' });
  const contrato = caminhoPastaDocumento({ raiz: RAIZ, condominioNome: A, ano: 2025, tipo: 'contrato' });
  assert.strictEqual(recibo[2], '2025', 'ano no caminho');
  assert.notStrictEqual(recibo[3], contrato[3], 'subpastas de tipos diferentes');

  // Um ficheiro com o mesmo nome/ano em A e em B cai sempre em pastas distintas
  // (o caminho diverge no nível do condomínio, antes do ano/tipo).
  assert.strictEqual(reciboA[1], A);
  assert.strictEqual(reciboB[1], B);
  assert.notStrictEqual(reciboA[1], reciboB[1], 'nível do condomínio diferente');
}

function testarIsolamentoFornecedores() {
  const supA = caminhoPastaFornecedor({ raiz: RAIZ, condominioNome: A, ano: 2026, nome: 'Empresa X' });
  const supB = caminhoPastaFornecedor({ raiz: RAIZ, condominioNome: B, ano: 2026, nome: 'Empresa X' });
  assert.deepStrictEqual(supA, [RAIZ, A, '2026', 'Fornecedores', 'Empresa X', 'Comprovativos'], 'fornecedor A dentro da árvore de A');
  assert.deepStrictEqual(supB, [RAIZ, B, '2026', 'Fornecedores', 'Empresa X', 'Comprovativos'], 'fornecedor B dentro da árvore de B');
  assert.notDeepStrictEqual(supA, supB, 'comprovativos do mesmo fornecedor separados por condomínio');
}

function testarLinkPasta() {
  assert.strictEqual(linkPastaDrive('abc123'), 'https://drive.google.com/drive/folders/abc123', 'link da pasta');
  assert.strictEqual(linkPastaDrive(null), null, 'sem folderId → null');
  assert.strictEqual(linkPastaDrive(''), null, 'folderId vazio → null');
}

testarNomePastaCondominio();
testarSubpastaPorTipo();
testarIsolamentoDocumentos();
testarIsolamentoFornecedores();
testarLinkPasta();
console.log('✓ Testes do isolamento Drive por condomínio passaram (sem rede).');
