// ─────────────────────────────────────────────────────────────────────
// Contrato dos provedores de armazenamento do GesCondu.
//
// Qualquer provedor (helpers/armazenamento/provedores/*.js) tem de cumprir
// esta interface para poder ser registado na fachada (helpers/storage). É o
// que permite acrescentar serviços novos (S3, Nextcloud, …) sem tocar nas
// rotas, nas vistas nem na lógica de documentos.
//
// ── INVARIANTE DE SEGURANÇA (obrigatório) ────────────────────────────
//  · Um provedor NUNCA cria links públicos ("qualquer pessoa com o link").
//    Não pode existir `linkPublico`/`criarLinkPartilha`/equivalente.
//  · Os ficheiros ficam privados na conta do condomínio/plataforma; o
//    GesCondu é o único caminho de acesso aos documentos.
//  · O acesso é sempre servido pelo backend, depois de verificar
//    Utilizador → Condomínio → Documento (helpers/documentos-acesso.js).
//  · Os links de pasta (linkPasta) são atalhos de administração para o
//    painel do fornecedor e nunca são usados para servir documentos.
//
// ── Métodos ──────────────────────────────────────────────────────────
//  nome()                                  → 'google_drive' | 'dropbox' | 'onedrive'
//  rotulo()                                → nome legível para a interface
//  capacidades()                           → { oauth, pastas, streaming, backups }
//  featureAtiva()                          → boolean (a integração está ligada por .env?)
//  temCredenciais()                        → boolean (existem client id/secret?)
//  redirectUriDefinido()                   → boolean
//  isConfigured(condominioId?)             → boolean (síncrono: ligação utilizável)
//  estadoLigacao(condominioId?)            → { ativo, credenciais, redirectUriDefinido, ligado, conta }
//  testarLigacao(condominioId?)            → { ok, conta?, erro? }
//  urlAutorizacao({ redirectUri, state, condominioId })   → string
//  trocarCodigo({ code, redirectUri, condominioId })      → { conta } (grava os tokens)
//  desligar(condominioId?)                 → void (remove os tokens; não apaga ficheiros)
//  uploadArquivo({ nome, mimeType, buffer, parentFolderId, condominioId })
//                                          → { provedorFileId, localizador, tamanho, pastaId }
//  descarregarArquivo(fileId, condominioId?) → Buffer
//  abrirFluxo(fileId, condominioId?)       → { fluxo, tamanho?, nome? } (streaming para o cliente)
//  pastaParaDocumento(tipo, ano, condominioId)            → id/caminho da pasta
//  pastaParaFornecedor({ condominioId, nome, ano, subpasta }) → { subpastaId, ... }
//  obterPastaCondominioId(condominioId)    → id/caminho da pasta do condomínio
//  criarEstruturaPastas(condominioId, ano) → { raizId, condominioFolderId, anoId, subpastas, backupsId }
//  linkPasta(pastaId)                      → URL do painel do fornecedor (ou null)
// ─────────────────────────────────────────────────────────────────────

const METODOS_OBRIGATORIOS = [
  'nome',
  'rotulo',
  'capacidades',
  'featureAtiva',
  'temCredenciais',
  'redirectUriDefinido',
  'isConfigured',
  'estadoLigacao',
  'testarLigacao',
  'urlAutorizacao',
  'trocarCodigo',
  'desligar',
  'uploadArquivo',
  'descarregarArquivo',
  'abrirFluxo',
  'pastaParaDocumento',
  'pastaParaFornecedor',
  'obterPastaCondominioId',
  'criarEstruturaPastas',
  'linkPasta',
];

// Métodos proibidos: criariam acesso direto sem passar pelo GesCondu.
const METODOS_PROIBIDOS = ['linkPublico', 'criarLinkPublico', 'criarLinkPartilha', 'partilharPublicamente', 'tornarPublico'];

// Capacidades que todos os provedores têm de declarar.
const CAPACIDADES_OBRIGATORIAS = ['oauth', 'pastas', 'streaming'];

function verificarProvedor(provedor) {
  const faltam = [];
  const avisos = [];
  if (!provedor || typeof provedor !== 'object') {
    return { ok: false, nome: null, faltam: METODOS_OBRIGATORIOS.slice(), avisos: ['provedor inválido'] };
  }
  for (const m of METODOS_OBRIGATORIOS) {
    if (typeof provedor[m] !== 'function') faltam.push(m);
  }
  for (const m of METODOS_PROIBIDOS) {
    if (typeof provedor[m] === 'function') avisos.push(`método proibido presente: ${m}`);
  }
  let nome = null;
  try {
    nome = typeof provedor.nome === 'function' ? provedor.nome() : null;
  } catch (err) {
    avisos.push(`nome() lançou: ${err.message}`);
  }
  if (typeof provedor.capacidades === 'function') {
    try {
      const cap = provedor.capacidades() || {};
      for (const c of CAPACIDADES_OBRIGATORIAS) {
        if (!(c in cap)) avisos.push(`capacidade não declarada: ${c}`);
      }
      if (cap.linksPublicos) avisos.push('declara linksPublicos: true (proibido)');
    } catch (err) {
      avisos.push(`capacidades() lançou: ${err.message}`);
    }
  }
  return { ok: faltam.length === 0 && avisos.length === 0, nome, faltam, avisos };
}

function verificarRegisto(registo) {
  const problemas = [];
  const nomes = [];
  for (const [chave, provedor] of Object.entries(registo || {})) {
    const r = verificarProvedor(provedor);
    nomes.push(chave);
    if (!r.ok) {
      problemas.push({ provedor: chave, faltam: r.faltam, avisos: r.avisos });
    }
    if (r.nome && r.nome !== chave) {
      problemas.push({ provedor: chave, faltam: [], avisos: [`nome() devolve "${r.nome}" e não "${chave}"`] });
    }
  }
  return { ok: problemas.length === 0, provedores: nomes, problemas };
}

module.exports = {
  METODOS_OBRIGATORIOS,
  METODOS_PROIBIDOS,
  CAPACIDADES_OBRIGATORIAS,
  verificarProvedor,
  verificarRegisto,
};
