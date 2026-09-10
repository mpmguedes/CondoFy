// ─────────────────────────────────────────────────────────────────────
// Estrutura de pastas — planners PUROS, partilhados por TODOS os provedores
// de armazenamento (Google Drive, Dropbox, OneDrive, futuros).
//
// Layout lógico (igual em qualquer provedor):
//
//   <raiz>/
//   ├── Backups/                          ← infraestrutura (global)
//   ├── <Condomínio A>/
//   │   └── <ano>/{Assembleias, Quotas, Recibos, Despesas, Contratos,
//   │                Outros, Fornecedores/<nome>/<subpasta>}
//   └── <Condomínio B>/…
//
// O condomínio é SEMPRE resolvido por condominio_id (nunca por nome de
// ficheiro, fração, tipo, ano, email ou pasta). Estas funções não falam com
// nenhuma API: são a fonte única de verdade dos nomes da hierarquia, usada
// pelos resolvedores reais e pelos testes offline.
// ─────────────────────────────────────────────────────────────────────

// Subpastas fixas criadas por ano (e por condomínio).
const NOMES_PASTAS_ANO = ['Assembleias', 'Quotas', 'Recibos', 'Despesas', 'Contratos', 'Outros'];

// Rótulo físico da subpasta por tipo de documento.
const SUBPASTA_POR_TIPO = {
  ata: 'Assembleias',
  convocatoria: 'Assembleias',
  aviso_quota: 'Quotas',
  recibo: 'Recibos',
  fatura: 'Despesas',
  contrato: 'Contratos',
  relatorio: 'Outros',
  orcamento: 'Outros',
  outro: 'Outros',
};

function subpastaDoTipo(tipo) {
  return SUBPASTA_POR_TIPO[tipo] || 'Outros';
}

// Nome amigável da pasta do condomínio na raiz (nunca o id no nome).
function nomePastaCondominio(cond) {
  const nome = String((cond && cond.designacao) || '').trim();
  if (nome) {
    // Nomes puramente numéricos colidiriam com as pastas de anos antigas
    // (<raiz>/<ano>); o prefixo mantém a árvore legível e sem ambiguidade.
    if (/^\d+$/.test(nome)) return `Condomínio ${nome}`;
    return nome;
  }
  return cond && cond.id ? `Condomínio ${cond.id}` : 'Condomínio';
}

function caminhoPastaDocumento({ raiz, condominioNome, ano, tipo }) {
  return [raiz, condominioNome, String(ano || new Date().getFullYear()), subpastaDoTipo(tipo)];
}

function caminhoPastaFornecedor({ raiz, condominioNome, ano, nome, subpasta = 'Comprovativos' }) {
  return [
    raiz,
    condominioNome,
    String(ano || new Date().getFullYear()),
    'Fornecedores',
    String(nome || 'Fornecedor'),
    String(subpasta || 'Outros'),
  ];
}

module.exports = {
  NOMES_PASTAS_ANO,
  SUBPASTA_POR_TIPO,
  subpastaDoTipo,
  nomePastaCondominio,
  caminhoPastaDocumento,
  caminhoPastaFornecedor,
};
