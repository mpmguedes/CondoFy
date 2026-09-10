// ─────────────────────────────────────────────────────────────────────
// StorageProvider — fachada ÚNICA de acesso ao armazenamento de ficheiros.
//
// Todos os documentos do GesCondu vivem num provedor externo escolhido POR
// CONDOMÍNIO (Google Drive, Dropbox, OneDrive, …) e são sempre servidos pelo
// backend depois de verificar Utilizador → Condomínio → Documento
// (helpers/documentos-acesso.js). Nenhuma vista nem email recebe links do
// fornecedor.
//
// Compatibilidade: sem STORAGE_PROVIDER definido e sem provedor escolhido no
// condomínio, o provedor é o Google Drive — exatamente como antes desta
// abstração. `isConfigured()` continua SÍNCRONO (as vistas dependem disso).
//
// Regras de resolução:
//  · ESCRITAS (upload/pastas): o provedor é o do condomínio (storage:provedor:c<id>);
//  · LEITURAS (descarregar/abrir): o provedor é o do LOCALIZADOR do ficheiro
//    (documentos.drive_file_id, com prefixo gd:/dbx:/od:), para que mudar de
//    provedor não torne ilegíveis os documentos já guardados.
// ─────────────────────────────────────────────────────────────────────
const REGISTO = require('./armazenamento/provedores');
const ligacoes = require('./armazenamento/ligacoes');
const locator = require('./armazenamento/locator');
const contrato = require('./armazenamento/contrato');

// ── Registo ─────────────────────────────────────────────────────────
function registo() {
  return REGISTO;
}

function provedoresDisponiveis() {
  return Object.keys(REGISTO);
}

function obterProvedor(nome) {
  const chave = String(nome || '').trim().toLowerCase();
  return REGISTO[chave] || null;
}

// Provedor por omissão (compatível com o contrato antigo): STORAGE_PROVIDER
// válido ou google_drive.
function nome() {
  return ligacoes.provedorPadrao();
}

// Provedor do condomínio (assíncrono: lê a escolha guardada na BD).
async function provedorDoCondominio(condominioId) {
  const nomeProvedor = await ligacoes.provedorDoCondominio(condominioId, REGISTO);
  return REGISTO[nomeProvedor] || REGISTO.google_drive;
}

async function nomeDoCondominio(condominioId) {
  return (await provedorDoCondominio(condominioId)).nome();
}

async function definirProvedorDoCondominio(condominioId, nomeProvedor) {
  if (!obterProvedor(nomeProvedor)) {
    throw new Error(`Provedor de armazenamento desconhecido: ${nomeProvedor}`);
  }
  return ligacoes.definirProvedor(condominioId, nomeProvedor);
}

// Estado de todos os provedores para um condomínio (usado pela interface de
// Configuração → Armazenamento e Backups).
async function estadoDoCondominio(condominioId) {
  const escolhido = String(await ligacoes.provedorDoCondominio(condominioId, REGISTO)).trim().toLowerCase();
  const lista = [];
  for (const [chave, p] of Object.entries(REGISTO)) {
    let estado;
    try {
      estado = await p.estadoLigacao(condominioId);
    } catch (err) {
      estado = { ativo: false, credenciais: false, ligado: false, viaEnv: false, conta: null, erro: err.message };
    }
    lista.push({
      nome: chave,
      rotulo: p.rotulo(),
      capacidades: p.capacidades(),
      escolhido: chave === escolhido,
      ligado: Boolean(estado.ligado),
      estado,
    });
  }
  return { escolhido, provedores: lista };
}

// ── Delegações (API histórica) ──────────────────────────────────────
// Sem condominioId usa-se o provedor por omissão (comportamento anterior).
function provedorParaEscrita(condominioId) {
  // Síncrono quando não há condomínio; caso contrário, o caller já resolveu
  // pelo provedorDoCondominio (ver métodos async abaixo).
  return REGISTO[ligacoes.provedorSync(condominioId, REGISTO)] || REGISTO.google_drive;
}

// Síncrono: útil para as vistas ("está ligado?").
function isConfigured(condominioId) {
  return provedorParaEscrita(condominioId).isConfigured(condominioId);
}

// Igual, mas com o provedor resolvido na BD (escolha do condomínio).
async function isConfiguredPara(condominioId) {
  const p = await provedorDoCondominio(condominioId);
  return p.isConfigured(condominioId);
}

function estadoLigacao(condominioId) {
  return provedorParaEscrita(condominioId).estadoLigacao(condominioId);
}

function testarLigacao(condominioId) {
  return provedorParaEscrita(condominioId).testarLigacao(condominioId);
}

function urlAutorizacao(opcoes = {}) {
  const p = obterProvedor(opcoes.provedor) || provedorParaEscrita(opcoes.condominioId);
  return p.urlAutorizacao(opcoes);
}

function trocarCodigo(opcoes = {}) {
  const p = obterProvedor(opcoes.provedor) || provedorParaEscrita(opcoes.condominioId);
  return p.trocarCodigo(opcoes);
}

function desligar(opcoes = {}) {
  // Aceita desligar(condominioId) (assinatura histórica) ou
  // desligar({ provedor, condominioId }).
  const alvo = typeof opcoes === 'object' && opcoes !== null ? opcoes : { condominioId: opcoes };
  const p = obterProvedor(alvo.provedor) || provedorParaEscrita(alvo.condominioId);
  return p.desligar(alvo.condominioId);
}

// ── Escritas ────────────────────────────────────────────────────────
async function uploadArquivo(opcoes = {}) {
  const p = await provedorDoCondominio(opcoes.condominioId);
  return p.uploadArquivo(opcoes);
}

async function pastaParaDocumento(tipo, ano, condominioId) {
  const p = await provedorDoCondominio(condominioId);
  return p.pastaParaDocumento(tipo, ano, condominioId);
}

async function pastaParaFornecedor(opcoes = {}) {
  const p = await provedorDoCondominio(opcoes.condominioId);
  return p.pastaParaFornecedor(opcoes);
}

async function obterPastaCondominioId(condominioId) {
  const p = await provedorDoCondominio(condominioId);
  return p.obterPastaCondominioId(condominioId);
}

async function criarEstruturaPastas(condominioId, ano) {
  const p = await provedorDoCondominio(condominioId);
  return p.criarEstruturaPastas(condominioId, ano);
}

// ── Leituras (provedor pelo LOCALIZADOR do ficheiro) ────────────────
function provedorDoLocalizador(localizador) {
  const { provedor } = locator.ler(localizador);
  return REGISTO[provedor] || null;
}

// Abre o ficheiro como fluxo (para servir ao cliente pelo GesCondu).
async function abrirFluxo(localizador, condominioId) {
  const { provedor, id } = locator.ler(localizador);
  const p = REGISTO[provedor];
  if (!p) throw new Error(`Não há provedor de armazenamento registado para o id indicado (${provedor || 'desconhecido'}).`);
  return p.abrirFluxo(id, condominioId);
}

async function descargarArquivo(localizador, condominioId) {
  const { provedor, id } = locator.ler(localizador);
  const p = REGISTO[provedor];
  if (!p) throw new Error(`Não há provedor de armazenamento registado para o id indicado (${provedor || 'desconhecido'}).`);
  return p.descarregarArquivo(id, condominioId);
}

// Alias em PT-PT (a fachada histórica chama-se descargarArquivo).
const descarregarArquivo = descargarArquivo;

// ── Atalhos de administração ────────────────────────────────────────
async function linkPasta(pastaId, condominioId) {
  const p = await provedorDoCondominio(condominioId);
  return p.linkPasta(pastaId);
}

// Compatibilidade com o nome histórico (só Google Drive).
function linkPastaDrive(pastaId) {
  return REGISTO.google_drive.linkPasta(pastaId);
}

// ── Localizadores ───────────────────────────────────────────────────
function montarLocalizador(provedor, id) {
  return locator.montar(provedor, id);
}

function lerLocalizador(valor) {
  return locator.ler(valor);
}

async function inicializar() {
  await ligacoes.inicializar();
}

module.exports = {
  // registo
  registo,
  provedores: provedoresDisponiveis,
  obterProvedor,
  nome,
  contrato,
  // por condomínio
  provedorDoCondominio,
  nomeDoCondominio,
  definirProvedorDoCondominio,
  estadoDoCondominio,
  // estado das ligações
  isConfigured,
  isConfiguredPara,
  estadoLigacao,
  testarLigacao,
  // OAuth
  urlAutorizacao,
  trocarCodigo,
  desligar,
  // escritas
  uploadArquivo,
  pastaParaDocumento,
  pastaParaFornecedor,
  obterPastaCondominioId,
  criarEstruturaPastas,
  // leituras
  abrirFluxo,
  // `descargarArquivo` é o nome histórico usado por routes/helpers — mantém-se
  // como canónico; `descarregarArquivo` fica como alias em PT-PT.
  descargarArquivo,
  descarregarArquivo: descargarArquivo,
  // atalhos
  linkPasta,
  linkPastaDrive,
  // localizadores
  montarLocalizador,
  lerLocalizador,
  // inicialização da cache de ligações
  inicializar,
};
