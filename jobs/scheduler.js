const cron = require('node-cron');
const { processarFilaEmail } = require('../helpers/email-fila');
const { gerarQuotasAutomaticas, enviarLembretesAutomaticos } = require('./automatizacao');
const { executarBackup } = require('./backup');

// Tarefas agendadas leves (node-cron). As configurações persistem na BD,
// pelo que sobrevivem a reinícios da aplicação.
function iniciar() {
  // Fila de email — processa um lote de cada vez
  cron.schedule('*/5 * * * *', () => {
    processarFilaEmail(20)
      .then((r) => {
        if (r.processados > 0) console.log('[fila-email]', r);
      })
      .catch((e) => console.error('[fila-email] erro:', e.message));
  });

  // Geração automática de quotas (diária, 05:00)
  cron.schedule('0 5 * * *', () => {
    gerarQuotasAutomaticas()
      .then((r) => console.log('[auto-quotas]', r))
      .catch((e) => console.error('[auto-quotas] erro:', e.message));
  });

  // Lembretes de vencimento / avisos de atraso (diária, 08:15)
  cron.schedule('15 8 * * *', () => {
    enviarLembretesAutomaticos()
      .then((r) => console.log('[auto-lembretes]', r))
      .catch((e) => console.error('[auto-lembretes] erro:', e.message));
  });

  // Backup da base de dados (diário, hora configurável)
  const horaBackup = process.env.BACKUP_HOUR || '3';
  cron.schedule(`0 ${horaBackup} * * *`, () => {
    executarBackup('diario').catch((e) => console.error('[backup] erro:', e.message));
  });

  console.log('[agendador] tarefas agendadas em execução.');
}

module.exports = { iniciar };
