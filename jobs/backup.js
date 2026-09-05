const { execFile } = require('child_process');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const { BackupLog } = require('../models');
const drive = require('../helpers/drive');
const { getConfig } = require('../helpers/config');

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
  for (const b of antigos) {
    try {
      await drive.getDrive().files.delete({ fileId: b.ficheiro_drive_id });
    } catch (err) {
      console.error('[backup] erro ao remover ficheiro antigo:', err.message);
    }
  }
  return antigos.length;
}

// Executa um backup: dump → gzip → Google Drive (ou cópia local temporária).
async function executarBackup(tipo = 'diario') {
  const log = await BackupLog.create({ tipo, estado: 'em_curso' });
  try {
    const dump = await executarMysqldump();
    const gz = zlib.gzipSync(dump);
    const nome = `backup_${tipo}_${new Date().toISOString().slice(0, 10)}_${Date.now()}.sql.gz`;

    // Preferência "Guardar backups no Google Drive" (Configuração → Google Drive).
    const backupsNoDrive = (await getConfig('drive_auto_backups', '1')) === '1';
    if (drive.isConfigured() && backupsNoDrive) {
      const estrutura = await drive.criarEstruturaPastas();
      const up = await drive.uploadArquivo({
        nome,
        mimeType: 'application/gzip',
        buffer: gz,
        parentFolderId: estrutura.backupsId,
      });
      await log.update({ estado: 'concluido', ficheiro_drive_id: up.driveFileId, tamanho: gz.length });
      const removidos = await limparBackupsAntigos(tipo);
      console.log(`[backup] ${nome} concluído (${gz.length} bytes); ${removidos} antigo(s) removido(s).`);
    } else {
      const dir = path.join(__dirname, '..', 'backups', 'local');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, nome), gz);
      await log.update({ estado: 'concluido', tamanho: gz.length });
      console.log(`[backup] ${nome} guardado localmente (Drive não configurado).`);
    }
    return log;
  } catch (err) {
    await log.update({ estado: 'erro', erro: err.message });
    console.error('[backup] erro:', err.message);
    return log;
  }
}

module.exports = { executarBackup };
