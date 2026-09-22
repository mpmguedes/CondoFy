const cron = require('node-cron');
const { processarFilaEmail } = require('../helpers/email-fila');
const { gerarQuotasAutomaticas, enviarLembretesAutomaticos } = require('./automatizacao');
const { executarBackup } = require('./backup');
// Avisos programados: disparo automático por `data_programada` (P29). O motor
// de enfileiramento é o mesmo do envio manual (`helpers/avisos-envio.js`).
const { enviarAvisosProgramados } = require('./avisos-programados');
// A decisão da agenda dos backups vive em helpers/backup-agenda.js (puro e
// testável): aqui só se registam as expressões que ele devolve.
const agenda = require('../helpers/backup-agenda');

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

  // Avisos PROGRAMADOS com data atingida (diária, 08:30).
  // Correm depois dos lembretes (08:15) para que as comunicações do dia saiam
  // em bloco. Um aviso já despachado não é reenviado: a deduplicação por
  // `email_fila.aviso_id` é o que torna a tarefa idempotente, apesar de a
  // condição (`data_programada <= hoje`) continuar verdadeira nos dias
  // seguintes. Ver `jobs/avisos-programados.js`.
  cron.schedule('30 8 * * *', () => {
    enviarAvisosProgramados()
      .then((r) => {
        if (r.enfileirados > 0) console.log('[avisos-programados]', r);
      })
      .catch((e) => console.error('[avisos-programados] erro:', e.message));
  });

  // Backups da base de dados — DIÁRIO, SEMANAL e MENSAL (antes só o diário
  // corria: `semanal` e `mensal` existiam no ENUM de `backup_logs` mas nunca
  // eram disparados). `manual` NÃO é agendado: dispara-se à mão em
  // Administração global → Backups.
  for (const tarefa of agenda.plano()) {
    cron.schedule(tarefa.expressao, () => {
      executarBackup(tarefa.tipo).catch((e) => console.error(`[backup] erro (${tarefa.tipo}):`, e.message));
    });
  }

  console.log('[agendador] tarefas agendadas em execução.');
}

// Plano de backups que `iniciar()` regista (exposto para teste: prova que a
// agenda REAL é a de `helpers/backup-agenda.js`, sem arrancar o cron).
function planear(env = process.env) {
  return agenda.plano(env);
}

module.exports = { iniciar, planear };
