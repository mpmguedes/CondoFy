// ─────────────────────────────────────────────────────────────────────
// Inventário das cópias LOCAIS dos backups.
//
// A cópia local é a cópia BASE e OBRIGATÓRIA. É um dump COMPLETO da base de
// dados da INSTALAÇÃO — contém os dados de TODOS os condomínios — e existe
// mesmo sem nenhum serviço de cloud ligado.
//
// ⛔ NÃO contém documentos, PDFs, imagens nem anexos: o armazenamento
// documental é um eixo SEPARADO (por condomínio, no Google Drive/Dropbox/
// OneDrive). Nada aqui pode somar, mover ou apagar ficheiros documentais.
//
// Este módulo lê o DISCO (a verdade), não a tabela `backup_logs` (o registo).
// O nome do ficheiro é AUTO-DESCRITIVO —
//   `backup_<tipo>_<AAAA-MM-DD>_<epoch>.sql.gz`
// — pelo que o tipo, a data e o instante exato saem do próprio nome. Foi por
// isso que NÃO foi preciso acrescentar nenhuma coluna a `backup_logs`.
//
// A junção ao registo é feita à parte (`apresentar`) e é SEMPRE conservadora:
// sem correspondência inequívoca diz «sem registo» em vez de inventar um estado.
// ─────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const backupEstado = require('./backup-estado');

// Nome produzido por `jobs/backup.js`. O `epoch` é limitado a 17 dígitos: acima
// disso `new Date(epoch)` sai do intervalo representável e o nome é recusado
// (nunca se inventa uma data).
const NOME_RE = /^backup_(diario|semanal|mensal|manual)_(\d{4}-\d{2}-\d{2})_(\d{1,17})\.sql\.gz$/;
const TIPOS = ['diario', 'semanal', 'mensal', 'manual'];
// Rótulo PT-PT do tipo (a vista não decide isto por si).
const TIPO_ROTULO = { diario: 'Diário', semanal: 'Semanal', mensal: 'Mensal', manual: 'Manual' };
const MAGIC_GZIP = Buffer.from([0x1f, 0x8b]);

// Estados que só existem NO INVENTÁRIO (não são estados de `backup_logs`).
const ESTADOS_INVENTARIO = {
  invalido: { rotulo: 'Inválido', cor: 'danger' },
  local_sem_registo: { rotulo: 'Local (sem registo)', cor: 'secondary' },
};

// ── Nome ────────────────────────────────────────────────────────────
// Devolve { nome, tipo, data, epoch, criadoEm } ou null. Um nome que não siga
// exatamente o formato é RECUSADO — é o que impede que um ficheiro alheio
// (um documento, por exemplo) seja tratado como backup.
function analisarNome(nome) {
  const bruto = String(nome === null || nome === undefined ? '' : nome).trim();
  const m = NOME_RE.exec(bruto);
  if (!m) return null;
  const epoch = Number(m[3]);
  const criadoEm = new Date(epoch);
  if (!Number.isFinite(epoch) || Number.isNaN(criadoEm.getTime())) return null;
  return { nome: bruto, tipo: m[1], data: m[2], epoch, criadoEm };
}

// ── Segurança: só nomes de backup, só DENTRO do diretório ───────────
// Nunca se aceita um caminho vindo do cliente. Só passa um nome simples (sem
// separadores, sem `..`) E conforme ao formato de backup. Devolve null quando
// não é aceitável — quem chama tem de tratar null como recusa.
function caminhoSeguro(diretorio, nome) {
  const bruto = String(nome === null || nome === undefined ? '' : nome).trim();
  if (!bruto || bruto !== path.basename(bruto)) return null;
  if (bruto.includes('/') || bruto.includes('\\') || bruto.includes('\0')) return null;
  if (!analisarNome(bruto)) return null;
  const base = path.resolve(String(diretorio || ''));
  const alvo = path.join(base, bruto);
  // Cinto e suspensórios: o resultado tem de estar DENTRO da base.
  if (path.dirname(alvo) !== base) return null;
  return alvo;
}

// ── Validação de um ficheiro em disco ───────────────────────────────
// Um backup local é VÁLIDO quando existe, não está vazio e começa pela
// assinatura gzip (`1f 8b`). Lê 2 bytes — não abre o dump inteiro (1,8 GB).
function validarFicheiro(caminho) {
  let st;
  try {
    st = fs.statSync(caminho);
  } catch (err) {
    return { valido: false, tamanho: null, motivo: err.code || 'erro_leitura' };
  }
  if (!st.isFile()) return { valido: false, tamanho: null, motivo: 'nao_e_ficheiro' };
  if (st.size <= 0) return { valido: false, tamanho: st.size, motivo: 'vazio' };
  let cabecalho;
  try {
    const fd = fs.openSync(caminho, 'r');
    try {
      cabecalho = Buffer.alloc(2);
      fs.readSync(fd, cabecalho, 0, 2, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { valido: false, tamanho: st.size, motivo: err.code || 'erro_leitura' };
  }
  if (!cabecalho.equals(MAGIC_GZIP)) return { valido: false, tamanho: st.size, motivo: 'nao_e_gzip' };
  return { valido: true, tamanho: st.size, motivo: null };
}

// ── Listagem do diretório ───────────────────────────────────────────
// Devolve sempre uma lista de itens (nunca lança por o diretório não existir:
// «ainda não há backups» é um estado normal, não um erro).
function listar(diretorio) {
  const base = path.resolve(String(diretorio || ''));
  let nomes;
  try {
    nomes = fs.readdirSync(base);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return { diretorio: base, existe: false, itens: [], ignorados: [] };
    }
    throw err;
  }
  const itens = [];
  const ignorados = [];
  for (const nome of nomes.slice().sort()) {
    const analisado = analisarNome(nome);
    if (!analisado) {
      // Qualquer outro ficheiro (ou subdiretório) é IGNORADO e reportado: nunca
      // é apagado, nunca entra nas contas.
      ignorados.push(nome);
      continue;
    }
    const caminho = path.join(base, nome);
    const v = validarFicheiro(caminho);
    itens.push({
      ...analisado,
      caminho,
      tamanho: v.tamanho,
      valido: v.valido,
      motivoInvalido: v.motivo,
    });
  }
  itens.sort((a, b) => a.criadoEm - b.criadoEm || a.nome.localeCompare(b.nome));
  return { diretorio: base, existe: true, itens, ignorados };
}

// ── Medição real ────────────────────────────────────────────────────
// `bytes` é o espaço REALMENTE ocupado por ficheiros de backup (inclui os
// inválidos: também ocupam disco). `numero` conta apenas os backups VÁLIDOS.
function medir(itens) {
  const lista = Array.isArray(itens) ? itens : [];
  const validos = lista.filter((i) => i && i.valido);
  const ordenados = validos.slice().sort((a, b) => a.criadoEm - b.criadoEm);
  const bytes = lista.reduce((soma, i) => soma + (Number(i && i.tamanho) || 0), 0);
  const bytesValidos = validos.reduce((soma, i) => soma + (Number(i.tamanho) || 0), 0);
  return {
    numero: validos.length,
    numeroFicheiros: lista.length,
    invalidos: lista.length - validos.length,
    bytes,
    bytesValidos,
    maisAntigo: ordenados.length ? ordenados[0].criadoEm : null,
    maisRecente: ordenados.length ? ordenados[ordenados.length - 1].criadoEm : null,
    ultimo: ordenados.length ? ordenados[ordenados.length - 1] : null,
  };
}

function maisRecenteValido(itens) {
  return medir(itens).ultimo;
}

// ── Junção conservadora ao registo ──────────────────────────────────
// Índice `tipo|tamanho` → registos. O `tamanho` é o comprimento exato do gzip,
// escrito imediatamente após a cópia local: é a chave natural que torna a
// junção inequívoca SEM coluna de nome. Dois backups do mesmo tipo com o mesmo
// comprimento exato são, na prática, impossíveis.
function indexarRegistos(logs) {
  const indice = new Map();
  for (const log of Array.isArray(logs) ? logs : []) {
    if (!log) continue;
    const tamanho = Number(log.tamanho);
    if (!Number.isFinite(tamanho)) continue;
    const chave = `${String(log.tipo || '')}|${tamanho}`;
    if (!indice.has(chave)) indice.set(chave, []);
    indice.get(chave).push(log);
  }
  return indice;
}

function registoDe(item, indice) {
  const candidatos = indice.get(`${item.tipo}|${Number(item.tamanho)}`);
  if (!candidatos || candidatos.length === 0) return null;
  if (candidatos.length === 1) return candidatos[0];
  // Vários candidatos com o mesmo comprimento: escolhe-se o de `data` mais
  // próxima do instante do nome. Empate ⇒ nenhum (não se inventa).
  let melhor = null;
  let melhorDistancia = Infinity;
  for (const c of candidatos) {
    const d = Math.abs(new Date(c.data).getTime() - item.criadoEm.getTime());
    if (Number.isFinite(d) && d < melhorDistancia) {
      melhorDistancia = d;
      melhor = c;
    }
  }
  return melhor;
}

// Estados de `backup_logs` que fazem sentido para um ficheiro que EXISTE.
const ESTADOS_DE_FICHEIRO = new Set(['local', 'local_com_cloud', 'local_copia_cloud_falhada']);

// Apresenta um item do inventário: nome, data/hora, tamanho, estado e — quando
// existe — a indicação da cópia cloud. Nunca expõe a mensagem técnica do
// fornecedor no rótulo (o `erro` completo fica disponível para quem o pedir).
function apresentar(item, log, opcoes = {}) {
  const base = {
    nome: item.nome,
    caminho: item.caminho,
    tipo: item.tipo,
    tipoRotulo: TIPO_ROTULO[item.tipo] || item.tipo,
    data: item.criadoEm,
    criadoEm: item.criadoEm,
    tamanho: item.tamanho,
    valido: Boolean(item.valido),
    motivoInvalido: item.motivoInvalido || null,
    temRegisto: Boolean(log),
    temCloud: false,
    cloud: null,
    erro: log ? log.erro || null : null,
  };

  if (!item.valido) {
    return { ...base, estado: 'invalido', ...ESTADOS_INVENTARIO.invalido };
  }

  if (log) {
    const lido = backupEstado.interpretar(log, opcoes);
    if (ESTADOS_DE_FICHEIRO.has(lido.estado)) {
      return {
        ...base,
        estado: lido.estado,
        rotulo: lido.rotulo,
        cor: lido.cor,
        detalhe: lido.detalhe,
        temCloud: lido.temCloud,
        cloud: lido.cloud,
      };
    }
  }

  // Ficheiro válido sem registo correspondente: diz-se o que se SABE (existe,
  // tem este tamanho, foi criado neste instante) e não se inventa um resultado.
  return { ...base, estado: 'local_sem_registo', ...ESTADOS_INVENTARIO.local_sem_registo };
}

// Apresenta a lista completa + a medição. É a função que a área do Super Admin
// usa (uma só verdade sobre o que está no disco).
function apresentarLista({ diretorio, logs = [], rotulos = null } = {}) {
  const { diretorio: base, existe, itens, ignorados } = listar(diretorio);
  const indice = indexarRegistos(logs);
  const opcoes = rotulos ? { rotulos } : {};
  const apresentados = itens.map((i) => apresentar(i, registoDe(i, indice), opcoes));
  return {
    diretorio: base,
    existe,
    itens: apresentados,
    ignorados,
    medicao: medir(itens),
  };
}

module.exports = {
  TIPOS,
  NOME_RE,
  ESTADOS_INVENTARIO,
  analisarNome,
  caminhoSeguro,
  validarFicheiro,
  listar,
  medir,
  maisRecenteValido,
  apresentar,
  apresentarLista,
  indexarRegistos,
};
