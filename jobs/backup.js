const { execFile } = require('child_process');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const { BackupLog } = require('../models');
// Backups são da INSTALAÇÃO (o dump contém dados de todos os condomínios):
// usam o destino configurado em Configurações → Armazenamento e Backups, com a
// ligação de PLATAFORMA do serviço escolhido — nunca a conta de um condomínio.
const storage = require('../helpers/storage');

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

// Executa um backup: dump → gzip → destino configurado (ou cópia local quando
// ainda não há nenhum serviço ligado à plataforma).
async function executarBackup(tipo = 'diario') {
  const log = await BackupLog.create({ tipo, estado: 'em_curso' });
  try {
    const dump = await executarMysqldump();
    const gz = zlib.gzipSync(dump);
    const nome = `backup_${tipo}_${new Date().toISOString().slice(0, 10)}_${Date.now()}.sql.gz`;

    // Destino de backups: escolha do administrador (pode ser diferente do
    // armazenamento principal dos documentos).
    const destino = await storage.destinoDeBackup();
    const provedor = destino ? storage.obterProvedor(destino) : null;
    const ligado = Boolean(provedor && provedor.isConfigured(null));

    if (provedor && ligado) {
      // Ligação a usar: de plataforma quando existe, senão a do condomínio que
      // tem esse serviço ligado (uma ligação por serviço, sem contas duplicadas).
      const ligacao = storage.ligacaoDeBackup(destino);
      const pastaId = await storage.pastaDeBackups(destino, ligacao.condominioId);
      const up = await storage.uploadComProvedor(destino, {
        nome,
        mimeType: 'application/gzip',
        buffer: gz,
        parentFolderId: pastaId,
        condominioId: ligacao.condominioId,
      });
      const referencia = up.localizador || up.provedorFileId || up.driveFileId || null;
      await log.update({ estado: 'concluido', ficheiro_drive_id: referencia, tamanho: gz.length });
      const removidos = await limparBackupsAntigos(tipo);
      console.log(`[backup] ${nome} concluído em ${provedor.rotulo()}${ligacao.conta ? ` (${ligacao.conta})` : ''} (${gz.length} bytes); ${removidos} antigo(s) fora da retenção.`);
    } else {
      const dir = path.join(__dirname, '..', 'backups', 'local');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, nome), gz);
      await log.update({ estado: 'concluido', tamanho: gz.length });
      console.log(`[backup] ${nome} guardado localmente (sem destino de backups ligado na plataforma).`);
    }
    return log;
  } catch (err) {
    await log.update({ estado: 'erro', erro: err.message });
    console.error('[backup] erro:', err.message);
    return log;
  }
}

module.exports = { executarBackup };
