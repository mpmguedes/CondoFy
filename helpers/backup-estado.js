// ─────────────────────────────────────────────────────────────────────
// Estado de um backup — interpretação PURA de um registo de `backup_logs`.
//
// DOIS CONCEITOS INDEPENDENTES (a mesma separação da fachada de armazenamento):
//
//  · A CÓPIA LOCAL é SEMPRE feita e é o backup a sério. Existe mesmo que não
//    haja nenhum serviço de cloud ligado, e é preservada mesmo que a cópia na
//    cloud falhe.
//  · A CÓPIA CLOUD é OPCIONAL e vai para o destino configurado para a
//    INSTALAÇÃO — que pode ser um serviço diferente do usado pelos documentos
//    de cada condomínio.
//
// As colunas existentes de `backup_logs` chegam para distinguir todos os
// estados — NÃO é necessária nenhuma migration:
//
//   sem registo                                        → sem_historico
//   estado='em_curso'                                  → em_curso
//   estado='erro'                                      → erro
//   estado='concluido' + ficheiro_drive_id             → local_com_cloud
//   estado='concluido' + erro (e sem ficheiro)         → local_copia_cloud_falhada
//   estado='concluido' + tamanho (sem erro, sem ficheiro) → local
//
// Regra de semântica: `estado='concluido'` significa sempre «o BACKUP concluiu»
// — uma falha apenas da cópia cloud não transforma um backup válido em erro; o
// que fica registado é a mensagem em `erro`. `tamanho` é escrito logo depois da
// cópia local, por isso distingue um backup que existe de um que nunca chegou a
// ser escrito.
//
// `ficheiro_drive_id` guarda um LOCALIZADOR do provedor (`gd:`, `dbx:`, `od:`,
// ou um id simples do Google Drive) — ver `helpers/armazenamento/locator.js`.
// ─────────────────────────────────────────────────────────────────────
const locator = require('./armazenamento/locator');

// Rótulo e cor de cada estado (a vista não decide nada disto). `cor` é o sufixo
// de uma classe Bootstrap (`text-<cor>` / `text-bg-<cor>`).
const ESTADOS = {
  sem_historico: { rotulo: 'Sem backups', cor: 'secondary' },
  em_curso: { rotulo: 'Em curso', cor: 'warning' },
  erro: { rotulo: 'Erro', cor: 'danger' },
  local: { rotulo: 'Concluído', cor: 'success' },
  local_com_cloud: { rotulo: 'Concluído', cor: 'success' },
  local_copia_cloud_falhada: { rotulo: 'Concluído', cor: 'warning' },
};

// Estados que exigem alguma atenção da administração (usados pelo painel).
const EXIGEM_ATENCAO = new Set(['erro', 'local_copia_cloud_falhada']);

// Detalhe curto para a interface. NUNCA expõe a mensagem técnica do fornecedor:
// o painel é uma vista de conjunto e não pode despejar URLs/contas de terceiros.
const DETALHES = {
  erro: 'falhou',
  local_copia_cloud_falhada: 'cópia cloud falhou',
};

function texto(valor) {
  if (valor === null || valor === undefined) return null;
  const s = String(valor).trim();
  return s === '' ? null : s;
}

function inteiro(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

// Nome legível do provedor do localizador. O mapa é injetado por quem chama
// (a partir do registo de provedores) para este módulo continuar puro e sem
// dependências de base de dados.
function rotuloDe(provedor, rotulos) {
  if (!provedor) return null;
  const mapa = rotulos && typeof rotulos === 'object' ? rotulos : {};
  return texto(mapa[provedor]) || null;
}

// Interpreta um registo de `backup_logs` (ou null) no estado apresentável.
// `opcoes.rotulos` = { google_drive: 'Google Drive', … } (opcional).
function interpretar(log, opcoes = {}) {
  const tamanho = log ? inteiro(log.tamanho) : null;
  const erro = log ? texto(log.erro) : null;
  const lido = log ? locator.ler(log.ficheiro_drive_id) : { provedor: null, id: null };
  const temCloud = Boolean(lido.provedor && lido.id);

  const base = {
    estado: 'sem_historico',
    rotulo: ESTADOS.sem_historico.rotulo,
    cor: ESTADOS.sem_historico.cor,
    detalhe: null,
    data: (log && log.data) || null,
    tipo: (log && log.tipo) || null,
    // Tamanho da cópia local (bytes). Null quando o dump nunca foi escrito.
    tamanho,
    // A cópia local existe?
    temLocal: false,
    // Existe uma cópia na cloud?
    temCloud,
    cloud: temCloud ? { provedor: lido.provedor, rotulo: rotuloDe(lido.provedor, opcoes.rotulos) } : null,
    // Mensagem completa (para as páginas de configuração; o painel usa `detalhe`).
    erro,
  };

  if (!log) return base;

  const estado = texto(log.estado);
  if (estado === 'em_curso') {
    return { ...base, estado: 'em_curso', ...ESTADOS.em_curso };
  }
  if (estado === 'erro') {
    return { ...base, estado: 'erro', ...ESTADOS.erro, detalhe: DETALHES.erro };
  }
  if (estado !== 'concluido') {
    // Estado desconhecido: nunca se inventa um resultado.
    return base;
  }

  // `tamanho` é escrito imediatamente após a cópia local: é a prova de que o
  // backup existe no servidor.
  const temLocal = Boolean(tamanho && tamanho > 0);

  if (temCloud) {
    return { ...base, estado: 'local_com_cloud', ...ESTADOS.local_com_cloud, temLocal };
  }
  if (erro) {
    return {
      ...base,
      estado: 'local_copia_cloud_falhada',
      ...ESTADOS.local_copia_cloud_falhada,
      temLocal,
      detalhe: DETALHES.local_copia_cloud_falhada,
    };
  }
  return { ...base, estado: 'local', ...ESTADOS.local, temLocal };
}

// O estado exige atenção da administração?
function exigeAtencao(estado) {
  return EXIGEM_ATENCAO.has(String(estado || ''));
}

module.exports = { ESTADOS, interpretar, exigeAtencao };
