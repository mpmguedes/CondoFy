// ─────────────────────────────────────────────────────────────────────
// StorageProvider — fachada ÚNICA de acesso ao armazenamento de ficheiros.
//
// DOIS CONCEITOS SEPARADOS:
//
//  · ARMAZENAMENTO DE DOCUMENTOS — por condomínio. Cada condomínio escolhe o
//    seu serviço principal (Google Drive | Dropbox | OneDrive) e tem as suas
//    próprias contas autorizadas. Pode ter vários serviços ligados ao mesmo
//    tempo, mas só UM é o principal: é nele que ficam os documentos (sem
//    duplicação automática).
//
//  · BACKUPS — da instalação. O dump contém dados de todos os condomínios, por
//    isso o destino de backups usa uma ligação de PLATAFORMA (nunca a conta de
//    um condomínio) e pode ser um serviço diferente do principal.
//
// Segurança: o acesso aos documentos passa sempre pelo backend do GesCondu
// (helpers/documentos-acesso.js) depois de verificar sessão, condomínio e
// permissões. Não são criados links públicos nem se entrega nenhum URL do
// fornecedor ao browser. Os tokens ficam no backend, associados ao condomínio
// (ou à plataforma) e ao fornecedor, e nunca são expostos.
//
// Compatibilidade: sem escolha guardada e sem STORAGE_PROVIDER, o serviço é o
// Google Drive, com a conta de plataforma — exatamente como antes.
//
// Resolução do provedor:
//  · ESCRITAS (upload/pastas)  → principal do condomínio;
//  · LEITURAS (abrir/descarregar) → provedor do LOCALIZADOR do ficheiro, para
//    que mudar de serviço não torne ilegíveis os documentos já guardados.
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

function exigirProvedor(nome) {
  const p = obterProvedor(nome);
  if (!p) throw new Error(`Provedor de armazenamento desconhecido: ${nome}`);
  return p;
}

// Provedor por omissão (contrato histórico): STORAGE_PROVIDER ou google_drive.
function nome() {
  return ligacoes.provedorPadrao();
}

// ── Armazenamento principal do condomínio ───────────────────────────
async function nomePrincipalDoCondominio(condominioId) {
  return ligacoes.principalDoCondominio(condominioId, REGISTO);
}

async function principalDoCondominio(condominioId) {
  return exigirProvedor(await nomePrincipalDoCondominio(condominioId));
}

async function definirPrincipalDoCondominio(condominioId, nomeProvedor) {
  exigirProvedor(nomeProvedor);
  return ligacoes.definirPrincipal(condominioId, nomeProvedor);
}

// Alias históricos (mesma semântica).
const provedorDoCondominio = principalDoCondominio;
const nomeDoCondominio = nomePrincipalDoCondominio;
const definirProvedorDoCondominio = definirPrincipalDoCondominio;

// ── Rótulo para a interface ─────────────────────────────────────────
// Nome do serviço de armazenamento principal do condomínio, para as vistas
// não escreverem "Drive" fixo (o principal pode ser Dropbox ou OneDrive).
// Devolve um texto genérico quando ainda não há ligação. Síncrono (cache de
// ligações), para poder ser definido no layout de todas as páginas.
function rotuloPrincipal(condominioId) {
  const nome = ligacoes.principalSync(condominioId, REGISTO);
  const p = REGISTO[nome];
  if (p && p.isConfigured(condominioId)) return p.rotulo();
  return 'serviço de armazenamento do condomínio';
}

// Nem todos os serviços expõem link da pasta no painel do fornecedor (só o
// Google Drive; Dropbox e OneDrive não criam partilhas). Usa a capacidade do
// adaptador, sem fixar nomes de provedores.
function abrePastaNoFornecedor(condominioId) {
  const nome = ligacoes.principalSync(condominioId, REGISTO);
  const p = REGISTO[nome];
  if (!p || !p.isConfigured(condominioId)) return false;
  try {
    return Boolean(p.linkPasta('verificacao-de-capacidade'));
  } catch (err) {
    return false;
  }
}

// ── Estado para a interface ─────────────────────────────────────────
// Serviços do condomínio + armazenamento principal + backups da instalação.
async function estadoDoCondominio(condominioId) {
  const principal = String(await nomePrincipalDoCondominio(condominioId)).trim().toLowerCase();
  const provedores = [];

  for (const [chave, p] of Object.entries(REGISTO)) {
    let estado = null;
    let erro = null;
    try {
      estado = await p.estadoLigacao(condominioId);
    } catch (err) {
      erro = err.message;
    }
    const ligado = Boolean(estado && estado.ligado);
    const plataforma = Boolean(p.isConfigured && p.isConfigured(null));
    const origem = ligacoes.tokensSync(chave, condominioId).origem;
    provedores.push({
      nome: chave,
      rotulo: p.rotulo(),
      capacidades: p.capacidades(),
      // A instalação tem as credenciais técnicas para disponibilizar o serviço?
      disponivel: Boolean(p.temCredenciais && p.temCredenciais()),
      ligado,
      // Ligado através da conta da plataforma (só acontece no Google Drive).
      contaPlataforma: Boolean(ligado && origem === 'plataforma_fallback'),
      // Ligado à plataforma (usado pelos backups).
      ligadoPlataforma: plataforma,
      principal: chave === principal,
      conta: (estado && estado.conta) || null,
      erro,
      estado: estado || null,
    });
  }

  const destinoBackup = await ligacoes.lerDestinoBackup().catch(() => null);
  const pBackup = destinoBackup ? REGISTO[destinoBackup] : null;

  return {
    principal: REGISTO[principal] ? principal : locator.PROVEDOR_PADRAO,
    // Estado da cifragem das credenciais (mensagem administrativa quando a
    // chave da instalação não está configurada). Nunca inclui chaves/tokens.
    cifra: ligacoes.estadoCifra(),
    provedores,
    backup: {
      destino: destinoBackup,
      rotulo: pBackup ? pBackup.rotulo() : null,
      ligadoPlataforma: Boolean(pBackup && pBackup.isConfigured && pBackup.isConfigured(null)),
    },
    // Serviços com ligação de plataforma (podem servir de destino de backups).
    plataforma: Object.entries(REGISTO).map(([chave, p]) => ({
      nome: chave,
      rotulo: p.rotulo(),
      disponivel: Boolean(p.temCredenciais && p.temCredenciais()),
      ligado: Boolean(p.isConfigured && p.isConfigured(null)),
    })),
  };
}

// ── Delegações históricas ───────────────────────────────────────────
function provedorParaEscrita(condominioId) {
  return REGISTO[ligacoes.principalSync(condominioId, REGISTO)] || REGISTO.google_drive;
}

// Síncrono: para as vistas ("está ligado?").
function isConfigured(condominioId) {
  return provedorParaEscrita(condominioId).isConfigured(condominioId);
}

// Assíncrono: resolve o principal na BD (escolha do condomínio).
async function isConfiguredPara(condominioId) {
  const p = await principalDoCondominio(condominioId);
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

// Aceita desligar(condominioId) ou desligar({ provedor, condominioId, plataforma }).
function desligar(opcoes = {}) {
  const alvo = typeof opcoes === 'object' && opcoes !== null ? opcoes : { condominioId: opcoes };
  const p = obterProvedor(alvo.provedor) || provedorParaEscrita(alvo.condominioId);
  return p.desligar(alvo.condominioId, { plataforma: Boolean(alvo.plataforma) });
}

// ── Escritas (armazenamento principal do condomínio) ────────────────
async function uploadArquivo(opcoes = {}) {
  const p = await principalDoCondominio(opcoes.condominioId);
  if (!p.isConfigured(opcoes.condominioId)) {
    throw new Error(`O armazenamento principal do condomínio (${p.rotulo()}) não está ligado.`);
  }
  const r = await p.uploadArquivo(opcoes);
  // O valor guardado em documentos.drive_file_id tem SEMPRE o prefixo do
  // provedor (dbx:/od:; o Google Drive mantém o id simples, compatível com os
  // valores já gravados). Os adaptadores devolvem o id em bruto — é aqui, no
  // ponto único, que o localizador fica pronto a usar. Sem isto, um ficheiro
  // guardado fora do Drive seria lido como se fosse do Drive.
  const lido = locator.ler(r.provedorFileId || r.localizador || null);
  const localizador = lido.id ? locator.montar(p.nome(), lido.id) : r.localizador || null;
  return { ...r, localizador };
}

async function pastaParaDocumento(tipo, ano, condominioId) {
  const p = await principalDoCondominio(condominioId);
  return p.pastaParaDocumento(tipo, ano, condominioId);
}

async function pastaParaFornecedor(opcoes = {}) {
  const p = await principalDoCondominio(opcoes.condominioId);
  return p.pastaParaFornecedor(opcoes);
}

async function obterPastaCondominioId(condominioId) {
  const p = await principalDoCondominio(condominioId);
  return p.obterPastaCondominioId(condominioId);
}

async function criarEstruturaPastas(condominioId, ano) {
  const p = await principalDoCondominio(condominioId);
  return p.criarEstruturaPastas(condominioId, ano);
}

// ── Escritas com proveniência explícita (backups da instalação) ─────
// Usado apenas onde o destino é a plataforma (nunca documentos de condomínio).
async function uploadComProvedor(nomeProvedor, opcoes = {}) {
  const p = exigirProvedor(nomeProvedor);
  return p.uploadArquivo({ ...opcoes, plataforma: true });
}

async function pastaDeBackups(nomeProvedor) {
  const p = exigirProvedor(nomeProvedor);
  if (typeof p.pastaDeBackups === 'function') return p.pastaDeBackups();
  throw new Error(`O provedor ${p.rotulo()} não suporta destino de backups.`);
}

// ── Leituras (provedor pelo LOCALIZADOR do ficheiro) ────────────────
function provedorDoLocalizador(localizador) {
  const { provedor } = locator.ler(localizador);
  return REGISTO[provedor] || null;
}

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

// Remoção no fornecedor (capacidade opcional: usada pela retenção de backups).
// Devolve false quando o provedor não suporta remoção.
async function apagarArquivo(localizador, condominioId) {
  const { provedor, id } = locator.ler(localizador);
  const p = REGISTO[provedor];
  if (!p || typeof p.apagarArquivo !== 'function') return false;
  return p.apagarArquivo(id, condominioId);
}

// ── Backups (instalação) ────────────────────────────────────────────
async function destinoDeBackup() {
  return ligacoes.lerDestinoBackup().catch(() => null);
}

async function definirDestinoDeBackup(nomeProvedor) {
  if (nomeProvedor) exigirProvedor(nomeProvedor);
  return ligacoes.definirDestinoBackup(nomeProvedor);
}

// ── Atalhos de administração ────────────────────────────────────────
async function linkPasta(pastaId, condominioId) {
  const p = await principalDoCondominio(condominioId);
  return p.linkPasta(pastaId);
}

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
  principalDoCondominio,
  nomePrincipalDoCondominio,
  nomeDoCondominio,
  rotuloPrincipal,
  abrePastaNoFornecedor,
  definirPrincipalDoCondominio,
  definirProvedorDoCondominio,
  provedorDoCondominio,
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
  // escritas (documentos)
  uploadArquivo,
  pastaParaDocumento,
  pastaParaFornecedor,
  obterPastaCondominioId,
  criarEstruturaPastas,
  // escritas de plataforma (backups)
  uploadComProvedor,
  pastaDeBackups,
  destinoDeBackup,
  definirDestinoDeBackup,
  // leituras
  abrirFluxo,
  descargarArquivo,
  apagarArquivo,
  // `descargarArquivo` é o nome histórico; mantém-se como canónico.
  descarregarArquivo: descargarArquivo,
  // atalhos
  linkPasta,
  linkPastaDrive,
  // localizadores
  montarLocalizador,
  lerLocalizador,
  // cache de ligações
  inicializar,
  ligacoes,
};
