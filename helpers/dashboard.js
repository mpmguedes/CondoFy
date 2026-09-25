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

// ── Sinais do painel ────────────────────────────────────────────────
//
// Parte PURA (sem consultas): recebe o que o handler já carregou e devolve a
// lista de sinais que exigem decisão da administração, por ordem de prioridade.
// Só entram os sinais com algo real a tratar — nunca se mostram zeros, porque um
// zero não é um problema. Cada sinal traz a quantidade e o destino da ação.
//
// ── A14 §9 — DUAS LISTAS QUE NÃO SE MISTURAM ────────────────────────
// Cada sinal declara `categoria`, e é essa declaração — NEM a gravidade nem o
// tipo — que decide em que lista do painel aparece:
//
//   · 'atencao'    → «Precisa de atenção»: um PROBLEMA ou uma situação
//                    operacional que exige intervenção (quotas em atraso,
//                    comprovativos por validar, backup falhado, emails com
//                    erro, quotas do mês ainda não geradas).
//   · 'preparacao' → «Preparação do condomínio»: CONFIGURAÇÃO que ainda não foi
//                    concluída (armazenamento dos documentos, email/SMTP,
//                    orçamento do ano por concluir).
//
// A regra é SEMÂNTICA: «ainda não configurou X» nunca é apresentado ao lado de
// «existe um problema». `separarSinais` é o único sítio que conhece as duas
// listas; a vista recebe-as já separadas e nunca as volta a misturar.
//
// ⛔ Um sinal que já tenha APRESENTAÇÃO PRÓPRIA no painel não entra em nenhuma
//    das duas listas: apareceria duas vezes. Foi por isso que «assembleias»
//    saiu daqui — as próximas assembleias têm cartão próprio no painel.
//
// Prioridade: segurança/estado do condomínio → dinheiro a receber → trabalho
// pendente → configuração. Números maiores aparecem primeiro. (Só ordena a
// lista; não decide a categoria.)
const PRIORIDADE_SINAL = {
  quotas_vencidas: 100,
  comprovativos: 90,
  quotas_mes: 80,
  pagamentos_fornecedor: 70,
  documentos: 60,
  orcamento: 50,
  email_erros: 40,
  backup: 35,
  drive: 30,
  smtp: 30,
};

// As duas categorias. Um sinal sem categoria válida é um ERRO DE PROGRAMAÇÃO:
// falha alto aqui (nos testes) em vez de aparecer calado na lista errada.
const CATEGORIAS_SINAL = new Set(['atencao', 'preparacao']);

// Sinais cujo DESTINO exige `comPapel('admin')` nos routers de `/admin`
// (`routes/emails.js` → email_erros/smtp; `routes/configuracao.js` →
// backup/drive). Só se mostram a quem tem efetivamente esse papel: um gestor
// receberia um `302 /` ao clicar. O papel NÃO vem de `users.role` (legado) —
// quem chama passa `podeAdmin` a partir do papel do condomínio ATIVO.
const SINAIS_SO_ADMIN = new Set(['email_erros', 'backup', 'drive', 'smtp']);

// Constrói os sinais. `dados`:
//  · nVencidas {number}, comprovativosPendentes {number}
//  · quotasMesEmitidas {number}, documentosPorDisponibilizar {number}
//  · orcamentoEstadoAberto {string|null}
//  · proximasAssembleias — ⛔ NÃO gera sinal (A14 §9): as próximas assembleias
//    já têm cartão próprio no painel; um sinal aqui repetia a informação e não
//    é nem um problema nem uma falta de configuração. O campo continua a ser
//    aceite para não partir quem já o passa.
//  · pagamentosFornecedorPendentes {number}, filaErros {number}
//  · documentosLigado {boolean} — os DOCUMENTOS do condomínio têm um serviço
//    de armazenamento ligado? (é o armazenamento principal do condomínio; não
//    tem nada a ver com o destino dos backups, que é da instalação)
//  · backupEstado {string|null} — estado interpretado do último backup
//    (`helpers/backup-estado.js`): só 'erro' e 'local_copia_cloud_falhada'
//    geram sinal (a cópia local existe nos dois casos).
//  · smtp {boolean}
//  · podeAdmin {boolean} — o perfil tem papel `admin` no condomínio ativo?
//    Omisso ⇒ true (compatibilidade: quem não passa o contexto mantém o
//    comportamento anterior). Com `false`, são omitidos os sinais cujo destino
//    exige `admin` — ver SINAIS_SO_ADMIN.
function sinaisDoPainel(dados = {}) {
  const sinais = [];
  const podeAdmin = dados.podeAdmin !== false;
  const juntar = (id, campos) => {
    if (!podeAdmin && SINAIS_SO_ADMIN.has(id)) return;
    // ⛔ Falha alto: um sinal novo sem `categoria` seria classificado por
    // omissão e podia ir parar à lista errada — exatamente a mistura que o
    // A14 §9 proíbe.
    if (!CATEGORIAS_SINAL.has(campos.categoria)) {
      throw new Error(`sinaisDoPainel: o sinal «${id}» não declara categoria ('atencao' ou 'preparacao')`);
    }
    sinais.push({ id, tipo: campos.tipo || 'trabalho', quantidade: Number(campos.quantidade) || 0, prioridade: PRIORIDADE_SINAL[id] || 0, ...campos });
  };

  // ══ «PRECISA DE ATENÇÃO» — problema real ═══════════════════════════
  if (Number(dados.nVencidas) > 0) {
    juntar('quotas_vencidas', {
      categoria: 'atencao',
      tipo: 'financeiro',
      gravidade: 'critico',
      texto: `${dados.nVencidas} quota(s) em atraso`,
      quantidade: dados.nVencidas,
      destino: { url: '/admin/quotas', texto: 'Ver quotas' },
    });
  }
  if (Number(dados.comprovativosPendentes) > 0) {
    juntar('comprovativos', {
      categoria: 'atencao',
      tipo: 'financeiro',
      gravidade: 'atencao',
      texto: `${dados.comprovativosPendentes} comprovativo(s) por validar`,
      quantidade: dados.comprovativosPendentes,
      destino: { url: '/admin/quotas/comprovativos', texto: 'Validar comprovativos' },
    });
  }
  if (Number(dados.quotasMesEmitidas) === 0) {
    juntar('quotas_mes', {
      // «Ainda não geradas» mas NÃO é falta de configuração: é trabalho
      // operacional do mês. Fica em Atenção (decisão de 2026-09-24).
      categoria: 'atencao',
      tipo: 'trabalho',
      gravidade: 'atencao',
      texto: 'Quotas do mês ainda não geradas',
      quantidade: 0,
      destino: { url: '/admin/quotas/gerar', texto: 'Gerar quotas' },
    });
  }
  if (Number(dados.pagamentosFornecedorPendentes) > 0) {
    juntar('pagamentos_fornecedor', {
      categoria: 'atencao',
      tipo: 'financeiro',
      gravidade: 'atencao',
      texto: `${dados.pagamentosFornecedorPendentes} pagamento(s) a fornecedores pendentes`,
      quantidade: dados.pagamentosFornecedorPendentes,
      destino: { url: '/admin/fornecedores', texto: 'Ver fornecedores' },
    });
  }
  if (Number(dados.documentosPorDisponibilizar) > 0) {
    juntar('documentos', {
      categoria: 'atencao',
      tipo: 'trabalho',
      gravidade: 'info',
      texto: `${dados.documentosPorDisponibilizar} documento(s) deste ano ainda não disponibilizados aos condóminos`,
      quantidade: dados.documentosPorDisponibilizar,
      destino: { url: '/admin/documentos', texto: 'Ver documentos' },
    });
  }
  if (Number(dados.filaErros) > 0) {
    juntar('email_erros', {
      categoria: 'atencao',
      tipo: 'sistema',
      gravidade: 'atencao',
      texto: `${dados.filaErros} email(s) com erro`,
      quantidade: dados.filaErros,
      destino: { url: '/admin/emails?estado=erros', texto: 'Ver emails' },
    });
  }
  // Último backup: só é um problema quando falhou por completo ou quando a
  // cópia cloud não foi criada. Em ambos os casos a cópia LOCAL é sempre
  // feita, por isso a mensagem di-lo explicitamente.
  if (dados.backupEstado === 'erro') {
    juntar('backup', {
      categoria: 'atencao',
      tipo: 'sistema',
      gravidade: 'atencao',
      texto: 'O último backup falhou',
      quantidade: 0,
      destino: { url: '/admin/config/armazenamento', texto: 'Ver backups' },
    });
  } else if (dados.backupEstado === 'local_copia_cloud_falhada') {
    juntar('backup', {
      categoria: 'atencao',
      tipo: 'sistema',
      gravidade: 'info',
      texto: 'A cópia cloud do último backup não foi criada (a cópia local existe)',
      quantidade: 0,
      destino: { url: '/admin/config/armazenamento', texto: 'Ver backups' },
    });
  }

  // ══ «PREPARAÇÃO DO CONDÓMINIO» — configuração ainda não concluída ══
  // Nenhum destes é um erro: são o que falta para o condomínio estar pronto.
  // Serviços: só se assinala o que está EXPLICITAMENTE desligado. Sem
  // informação (`undefined`) não se inventa uma falta — evita alarmes falsos
  // se o contexto vier incompleto.
  //
  // `documentosLigado` refere-se ao armazenamento principal DOS DOCUMENTOS do
  // condomínio (por condomínio) — nunca ao destino dos backups, que é uma
  // configuração da instalação e não depende deste condomínio.
  if (dados.documentosLigado === false) {
    juntar('drive', {
      categoria: 'preparacao',
      tipo: 'sistema',
      gravidade: 'info',
      texto: 'Sem serviço de armazenamento para os documentos',
      quantidade: 0,
      destino: { url: '/admin/config/armazenamento', texto: 'Ligar armazenamento' },
      ...estadoDePreparacao('requer-configuracao'),
    });
  }
  if (dados.smtp === false) {
    juntar('smtp', {
      categoria: 'preparacao',
      tipo: 'sistema',
      gravidade: 'info',
      texto: 'Email/SMTP não configurado',
      quantidade: 0,
      // A configuração SMTP passou para Configuração → Email / SMTP; a Central
      // de Emails ficou só com a operação da fila.
      destino: { url: '/admin/config/email', texto: 'Configurar' },
      ...estadoDePreparacao('requer-configuracao'),
    });
  }
  if (dados.orcamentoEstadoAberto) {
    juntar('orcamento', {
      // O orçamento do ano por concluir é PREPARAÇÃO, não um problema
      // (decisão de 2026-09-24): falta fechar o ano, não há nada errado.
      categoria: 'preparacao',
      tipo: 'trabalho',
      gravidade: 'info',
      texto: `Orçamento de ${dados.ano || ''} em ${dados.orcamentoEstadoRotulo || 'rascunho'}`.trim(),
      quantidade: 0,
      destino: { url: dados.orcamentoId ? `/admin/orcamento/${dados.orcamentoId}` : '/admin/orcamento', texto: 'Abrir orçamento' },
      ...estadoDePreparacao('por-concluir'),
    });
  }

  return sinais.sort((a, b) => b.prioridade - a.prioridade);
}

// Rótulo do estado de um sinal de PREPARAÇÃO (A14 §8). «Falta de configuração
// não deve parecer um erro» — por isso o texto diz o que é, sem dramatizar.
function estadoDePreparacao(estado) {
  const ROTULOS = {
    'requer-configuracao': 'Requer configuração',
    'por-concluir': 'Por concluir',
  };
  const rotulo = ROTULOS[estado];
  if (!rotulo) throw new Error(`estadoDePreparacao: estado desconhecido «${estado}»`);
  return { estado, estadoRotulo: rotulo };
}

// Separa os sinais nas DUAS listas do painel (A14 §9). Único sítio que conhece
// as duas categorias: a vista recebe-as já separadas e nunca volta a juntá-las.
// Um sinal fora destas duas categorias nunca chegou aqui (`juntar` recusa-o).
function separarSinais(sinais) {
  const atencao = [];
  const preparacao = [];
  for (const s of sinais || []) {
    if (s.categoria === 'preparacao') preparacao.push(s);
    else atencao.push(s);
  }
  return { atencao, preparacao };
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
  configurar_smtp: { rotulo: 'Configuração de email alterada', icone: 'settings', url: '/admin/config/email' },
  configurar_automacoes: { rotulo: 'Automações configuradas', icone: 'settings', url: '/admin/config/automacoes' },
  configurar_quotas: { rotulo: 'Configuração de quotas alterada', icone: 'settings', url: '/admin/quotas/config' },
  // `/admin/config/armazenamento/backups` só aceita POST: a atividade tem de
  // apontar para a página (GET), senão o clique dava 404.
  definir_destino_backups: { rotulo: 'Destino de backups alterado', icone: 'backup', url: '/admin/config/armazenamento' },
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
  // ⛔ `sinaisDeAtencao` passou a chamar-se `sinaisDoPainel`: agora devolve as
  // DUAS categorias (atenção e preparação), por isso o nome antigo mentia.
  sinaisDoPainel,
  separarSinais,
  orcamentoPorConcluir,
  ROTULOS_ESTADO_ORCAMENTO,
  ATIVIDADE,
  itemDeAtividade,
  atividadeRecente,
};
