// ─────────────────────────────────────────────────────────────────────
// StorageProvider — abstração do armazenamento de ficheiros/PDFs.
//
// Hoje existe apenas o provedor 'google_drive' (helpers/drive). A aplicação
// deve falar com esta fachada (helpers/storage) e não diretamente com o
// drive, para que futuramente se possa trocar/adicionar provedores sem
// tocar nas rotas. O provedor é selecionado por STORAGE_PROVIDER (default:
// google_drive).
// ─────────────────────────────────────────────────────────────────────
const drive = require('./drive');

const PROVIDERS = {
  google_drive: drive,
};

function provedorAtual() {
  const nome = (process.env.STORAGE_PROVIDER || 'google_drive').trim().toLowerCase();
  return PROVIDERS[nome] || drive;
}

module.exports = {
  nome() {
    const nome = (process.env.STORAGE_PROVIDER || 'google_drive').trim().toLowerCase();
    return PROVIDERS[nome] ? nome : 'google_drive';
  },

  isConfigured() {
    return provedorAtual().isConfigured();
  },

  // Delegações para o provedor ativo (Google Drive hoje).
  uploadArquivo(opcoes) {
    return provedorAtual().uploadArquivo(opcoes);
  },
  pastaParaDocumento(tipo, ano) {
    return provedorAtual().pastaParaDocumento(tipo, ano);
  },
  descargarArquivo(fileId) {
    return provedorAtual().descargarArquivo(fileId);
  },
  estadoLigacao() {
    return provedorAtual().estadoLigacao();
  },
  testarLigacao() {
    return provedorAtual().testarLigacao();
  },
  criarEstruturaPastas() {
    return provedorAtual().criarEstruturaPastas();
  },
};
