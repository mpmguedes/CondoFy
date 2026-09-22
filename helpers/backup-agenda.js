// ─────────────────────────────────────────────────────────────────────
// Agenda dos backups automáticos — PURO (sem cron, sem BD, sem rede).
//
// Contexto: o ciclo `diario` era o único que corria no cron, embora
// `backup_logs.tipo` tenha sempre aceitado `diario | semanal | mensal |
// manual`. `manual` é, por definição, disparado à mão (Administração global →
// Backups / `POST /admin/sistema/backup`) e continua deliberadamente FORA da
// agenda. `semanal` e `mensal` passam a ter expressão própria.
//
// Tudo o que DECIDE a agenda vive aqui, para poder ser provado sem arrancar o
// `node-cron`: `jobs/scheduler.js` limita-se a pedir o PLANO (`plano()`) e a
// registá-lo. Nenhuma decisão de agendamento fica no `jobs/scheduler.js`.
//
// Variáveis de ambiente (todas opcionais; os valores por omissão reproduzem o
// comportamento histórico — um backup diário às 03:00):
//   BACKUP_HOUR             hora (0–23) comum aos três ciclos. Por omissão 3.
//   BACKUP_WEEKLY_DAY       dia da semana do ciclo semanal (SU…SA ou 0…6).
//                           Por omissão SU (domingo).
//   BACKUP_MONTHLY_DAY      dia do mês do ciclo mensal (1–28). Por omissão 1.
//   BACKUP_WEEKLY_ENABLED   `0`/`false` desliga o ciclo semanal.
//   BACKUP_MONTHLY_ENABLED  `0`/`false` desliga o ciclo mensal.
// ─────────────────────────────────────────────────────────────────────

// Hora por omissão: a mesma do `BACKUP_HOUR` histórico (03:00).
const HORA_PADRAO = 3;
// Domingo — o dia de menor atividade na esmagadora dos condomínios.
const DIA_SEMANAL_PADRAO = 'SU';
// Dia 1 do mês.
const DIA_MENSAL_PADRAO = 1;

// node-cron: 0 = domingo … 6 = sábado (aceita também nomes de 3 letras).
const DIAS_SEMANA = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// ⛔ Máximo 28: os dias 29, 30 e 31 não existem em todos os meses, pelo que um
// backup mensal agendado para 31 nunca corria em fevereiro (e o de 30 falhava
// em fevereiro). 28 é o maior dia que existe SEMPRE.
const DIA_MENSAL_MAXIMO = 28;

// Interpreta um booleano de ambiente. Ausente/vazio ⇒ `defeito`.
function ativo(valor, defeito = true) {
  const t = String(valor == null ? '' : valor).trim().toLowerCase();
  if (!t) return defeito;
  if (['0', 'false', 'no', 'nao', 'não', 'off'].includes(t)) return false;
  if (['1', 'true', 'yes', 'sim', 'on'].includes(t)) return true;
  return defeito;
}

// 0–23; qualquer outra coisa cai no valor por omissão (nunca se inventa uma
// hora a partir de lixo — uma expressão cron inválida nunca é registada).
// ⛔ Vazio/ausente é testado ANTES do `Number()`: `Number('')` é 0, o que faria
// uma variável por definir significar «meia-noite» em vez do valor por omissão.
function normalizarHora(valor) {
  const t = String(valor == null ? '' : valor).trim();
  if (!t) return HORA_PADRAO;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : HORA_PADRAO;
}

// `SU`…`SA` (aceita minúsculas) ou `0`…`6`; por omissão `SU`.
function normalizarDiaSemanal(valor) {
  const t = String(valor == null ? '' : valor).trim().toUpperCase();
  if (!t) return DIA_SEMANAL_PADRAO;
  if (DIAS_SEMANA.includes(t)) return t;
  const n = Number(t);
  if (Number.isInteger(n) && n >= 0 && n <= 6) return DIAS_SEMANA[n];
  return DIA_SEMANAL_PADRAO;
}

// 1–28 (ver `DIA_MENSAL_MAXIMO`); por omissão 1.
function normalizarDiaMensal(valor) {
  const t = String(valor == null ? '' : valor).trim();
  if (!t) return DIA_MENSAL_PADRAO;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= DIA_MENSAL_MAXIMO ? n : DIA_MENSAL_PADRAO;
}

// As três expressões cron (5 campos: minuto hora dia-do-mês mês dia-da-semana).
function expressoes({ hora, diaSemanal, diaMensal } = {}) {
  const h = normalizarHora(hora);
  const ds = normalizarDiaSemanal(diaSemanal);
  const dm = normalizarDiaMensal(diaMensal);
  return {
    diario: `0 ${h} * * *`,
    semanal: `0 ${h} * * ${ds}`,
    mensal: `0 ${h} ${dm} * *`,
  };
}

// O PLANO que o agendador tem de registar: lista ordenada de `{ tipo, expressao }`.
// `manual` nunca aparece (é disparado à mão).
function plano(env = process.env) {
  const e = expressoes({
    hora: env && env.BACKUP_HOUR,
    diaSemanal: env && env.BACKUP_WEEKLY_DAY,
    diaMensal: env && env.BACKUP_MONTHLY_DAY,
  });
  const lista = [{ tipo: 'diario', expressao: e.diario }];
  if (ativo(env && env.BACKUP_WEEKLY_ENABLED, true)) lista.push({ tipo: 'semanal', expressao: e.semanal });
  if (ativo(env && env.BACKUP_MONTHLY_ENABLED, true)) lista.push({ tipo: 'mensal', expressao: e.mensal });
  return lista;
}

module.exports = {
  HORA_PADRAO,
  DIA_SEMANAL_PADRAO,
  DIA_MENSAL_PADRAO,
  DIAS_SEMANA,
  DIA_MENSAL_MAXIMO,
  ativo,
  normalizarHora,
  normalizarDiaSemanal,
  normalizarDiaMensal,
  expressoes,
  plano,
};
