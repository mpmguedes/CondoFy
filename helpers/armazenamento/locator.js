// ─────────────────────────────────────────────────────────────────────
// Localizadores de ficheiros por provedor de armazenamento.
//
// O identificador do ficheiro é guardado em documentos.drive_file_id
// (STRING(191)) — a coluna mantém o nome antigo por compatibilidade, mas
// passou a ser um localizador do provedor que guardou o ficheiro:
//
//   gd:<id>     Google Drive   (id do ficheiro)
//   dbx:<id>    Dropbox        (id do ficheiro, resolvido pela API)
//   od:<id>     OneDrive       (id do driveItem no Microsoft Graph)
//
// Compatibilidade: valores SEM prefixo conhecido são ids do Google Drive
// (formato anterior a este módulo) — nenhum documento existente precisa de
// migração, e o provedor de leitura é decidido pelo próprio localizador.
//
// Regra: os ids são tratados como opacos (nunca interpretados, deduzidos ou
// construídos a partir de nomes/caminhos) e nunca são enviados para o
// browser como forma de acesso.
// ─────────────────────────────────────────────────────────────────────

// Comprimento útil da coluna documentos.drive_file_id.
const LIMITE_COLUNA = 191;

const PREFIXOS = { google_drive: 'gd', dropbox: 'dbx', onedrive: 'od' };
const POR_PREFIXO = { gd: 'google_drive', dbx: 'dropbox', od: 'onedrive' };
const PROVEDOR_PADRAO = 'google_drive';

// Provedores que nunca levam prefixo (compatibilidade com os ids já gravados).
const SEM_PREFIXO = new Set(['google_drive']);

function prefixo(provedor) {
  return PREFIXOS[String(provedor || '').trim().toLowerCase()] || null;
}

function provedorValido(provedor) {
  return Boolean(prefixo(provedor));
}

// Monta o localizador a partir do id devolvido pelo provedor.
function montar(provedor, id) {
  const nome = String(provedor || '').trim().toLowerCase();
  const valor = String(id == null ? '' : id).trim();
  if (!provedorValido(nome)) throw new Error(`Provedor de armazenamento desconhecido: ${provedor}`);
  if (!valor) throw new Error('O id do ficheiro no provedor é obrigatório.');
  if (valor.length > LIMITE_COLUNA) {
    throw new Error(`Identificador do provedor demasiado longo (${valor.length} > ${LIMITE_COLUNA}).`);
  }
  if (SEM_PREFIXO.has(nome)) return valor;
  const loc = `${PREFIXOS[nome]}:${valor}`;
  if (loc.length > LIMITE_COLUNA) {
    throw new Error(`Localizador demasiado longo para a coluna de documentos (${loc.length} > ${LIMITE_COLUNA}).`);
  }
  return loc;
}

// Lê um localizador → { provedor, id }. Valores antigos (sem prefixo) são
// ids do Google Drive.
function ler(valor) {
  const texto = String(valor == null ? '' : valor).trim();
  if (!texto) return { provedor: null, id: null };
  const i = texto.indexOf(':');
  if (i > 0) {
    const p = POR_PREFIXO[texto.slice(0, i).toLowerCase()];
    if (p) {
      const id = texto.slice(i + 1);
      return id ? { provedor: p, id } : { provedor: null, id: null };
    }
  }
  return { provedor: PROVEDOR_PADRAO, id: texto };
}

// Nome do provedor de um localizador (null quando vazio).
function provedorDe(valor) {
  return ler(valor).provedor;
}

// Verifica se um valor é um localizador legível sem ambiguidade.
function valido(valor) {
  const { provedor, id } = ler(valor);
  return Boolean(provedor && id);
}

// Lista de nomes de provedores suportados pelos localizadores.
function provedores() {
  return Object.keys(PREFIXOS);
}

module.exports = {
  LIMITE_COLUNA,
  PREFIXOS,
  PROVEDOR_PADRAO,
  provedores,
  provedorValido,
  montar,
  ler,
  provedorDe,
  valido,
};
