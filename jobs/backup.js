const { execFile } = require('child_process');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const { BackupLog } = require('../models');
// Backups são da INSTALAÇÃO (o dump contém dados de todos os condomínios):
// a cópia na cloud usa o destino configurado em Configurações → Armazenamento e
// Backups, com a ligação de PLATAFORMA do serviço escolhido — nunca a conta
// principal de documentos de um condomínio.
const storage = require('../helpers/storage');

// Pasta da cópia LOCAL dos backups. É o backup a sério e existe SEMPRE, mesmo
// sem nenhum serviço de cloud ligado. Configurável apenas para os testes
// poderem escrever num diretório temporário (em produção é a pasta
// `backups/local` do projeto, ignorada pelo git).
function pastaLocal() {
  const configurada = String(process.env.BACKUP_LOCAL_DIR || '').trim();
  return configurada || path.join(__dirname, '..', 'backups', 'local');
}

function executarMysqldump() {
  return new Promise((resolve, reject) => {
    const args = [
      '-h', process.env.DB_HOST || '127.0.0.1',
      '-P', process.env.DB_PORT || '3306',
      '-u', process.env.DB_USER || 'condofy',
      '--single-transaction',
      '--quick',
      '--skip-lock-tables',
      process.env.DB_NAME || 'condofy',
    ];
    execFile(
      'mysqldump',
      args,
      { env: { ...process.env, MYSQL_PWD: process.env.DB_PASS || 'condofy' }, maxBuffer: 1024 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      }
    );
  });
}

function retencaoDias(tipo) {
  const mapa = {
    diario: parseInt(process.env.BACKUP_DAILY_RETENTION || '30', 10),
    semanal: parseInt(process.env.BACKUP_WEEKLY_RETENTION || '90', 10),
    mensal: parseInt(process.env.BACKUP_MONTHLY_RETENTION || '365', 10),
    manual: 30,
  };
  return mapa[tipo] || 30;
}

async function limparBackupsAntigos(tipo) {
  const dias = retencaoDias(tipo);
  const limite = new Date(Date.now() - dias * 86400000);
  const antigos = await BackupLog.findAll({
    where: {
      tipo,
      estado: 'concluido',
      data: { [Op.lt]: limite },
      ficheiro_drive_id: { [Op.ne]: null },
    },
  });
  // Mantém a retenção: os backups fora do prazo deixam de estar referenciados
  // e são removidos no fornecedor quando este suporta remoção (o Google Drive
  // suportava já este comportamento).
  for (const b of antigos) {
    try {
      await storage.apagarArquivo(b.ficheiro_drive_id);
    } catch (err) {
      console.error('[backup] erro ao remover ficheiro antigo:', err.message);
    }
  }
  return antigos.length;
}

// Destino cloud dos backups: a configuração GLOBAL da instalação + uma ligação
// que este job consiga MESMO usar (de plataforma quando existe, senão a do
// condomínio que tem esse serviço ligado). O fornecedor dos backups nunca é
// deduzido do fornecedor principal dos documentos de um condomínio — são dois
// conceitos independentes.
async function destinoCloud() {
  try {
    const destino = await storage.destinoDeBackup();
    if (!destino) return { destino: null, provedor: null, ligacao: null };
    const provedor = storage.obterProvedor(destino);
    if (!provedor) return { destino, provedor: null, ligacao: null };
    const ligacao = storage.ligacaoDeBackup(destino);
    if (!ligacao || !ligacao.origem) return { destino, provedor, ligacao: null };
    return { destino, provedor, ligacao };
  } catch (err) {
    console.error('[backup] não foi possível ler o destino dos backups:', err.message);
    return { destino: null, provedor: null, ligacao: null };
  }
}

// Executa um backup:
//   1. cópia LOCAL — sempre (é o backup a sério);
//   2. cópia CLOUD — só quando existe um destino configurado E uma ligação
//      utilizável para esse destino.
// Uma falha na cópia cloud NUNCA remove nem invalida a cópia local.
async function executarBackup(tipo = 'diario') {
  const log = await BackupLog.create({ tipo, estado: 'em_curso' });
  let localFeito = false;
  try {
    const dump = await executarMysqldump();
    const gz = zlib.gzipSync(dump);
    const nome = `backup_${tipo}_${new Date().toISOString().slice(0, 10)}_${Date.now()}.sql.gz`;

    // 1) Cópia local: obrigatória. Escrita antes de qualquer tentativa de
    //    upload — se a cloud falhar, o backup já existe no servidor.
    const dir = pastaLocal();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, nome), gz);
    localFeito = true;
    // `tamanho` fica registado logo aqui: é a prova de que a cópia local existe
    // (ver helpers/backup-estado.js).
    await log.update({ tamanho: gz.length });

    // 2) Cópia cloud: opcional e independente do serviço dos documentos.
    const { destino, provedor, ligacao } = await destinoCloud();
    let referencia = null;
    let erroCloud = null;
    if (provedor && ligacao) {
      try {
        const pastaId = await storage.pastaDeBackups(destino, ligacao.condominioId);
        const up = await storage.uploadComProvedor(destino, {
          nome,
          mimeType: 'application/gzip',
          buffer: gz,
          parentFolderId: pastaId,
          condominioId: ligacao.condominioId,
        });
        referencia = up.localizador || up.provedorFileId || up.driveFileId || null;
        if (!referencia) erroCloud = 'o serviço não devolveu a referência do ficheiro';
      } catch (err) {
        erroCloud = err.message;
      }
    }

    if (referencia) {
      await log.update({ estado: 'concluido', ficheiro_drive_id: referencia, erro: null });
      const removidos = await limparBackupsAntigos(tipo);
      console.log(`[backup] ${nome} concluído: cópia local + ${provedor.rotulo()}${ligacao.conta ? ` (${ligacao.conta})` : ''} (${gz.length} bytes); ${removidos} antigo(s) fora da retenção.`);
    } else if (erroCloud) {
      // A cópia local está feita e fica onde está: só a cópia cloud falhou.
      await log.update({ estado: 'concluido', erro: `Cópia cloud não criada: ${erroCloud}` });
      console.error(`[backup] ${nome} guardado localmente; cópia cloud (${destino}) falhou: ${erroCloud}`);
    } else {
      await log.update({ estado: 'concluido', erro: null });
      console.log(`[backup] ${nome} guardado localmente (sem destino de backups configurado ou utilizável).`);
    }
    return log;
  } catch (err) {
    // Falhou ANTES da cópia local: não há backup nenhum (estado 'erro').
    // Falhou DEPOIS: a cópia local existe e é preservada — regista-se a falha
    // sem transformar um backup válido em «erro».
    if (localFeito) {
      await log.update({ estado: 'concluido', erro: err.message }).catch(() => {});
      console.error('[backup] cópia local preservada; falha a seguir:', err.message);
    } else {
      await log.update({ estado: 'erro', erro: err.message }).catch(() => {});
      console.error('[backup] erro:', err.message);
    }
    return log;
  }
}

module.exports = { executarBackup };
