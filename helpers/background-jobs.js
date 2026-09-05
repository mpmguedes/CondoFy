// ─────────────────────────────────────────────────────────────────────
// Tarefas em segundo plano (in-memory, processo único).
//
// Objetivo: operações pesadas (gerar PDFs, Google Drive, emails) saem do
// request HTTP e correm numa fila de processamento sequencial, sem bloquear
// a interface. O estado de cada tarefa fica disponível para a UI (indicador
// discreto) e inclui progresso e erros — sem perder os registos já feitos
// (os processadores devem ser idempotentes).
// ─────────────────────────────────────────────────────────────────────

const handlers = new Map();
const tarefas = new Map();
const fila = [];
let aProcessar = false;
let seq = 0;

const MAX_TAREFAS_RETIDAS = 200; // memória limitada: mantém as N mais recentes

function registar(tipo, handler) {
  handlers.set(tipo, handler);
}

// Cria e agenda uma tarefa. Devolve o id da tarefa.
function enqueue(tipo, dados = {}) {
  seq += 1;
  const id = `bg-${seq}`;
  tarefas.set(id, {
    id,
    tipo,
    dados,
    estado: 'fila',
    criadoEm: new Date(),
    progresso: null,
    erro: null,
    fimEm: null,
  });
  fila.push(id);
  // Limita memória: remove tarefas antigas concluídas/erro.
  while (tarefas.size > MAX_TAREFAS_RETIDAS) {
    const primeiro = tarefas.keys().next().value;
    const t = tarefas.get(primeiro);
    if (t && t.estado !== 'a_processar' && t.estado !== 'fila') tarefas.delete(primeiro);
    else break;
  }
  processar();
  return id;
}

async function processar() {
  if (aProcessar) return;
  aProcessar = true;
  try {
    while (fila.length) {
      const id = fila.shift();
      const t = tarefas.get(id);
      if (!t) continue;
      t.estado = 'a_processar';
      t.inicioEm = new Date();
      try {
        const handler = handlers.get(t.tipo);
        if (!handler) throw new Error(`Tipo de tarefa sem processador: ${t.tipo}`);
        await handler(t.dados, (progresso) => {
          t.progresso = progresso || null;
        });
        t.estado = 'concluido';
      } catch (err) {
        console.error('[tarefa] erro', id, t.tipo, err && err.message ? err.message : err);
        t.estado = 'erro';
        t.erro = String((err && err.message) || err);
      }
      t.fimEm = new Date();
    }
  } finally {
    aProcessar = false;
  }
}

function obterTarefa(id) {
  return tarefas.get(id) || null;
}

function listarTarefas(limite = 50) {
  return [...tarefas.values()].sort((a, b) => (b.criadoEm > a.criadoEm ? 1 : -1)).slice(0, limite);
}

// Resumo compacto para o indicador global (sempre sem dados sensíveis).
function resumo() {
  const valores = [...tarefas.values()];
  const ativas = valores.filter((t) => t.estado === 'fila' || t.estado === 'a_processar');
  const erros = valores.filter((t) => t.estado === 'erro');
  const concluidasRecentes = valores.filter((t) => t.estado === 'concluido' && t.fimEm && Date.now() - t.fimEm.getTime() < 60 * 60 * 1000);
  return {
    ativas: ativas.length,
    emErro: erros.length,
    concluidasRecentes: concluidasRecentes.length,
    emProcessamento: ativas.find((t) => t.estado === 'a_processar') ? true : false,
  };
}

module.exports = { registar, enqueue, obterTarefa, listarTarefas, resumo };
