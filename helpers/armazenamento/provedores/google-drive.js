// ─────────────────────────────────────────────────────────────────────
// Adaptador do Google Drive para o contrato de armazenamento.
//
// É uma camada fina sobre helpers/drive.js (a integração OAuth + API Drive
// v3 já existente e testada): NÃO duplica lógica nem altera comportamento.
// A ligação é a da plataforma (conta Google configurada em Configuração →
// Armazenamento e Backups), com isolamento físico por condomínio na árvore
// de pastas, como até aqui.
//
// Segurança: este adaptador não cria nem usa links de partilha. O único
// "link" que conhece (webViewLink, devolvido em `url`) é metadado do
// fornecedor e NUNCA é usado para servir documentos — o acesso passa sempre
// pelo backend do GesCondu (helpers/documentos-acesso.js).
// ─────────────────────────────────────────────────────────────────────
const drive = require('../../drive');

function capacidades() {
  return { oauth: true, pastas: true, streaming: true, backups: true };
}

// `estadoLigacao` do drive.js já devolve a forma usada pela interface
// (ativo, credenciais, redirectUriDefinido, ligado, viaEnv, conta). Aqui
// acrescenta-se a identificação do provedor.
async function estadoLigacao(condominioId) {
  const e = await drive.estadoLigacao(condominioId);
  return { ...e, provedor: 'google_drive' };
}

module.exports = {
  nome: () => 'google_drive',
  rotulo: () => 'Google Drive',

  capacidades,

  featureAtiva: () => process.env.GOOGLE_DRIVE_ENABLED === 'true',

  temCredenciais: () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),

  redirectUriDefinido: () => Boolean(process.env.GOOGLE_REDIRECT_URI),

  isConfigured: (condominioId) => drive.isConfigured(condominioId),

  estadoLigacao,

  testarLigacao: (condominioId) => drive.testarLigacao(condominioId),

  // Fluxo OAuth (a rota de callback continua a ser a histórica).
  urlAutorizacao: ({ redirectUri, state, condominioId }) =>
    drive.construirUrlAutorizacao({ redirectUri, state, condominioId }),

  trocarCodigo: (opcoes) => drive.trocarCodigo(opcoes),

  desligar: (condominioId) => drive.desligar(condominioId),

  // Escritas
  uploadArquivo: (opcoes) => drive.uploadArquivo(opcoes),
  pastaParaDocumento: (tipo, ano, condominioId) => drive.pastaParaDocumento(tipo, ano, condominioId),
  pastaParaFornecedor: (opcoes) => drive.pastaParaFornecedor(opcoes),
  obterPastaCondominioId: (condominioId) => drive.obterPastaCondominioId(condominioId),
  criarEstruturaPastas: (condominioId, ano) => drive.criarEstruturaPastas(condominioId, ano),

  // Leituras (o id já vem resolvido pelo localizador, sem prefixo no Drive)
  descarregarArquivo: (fileId, condominioId) => drive.descargarArquivo(fileId, condominioId),
  abrirFluxo: (fileId, condominioId) => drive.abrirFluxo(fileId, condominioId),

  // Atalho de administração para o painel do fornecedor (nunca para servir
  // documentos). Devolve null quando não há pasta.
  linkPasta: (pastaId) => drive.linkPastaDrive(pastaId),

  // Expediente usado por jobs/backup.js e por código legado.
  cliente: (condominioId) => drive.getDrive(condominioId),
};
