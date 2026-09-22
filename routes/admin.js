const express = require('express');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const {
  Fracao,
  Pessoa,
  FracaoPessoa,
  FracaoTitularidade,
  User,
  UserCondominio,
  Condominio,
  Categoria,
  MetodoPagamento,
  ContaBancaria,
  Quota,
  Pagamento,
  Despesa,
  Documento,
  Aviso,
  AvisoDestinatario,
  Assembleia,
  AuditLog,
  Fornecedor,
  PagamentoFornecedor,
  BackupLog,
  EmailFila,
} = require('../models');
const tenant = require('../helpers/tenant');
const { toCents, fromCents } = require('../helpers/money');
const { audit } = require('../helpers/audit');
const { getCondominio } = require('../helpers/condominio');
const { resumoCondominio, resumoFracao, estadoEfetivo } = require('../helpers/saldos');
const { resumoFinanceiroMes, resumoEmAtraso, orcamentoDoAno } = require('../helpers/dashboard');
// Ajudante completo do painel (sinais de atenção, atividade recente, orçamento).
const dashboardHelpers = require('../helpers/dashboard');
// Histórico de titularidade da fração (relação temporal pessoa/conta ↔ fração).
const titularidades = require('../helpers/titularidades');
const { validarNif } = require('../public/js/validacao-fiscal');
// Estado real do armazenamento: DOCUMENTOS (por condomínio) e BACKUPS
// (configuração da instalação) são dois eixos independentes.
const storage = require('../helpers/storage');
// Interpretação pura de um registo de `backup_logs` (cópia local vs. cópia
// cloud) — nenhuma vista decide isto por si.
const backupEstado = require('../helpers/backup-estado');
const { smtpConfigured, sendMail } = require('../helpers/mailer');
const convites = require('../helpers/convites');
// Acesso de suporte (terceiro contexto de autorização) — usado apenas no bloco
// que autoriza/recusa/revoga os pedidos de diagnóstico feitos por um Super
// Admin. As restantes rotas deste router ignoram-no por completo.
const suporte = require('../helpers/suporte');
const background = require('../helpers/background-jobs');
// Tips contextuais do painel: orientação (o que pode não ser óbvio), distinta
// dos sinais de atenção (factos operacionais). A decisão é do motor puro.
const tips = require('../helpers/tips');
// Regra real da permilagem (a soma tem de fechar 1000‰) — uma só implementação.
const { validarPermilagem } = require('../helpers/permilagem');
const { sincronizarContactosPessoa, parseContactosForm, validarContactos, contactosParaForm } = require('../helpers/contactos');

const router = express.Router();

// Isolamento: condomínio ativo (sessão validada) em todas as operações.
router.use(tenant.comCondominioAtivo);

// ── Guarda do backoffice: mínimo `gestor` (não `admin`) ─────────────
// `/admin` é o backoffice COMUM de `admin` e `gestor` — é o destino que
// `tenant.destinoInicial()` dá a ambos (`uc.role` ∈ {'admin','gestor'}).
// A guarda do router tem de ter o MESMO mínimo que o destino, senão um gestor
// é enviado para `/admin` e imediatamente expulso para `/` (a inconsistência
// que esta alteração corrige).
//
// As permissões ESPECÍFICAS continuam protegidas nos sítios próprios, com o
// mínimo respetivo — um gestor não ganha nada com isto:
//   · rotas de gestão de utilizadores deste router → `comPapel('admin')`
//     (ver `apenasAdmin` abaixo, aplicado rota a rota);
//   · `routes/configuracao.js`, `routes/sistema.js` e `routes/emails.js`
//     mantêm o seu próprio `router.use(comPapel('admin'))`;
//   · os módulos `Calendário`/`Tickets`/`Seguros` mantêm `comPapel('admin')`
//     em `routes/placeholders.js`;
//   · os restantes módulos de `/admin` usam `comPapel('gestor')`.
// Fonte do papel: `utilizador_condominios.role` (associação ativa). Nunca
// `users.role`, que é legado.
//
// ── ALLOW-LIST do suporte diagnóstico ─────────────────────────────
// A superfície de suporte é um CONJUNTO FECHADO de rotas de LEITURA, definido
// num só sítio (`helpers/suporte-allowlist.js`) e partilhado por todos os
// módulos de `/admin`. Aqui monta-se apenas a ADMISSÃO deste módulo.
//
// A entrada é UM SÓ PONTO — o guard `soDiagnostico('admin')` — montado como
// `router.use` ANTES de qualquer rota. Ele admite o pedido de suporte apenas
// quando o CONTEXTO é de suporte, o NÍVEL é `diagnostico`, o CAMINHO consta da
// lista do módulo e o MÉTODO é de leitura (GET/HEAD). Só então a guarda de
// papel é contornada; tudo o resto é recusado. Uma rota nova neste ficheiro
// nasce INACESSÍVEL ao suporte.
//
// NOTA DE DESENHO — `/fracoes/:id` NÃO está na lista. A ficha da fração junta
// identidade, contactos, quotas, pagamentos, documentos e avisos; a separação
// estrutural é mais fiável do que mascarar uma vista que mistura identidade e
// finanças. A rota continua disponível a admin/gestor.
const allowlistSuporte = require('../helpers/suporte-allowlist');
const ADMITIDO_SUPORTE = allowlistSuporte.ADMITIDO_SUPORTE;

// Guard de admissão DESTE módulo. Condicional: sem suporte, segue e a guarda de
// papel decide; com suporte, só passa o que a lista do módulo admite.
router.use(allowlistSuporte.soDiagnostico('admin'));

// ── Guarda de papel do backoffice: mínimo `gestor` ─────────────────
// `tenant.destinoInicial()` dá a `admin` e `gestor`; as operações estritamente
// de admin usam `apenasAdmin`, rota a rota.
//
// Um acesso de suporte admitido pela allow-list NÃO tem papel
// (`req.papelCondominio === null`) e seria recusado pela guarda de papel. O
// crivo de admissão corre ANTES e marca `req[ADMITIDO_SUPORTE]`; a guarda de
// papel continua a ser a ÚNICA decisora de todos os outros pedidos.
//
// A montagem é CONDICIONAL porque um `router.use` incondicional a seguir
// recusaria outra vez, e sempre, o pedido de suporte que a admissão acabou de
// deixar passar — a allow-list deixaria de funcionar por completo. A guarda de
// papel em si (`tenant.comPapel('gestor')`) não é alterada: é o mesmo mínimo,
// aplicado pelo mesmo guard, aos mesmos pedidos (todos os que não são suporte
// admitido). A lógica vive em `helpers/suporte-allowlist.js` para ser o MESMO
// wrapper em todos os módulos.
router.use(allowlistSuporte.comPapelOuSuporteAdmitido('gestor'));

// Guarda por rota, para o que exige estritamente `admin`. Como o `router.use`
// acima já garante `gestor`, isto só recusa efetivamente o gestor.
const apenasAdmin = tenant.comPapel('admin');

// Escopo e carregadores restritos ao condomínio ativo (bloqueiam IDOR).
function onde(req, extra = {}) {
  return { condominio_id: req.condominioId, ...extra };
}
function carregarFracao(req) {
  return Fracao.findOne({ where: { id: req.params.id, condominio_id: req.condominioId } });
}
function carregarPessoa(req) {
  return Pessoa.findOne({ where: { id: req.params.id, condominio_id: req.condominioId } });
}

function parseDecimal(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// ── Dashboard ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const hoje = new Date().toISOString().slice(0, 10);
  const [nFracoes, nPessoas, nUsers, condominio, resumo, quotas, ultimoBackup, filaPendentes, filaErros] =
    await Promise.all([
      Fracao.count({ where: onde(req) }),
      Pessoa.count({ where: onde(req) }),
      UserCondominio.count({ where: { condominio_id: req.condominioId } }),
      getCondominio({ id: req.condominioId }),
      resumoCondominio(req.condominioId),
      Quota.findAll({ where: onde(req, { estado: { [Op.ne]: 'anulada' } }) }),
      BackupLog.findOne({ order: [['id', 'DESC']] }),
      // Contagens da fila isoladas por condomínio (nunca globais).
      EmailFila.count({ where: onde(req, { estado: 'pendente' }) }),
      EmailFila.count({ where: onde(req, { estado: 'erro' }) }),
    ]);

  const [nDriveDocs, nEmailsEnviados, nFornecedores, nPagFornecedorPendentes] = await Promise.all([
    Documento.count({ where: onde(req, { drive_status: 'guardado' }) }),
    // Contagens isoladas por condomínio (nunca globais).
    EmailFila.count({ where: onde(req, { estado: 'enviado' }) }),
    Fornecedor.count({ where: onde(req, { ativo: true }) }),
    PagamentoFornecedor.count({ where: onde(req, { estado: 'pendente' }) }),
  ]);

  // ── Sinais de atenção + atividade recente (Fase 2H.2) ─────────────
  // Tudo o que é carregado aqui serve os dois blocos novos. Isolamento: cada
  // consulta filtra pelo condomínio ativo; `audit_logs` não tem condominio_id,
  // por isso o âmbito é feito pelos utilizadores associados a este condomínio
  // (ver o comentário antes da consulta).
  const anoCorrente = new Date().getFullYear();
  const mesCorrente = new Date().getMonth() + 1;
  const inicioAno = `${anoCorrente}-01-01`;
  const fimAno = `${anoCorrente}-12-31`;
  const idsUtilizadoresDoCondominio = await UserCondominio.findAll({
    where: { condominio_id: req.condominioId },
    attributes: ['utilizador_id'],
    raw: true,
  });
  const utilizadoresDoCondominio = idsUtilizadoresDoCondominio.map((u) => u.utilizador_id).filter(Boolean);

  const [
    quotasDoMes,
    proximasAssembleias,
    documentosPorDisponibilizar,
    comprovativosPendentes,
    registosAuditoria,
  ] = await Promise.all([
    // As quotas do mês corrente, com a MESMA lógica da geração de quotas
    // (`/admin/quotas/gerar`): ano + mês, sem as anuladas.
    Quota.count({ where: onde(req, { ano: anoCorrente, mes: mesCorrente, estado: { [Op.ne]: 'anulada' } }) }),
    // Próximas assembleias relevantes, com a mesma seleção da área Assembleias.
    Assembleia.findAll({
      where: onde(req, { estado: { [Op.in]: ['agendada', 'convocada'] }, data: { [Op.gte]: hoje } }),
      order: [['data', 'ASC'], ['hora', 'ASC']],
      limit: 3,
    }),
    // Documentos DESTE ano ainda não disponibilizados aos condóminos (o
    // histórico antigo não é apresentado como pendente).
    Documento.count({ where: onde(req, { disponivel_condominos: false, data: { [Op.between]: [inicioAno, fimAno] } }) }),
    // Comprovativos à espera de validação — o mesmo critério do módulo de
    // Comprovativos (pagamento confirmado com ficheiro e estado pendente).
    Pagamento.count({ where: onde(req, { estado: 'confirmado', comprovativo_estado: 'pendente' }) }),
    // Atividade recente. `audit_logs` não tem condominio_id: filtra-se pelos
    // utilizadores associados a este condomínio, para nunca trazer atividade de
    // outro condomínio em instalações com vários.
    utilizadoresDoCondominio.length
      ? AuditLog.findAll({
          where: { user_id: { [Op.in]: utilizadoresDoCondominio } },
          include: [{ model: User, as: 'user', attributes: ['id', 'nome'], required: false }],
          order: [['id', 'DESC']],
          limit: 60,
        })
      : [],
  ]);

  const nPagas = quotas.filter((q) => q.estado === 'paga').length;
  const nPendentes = quotas.filter((q) => ['pendente', 'parcialmente_paga'].includes(q.estado)).length;
  const nVencidas = quotas.filter((q) => estadoEfetivo(q) === 'vencida').length;

  // Gráficos do dashboard (ano corrente)
  const anoAtual = new Date().getFullYear();
  const mesAtual = new Date().getMonth() + 1;
  const [pagamentos, despesas, financeiroMes, emAtraso, orcamentoAno] = await Promise.all([
    Pagamento.findAll({ attributes: ['valor', 'data_pagamento'], where: onde(req, { estado: 'confirmado' }), raw: true }),
    Despesa.findAll({
      attributes: ['valor', 'data'],
      where: onde(req, { estado: { [Op.ne]: 'anulada' } }),
      include: [{ model: Categoria, as: 'categoria', attributes: ['nome'] }],
      raw: true,
    }),
    resumoFinanceiroMes(anoAtual, mesAtual, req.condominioId),
    resumoEmAtraso(req.condominioId),
    orcamentoDoAno(anoAtual, req.condominioId),
  ]);

  const receitasMes = Array(12).fill(0);
  const despesasMes = Array(12).fill(0);
  const porCategoria = {};

  pagamentos.forEach((p) => {
    const d = p.data_pagamento ? new Date(p.data_pagamento) : null;
    if (d && !isNaN(d.getTime()) && d.getFullYear() === anoAtual) receitasMes[d.getMonth()] += toCents(p.valor);
  });
  despesas.forEach((d) => {
    const dt = d.data ? new Date(d.data) : null;
    if (dt && !isNaN(dt.getTime()) && dt.getFullYear() === anoAtual) despesasMes[dt.getMonth()] += toCents(d.valor);
    const nome = d['categoria.nome'] || 'Outras';
    porCategoria[nome] = (porCategoria[nome] || 0) + toCents(d.valor);
  });

  const categoriasTop = Object.entries(porCategoria).sort((a, b) => b[1] - a[1]).slice(0, 6);

  // TOP DEVEDORES (Painel): agrupado por fração, quotas não pagas.
  // `permilagem` é lida aqui (a mesma consulta) para os tips de estrutura
  // avaliarem a soma real sem uma segunda passagem à tabela.
  const fracoesTodas = await Fracao.findAll({ attributes: ['id', 'designacao', 'permilagem'], where: onde(req) });
  const nomeFracao = new Map(fracoesTodas.map((f) => [f.id, f.designacao]));
  const mapaDivida = new Map();
  for (const q of quotas) {
    if (q.estado === 'anulada') continue;
    const st = estadoEfetivo(q);
    if (st === 'paga' || st === 'anulada') continue;
    const e = mapaDivida.get(q.fracao_id) || { fracao: nomeFracao.get(q.fracao_id) || `#${q.fracao_id}`, meses: new Set(), totalC: 0 };
    e.meses.add(`${q.ano}-${String(q.mes).padStart(2, '0')}`);
    e.totalC += toCents(q.valor);
    mapaDivida.set(q.fracao_id, e);
  }
  const topDevedores = [...mapaDivida.values()]
    .map((e) => ({ fracao: e.fracao, meses: e.meses.size, totalC: e.totalC, total: fromCents(e.totalC) }))
    .sort((a, b) => b.totalC - a.totalC)
    .slice(0, 5);

  // Estado real dos serviços, nos DOIS eixos independentes:
  //  · DOCUMENTOS — o serviço principal DESTE condomínio (por condomínio);
  //  · BACKUPS — a cópia LOCAL (sempre existe) e, quando configurado e
  //    utilizável, o destino GLOBAL da instalação (que pode ser outro serviço).
  // O serviço dos documentos resolve-se com o condomínio ativo: a versão
  // anterior avaliava o armazenamento SEM âmbito de condomínio (lia apenas a
  // ligação da plataforma) e mostrava «Desligado» a um condomínio que tinha o
  // Drive ligado.
  const documentosLigado = storage.isConfigured(req.condominioId);
  const destinoBackup = await storage.destinoDeBackup().catch(() => null);
  const provedorBackup = destinoBackup ? storage.obterProvedor(destinoBackup) : null;
  const ligacaoBackup = destinoBackup ? storage.ligacaoDeBackup(destinoBackup) : null;
  // Só é apresentado como destino ativo o que o job consegue mesmo usar: um
  // destino configurado sem ligação utilizável é ignorado por ele.
  const copiaCloud = provedorBackup && ligacaoBackup && ligacaoBackup.origem
    ? {
        nome: destinoBackup,
        rotulo: provedorBackup.rotulo(),
        icone: typeof provedorBackup.icone === 'function' ? provedorBackup.icone() : 'bi bi-cloud',
        conta: ligacaoBackup.conta || null,
      }
    : null;
  const rotulosProvedor = {};
  for (const nome of storage.provedores()) {
    const p = storage.obterProvedor(nome);
    if (p) rotulosProvedor[nome] = p.rotulo();
  }
  const ultimoBackupEstado = backupEstado.interpretar(ultimoBackup, { rotulos: rotulosProvedor });

  // Sinais de atenção: a decisão é do ajudante (lógica pura); aqui só se reúne o
  // que ele precisa. Sem sinais a apresentar, a vista mostra o estado tranquilo.
  // `podeAdmin` vem do papel do condomínio ATIVO (a mesma fonte que
  // `comPapel('admin')` usa) — nunca de `users.role`, que é legado. Serve para
  // não mostrar ao gestor sinais que o levariam a módulos reservados ao admin.
  const podeAdmin = tenant.papelMaiorOuIgual(req.papelCondominio, 'admin');
  const orcamentoPorConcluir = dashboardHelpers.orcamentoPorConcluir(orcamentoAno);
  const sinais = dashboardHelpers.sinaisDeAtencao({
    podeAdmin,
    nVencidas,
    comprovativosPendentes,
    quotasMesEmitidas: quotasDoMes,
    pagamentosFornecedorPendentes: nPagFornecedorPendentes,
    documentosPorDisponibilizar,
    ano: anoAtual,
    orcamentoEstadoAberto: orcamentoPorConcluir ? orcamentoPorConcluir.estado : null,
    orcamentoEstadoRotulo: orcamentoPorConcluir ? orcamentoPorConcluir.rotulo : null,
    orcamentoId: orcamentoPorConcluir ? orcamentoPorConcluir.id : null,
    proximasAssembleias: proximasAssembleias.map((a) => ({
      id: a.id,
      numero: a.numero || null,
      data: a.data ? String(a.data).slice(0, 10).split('-').reverse().join('/') : '',
      designacao: a.designacao || null,
    })),
    filaErros,
    documentosLigado,
    backupEstado: ultimoBackupEstado.estado,
    smtp: smtpConfigured(),
  });

  // ── Tips contextuais (orientação, distinta dos sinais) ─────────────
  // Reúne os factos que o motor precisa e deixa-o decidir. Tolerante a falha:
  // um tip que não se consegue avaliar simplesmente não aparece — nunca se
  // inventa uma situação a partir de um erro.
  let contextoDeTips = { apresentar: [], total: 0, outras: [], limite: 0 };
  try {
    const [semTitular, contas, realizadasSemAta, dispensas] = await Promise.all([
      // Frações sem nenhuma titularidade em vigor: existe fração e não há
      // ninguém a quem dirigir quotas, avisos ou contactos.
      (async () => {
        const ids = fracoesTodas.map((f) => f.id);
        if (!ids.length) return 0;
        const comTitular = await FracaoTitularidade.findAll({
          attributes: ['fracao_id'],
          where: { condominio_id: req.condominioId, estado: 'ativa', fracao_id: { [Op.in]: ids } },
          raw: true,
        });
        const comTitularIds = new Set(comTitular.map((t) => Number(t.fracao_id)));
        return ids.filter((id) => !comTitularIds.has(Number(id))).length;
      })(),
      ContaBancaria.findAll({ attributes: ['tipo'], where: { condominio_id: req.condominioId }, raw: true }),
      Assembleia.count({
        where: { condominio_id: req.condominioId, estado: 'realizada', ata_texto: null, ata_documento_id: null },
      }),
      tips.carregarDispensas(req.user.id),
    ]);

    // A mesma regra da página de quotas (`helpers/permilagem.js`): a soma das
    // permilagens tem de fechar 1000‰.
    const permilagem = validarPermilagem(fracoesTodas);
    contextoDeTips = tips.escolher(
      {
        condominioId: req.condominioId,
        papel: req.papelCondominio,
        // Área do PAINEL: os tips que declaram `areas` para outra página (ex.:
        // armazenamento) não aparecem aqui. O painel mostra os tips de âmbito
        // geral — de condomínio e de instalação.
        area: 'inicio',
        ambito: [tips.AMBITOS.condominio, tips.AMBITOS.instalacao],
        fracoes: {
          n: fracoesTodas.length,
          permilagemTotal: permilagem.total,
          permilagemOk: permilagem.ok,
          semTitular,
        },
        contas: {
          n: contas.length,
          fundoReserva: contas.filter((c) => c.tipo === 'fundo_reserva').length,
        },
        assembleias: { realizadasSemAta },
        // Backups: o destino é da INSTALAÇÃO; `origem` indica se há alguma
        // ligação utilizável. Sem ligações, a página de armazenamento já
        // explica como ligar um serviço — o tip não repete isso.
        backup: {
          destino: destinoBackup || null,
          temLigacoes: Boolean(ligacaoBackup && ligacaoBackup.origem),
        },
      },
      dispensas
    );
  } catch (err) {
    console.error('[tips] painel:', err.message);
  }

  res.render('admin/dashboard', {
    titulo: 'Painel de administração',
    nFracoes,
    nPessoas,
    nUsers,
    condominio: condominio ? condominio.toJSON() : null,
    resumo,
    nPagas,
    nPendentes,
    nVencidas,
    nDriveDocs,
    nEmailsEnviados,
    nFornecedores,
    nPagFornecedorPendentes,
    topDevedores,
    anoAtual,
    financeiroMes,
    emAtraso,
    orcamentoAno: orcamentoAno,
    // Fase 2H.2 — o que exige decisão hoje + o que aconteceu recentemente.
    sinais,
    // Tips contextuais (orientação): só aparece o que a situação real justifica.
    // `voltar` é o destino de regresso da dispensa (validado na rota).
    tips: { ...contextoDeTips, voltar: '/admin' },
    proximasAssembleias: proximasAssembleias.map((a) => ({ ...a.toJSON() })),
    atividade: dashboardHelpers.atividadeRecente(
      registosAuditoria.map((r) => ({ ...r.toJSON(), utilizador: r.user ? { nome: r.user.nome } : null })),
      5
    ),
    sistema: {
      // Documentos do condomínio (serviço principal) — o nome e o ícone do
      // serviço vêm de `@root.armazenamentoRotulo`/`armazenamentoIcone`.
      documentos: { ligado: documentosLigado },
      // Cópias de segurança: a local existe sempre; a cloud é opcional e
      // independente do serviço dos documentos.
      backups: { cloud: copiaCloud },
      ultimoBackup: ultimoBackupEstado,
      smtp: smtpConfigured(),
      filaPendentes,
      filaErros,
    },
    chartFinanceiro: JSON.stringify({
      labels: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
      receitas: receitasMes.map((c) => fromCents(c)),
      despesas: despesasMes.map((c) => fromCents(c)),
    }),
    chartCategorias: JSON.stringify({
      labels: categoriasTop.map(([n]) => n),
      valores: categoriasTop.map(([, v]) => fromCents(v)),
    }),
  });
});

// ═══════════════════════════════════════════════════════════════════
// FRAÇÕES
// ═══════════════════════════════════════════════════════════════════
router.get('/fracoes', async (req, res) => {
  const fracoes = await Fracao.findAll({
    where: onde(req),
    include: [{ model: Pessoa, as: 'pessoas', through: { attributes: ['vinculo'] } }],
    order: [['designacao', 'ASC']],
  });
  res.render('admin/fracoes/listar', {
    titulo: 'Frações',
    fracoes,
    // A vista de suporte reduz os titulares a INICIAIS (`iniciais`, já
    // existente). Sinalizado pelo CONTEXTO, nunca pelo papel — em suporte
    // `req.papelCondominio` é `null` e `req.contexto` é `'suporte'`.
    suporteDiagnostico: Boolean(req.suporte),
  });
});

router.get('/fracoes/nova', (req, res) => {
  res.render('admin/fracoes/form', { titulo: 'Nova fração', fracao: null });
});

router.post('/fracoes', async (req, res) => {
  try {
    const { designacao, permilagem, andar, porta, observacoes, estado } = req.body;
    const fracao = await Fracao.create({
      condominio_id: req.condominioId,
      designacao,
      permilagem: parseDecimal(permilagem),
      andar,
      porta,
      observacoes,
      estado: estado || 'ativo',
    });
    await audit({ userId: req.user.id, acao: 'criar_fração', entidade: 'Fracao', entidadeId: fracao.id });
    req.flash('success_msg', 'Fração criada com sucesso.');
    res.redirect('/admin/fracoes');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao criar a fração.');
    res.redirect('/admin/fracoes/nova');
  }
});

router.get('/fracoes/:id/editar', async (req, res) => {
  const fracao = await Fracao.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
    include: [{ model: Pessoa, as: 'pessoas', through: { attributes: ['id', 'vinculo', 'data_inicio', 'data_fim'] } }],
  });
  if (!fracao) {
    req.flash('error_msg', 'Fração não encontrada.');
    return res.redirect('/admin/fracoes');
  }
  const pessoas = await Pessoa.findAll({ where: onde(req, { ativo: true }), order: [['nome', 'ASC']] });
  // Titularidade: quem é titular agora e o histórico completo (os períodos nunca
  // são apagados, por isso é possível ver quem foi proprietário e quando).
  const [titulares, historico] = await Promise.all([
    titularidades.titularesAtuais({ condominioId: req.condominioId, fracaoId: fracao.id }),
    titularidades.historicoDaFracao({ condominioId: req.condominioId, fracaoId: fracao.id }),
  ]);
  // Uma conta só existe depois de criada/convite aceite (fluxo de Utilizadores).
  // Sem conta, o titular consta do histórico mas não tem acesso ao GesCondu.
  const idsPessoasTitulares = [...new Set(titulares.map((t) => t.pessoa_id).filter(Boolean))];
  const contasPorPessoa = new Map();
  if (idsPessoasTitulares.length) {
    const contas = await User.findAll({
      where: { pessoa_id: { [Op.in]: idsPessoasTitulares } },
      attributes: ['id', 'pessoa_id'],
    });
    contas.forEach((c) => {
      const chave = Number(c.pessoa_id);
      contasPorPessoa.set(chave, (contasPorPessoa.get(chave) || 0) + 1);
    });
  }
  const titularesComConta = titulares.map((t) => {
    const n = contasPorPessoa.get(Number(t.pessoa_id)) || 0;
    return { ...t.toJSON(), temConta: n > 0, contasMultiplas: n > 1 };
  });

  res.render('admin/fracoes/form', {
    titulo: 'Editar fração',
    fracao,
    pessoas,
    titulares: titularesComConta,
    historico,
    // Data de hoje no formato dos inputs <input type="date">.
    hoje: titularidades.hojeISO(),
    // Dois proprietários ativos ao mesmo tempo é sinal de que uma mudança de
    // proprietário ficou a meio (o anterior não foi encerrado).
    proprietariosDuplicados: titularesComConta.filter((t) => t.vinculo === 'proprietario').length > 1,
  });
});

router.post('/fracoes/:id', async (req, res) => {
  const fracao = await carregarFracao(req);
  if (!fracao) {
    req.flash('error_msg', 'Fração não encontrada.');
    return res.redirect('/admin/fracoes');
  }
  const { designacao, permilagem, andar, porta, observacoes, estado } = req.body;
  await fracao.update({
    designacao,
    permilagem: parseDecimal(permilagem),
    andar,
    porta,
    observacoes,
    estado: estado || 'ativo',
  });
  await audit({ userId: req.user.id, acao: 'editar_fração', entidade: 'Fracao', entidadeId: fracao.id });
  req.flash('success_msg', 'Fração atualizada.');
  res.redirect('/admin/fracoes');
});

router.post('/fracoes/:id/eliminar', async (req, res) => {
  try {
    const fracao = await carregarFracao(req);
    if (fracao) {
      await fracao.destroy();
      await audit({ userId: req.user.id, acao: 'eliminar_fração', entidade: 'Fracao', entidadeId: req.params.id });
    }
    req.flash('success_msg', 'Fração eliminada.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Não foi possível eliminar a fração (pode ter registos associados).');
  }
  res.redirect('/admin/fracoes');
});

// Vínculos fração ↔ pessoa (ambos do condomínio ativo)
router.post('/fracoes/:id/pessoas', async (req, res) => {
  const fracao = await carregarFracao(req);
  if (!fracao) return res.redirect('/admin/fracoes');
  const { pessoa_id, vinculo, data_inicio, data_fim } = req.body;
  try {
    const pessoa = await Pessoa.findOne({ where: { id: pessoa_id, condominio_id: req.condominioId } });
    if (!pessoa) {
      req.flash('error_msg', 'Pessoa não encontrada neste condomínio.');
      return res.redirect(`/admin/fracoes/${fracao.id}/editar`);
    }
    await FracaoPessoa.findOrCreate({
      where: { fracao_id: fracao.id, pessoa_id: pessoa.id, vinculo: vinculo || 'proprietario' },
      defaults: {
        fracao_id: fracao.id,
        pessoa_id: pessoa.id,
        vinculo: vinculo || 'proprietario',
        data_inicio: data_inicio || null,
        data_fim: data_fim || null,
      },
    });
    // Mantém a titularidade em sincronia: se ainda não existir um período ativo
    // para esta pessoa/fração/vínculo, regista-o (o histórico não é substituído).
    const vinculoNormalizado = titularidades.normalizarVinculo(vinculo);
    const atuais = await titularidades.titularesAtuais({ condominioId: req.condominioId, fracaoId: fracao.id });
    const jaTemPeriodo = atuais.some((t) => Number(t.pessoa_id) === Number(pessoa.id) && t.vinculo === vinculoNormalizado);
    if (!jaTemPeriodo) {
      const contas = await User.findAll({ where: { pessoa_id: pessoa.id }, attributes: ['id'], limit: 2 });
      await titularidades.criarTitularidade({
        condominioId: req.condominioId,
        fracaoId: fracao.id,
        pessoaId: pessoa.id,
        utilizadorId: contas.length === 1 ? contas[0].id : null,
        vinculo: vinculoNormalizado,
        dataInicio: data_inicio || titularidades.hojeISO(),
        userId: req.user.id,
        origem: 'vinculo_pessoa',
      });
    }
    await audit({ userId: req.user.id, acao: 'vincular_pessoa_fração', entidade: 'FracaoPessoa' });
    req.flash('success_msg', 'Pessoa associada à fração.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao associar a pessoa.');
  }
  res.redirect(`/admin/fracoes/${fracao.id}/editar`);
});

router.post('/fracoes/:id/pessoas/:vinculoId/eliminar', async (req, res) => {
  const fracao = await carregarFracao(req);
  if (!fracao) return res.redirect('/admin/fracoes');
  const vinculo = await FracaoPessoa.findOne({ where: { id: req.params.vinculoId, fracao_id: fracao.id } });
  await FracaoPessoa.destroy({ where: { id: req.params.vinculoId, fracao_id: fracao.id } });
  // A titularidade correspondente NÃO é apagada: encerra-se com a data de hoje,
  // para o histórico e a autorização ficarem coerentes com a remoção do vínculo.
  if (vinculo) {
    const ativas = await titularidades.titularesAtuais({ condominioId: req.condominioId, fracaoId: fracao.id });
    for (const t of ativas) {
      if (Number(t.pessoa_id) === Number(vinculo.pessoa_id) && t.vinculo === vinculo.vinculo) {
        await titularidades.cessarTitularidade({
          titularidadeId: t.id,
          dataFim: titularidades.hojeISO(),
          motivo: 'vinculo_removido',
          userId: req.user.id,
        });
      }
    }
  }
  await audit({ userId: req.user.id, acao: 'desvincular_pessoa_fração', entidade: 'FracaoPessoa' });
  req.flash('success_msg', 'Associação removida.');
  res.redirect(`/admin/fracoes/${fracao.id}/editar`);
});

// ── Titularidade da fração (histórico e mudança de proprietário) ────
// Registar um titular NUNCA substitui o anterior: ou se cria mais um período, ou
// se encerra explicitamente o titular atual do mesmo vínculo (mudança de
// proprietário), ficando ambos no histórico.
router.post('/fracoes/:id/titulares', async (req, res) => {
  const fracao = await carregarFracao(req);
  if (!fracao) return res.redirect('/admin/fracoes');
  const { pessoa_id, vinculo, data_inicio, encerrar_atual } = req.body;
  try {
    const pessoa = await Pessoa.findOne({ where: { id: pessoa_id, condominio_id: req.condominioId } });
    if (!pessoa) {
      req.flash('error_msg', 'Pessoa não encontrada neste condomínio.');
      return res.redirect(`/admin/fracoes/${fracao.id}/editar`);
    }
    const vinculoNormalizado = titularidades.normalizarVinculo(vinculo);
    const inicio = titularidades.normalizarData(data_inicio) || titularidades.hojeISO();

    // Conta associada a esta pessoa, quando for inequívoca (uma só).
    const contas = await User.findAll({ where: { pessoa_id: pessoa.id }, attributes: ['id'], limit: 2 });
    const utilizadorId = contas.length === 1 ? contas[0].id : null;

    // Mudança de proprietário: encerrar o titular atual do MESMO vínculo no dia
    // anterior ao início do novo período (não há sobreposição nem buraco).
    const encerrados = [];
    if (encerrar_atual === 'on') {
      const atuais = await titularidades.titularesAtuais({ condominioId: req.condominioId, fracaoId: fracao.id });
      for (const t of atuais) {
        if (t.vinculo !== vinculoNormalizado) continue;
        const fim = titularidades.diaAnterior(inicio);
        encerrados.push(await titularidades.cessarTitularidade({
          titularidadeId: t.id,
          dataFim: fim,
          motivo: 'mudanca_titular',
          userId: req.user.id,
        }));
      }
    }

    const criada = await titularidades.criarTitularidade({
      condominioId: req.condominioId,
      fracaoId: fracao.id,
      pessoaId: pessoa.id,
      utilizadorId,
      vinculo: vinculoNormalizado,
      dataInicio: inicio,
      userId: req.user.id,
      origem: 'administracao',
      motivo: encerrados.length ? 'mudanca_titular' : null,
    });

    // Manter o vínculo do modelo anterior em sincronia (é o que sustenta os
    // contactos e as comunicações por fração).
    await FracaoPessoa.findOrCreate({
      where: { fracao_id: fracao.id, pessoa_id: pessoa.id, vinculo: vinculoNormalizado },
      defaults: { fracao_id: fracao.id, pessoa_id: pessoa.id, vinculo: vinculoNormalizado, data_inicio: inicio, data_fim: null },
    });

    await audit({
      userId: req.user.id,
      acao: encerrados.length ? 'alterar_titularidade' : 'registar_titularidade',
      entidade: 'Fracao',
      entidadeId: fracao.id,
      detalhes: {
        condominioId: req.condominioId,
        titularidadeId: criada.id,
        pessoaId: pessoa.id,
        utilizadorId,
        vinculo: vinculoNormalizado,
        inicio,
        encerrados: encerrados.map((t) => ({ id: t.id, pessoaId: t.pessoa_id, dataFim: t.data_fim })),
        contaAssociada: utilizadorId ? 'sim' : 'sem conta ligada',
      },
    });

    req.flash(
      'success_msg',
      encerrados.length
        ? `Titularidade alterada: ${encerrados.length} período(s) anterior(es) encerrado(s) e novo titular registado. O histórico mantém-se.`
        : 'Titular registado. O período anterior, se existir, mantém-se no histórico.'
    );
  } catch (err) {
    console.error('[titularidades]', err);
    req.flash('error_msg', 'Não foi possível registar a titularidade.');
  }
  res.redirect(`/admin/fracoes/${fracao.id}/editar`);
});

router.post('/fracoes/:id/titulares/:tid/cessar', async (req, res) => {
  const fracao = await carregarFracao(req);
  if (!fracao) return res.redirect('/admin/fracoes');
  const titulo = await FracaoTitularidade.findOne({
    where: { id: req.params.tid, fracao_id: fracao.id, condominio_id: req.condominioId },
  });
  if (!titulo) {
    req.flash('error_msg', 'Titularidade não encontrada nesta fração.');
    return res.redirect(`/admin/fracoes/${fracao.id}/editar`);
  }
  await titularidades.cessarTitularidade({
    titularidadeId: titulo.id,
    dataFim: req.body.data_fim,
    motivo: (req.body.motivo || '').trim() || 'cessacao',
    userId: req.user.id,
  });
  req.flash('success_msg', 'Titularidade encerrada com data de fim. O registo mantém-se no histórico.');
  res.redirect(`/admin/fracoes/${fracao.id}/editar`);
});

// Detalhe da fração (tabs)
router.get('/fracoes/:id', async (req, res) => {
  const fracao = await Fracao.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
    include: [{ model: Pessoa, as: 'pessoas', through: { attributes: ['id', 'vinculo', 'data_inicio', 'data_fim'] } }],
  });
  if (!fracao) {
    req.flash('error_msg', 'Fração não encontrada.');
    return res.redirect('/admin/fracoes');
  }

  const [quotas, pagamentos, documentos, avisosDest, resumo] = await Promise.all([
    Quota.findAll({ where: { fracao_id: fracao.id }, order: [['ano', 'DESC'], ['mes', 'DESC']] }),
    Pagamento.findAll({
      where: { fracao_id: fracao.id },
      include: [{ model: MetodoPagamento, as: 'metodo_pagamento' }],
      order: [['data_pagamento', 'DESC'], ['id', 'DESC']],
    }),
    Documento.findAll({ where: { entidade_tipo: 'Fracao', entidade_id: fracao.id, condominio_id: req.condominioId }, order: [['data', 'DESC']] }),
    AvisoDestinatario.findAll({
      where: { fracao_id: fracao.id },
      include: [{ model: Aviso, as: 'aviso', where: { condominio_id: req.condominioId }, required: true }],
      order: [['id', 'DESC']],
    }),
    resumoFracao(fracao.id),
  ]);

  const quotasComEstado = quotas.map((q) => ({ ...q.toJSON(), estadoEfetivo: estadoEfetivo(q) }));

  res.render('admin/fracoes/detalhe', {
    titulo: `Fração ${fracao.designacao}`,
    fracao: fracao.toJSON(),
    // Nesta aba mostram-se apenas as relações em vigor: os vínculos já
    // encerrados ficam no histórico de titularidade (ecrã de edição da fração).
    pessoasAtuais: fracao.pessoas.filter((p) => !p.FracaoPessoa.data_fim),
    quotas: quotasComEstado,
    pagamentos: pagamentos.map((p) => p.toJSON()),
    documentos: documentos.map((d) => d.toJSON()),
    avisos: avisosDest.map((a) => a.toJSON()),
    resumo,
  });
});

// ═══════════════════════════════════════════════════════════════════
// CONDÓMINOS (PESSOAS)
// ═══════════════════════════════════════════════════════════════════
router.get('/condominos', async (req, res) => {
  const pessoas = await Pessoa.findAll({
    where: onde(req),
    include: [{ model: Fracao, as: 'fracoes', through: { attributes: ['vinculo'] } }],
    order: [['nome', 'ASC']],
  });
  // Vista de SUPORTE quando o pedido vem do contexto de suporte: contactos e
  // NIF mascarados (`maskEmail`/`maskTelefone`/`maskNif`). A vista
  // administrativa normal não é tocada — o gestor continua a ver o que via.
  if (req.suporte) {
    return res.render('admin/condominos/listar-suporte', { titulo: 'Condóminos', pessoas });
  }
  res.render('admin/condominos/listar', { titulo: 'Condóminos', pessoas });
});

// Linhas de arranque da ficha "Novo condómino" (uma linha vazia de cada tipo).
function contactosIniciaisForm() {
  return {
    emails: [{ id: null, valor: '', etiqueta: '', principal: true }],
    telefones: [{ id: null, valor: '', etiqueta: '', principal: true }],
  };
}

router.get('/condominos/nova', async (req, res) => {
  const fracoes = await Fracao.findAll({ where: onde(req), order: [['designacao', 'ASC']] });
  res.render('admin/condominos/form', {
    titulo: 'Novo condómino',
    edicao: false,
    pessoa: null,
    contactosForm: contactosIniciaisForm(),
    fracoes: fracoes.map((f) => ({ ...f.toJSON(), associada: false })),
  });
});

// Frações do condomínio ativo para validar os ids enviados pelo browser.
async function fracoesDoAtivo(req) {
  return Fracao.findAll({ where: onde(req), attributes: ['id'] });
}

// ── Relação pessoa ↔ fração pela via das titularidades ─────────────
// A ficha do condómino NÃO cria vínculos paralelos: qualquer ligação ou remoção
// passa pelos helpers de titularidade (período com data de início/fim, estado,
// motivo e auditoria) e mantém `fracao_pessoas` em sincronia. Nunca se apaga uma
// relação — encerra-se com data de fim.
async function relacoesAtuaisDaPessoa({ condominioId, pessoaId }) {
  return titularidades.relacoesAtuaisDaPessoa({ condominioId, pessoaId });
}

async function acrescentarRelacao({ req, fracaoId, pessoa, vinculo, origem }) {
  return titularidades.ligarPessoaAFracao({
    condominioId: req.condominioId,
    fracaoId,
    pessoaId: pessoa.id,
    vinculo,
    userId: req.user.id,
    origem,
  });
}

async function retirarRelacao({ req, fracaoId, pessoaId, motivo }) {
  return titularidades.desligarPessoaDaFracao({
    condominioId: req.condominioId,
    fracaoId,
    pessoaId,
    motivo,
    userId: req.user.id,
  });
}

router.post('/condominos', async (req, res) => {
  const { nome, nif, tipo, observacoes } = req.body;
  const vinculo = req.body.vinculo || 'proprietario';
  const { emails, telefones } = parseContactosForm(req.body);
  const erro = validarContactos({ emails, telefones });
  const nifValidado = validarNif(nif);
  const fracoesSelecionadas = toArray(req.body.fracoes).map(Number);

  if (erro || !nifValidado.ok) {
    const fracoes = await Fracao.findAll({ where: onde(req), order: [['designacao', 'ASC']] });
    const selecionadas = new Set(fracoesSelecionadas);
    res.locals.error_msg = [erro || nifValidado.mensagem];
    return res.render('admin/condominos/form', {
      titulo: 'Novo condómino',
      edicao: false,
      pessoa: { nome: nome || '', nif: nif || '', tipo: tipo || 'proprietario', observacoes: observacoes || '' },
      contactosForm: { emails, telefones },
      fracoes: fracoes.map((f) => ({ ...f.toJSON(), associada: selecionadas.has(f.id) })),
    });
  }

  const pessoa = await Pessoa.create({
    condominio_id: req.condominioId,
    nome,
    nif: nifValidado.valor || null,
    tipo: tipo || 'proprietario',
    observacoes,
    email: null,
    telefone: null,
  });
  // Guarda os contactos (email/telefone legados ficam sincronizados com o principal).
  await sincronizarContactosPessoa(pessoa, emails, telefones, req.condominioId);

  // Liga apenas frações do condomínio ativo (ignora ids de outros condomínios),
  // sempre pelo mecanismo de titularidades (com período e auditoria).
  const validas = new Set((await fracoesDoAtivo(req)).map((f) => f.id));
  const recusadas = [];
  for (const fid of fracoesSelecionadas) {
    if (!validas.has(fid)) continue;
    const r = await acrescentarRelacao({ req, fracaoId: fid, pessoa, vinculo, origem: 'ficha_condomino' });
    if (!r.ok) recusadas.push(r.erro);
  }

  await audit({ userId: req.user.id, acao: 'criar_condómino', entidade: 'Pessoa', entidadeId: pessoa.id, detalhes: { fracoes: fracoesSelecionadas.length, recusadas: recusadas.length } });
  if (recusadas.length) {
    req.flash('error_msg', recusadas.join(' '));
    req.flash('success_msg', 'Condómino criado; algumas frações não foram associadas (ver aviso).');
  } else {
    req.flash('success_msg', 'Condómino criado.');
  }
  res.redirect('/admin/condominos');
});

router.get('/condominos/:id/editar', async (req, res) => {
  const pessoa = await Pessoa.findOne({
    where: { id: req.params.id, condominio_id: req.condominioId },
    include: [{ model: Fracao, as: 'fracoes', through: { attributes: ['id', 'vinculo'] } }],
  });
  if (!pessoa) {
    req.flash('error_msg', 'Condómino não encontrado.');
    return res.redirect('/admin/condominos');
  }
  const fracoes = await Fracao.findAll({ where: onde(req), order: [['designacao', 'ASC']] });
  // A relação atual é a união das titularidades ativas com os vínculos antigos
  // ainda em vigor: é isso que a ficha mostra marcado (e o que a gravação usa).
  const atuais = await relacoesAtuaisDaPessoa({ condominioId: req.condominioId, pessoaId: pessoa.id });
  const associadasIds = new Set(atuais.map((a) => a.fracaoId));
  // Mostra os contactos existentes; na ausência de registos de um tipo usa o
  // valor legado pessoa.email/telefone (nunca desaparecem da ficha).
  const contactosForm = await contactosParaForm(pessoa);
  res.render('admin/condominos/form', {
    titulo: 'Editar condómino',
    edicao: true,
    pessoa,
    contactosForm,
    fracoes: fracoes.map((f) => ({ ...f.toJSON(), associada: associadasIds.has(f.id) })),
  });
});

router.post('/condominos/:id', async (req, res) => {
  const pessoa = await carregarPessoa(req);
  if (!pessoa) return res.redirect('/admin/condominos');
  const { nome, nif, tipo, observacoes } = req.body;
  const ativo = req.body.ativo === 'on' || req.body.ativo === '1' || req.body.ativo === true;
  const vinculo = req.body.vinculo || 'proprietario';
  const { emails, telefones } = parseContactosForm(req.body);
  const erro = validarContactos({ emails, telefones });
  const nifValidado = validarNif(nif);
  const fracoesSelecionadas = toArray(req.body.fracoes).map(Number);

  if (erro || !nifValidado.ok) {
    // Reapresenta a ficha com os valores submetidos (sem perder nada).
    const atuais = await FracaoPessoa.findAll({ where: { pessoa_id: pessoa.id } });
    const atuaisIds = new Set(atuais.map((a) => a.fracao_id));
    const selecionadas = new Set(fracoesSelecionadas);
    const fracoes = await Fracao.findAll({ where: onde(req), order: [['designacao', 'ASC']] });
    res.locals.error_msg = [erro || nifValidado.mensagem];
    return res.render('admin/condominos/form', {
      titulo: 'Editar condómino',
      edicao: true,
      pessoa: {
        id: pessoa.id,
        nome: nome || '',
        nif: nif || '',
        tipo: tipo || 'proprietario',
        observacoes: observacoes || '',
        ativo,
      },
      contactosForm: { emails, telefones },
      fracoes: fracoes.map((f) => ({
        ...f.toJSON(),
        associada: atuaisIds.has(f.id) || selecionadas.has(f.id),
      })),
    });
  }

  await pessoa.update({
    nome,
    nif: nifValidado.valor || null,
    tipo: tipo || 'proprietario',
    observacoes,
    ativo,
  });
  // Substituição idempotente: a ficha submete sempre a lista completa, por isso
  // os contactos são reconstruídos sem duplicar em gravações repetidas.
  await sincronizarContactosPessoa(pessoa, emails, telefones, req.condominioId);

  // Frações: acrescenta as novas e ENCERRA as desmarcadas — sempre pelo sistema
  // de titularidades (data de início/fim, motivo e auditoria). Sem `destroy`.
  const validas = new Set((await fracoesDoAtivo(req)).map((f) => f.id));
  const selecionadasIds = new Set(fracoesSelecionadas.filter((fid) => validas.has(fid)));
  const atuais = await relacoesAtuaisDaPessoa({ condominioId: req.condominioId, pessoaId: pessoa.id });
  const atuaisIds = new Set(atuais.map((a) => a.fracaoId));

  const recusadas = [];
  let encerradas = 0;
  for (const a of atuais) {
    if (selecionadasIds.has(a.fracaoId)) continue;
    const r = await retirarRelacao({ req, fracaoId: a.fracaoId, pessoaId: pessoa.id, motivo: 'removido_ficha_condomino' });
    encerradas += r.titularesEncerrados + r.vinculosFechados;
  }
  for (const fid of selecionadasIds) {
    if (atuaisIds.has(fid)) continue;
    const r = await acrescentarRelacao({ req, fracaoId: fid, pessoa, vinculo, origem: 'ficha_condomino' });
    if (!r.ok) recusadas.push(r.erro);
  }

  await audit({
    userId: req.user.id,
    acao: 'editar_condómino',
    entidade: 'Pessoa',
    entidadeId: pessoa.id,
    detalhes: { fracoes: selecionadasIds.size, relacoesEncerradas: encerradas, relacoesRecusadas: recusadas.length },
  });
  if (recusadas.length) {
    req.flash('error_msg', recusadas.join(' '));
    req.flash('success_msg', 'Condómino atualizado; algumas frações não foram associadas (ver aviso).');
  } else {
    req.flash('success_msg', encerradas
      ? 'Condómino atualizado. As relações retiradas ficaram encerradas com data de fim, no histórico.'
      : 'Condómino atualizado.');
  }
  res.redirect('/admin/condominos');
});

router.post('/condominos/:id/eliminar', async (req, res) => {
  const pessoa = await carregarPessoa(req);
  if (!pessoa) return res.redirect('/admin/condominos');
  // Não se apaga a ficha de quem tem titularidade ativa: a titularidade ficaria
  // órfã (pessoa_id NULL) e continuaria a autorizar o acesso pela conta ligada.
  // O encerramento tem de ser explícito, na ficha da fração, com data e motivo.
  const ativas = await titularidades.titularesAtivosDaPessoa({
    condominioId: req.condominioId,
    pessoaId: pessoa.id,
  });
  const bloqueio = titularidades.bloqueioEliminacaoCondomino(ativas);
  if (bloqueio) {
    req.flash('error_msg', bloqueio);
    return res.redirect(`/admin/condominos/${pessoa.id}/editar`);
  }
  await pessoa.destroy();
  await audit({ userId: req.user.id, acao: 'eliminar_condómino', entidade: 'Pessoa', entidadeId: req.params.id });
  req.flash('success_msg', 'Condómino eliminado. O histórico financeiro e documental do condomínio mantém-se.');
  res.redirect('/admin/condominos');
});

// ═══════════════════════════════════════════════════════════════════
// UTILIZADORES (CONTAS)
// Contas criadas aqui pertencem ao condomínio ativo (associação
// utilizador_condominios). O papel legado mantém-se para a interface:
// 'admin' ↔ papel de condomínio admin; restantes ↔ 'leitura'.
// ═══════════════════════════════════════════════════════════════════
// TRADUÇÃO LEGADO ↔ NOVO — único ponto onde `users.role` ainda é lido/escrito.
//
// `users.role` é a coluna LEGADO (ENUM 'admin'|'condomino') mantida por
// compatibilidade. Já NÃO decide autorização, destino pós-login nem interface:
//   · autorização e destino → `utilizador_condominios.role` (helpers/tenant.js);
//   · privilégio global     → `users.role_global` (tenant.eSuperAdmin).
//
// O que resta aqui é a TRADUÇÃO entre os dois vocabulários, para que o
// formulário de utilizadores (que fala 'condomino'/'admin') continue a
// escrever um valor coerente na coluna legada e para que a coluna legada
// continue a poder alimentar o papel POR CONDOMÍNIO. NOTA: a tradução é
// lossy — o formulário não distingue 'gestor' de 'leitura', pelo que qualquer
// papel não-admin é traduzido para 'leitura' (e 'leitura' de volta para
// 'condomino'). Não alterar sem desenhar os dois sentidos em conjunto.
// ═══════════════════════════════════════════════════════════════════
function papelDaAssociacao(role) {
  return role === 'admin' ? 'admin' : 'leitura';
}
function roleLegadoDoPapel(papel) {
  return papel === 'admin' ? 'admin' : 'condomino';
}

// Gera/renova o convite de um utilizador e tenta o envio por email.
async function enviarConviteAoUtilizador(user, req) {
  const token = convites.gerarToken();
  const expira = convites.calcularExpiracao();
  await user.update({
    convite_token: token,
    convite_token_expira: expira,
    convite_estado: 'enviado',
    email_confirmado: false,
  });
  const link = `${req.protocol}://${req.get('host')}/aceitar-convite/${token}`;
  try {
    await sendMail({
      to: user.email,
      subject: 'Convite de acesso — GesCondu',
      text: `Olá ${user.nome},\n\nFoi criada uma conta para si no GesCondu.\nPara definir a sua palavra-passe e confirmar o email, abra o link (válido por ${convites.diasValidade()} dias):\n\n${link}\n\nSe não esperava este convite, ignore este email.`,
      html: `<p>Olá ${user.nome},</p><p>Foi criada uma conta para si no <strong>GesCondu</strong>.</p><p>Para definir a sua palavra-passe e confirmar o email, clique em:</p><p><a href="${link}">${link}</a></p><p>Este link é válido por ${convites.diasValidade()} dias.</p><p>Se não esperava este convite, ignore este email.</p>`,
      // O convite é criado no condomínio ativo — remetente contextualizado
      // (nunca o "primeiro condomínio" da BD).
      condominioId: req.condominioId,
    });
    return { ok: true };
  } catch (err) {
    console.error('[convite-email]', err.message);
    return { ok: false, erro: err.message };
  }
}

async function assocDeUtilizador(req, userId) {
  return UserCondominio.findOne({ where: { utilizador_id: userId, condominio_id: req.condominioId } });
}

// ── Gestão de utilizadores — exclusiva do `admin` ──────────────────
// Bloco escondido ao gestor na navegação (`main.handlebars`, grupo «Sistema»,
// em `{{#if (ne condominioAtivo.role 'gestor')}}`) e por isso protegido aqui
// rota a rota com `comPapel('admin')`. O gestor continua autorizado a entrar
// no backoffice, mas não a criar/editar/encerrar acessos.
router.get('/utilizadores', apenasAdmin, async (req, res) => {
  const assocs = await UserCondominio.findAll({
    where: { condominio_id: req.condominioId },
    include: [
      { model: User, as: 'utilizador', include: [{ model: Pessoa, as: 'pessoa' }] },
    ],
    order: [[{ model: User, as: 'utilizador' }, 'nome', 'ASC']],
  });
  const users = assocs
    .map((a) => {
      const u = a.utilizador;
      if (!u) return null;
      const json = u.toJSON();
      json.papel = a.role;
      json.estadoAssoc = a.estado;
      json.role = roleLegadoDoPapel(a.role);
      json.estadoConvite = convites.estadoDoConvite(json);
      json.podeConvite = Boolean(json.convite_token) && ['pendente', 'enviado'].includes(json.convite_estado);
      return json;
    })
    .filter(Boolean);
  res.render('admin/utilizadores/listar', { titulo: 'Utilizadores', users });
});

router.get('/utilizadores/nova', apenasAdmin, async (req, res) => {
  const pessoas = await Pessoa.findAll({ where: onde(req, { ativo: true }), order: [['nome', 'ASC']] });
  res.render('admin/utilizadores/form', { titulo: 'Novo utilizador', user: null, pessoas });
});

router.post('/utilizadores', apenasAdmin, async (req, res) => {
  const { nome, email, password, role, pessoa_id, ativo } = req.body;
  const enviarConvite = req.body.enviar_convite === '1' || req.body.enviar_convite === 'on';
  try {
    if (!password && !enviarConvite) {
      req.flash('error_msg', 'Defina uma palavra-passe ou escolha o envio de convite.');
      return res.redirect('/admin/utilizadores/nova');
    }
    const existente = await User.findOne({ where: { email } });
    if (existente) {
      req.flash('error_msg', 'Já existe uma conta com esse email.');
      return res.redirect('/admin/utilizadores/nova');
    }
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const token = enviarConvite ? convites.gerarToken() : null;
    const expira = enviarConvite ? convites.calcularExpiracao() : null;
    const user = await User.create({
      nome,
      email,
      password_hash: passwordHash,
      role: role || 'condomino',
      pessoa_id: pessoa_id || null,
      // Sem marcação explícita a conta nasce ATIVA (a caixa «Ativo» só existe no
      // ecrã de edição): uma conta criada pelo administrador não pode ficar
      // inativa por omissão e impedir a entrada do próprio utilizador.
      ativo: titularidades.contaAtivaDoFormulario(ativo),
      // Por convite: o email só fica confirmado quando o utilizador aceitar.
      email_confirmado: enviarConvite ? false : true,
      convite_token: token,
      convite_token_expira: expira,
      convite_estado: enviarConvite ? 'pendente' : null,
    });
    // Associa ao condomínio ativo (só assim a conta entra na área certa).
    await UserCondominio.create({
      utilizador_id: user.id,
      condominio_id: req.condominioId,
      role: papelDaAssociacao(role),
      estado: 'ativo',
    });
    await audit({ userId: req.user.id, acao: 'criar_utilizador', entidade: 'User', entidadeId: user.id, detalhes: { condominio_id: req.condominioId, papel: papelDaAssociacao(role), porConvite: Boolean(enviarConvite) } });
    if (enviarConvite) {
      const envio = await enviarConviteAoUtilizador(user, req);
      req.flash('success_msg', envio.ok
        ? 'Utilizador criado e convite enviado por email (válido 30 dias).'
        : 'Utilizador criado com convite pendente — o email não foi enviado (configure o SMTP em Emails e use "Reenviar convite").');
    } else {
      req.flash('success_msg', 'Utilizador criado.');
    }
    res.redirect('/admin/utilizadores');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao criar o utilizador.');
    res.redirect('/admin/utilizadores/nova');
  }
});

router.get('/utilizadores/:id/editar', apenasAdmin, async (req, res) => {
  const assoc = await assocDeUtilizador(req, req.params.id);
  if (!assoc) {
    req.flash('error_msg', 'Utilizador não encontrado neste condomínio.');
    return res.redirect('/admin/utilizadores');
  }
  const user = await User.findByPk(req.params.id, { include: [{ model: Pessoa, as: 'pessoa' }] });
  if (!user) return res.redirect('/admin/utilizadores');
  const pessoas = await Pessoa.findAll({ where: onde(req, { ativo: true }), order: [['nome', 'ASC']] });
  const userVista = user.toJSON();
  userVista.papel = assoc.role;
  userVista.role = roleLegadoDoPapel(assoc.role);
  // A associação ao condomínio é o que dá acesso: quando está inativa (por
  // exemplo, depois de «Preparar saída do condomínio»), guardar este formulário
  // não a reativa — a reativação é uma escolha explícita nesta página.
  const assocAtiva = assoc.estado === 'ativo';
  res.render('admin/utilizadores/form', {
    titulo: 'Editar utilizador',
    user: userVista,
    pessoas,
    assocAtiva,
    assocEstado: assoc.estado,
  });
});

router.post('/utilizadores/:id', apenasAdmin, async (req, res) => {
  const assoc = await assocDeUtilizador(req, req.params.id);
  if (!assoc) return res.redirect('/admin/utilizadores');
  const user = await User.findByPk(req.params.id);
  if (!user) return res.redirect('/admin/utilizadores');
  const { nome, email, password, role, pessoa_id, ativo } = req.body;

  // ── Conta (global: vale em todos os condomínios) ──────────────────
  const contaAntes = user.ativo === true;
  const contaDepois = ativo === 'on' || ativo === '1' || ativo === true;
  const motivo = String(req.body.motivo_conta || '').trim();
  const decisaoConta = titularidades.decidirAcaoConta({ antes: contaAntes, depois: contaDepois });
  // Desativar a conta bloqueia a entrada em toda a plataforma: exige
  // justificação, que fica registada na auditoria.
  if (decisaoConta.exigeMotivo && !motivo) {
    req.flash('error_msg', 'Indique o motivo para desativar a conta — fica registado na auditoria.');
    return res.redirect(`/admin/utilizadores/${user.id}/editar`);
  }
  // E não pode deixar nenhum condomínio sem quem o possa gerir: se esta conta for
  // o último administrador/gestor ativo de algum condomínio, a desativação é
  // recusada (nada é alterado) e a mensagem identifica os condomínios afetados.
  if (decisaoConta.desativou) {
    const assocGestao = await UserCondominio.findAll({
      where: {
        utilizador_id: user.id,
        estado: 'ativo',
        role: { [Op.in]: titularidades.PAPEIS_GESTAO },
      },
      include: [{ model: Condominio, as: 'condominio', attributes: ['id', 'designacao'], required: false }],
    });
    const gestoresPorCondominio = {};
    for (const a of assocGestao) {
      gestoresPorCondominio[a.condominio_id] = await UserCondominio.count({
        where: {
          condominio_id: a.condominio_id,
          estado: 'ativo',
          role: { [Op.in]: titularidades.PAPEIS_GESTAO },
        },
      });
    }
    const afetados = titularidades.condominiosSemGestao({
      associacoes: assocGestao.map((a) => ({
        condominioId: a.condominio_id,
        designacao: a.condominio ? a.condominio.designacao : null,
        role: a.role,
        estado: a.estado,
      })),
      gestoresPorCondominio,
    });
    const bloqueio = titularidades.motivoBloqueioDesativacaoConta(afetados);
    if (bloqueio) {
      req.flash('error_msg', bloqueio);
      return res.redirect(`/admin/utilizadores/${user.id}/editar`);
    }
  }

  const data = { nome, email, role: role || 'condomino', pessoa_id: pessoa_id || null, ativo: contaDepois };
  if (password) {
    data.password_hash = await bcrypt.hash(password, 10);
  }
  await user.update(data);

  // ── Associação ao condomínio ──────────────────────────────────────
  // Guardar a ficha altera apenas o papel. O estado do ACESSO a este condomínio
  // não é alterado aqui: encerrar/reativar acesso são ações próprias e
  // explícitas (abaixo), para que gravar dados nunca reabra nem feche acessos.
  await assoc.update({ role: papelDaAssociacao(role) });

  await audit({
    // A alteração do estado da conta tem ação própria (desativar/reativar conta).
    acao: decisaoConta.acao || 'editar_utilizador',
    entidade: 'User',
    entidadeId: user.id,
    detalhes: decisaoConta.mudou
      ? {
          estadoAnterior: contaAntes,
          estadoNovo: contaDepois,
          motivo: motivo || null,
          ambito: 'conta (global — todos os condomínios)',
          condominioContexto: req.condominioId,
          papel: papelDaAssociacao(role),
          associacao: assoc.estado,
          titularidadesAlteradas: false,
        }
      : { papel: papelDaAssociacao(role), associacao: assoc.estado },
  });

  if (decisaoConta.reativou) {
    req.flash('success_msg', 'Conta reativada: volta a poder iniciar sessão onde as associações e as titularidades o permitirem. Nenhuma associação foi reaberta por esta ação.');
  } else if (decisaoConta.desativou) {
    req.flash('success_msg', 'Conta desativada: o acesso à plataforma fica bloqueado em todos os condomínios. As associações ao condomínio e as titularidades não foram alteradas.');
  } else {
    req.flash('success_msg', 'Utilizador atualizado.');
  }
  res.redirect('/admin/utilizadores');
});

// ── Acesso a ESTE condomínio (associação) ──────────────────────────
// Ações administrativas explícitas sobre `utilizador_condominios.estado`.
// Alteram apenas esse estado: a conta (`users.ativo`) e as titularidades ficam
// intactas e nada é apagado. Não substituem «Preparar saída do condomínio»
// (fluxo do próprio utilizador, com exportação, reautenticação, declaração e
// encerramento das titularidades) — esse mantém-se como está.

// O condomínio não pode ficar sem quem o possa gerir (mesma regra do fluxo de
// saída, agora num só sítio: helpers/titularidades.js).
async function deixariaCondominioSemGestao(req, assoc) {
  if (!titularidades.PAPEIS_GESTAO.includes(assoc.role)) return false;
  const n = await UserCondominio.count({
    where: {
      condominio_id: req.condominioId,
      estado: 'ativo',
      role: { [Op.in]: titularidades.PAPEIS_GESTAO },
    },
  });
  return titularidades.eUltimoGestorAtivo({ papel: assoc.role, nGestores: n });
}

router.post('/utilizadores/:id/encerrar-acesso', apenasAdmin, async (req, res) => {
  const assoc = await assocDeUtilizador(req, req.params.id);
  if (!assoc) return res.redirect('/admin/utilizadores');
  const destino = `/admin/utilizadores/${req.params.id}/editar`;
  const motivo = String(req.body.motivo || '').trim();
  if (!motivo) {
    req.flash('error_msg', 'Indique o motivo do encerramento do acesso — fica registado na auditoria.');
    return res.redirect(destino);
  }
  if (Number(req.params.id) === Number(req.user.id)) {
    req.flash('error_msg', 'Para deixar de ter acesso a este condomínio utilize «Preparar saída do condomínio» na sua área.');
    return res.redirect(destino);
  }
  if (assoc.estado !== 'ativo') {
    req.flash('error_msg', 'O acesso deste utilizador a este condomínio já está encerrado.');
    return res.redirect(destino);
  }
  if (await deixariaCondominioSemGestao(req, assoc)) {
    req.flash('error_msg', 'É o único administrador ou gestor com acesso ativo a este condomínio. Encerrar este acesso deixaria o condomínio sem quem o possa gerir.');
    return res.redirect(destino);
  }
  await assoc.update({ estado: 'inativo' });
  await audit({
    userId: req.user.id,
    acao: 'encerrar_acesso_condominio',
    entidade: 'UserCondominio',
    entidadeId: assoc.id,
    detalhes: {
      condominioId: req.condominioId,
      utilizadorId: assoc.utilizador_id,
      papel: assoc.role,
      motivo,
      estadoAnterior: 'ativo',
      estadoNovo: 'inativo',
      contaAlterada: false,
      titularidadesAlteradas: false,
    },
  });
  req.flash('success_msg', 'Acesso a este condomínio encerrado. A conta e as titularidades não foram alteradas; a associação mantém-se registada (pode ser reaberta).');
  res.redirect('/admin/utilizadores');
});

router.post('/utilizadores/:id/reativar-acesso', apenasAdmin, async (req, res) => {
  const assoc = await assocDeUtilizador(req, req.params.id);
  if (!assoc) return res.redirect('/admin/utilizadores');
  const destino = `/admin/utilizadores/${req.params.id}/editar`;
  const motivo = String(req.body.motivo || '').trim();
  if (assoc.estado === 'ativo') {
    req.flash('error_msg', 'O acesso deste utilizador a este condomínio já está ativo.');
    return res.redirect(destino);
  }
  await assoc.update({ estado: 'ativo' });
  await audit({
    userId: req.user.id,
    acao: 'reativar_acesso_condominio',
    entidade: 'UserCondominio',
    entidadeId: assoc.id,
    detalhes: {
      condominioId: req.condominioId,
      utilizadorId: assoc.utilizador_id,
      papel: assoc.role,
      motivo: motivo || null,
      estadoAnterior: 'inativo',
      estadoNovo: 'ativo',
      contaAlterada: false,
      titularidadesAlteradas: false,
    },
  });
  req.flash('success_msg', 'Acesso a este condomínio reativado. A conta não foi alterada e as titularidades continuam como estavam.');
  res.redirect('/admin/utilizadores');
});

router.post('/utilizadores/:id/eliminar', apenasAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const assoc = await assocDeUtilizador(req, userId);
  if (!assoc || userId === req.user.id) {
    req.flash('error_msg', 'Não pode eliminar a sua própria conta.');
    return res.redirect('/admin/utilizadores');
  }
  await assoc.destroy();
  // Elimina a conta apenas se já não pertence a nenhum outro condomínio.
  const restantes = await UserCondominio.count({ where: { utilizador_id: userId } });
  if (restantes === 0) {
    const user = await User.findByPk(userId);
    if (user) await user.destroy();
  }
  await audit({ userId: req.user.id, acao: 'eliminar_utilizador', entidade: 'User', entidadeId: userId, detalhes: { condominio_id: req.condominioId } });
  req.flash('success_msg', 'Utilizador removido deste condomínio.');
  res.redirect('/admin/utilizadores');
});

// ── Convites (estados/validade; confirmação de email) ──────────────
router.post('/utilizadores/:id/reenviar-convite', apenasAdmin, async (req, res) => {
  const assoc = await assocDeUtilizador(req, req.params.id);
  if (!assoc) return res.redirect('/admin/utilizadores');
  const user = await User.findByPk(req.params.id);
  if (!user) return res.redirect('/admin/utilizadores');
  if (user.convite_estado === 'aceite') {
    req.flash('error_msg', 'Este utilizador já aceitou o convite.');
    return res.redirect('/admin/utilizadores');
  }
  if (user.convite_estado === 'revogado') {
    req.flash('error_msg', 'Convite revogado. Crie/edite o utilizador para gerar um novo convite.');
    return res.redirect('/admin/utilizadores');
  }
  const envio = await enviarConviteAoUtilizador(user, req);
  await audit({ userId: req.user.id, acao: 'reenviar_convite', entidade: 'User', entidadeId: user.id, detalhes: { email: user.email } }).catch(() => {});
  req.flash('success_msg', envio.ok
    ? 'Convite reenviado por email (válido 30 dias).'
    : 'Convite renovado mas o email não foi enviado (verifique o SMTP).');
  res.redirect('/admin/utilizadores');
});

router.post('/utilizadores/:id/revogar-convite', apenasAdmin, async (req, res) => {
  const assoc = await assocDeUtilizador(req, req.params.id);
  if (!assoc) return res.redirect('/admin/utilizadores');
  const user = await User.findByPk(req.params.id);
  if (!user) return res.redirect('/admin/utilizadores');
  if (user.convite_estado === 'aceite') {
    req.flash('error_msg', 'Não pode revogar o convite de uma conta já ativada.');
    return res.redirect('/admin/utilizadores');
  }
  await user.update({ convite_token: null, convite_token_expira: null, convite_estado: 'revogado' });
  await audit({ userId: req.user.id, acao: 'revogar_convite', entidade: 'User', entidadeId: user.id, detalhes: { email: user.email } }).catch(() => {});
  req.flash('success_msg', 'Convite revogado.');
  res.redirect('/admin/utilizadores');
});

// ── Pedidos de acesso de SUPORTE ───────────────────────────────────
// O Super Admin é administrador da PLATAFORMA: quando precisa de consultar um
// condomínio, faz um pedido registado (`acessos_suporte`) com motivo e prazo.
// Se o condomínio TEM administrador ativo, o pedido fica `pendente_autorizacao`
// e é o administrador que autoriza aqui — não existe ativação automática, nem
// prazo que promova sozinho o pedido.
//
// Bloco exclusivo do `admin` (como o resto da gestão de utilizadores): o gestor
// não decide quem entra no condomínio em diagnóstico.
router.get('/suporte', apenasAdmin, async (req, res) => {
  const [pendentes, ativos, historico, temAdmin] = await Promise.all([
    suporte.pendentesDe(req.condominioId),
    suporte.ativosDe(req.condominioId),
    suporte.historicoDe(req.condominioId, 100),
    suporte.temAdminAtivo(req.condominioId),
  ]);
  res.render('admin/suporte', {
    titulo: 'Acessos de suporte',
    pendentes,
    ativos,
    historico,
    temAdmin,
  });
});

router.post('/suporte/:id/autorizar', apenasAdmin, async (req, res) => {
  // A autorização é concedida em nome de QUEM A DÁ (`req.user.id`), e
  // `suporte.autorizar` verifica que essa conta é admin ATIVO do condomínio do
  // acesso. Um admin de outro condomínio não autoriza nada — o âmbito do acesso
  // nunca vem do formulário.
  const r = await suporte.autorizar({
    acessoId: req.params.id,
    adminUserId: req.user.id,
    req,
  });
  if (!r.ok) {
    const MENSAGENS = {
      nao_encontrado: 'Pedido de suporte não encontrado.',
      estado_invalido: 'Este pedido já não está pendente.',
      sem_permissao: 'Não tem permissão para autorizar este acesso.',
      expirado: 'O prazo deste pedido já tinha passado — foi fechado.',
    };
    req.flash('error_msg', MENSAGENS[r.erro] || 'Não foi possível autorizar o acesso.');
    return res.redirect('/admin/suporte');
  }
  await audit({
    userId: req.user.id,
    acao: 'suporte_autorizado',
    entidade: 'Condominio',
    entidadeId: r.acesso.condominio_id,
    detalhes: {
      acesso_suporte_id: r.acesso.id,
      nivel: r.acesso.nivel,
      expira_em: r.acesso.expira_em,
    },
  }).catch(() => {});
  req.flash('success_msg', 'Acesso de suporte autorizado (só leitura, com prazo).');
  return res.redirect('/admin/suporte');
});

router.post('/suporte/:id/recusar', apenasAdmin, async (req, res) => {
  const r = await suporte.recusar({ acessoId: req.params.id, resgatadoPor: req.user.id, req });
  if (!r.ok) {
    req.flash('error_msg', 'Este pedido já não está pendente.');
    return res.redirect('/admin/suporte');
  }
  await audit({
    userId: req.user.id,
    acao: 'suporte_recusado',
    entidade: 'Condominio',
    entidadeId: r.acesso.condominio_id,
    detalhes: { acesso_suporte_id: r.acesso.id },
  }).catch(() => {});
  req.flash('success_msg', 'Pedido de suporte recusado.');
  return res.redirect('/admin/suporte');
});

// Revogação pelo administrador do condomínio: um acesso JÁ ATIVO pode ser
// cortado a meio — a decisão não é irreversível. O impacto é imediato porque o
// estado é revalidado em cada pedido (`suporte.vigente`).
router.post('/suporte/:id/revogar', apenasAdmin, async (req, res) => {
  const r = await suporte.revogar({ acessoId: req.params.id, revogadoPor: req.user.id, req });
  if (!r.ok) {
    req.flash('error_msg', 'Este acesso já não estava ativo.');
    return res.redirect('/admin/suporte');
  }
  await audit({
    userId: req.user.id,
    acao: 'suporte_revogado_pelo_condominio',
    entidade: 'Condominio',
    entidadeId: r.acesso.condominio_id,
    detalhes: { acesso_suporte_id: r.acesso.id },
  }).catch(() => {});
  req.flash('success_msg', 'Acesso de suporte revogado.');
  return res.redirect('/admin/suporte');
});

// Tarefas de processamento em segundo plano (estado/consulta)
router.get('/tarefas', async (req, res) => {
  const tarefas = background.listarTarefas(100);
  res.render('admin/sistema/tarefas', { titulo: 'Processamento em segundo plano', tarefas });
});

// ── Contactos flexíveis do condómino ────────────────────────────────
// Geridos na própria ficha (/editar) — criar/editar chamam
// sincronizarContactosPessoa com a lista completa. A página antiga mantém-se
// apenas por compatibilidade e redireciona para a edição.
router.get('/condominos/:id/contactos', (req, res) => {
  res.redirect(`/admin/condominos/${req.params.id}/editar#contactos`);
});

// ── Rede de segurança da allow-list do suporte diagnóstico ─────────
// A guarda de papel do router (acima) já recusa qualquer pedido de suporte que
// não tenha sido admitido pela allow-list, pelo que este ponto só é alcançado
// por um caminho que escape àquela guarda (por exemplo, uma rota registada
// antes dela). Fica no FIM do ficheiro e fecha a superfície: um acesso de
// suporte que chegue aqui é, por definição, uma rota FORA da lista.
// ── Rede de segurança: o suporte não «cai» em nenhuma rota deste router ─
// Este router é o PRIMEIRO montado sob `/admin` e cobre TODOS os caminhos. As
// rotas servidas por routers posteriores (`/quotas`, `/despesas`, …) chegam
// aqui primeiro e, se a sua admissão as marcou, TÊM de seguir para o router que
// as serve — não podem ser intercetadas por esta rede.
//
// Por isso a condição é «não foi admitido em NENHUM módulo da lista». Só um
// pedido de suporte que NENHUM módulo admite (e que, por isso, nenhum router
// posterior vai servir no contexto de suporte) é que é reencaminhado para
// `/admin`. A `LISTA` continua a ser o conjunto fechado: isto não admite nada
// de novo — apenas deixa passar quem já foi admitido, para que a admissão do
// router que corre DEPOIS não seja código morto.
router.use((req, res, next) => {
  if (!req.suporte) return next();
  if (allowlistSuporte.caminhoAdmitidoEmAlgumModulo(req.path)) return next();
  req.flash('error_msg', 'O acesso de suporte é de diagnóstico: esta área não está disponível.');
  return res.redirect('/admin');
});

module.exports = router;
