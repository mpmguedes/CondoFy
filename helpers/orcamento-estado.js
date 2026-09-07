// ─────────────────────────────────────────────────────────────────────
// Orçamento — regras de estado (rascunho / aprovado / em execução /
// fechado / anulado).
//
// Fonte única das transições e ações permitidas, testável offline:
//  · Rascunho: editar, gerir rubricas/valores, eliminar, aprovar;
//  · Aprovado: protegido de edições normais; sem eliminação destrutiva;
//    pode ser fechado ou ANULADO (ação distinta — preserva o histórico);
//  · Em execução: sem edições normais; pode ser fechado;
//  · Fechado: histórico encerrado; apenas alterações extraordinárias com
//    justificação (mantém o comportamento existente);
//  · Anulado: histórico, apenas leitura — não edita, não aprova, não
//    fecha, não anula de novo, não elimina, não executa.
// ─────────────────────────────────────────────────────────────────────
const ESTADOS = {
  rascunho: 'Rascunho',
  aprovado: 'Aprovado',
  em_execucao: 'Em execução',
  encerrado: 'Fechado',
  anulado: 'Anulado',
};

function podeEditar(estado) {
  return estado === 'rascunho';
}

function podeAprovar(estado) {
  return estado === 'rascunho';
}

function podeEliminar(estado) {
  return estado === 'rascunho';
}

// Anulação é uma ação distinta de eliminar e aplica-se apenas a um orçamento
// aprovado que ainda NÃO entrou em execução (sem quotas emitidas).
function podeAnular(estado) {
  return estado === 'aprovado';
}

function podeFechar(estado) {
  return estado === 'aprovado' || estado === 'em_execucao';
}

// Alteração extraordinária de rubrica (com justificação) fora do rascunho —
// mantida para aprovado/em execução/fechado; nunca num anulado.
function podeAlteracaoExtraordinaria(estado) {
  return estado === 'aprovado' || estado === 'em_execucao' || estado === 'encerrado';
}

// Ações de execução/planeamento (emitir, distribuição, plano): bloqueadas
// apenas num orçamento anulado (as restantes regras existentes mantêm-se).
function naoAnulado(estado) {
  return estado !== 'anulado';
}

module.exports = {
  ESTADOS,
  podeEditar,
  podeAprovar,
  podeEliminar,
  podeAnular,
  podeFechar,
  podeAlteracaoExtraordinaria,
  naoAnulado,
};
