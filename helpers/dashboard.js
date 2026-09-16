const { Op } = require('sequelize');
const {
  Quota,
  Pagamento,
  PagamentoQuota,
  ExtraQuotaParcela,
  Orcamento,
  OrcamentoRubrica,
  PlanoQuota,
} = require('../models');
const { toCents, fromCents } = require('./money');
const { estadoEfetivo } = require('./saldos');

function rangeMes(ano, mes) {
  const m = String(mes).padStart(2, '0');
  return [`${ano}-${m}-01`, `${ano}-${m}-31`];
}

// Resumo financeiro de um mês: quotas previstas (incl. FCR), parcelas extra
// previstas e recebidas (pagamentos confirmados no mês).
// condominioId (opcional, multi-condomínio): restringe ao condomínio ativo.
async function resumoFinanceiroMes(ano, mes, condominioId) {
  const [ini, fim] = rangeMes(ano, mes);
  const onde = condominioId ? { condominio_id: condominioId } : {};

  const [quotasMes, extraMes, recebidas] = await Promise.all([
    Quota.findAll({ where: { ano, mes, estado: { [Op.ne]: 'anulada' }, ...onde } }),
    ExtraQuotaParcela.findAll({
      where: { data_vencimento: { [Op.gte]: ini, [Op.lte]: fim }, estado: { [Op.ne]: 'anulada' } },
      include: condominioId
        ? [{ model: require('../models').ExtraQuota, as: 'extra_quota', attributes: [], where: { condominio_id: condominioId }, required: true }]
        : [],
    }),
    Pagamento.sum('valor', {
      where: { estado: 'confirmado', data_pagamento: { [Op.gte]: ini, [Op.lte]: fim }, ...onde },
    }),
  ]);

  const previstasC = quotasMes.reduce((s, q) => s + toCents(q.valor), 0);
  const extraC = extraMes.reduce((s, p) => s + toCents(p.valor), 0);

  return {
    previstas: fromCents(previstasC),
    extra: fromCents(extraC),
    recebidas: fromCents(toCents(recebidas)),
  };
}

// Total e contagem de quotas vencidas (em atraso), considerando apenas o que
// ainda está por pagar.
async function resumoEmAtraso(condominioId) {
  const onde = condominioId ? { condominio_id: condominioId } : {};
  const quotas = await Quota.findAll({
    where: { estado: { [Op.in]: ['pendente', 'parcialmente_paga', 'vencida'] }, ...onde },
  });

  const ids = quotas.map((q) => q.id);
  const aplicacoes = ids.length
    ? await PagamentoQuota.findAll({
        where: { quota_id: ids },
        include: [
          { model: Pagamento, as: 'pagamento', attributes: [], where: { estado: 'confirmado' }, required: true },
        ],
        raw: true,
      })
    : [];

  const pagoC = {};
  aplicacoes.forEach((a) => {
    pagoC[a.quota_id] = (pagoC[a.quota_id] || 0) + toCents(a.valor_aplicado);
  });

  let totalC = 0;
  let count = 0;
  for (const q of quotas) {
    if (estadoEfetivo(q) === 'vencida') {
      const emAberto = toCents(q.valor) - (pagoC[q.id] || 0);
      if (emAberto > 0) {
        totalC += emAberto;
        count += 1;
      }
    }
  }

  return { total: fromCents(totalC), count };
}

// Orçamento cujo ano de início corresponde ao ano indicado (ou null), com os
// totais previstos: despesas (rubricas), receitas (plano emitido/planeado) e saldo.
// Orçamentos ANULADOS nunca são apresentados como o orçamento corrente do ano.
async function orcamentoDoAno(ano, condominioId) {
  const onde = condominioId
    ? { condominio_id: condominioId, estado: { [Op.ne]: 'anulado' } }
    : { estado: { [Op.ne]: 'anulado' } };
  const orcamentos = await Orcamento.findAll({
    where: onde,
    include: [{ model: OrcamentoRubrica, as: 'rubricas' }],
    order: [['data_inicio', 'ASC']],
  });
  const orcamento = orcamentos.find((o) => new Date(o.data_inicio).getFullYear() === ano) || null;
  if (!orcamento) return null;

  const despesasC = orcamento.rubricas.filter((r) => r.ativo).reduce((s, r) => s + toCents(r.valor_anual), 0);
  const plano = await PlanoQuota.findAll({
    where: { orcamento_id: orcamento.id, estado: { [Op.ne]: 'cancelada' } },
    raw: true,
  });
  const receitasC = plano.reduce((s, p) => s + toCents(p.valor), 0);

  return {
    ...orcamento.toJSON(),
    despesasPrevistas: fromCents(despesasC),
    receitasPrevistas: fromCents(receitasC),
    saldoPrevisto: fromCents(receitasC - despesasC),
  };
}

// ── Sinais de atenção do painel ─────────────────────────────────────
//
// Parte PURA (sem consultas): recebe o que o handler já carregou e devolve a
// lista de sinais que exigem decisão da administração, por ordem de prioridade.
// Só entram os sinais com algo real a tratar — nunca se mostram zeros, porque um
// zero não é um problema. Cada sinal traz a quantidade e o destino da ação.
//
// Prioridade: segurança/estado do condomínio → dinheiro a receber → trabalho
// pendente → configuração. Números maiores aparecem primeiro.
const PRIORIDADE_SINAL = {
  quotas_vencidas: 100,
  comprovativos: 90,
  quotas_mes: 80,
  pagamentos_fornecedor: 70,
  documentos: 60,
  orcamento: 50,
  assembleias: 45,
  email_erros: 40,
  drive: 30,
  smtp: 30,
};

// Constrói os sinais. `dados`:
//  · nVencidas {number}, comprovativosPendentes {number}
//  · quotasMesEmitidas {number}, documentosPorDisponibilizar {number}
//  · orcamentoEstadoAberto {string|null}
//  · proximasAssembleias {Array<{id, numero, data, designacao}>}
//  · pagamentosFornecedorPendentes {number}, filaErros {number}
//  · driveLigado {boolean}, smtp {boolean}
function sinaisDeAtencao(dados = {}) {
  const sinais = [];
  const juntar = (id, campos) => {
    sinais.push({ id, tipo: campos.tipo || 'trabalho', quantidade: Number(campos.quantidade) || 0, prioridade: PRIORIDADE_SINAL[id] || 0, ...campos });
  };

  if (Number(dados.nVencidas) > 0) {
    juntar('quotas_vencidas', {
      tipo: 'financeiro',
      gravidade: 'critico',
      texto: `${dados.nVencidas} quota(s) em atraso`,
      quantidade: dados.nVencidas,
      destino: { url: '/admin/quotas', texto: 'Ver quotas' },
    });
  }
  if (Number(dados.comprovativosPendentes) > 0) {
    juntar('comprovativos', {
      tipo: 'financeiro',
      gravidade: 'atencao',
      texto: `${dados.comprovativosPendentes} comprovativo(s) por validar`,
      quantidade: dados.comprovativosPendentes,
      destino: { url: '/admin/quotas/comprovativos', texto: 'Validar comprovativos' },
    });
  }
  if (Number(dados.quotasMesEmitidas) === 0) {
    juntar('quotas_mes', {
      tipo: 'trabalho',
      gravidade: 'atencao',
      texto: 'Quotas do mês ainda não geradas',
      quantidade: 0,
      destino: { url: '/admin/quotas/gerar', texto: 'Gerar quotas' },
    });
  }
  if (Number(dados.pagamentosFornecedorPendentes) > 0) {
    juntar('pagamentos_fornecedor', {
      tipo: 'financeiro',
      gravidade: 'atencao',
      texto: `${dados.pagamentosFornecedorPendentes} pagamento(s) a fornecedores pendentes`,
      quantidade: dados.pagamentosFornecedorPendentes,
      destino: { url: '/admin/fornecedores', texto: 'Ver fornecedores' },
    });
  }
  if (Number(dados.documentosPorDisponibilizar) > 0) {
    juntar('documentos', {
      tipo: 'trabalho',
      gravidade: 'info',
      texto: `${dados.documentosPorDisponibilizar} documento(s) deste ano ainda não disponibilizados aos condóminos`,
      quantidade: dados.documentosPorDisponibilizar,
      destino: { url: '/admin/documentos', texto: 'Ver documentos' },
    });
  }
  if (dados.orcamentoEstadoAberto) {
    juntar('orcamento', {
      tipo: 'trabalho',
      gravidade: 'info',
      texto: `Orçamento de ${dados.ano || ''} em ${dados.orcamentoEstadoRotulo || 'rascunho'}`.trim(),
      quantidade: 0,
      destino: { url: dados.orcamentoId ? `/admin/orcamento/${dados.orcamentoId}` : '/admin/orcamento', texto: 'Abrir orçamento' },
    });
  }
  const proximas = Array.isArray(dados.proximasAssembleias) ? dados.proximasAssembleias : [];
  if (proximas.length) {
    const primeira = proximas[0];
    juntar('assembleias', {
      tipo: 'trabalho',
      gravidade: 'info',
      texto: `Assembleia a ${primeira.data}`,
      quantidade: 0,
      destino: { url: `/admin/assembleias/${primeira.id}`, texto: 'Ver assembleia' },
    });
  }
  if (Number(dados.filaErros) > 0) {
    juntar('email_erros', {
      tipo: 'sistema',
      gravidade: 'atencao',
      texto: `${dados.filaErros} email(s) com erro`,
      quantidade: dados.filaErros,
      destino: { url: '/admin/emails?estado=erros', texto: 'Ver emails' },
    });
  }
  // Serviços: só se assinala o que está EXPLICITAMENTE desligado. Sem
  // informação (`undefined`) não se inventa um problema — evita alarmes falsos
  // se o contexto vier incompleto.
  if (dados.driveLigado === false) {
    juntar('drive', {
      tipo: 'sistema',
      gravidade: 'info',
      texto: 'Armazenamento externo desligado',
      quantidade: 0,
      destino: { url: '/admin/config/armazenamento', texto: 'Ligar armazenamento' },
    });
  }
  if (dados.smtp === false) {
    juntar('smtp', {
      tipo: 'sistema',
      gravidade: 'info',
      texto: 'Email/SMTP não configurado',
      quantidade: 0,
      destino: { url: '/admin/emails#smtp', texto: 'Configurar' },
    });
  }

  return sinais.sort((a, b) => b.prioridade - a.prioridade);
}

// Rótulos legíveis dos estados do orçamento (os mesmos da interface).
const ROTULOS_ESTADO_ORCAMENTO = {
  rascunho: 'rascunho',
  aprovado: 'aprovado',
  em_execucao: 'em execução',
  encerrado: 'fechado',
  anulado: 'anulado',
};

// Um orçamento exige ação quando ainda não foi fechado nem anulado.
function orcamentoPorConcluir(orcamento) {
  if (!orcamento) return null;
  const estado = String(orcamento.estado || '');
  if (!['rascunho', 'aprovado', 'em_execucao'].includes(estado)) return null;
  return { id: orcamento.id, estado, rotulo: ROTULOS_ESTADO_ORCAMENTO[estado] || estado };
}

// ── Atividade recente (audit_logs) ──────────────────────────────────
//
// Só eventos úteis à administração (nada de sessões, 2FA, dispensas de
// recomendações nem exportações de dados), com ícone, texto e destino.
// A tabela `audit_logs` NÃO tem condominio_id: o âmbito ao condomínio ativo é
// feito pelos utilizadores associados a esse condomínio (ver o handler).
const ATIVIDADE = {
  criar_titularidade: { rotulo: 'Titular acrescentado', icone: 'person_add', url: '/admin/fracoes' },
  cessar_titularidade: { rotulo: 'Titularidade cessada', icone: 'person_remove', url: '/admin/fracoes' },
  gerar_quotas: { rotulo: 'Quotas geradas', icone: 'event_repeat', url: '/admin/quotas' },
  emitir_quotas: { rotulo: 'Quotas emitidas', icone: 'event_repeat', url: '/admin/quotas' },
  editar_quota: { rotulo: 'Quota editada', icone: 'edit_note', url: '/admin/quotas' },
  anular_quota: { rotulo: 'Quota anulada', icone: 'block', url: '/admin/quotas' },
  gerar_plano_quotas: { rotulo: 'Plano de quotas gerado', icone: 'calendar_view_month', url: '/admin/orcamento' },
  registar_pagamento: { rotulo: 'Pagamento registado', icone: 'payments', url: '/admin/quotas/comprovativos' },
  anular_pagamento: { rotulo: 'Pagamento anulado', icone: 'undo', url: '/admin/quotas/comprovativos' },
  anexar_comprovativo: { rotulo: 'Comprovativo anexado', icone: 'attach_file', url: '/admin/quotas/comprovativos' },
  validar_comprovativo: { rotulo: 'Comprovativo validado', icone: 'verified', url: '/admin/quotas/comprovativos' },
  rejeitar_comprovativo: { rotulo: 'Comprovativo rejeitado', icone: 'report', url: '/admin/quotas/comprovativos' },
  emitir_recibo: { rotulo: 'Recibo emitido', icone: 'receipt', url: '/admin/quotas/recibos' },
  emitir_recibo_pagamento: { rotulo: 'Recibo emitido', icone: 'receipt', url: '/admin/quotas/recibos' },
  anular_recibo: { rotulo: 'Recibo anulado', icone: 'receipt_long', url: '/admin/quotas/recibos' },
  criar_quota_extra: { rotulo: 'Quota extraordinária criada', icone: 'request_quote', url: '/admin/quotas-extra' },
  aprovar_quota_extra: { rotulo: 'Quota extraordinária aprovada', icone: 'task_alt', url: '/admin/quotas-extra' },
  processar_quota_extra: { rotulo: 'Quota extraordinária processada', icone: 'play_circle', url: '/admin/quotas-extra' },
  criar_documento: { rotulo: 'Documento criado', icone: 'note_add', url: '/admin/documentos' },
  eliminar_documento: { rotulo: 'Documento eliminado', icone: 'delete', url: '/admin/documentos' },
  enviar_documento_email: { rotulo: 'Documento enviado por email', icone: 'forward_to_inbox', url: '/admin/documentos' },
  criar_aviso: { rotulo: 'Aviso criado', icone: 'campaign', url: '/admin/avisos' },
  enviar_aviso: { rotulo: 'Aviso enviado', icone: 'send', url: '/admin/avisos' },
  criar_assembleia: { rotulo: 'Assembleia criada', icone: 'forum', url: '/admin/assembleias' },
  editar_assembleia: { rotulo: 'Assembleia atualizada', icone: 'edit_calendar', url: '/admin/assembleias' },
  gerar_convocatoria: { rotulo: 'Convocatória gerada', icone: 'mail', url: '/admin/assembleias' },
  criar_despesa: { rotulo: 'Despesa registada', icone: 'credit_card', url: '/admin/orcamento/despesas' },
  editar_despesa: { rotulo: 'Despesa atualizada', icone: 'edit_note', url: '/admin/orcamento/despesas' },
  anular_despesa: { rotulo: 'Despesa anulada', icone: 'block', url: '/admin/orcamento/despesas' },
  criar_fornecedor: { rotulo: 'Fornecedor criado', icone: 'local_shipping', url: '/admin/fornecedores' },
  editar_fornecedor: { rotulo: 'Fornecedor atualizado', icone: 'edit_note', url: '/admin/fornecedores' },
  criar_pagamento_fornecedor: { rotulo: 'Pagamento a fornecedor criado', icone: 'payments', url: '/admin/fornecedores' },
  estado_pagamento_fornecedor: { rotulo: 'Estado de pagamento a fornecedor alterado', icone: 'swap_horiz', url: '/admin/fornecedores' },
  criar_utilizador: { rotulo: 'Utilizador criado', icone: 'person_add', url: '/admin/utilizadores' },
  eliminar_utilizador: { rotulo: 'Utilizador eliminado', icone: 'person_remove', url: '/admin/utilizadores' },
  alterar_associacao_condominio: { rotulo: 'Acesso a condomínio alterado', icone: 'swap_horiz', url: '/admin/utilizadores' },
  reativar_acesso_condominio: { rotulo: 'Acesso a condomínio reativado', icone: 'lock_open', url: '/admin/utilizadores' },
  encerrar_acesso_condominio: { rotulo: 'Acesso a condomínio encerrado', icone: 'lock', url: '/admin/utilizadores' },
  configurar_smtp: { rotulo: 'Configuração de email alterada', icone: 'settings', url: '/admin/emails' },
  configurar_automacoes: { rotulo: 'Automações configuradas', icone: 'settings', url: '/admin/config/automacoes' },
  configurar_quotas: { rotulo: 'Configuração de quotas alterada', icone: 'settings', url: '/admin/quotas/config' },
  definir_destino_backups: { rotulo: 'Destino de backups alterado', icone: 'backup', url: '/admin/config/armazenamento/backups' },
  configurar_armazenamento_drive: { rotulo: 'Armazenamento configurado', icone: 'cloud_done', url: '/admin/config/armazenamento' },
};

// Converte um registo de auditoria no item que o painel apresenta. Devolve null
// para tudo o que não seja atividade útil à administração.
function itemDeAtividade(registo) {
  if (!registo) return null;
  const info = ATIVIDADE[registo.acao];
  if (!info) return null;
  return {
    acao: registo.acao,
    rotulo: info.rotulo,
    icone: info.icone,
    url: info.url,
    data: registo.data_hora || registo.createdAt || null,
    // Só o nome de quem fez a ação (nunca email nem detalhes internos).
    autor: registo.utilizador ? registo.utilizador.nome : null,
  };
}

// Lista pronta para a vista: só eventos úteis, no máximo `limite`.
function atividadeRecente(registos = [], limite = 5) {
  return (Array.isArray(registos) ? registos : [])
    .map(itemDeAtividade)
    .filter(Boolean)
    .slice(0, limite);
}

module.exports = {
  resumoFinanceiroMes,
  resumoEmAtraso,
  orcamentoDoAno,
  sinaisDeAtencao,
  orcamentoPorConcluir,
  ROTULOS_ESTADO_ORCAMENTO,
  ATIVIDADE,
  itemDeAtividade,
  atividadeRecente,
};
