const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { Condominio, BackupLog, AuditLog, User, sequelize } = require('../models');
const tenant = require('../helpers/tenant');
const { audit } = require('../helpers/audit');
const { getCondominio, clearCondominioCache } = require('../helpers/condominio');
const { getConfig, setConfig } = require('../helpers/config');
const { listarAutomacoes, linhasDeConsulta, guardarAutomacoes } = require('../helpers/automacoes');
const drive = require('../helpers/drive');
// Fachada de armazenamento multi-provedor (Google Drive | Dropbox | OneDrive).
const storage = require('../helpers/storage');
// Interpretação pura do estado do último backup (cópia local vs. cloud).
const backupEstado = require('../helpers/backup-estado');
const { contarPorServico, documentosDoServico } = require('../helpers/documentos-por-servico');
const { validarNif, validarIban } = require('../public/js/validacao-fiscal');
// Email/SMTP: a configuração técnica do serviço de email é uma CONFIGURAÇÃO do
// condomínio (não operação da fila) — vive neste router. O envio do email de
// teste reutiliza o MESMO mailer: não existe uma segunda configuração.
const mailer = require('../helpers/mailer');
// ── P54-3 — proteção SERVER-SIDE da alteração de credenciais ─────────
// Reutiliza o que já existe: o limitador de `helpers/seguranca` (o mesmo do
// login) e a reautenticação extraída de `saida-condominio` para
// `helpers/reautenticacao`. O único mecanismo novo é o da confirmação, que não
// existia em lado nenhum — ver `helpers/confirmacao-sensivel`.
const { createLimiter, identidadeAutenticada } = require('../helpers/seguranca');
const confirmacao = require('../helpers/confirmacao-sensivel');
const reautenticacao = require('../helpers/reautenticacao');
// Tips contextuais da área de armazenamento (motor único: helpers/tips.js).
const { tipsDaPagina } = require('../helpers/tips/contexto');

const router = express.Router();
// Isolamento: a configuração edita o condomínio ATIVO (sessão).
router.use(tenant.comCondominioAtivo);
router.use(tenant.comPapel('admin'));

// ── P54-3 (V12) — limites por IDENTIDADE, não por IP ────────────────
// O limite por IP serve o login, onde ainda não há identidade. Aqui já há: a
// chave é o UTILIZADOR. Um atacante com sessão válida não escapa mudando de
// rede, e vários administradores atrás do mesmo NAT não se bloqueiam entre si.
// Cada gravação custa DOIS pedidos (preparar + gravar), pelo que o limite é
// expresso em operações, não em pedidos: 20 pedidos = 10 tentativas de guardar
// em 10 minutos. Continua muito abaixo do que qualquer uso legítimo precisa —
// corrigir uma gralha e voltar a guardar não chega perto disto — e trava uma
// tentativa repetida de forçar a configuração.
const limiteSmtpGravar = createLimiter({
  rotulo: 'smtp-gravar',
  max: 20,
  janelaMs: 10 * 60 * 1000,
  chaveDe: identidadeAutenticada,
  msg: 'Demasiadas tentativas de alteração da configuração de email. Aguarde alguns minutos.',
});
const limiteSmtpAcoes = createLimiter({
  rotulo: 'smtp-acoes',
  max: 30,
  janelaMs: 10 * 60 * 1000,
  chaveDe: identidadeAutenticada,
  msg: 'Demasiadas operações de email. Aguarde alguns minutos.',
});

// ── P54-3 (V10) — a operação confirmável e o payload que ela liga ────
const OPERACAO_SMTP = 'smtp-config';

// Impressão do pedido: é isto que liga a confirmação ao CONTEÚDO. Tem de ser
// calculada de forma IDÊNTICA na preparação e na gravação — qualquer diferença
// de normalização faria a gravação legítima ser recusada por «payload alterado».
function impressaoDoPedido(body) {
  const b = body || {};
  const texto = (v) => (v === undefined || v === null ? '' : String(v));
  return confirmacao.impressao({
    host: texto(b.host),
    port: texto(b.port),
    user: texto(b.user),
    tls: texto(b.tls),
    from: texto(b.from),
    from_name: texto(b.from_name),
    // Digest do segredo (NUNCA o valor): muda se a password mudar, e é o mínimo
    // necessário para detetar uma password trocada entre confirmar e gravar.
    pass: confirmacao.impressaoSegredo(b.pass),
  });
}

// Os campos que o mailer recebe — um só sítio, para a preparação e a gravação
// não poderem divergir no mapeamento dos nomes do formulário.
function corpoSmtp(body) {
  const b = body || {};
  return {
    host: b.host,
    port: b.port,
    user: b.user,
    pass: b.pass,
    tls: b.tls,
    from: b.from,
    fromName: b.from_name,
  };
}

// Provedores ligados pelo fluxo OAuth genérico (o Google Drive mantém as
// rotas históricas /admin/config/drive/*, sem alterações).
const PROVEDORES_OAUTH = new Set(['dropbox', 'onedrive']);

// O Google Drive mantém as rotas próprias (Redirect URI registado na consola
// Google e estado OAuth próprio): as rotas genéricas delegam nelas.
const ROTAS_DRIVE = {
  ligar: '/admin/config/drive/ligar',
  desligar: '/admin/config/drive/desligar',
  testar: '/admin/config/drive/testar',
};

const VAR_REDIRECT = {
  dropbox: 'DROPBOX_REDIRECT_URI',
  onedrive: 'ONEDRIVE_REDIRECT_URI',
};

// ── P54-4 (reforço) — âmbito de PLATAFORMA exige Super Admin ───────
// As ligações de armazenamento existem em dois âmbitos: a do CONDOMÍNIO ativo
// (documentos desse condomínio) e a da PLATAFORMA/instalação (a mesma conta que
// serve os backups de TODOS os condomínios). A guarda `tenant.apenasSuperAdmin`
// já protegia o destino dos backups; faltava-a nas duas ações OAuth, onde o
// âmbito chega por `?ambito=plataforma` — um admin de condomínio podia, por
// POST direto, desligar ou testar a ligação de que a instalação inteira depende.
//
// Ao contrário de `tenant.apenasSuperAdmin` (middleware montado à entrada, com
// o âmbito ainda por resolver), esta verificação corre DENTRO do handler, já
// depois de `plataforma` ser conhecido: assim o âmbito de CONDOMÍNIO continua a
// funcionar sem alteração para um admin de condomínio.
//
// ⛔ Não é um segundo sistema de autorização: decide pelo MESMO mecanismo
// (`tenant.eSuperAdmin` → `users.role_global`). Devolve `true` quando RECUSOU
// (já respondeu com flash + redirect), `false` quando pode continuar.
function recusarSePlataformaSemSuperAdmin(req, res, plataforma) {
  if (!plataforma) return false;
  if (tenant.eSuperAdmin(req.user)) return false;
  req.flash('error_msg', 'Esta operação é da administração global: apenas um Super Admin pode gerir as ligações de armazenamento da plataforma.');
  res.redirect('/admin/config/armazenamento');
  return true;
}

// ── P54-4 (reforço) — gravação de configuração GLOBAL exige Super Admin ──
// `configuracoes` NÃO tem `condominio_id`: as chaves que `drive/opcoes` escreve
// (`google_drive_root_folder`, `drive_auto_backups`) valem para a instalação
// inteira — a pasta raiz é a da conta Google e a cópia automática é a dos
// backups. Um admin de condomínio não pode, por isso, alterá-las: sem esta
// guarda, escrevia a configuração global a partir de um formulário de
// condomínio. Mesmo critério de `tenant.apenasSuperAdmin` (é um sistema só).
// Devolve `true` quando RECUSOU.
function recusarConfiguracaoGlobalSemSuperAdmin(req, res) {
  if (tenant.eSuperAdmin(req.user)) return false;
  req.flash('error_msg', 'Estas opções são da administração global: apenas um Super Admin as pode alterar.');
  res.redirect('/admin/config/armazenamento#google-drive');
  return true;
}


// Redirect URI do provedor: .env (quando definido) ou derivado do pedido.
function redirectUriDe(req, provedor) {
  const daEnv = String(process.env[VAR_REDIRECT[provedor]] || '').trim();
  if (daEnv) return daEnv;
  return `${req.protocol}://${req.get('host')}/admin/config/armazenamento/${provedor}/callback`;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  // O logótipo é guardado em public/uploads (servido como imagem estática):
  // o tipo é validado no SERVIDOR (não basta o accept do formulário) para não
  // permitir gravar HTML/SVG executável na origem da aplicação.
  fileFilter: (req, file, cb) => {
    const permitidos = new Set(['image/png', 'image/jpeg']);
    if (!permitidos.has(String(file.mimetype || '').toLowerCase())) {
      return cb(new Error('Formato de logótipo não suportado (use PNG ou JPG).'));
    }
    return cb(null, true);
  },
});

// Dados de armazenamento/backups (Google Drive, pasta de destino, último backup),
// usados pelo separador "Armazenamento e Backups".
async function dadosArmazenamento(condominioId) {
  const driveEstado = await drive.estadoLigacao();

  const [ultimoBackup, raizDbRaw, backupsDb, estados, documentosPorServico] = await Promise.all([
    BackupLog.findOne({ order: [['id', 'DESC']] }).catch(() => null),
    getConfig('google_drive_root_folder', '').catch(() => ''),
    getConfig('drive_auto_backups', '1').catch(() => '1'),
    storage.estadoDoCondominio(condominioId).catch(() => ({ escolhido: 'google_drive', provedores: [] })),
    // Quantos documentos deste condomínio estão em cada serviço: permite avisar
    // quando há ficheiros guardados num serviço que não está ligado (sem esse
    // aviso, o administrador só descobre ao tentar abrir um documento).
    contarPorServico(condominioId),
  ]);

  // Fonte única de verdade: BD → .env → pasta inicial "GesCondu".
  const raizDb = String(raizDbRaw || '').trim();
  const raizEfetiva = raizDb || (process.env.GOOGLE_DRIVE_ROOT_FOLDER || '').trim() || 'GesCondu';

  // Cada serviço fica a saber quantos documentos guardou (a vista usa isto para
  // avisar quando não está ligado).
  const provedores = (estados.provedores || []).map((p) => ({
    ...p,
    documentos: documentosDoServico(documentosPorServico, p.nome),
  }));

  // Estado do último backup interpretado (cópia local vs. cópia cloud). As
  // colunas de `backup_logs` chegam para o distinguir — sem migration.
  const rotulosProvedor = {};
  for (const nome of storage.provedores()) {
    const p = storage.obterProvedor(nome);
    if (p) rotulosProvedor[nome] = p.rotulo();
  }

  return {
    driveLigado: driveEstado.ligado,
    driveEstado,
    driveOpcoes: { pastaRaiz: raizEfetiva, backupsDrive: String(backupsDb) !== '0' },
    ultimoBackup: ultimoBackup ? ultimoBackup.toJSON() : null,
    ultimoBackupEstado: backupEstado.interpretar(ultimoBackup, { rotulos: rotulosProvedor }),
    armazenamento: { ...estados, provedores },
  };
}

// ── Separador 1: Configuração do Condomínio ────────────────────────
router.get('/config', async (req, res) => {
  const condominio = await getCondominio({ force: true, id: req.condominioId });
  const c = condominio ? condominio.toJSON() : null;

  // ── A14 §7 — síntese de CONSULTA por secções (padrão P54-0) ────────
  // A Configuração deixou de ser um formulário gigante permanentemente
  // aberto: cada secção nasce em consulta e mostra o que está gravado.
  // As linhas são construídas AQUI (e não na vista) pelo mesmo motivo do
  // `linhasSmtp` do P54-2: o Handlebars não compõe arrays.
  //
  // ⛔ Valor vazio é `null` — o parcial imprime «—» e o utilizador distingue
  // «em branco» de «valor zero». Nenhuma linha é `sensivel`: nesta página não
  // há segredos (o IBAN não é um segredo do sistema, é um dado do condomínio).
  const v = (x) => (x === null || x === undefined || x === '' ? null : String(x));

  res.render('admin/configuracao/index', {
    titulo: 'Configuração do Condomínio',
    condominio: c,
    linhasDados: [
      { rotulo: 'Designação', valor: v(c && c.designacao) },
      { rotulo: 'NIF', valor: v(c && c.nif) },
      { rotulo: 'Morada', valor: v(c && c.morada) },
      { rotulo: 'Código postal', valor: v(c && c.codigo_postal) },
      { rotulo: 'Localidade', valor: v(c && c.localidade) },
      { rotulo: 'Estado', valor: c && c.estado === 'inativo' ? 'Inativo' : 'Ativo' },
    ],
    linhasAdministracao: [
      { rotulo: 'Nome da administração', valor: v(c && c.administracao_nome) },
      { rotulo: 'Website', valor: v(c && c.website) },
      { rotulo: 'Email', valor: v(c && c.email) },
      { rotulo: 'Telefone', valor: v(c && c.telefone) },
    ],
    linhasPagamentos: [
      { rotulo: 'IBAN principal', valor: v(c && c.iban_principal) },
      { rotulo: 'Outros meios de pagamento', valor: v(c && c.outros_meios_pagamento) },
      { rotulo: 'Instruções adicionais', valor: v(c && c.dados_bancarios_adicionais) },
    ],
    linhasIdentidade: [
      { rotulo: 'Modo', valor: c && c.identidade_visual === 'logo' ? 'Logótipo personalizado' : 'Apenas a designação oficial' },
      { rotulo: 'Logótipo', valor: v(c && c.logotipo) },
    ],
  });
});

// ── Separador 2: Armazenamento e Backups ───────────────────────────
router.get('/config/armazenamento', async (req, res) => {
  const dados = await dadosArmazenamento(req.condominioId);

  // ── Tips contextuais (orientação, distinta dos sinais) ────────────
  // A área é `armazenamento`: o motor só apresenta os tips registados para
  // esta página, e só quando a situação descrita existe mesmo (destino sem
  // ligação, backup falhado, retenção no mínimo...). Tolerante a falha: um tip
  // que não se consegue avaliar simplesmente não aparece.
  let contextoDeTips = { apresentar: [], total: 0, outras: [], limite: 0 };
  try {
    contextoDeTips = await tipsDaPagina({
      area: 'armazenamento',
      condominioId: req.condominioId,
      userId: req.user.id,
      papel: req.papelCondominio,
      dados,
    });
  } catch (err) {
    console.error('[tips] armazenamento:', err.message);
  }

  // ── P54-4 — linhas do estado de CONSULTA (padrão P54-0) ───────────
  // O parcial `_modo-edicao` mostra estes valores como TEXTO enquanto o bloco
  // está em consulta; os campos só existem depois de `Editar`. Construídas
  // AQUI (e não na vista) porque o Handlebars não compõe arrays — é o mesmo
  // caminho do `linhasSmtp` do P54-2.
  //
  // ⛔ Nenhuma linha é `sensivel: true`, e isso é deliberado: nesta área NÃO
  // há um único segredo editável por formulário. As credenciais OAuth vivem no
  // `.env` (`*_CLIENT_SECRET`) e os tokens em `configuracoes` só mudam pelo
  // fluxo OAuth — nunca por um campo. Um segredo que aparecesse aqui seria um
  // defeito, não uma linha a mais (spec P54 §6).
  const provedoresLigados = (dados.armazenamento.provedores || []).filter((p) => p.ligado);
  const principal = provedoresLigados.find((p) => p.principal) || null;
  const backup = dados.armazenamento.backup || {};

  const linhasPrincipal = [
    {
      rotulo: 'Serviço de armazenamento',
      valor: principal ? principal.rotulo : null,
      estado: principal ? 'Em uso' : 'Por escolher',
    },
  ];
  const linhasBackup = [
    { rotulo: 'Destino dos backups', valor: backup.destino ? backup.rotulo : 'Só neste servidor' },
    // A conta só se mostra quando há destino externo: sem ele a linha seria um
    // «—» que não informa nada.
    ...(backup.destino && backup.conta ? [{ rotulo: 'Conta', valor: backup.conta }] : []),
  ];
  const linhasDrive = [
    { rotulo: 'Pasta de destino', valor: dados.driveOpcoes.pastaRaiz || 'GesCondu' },
  ];

  res.render('admin/configuracao/armazenamento', {
    titulo: 'Armazenamento e Backups',
    ...dados,
    linhasPrincipal,
    linhasBackup,
    linhasDrive,
    // `voltar` diz à rota de dispensa para onde regressar (validado no servidor).
    tips: { ...contextoDeTips, voltar: '/admin/config/armazenamento' },
  });
});

// ── Serviço de armazenamento do condomínio ─────────────────────────
// A escolha do armazenamento principal e do destino de backups é feita em
// /config/armazenamento/principal e /config/armazenamento/backups (abaixo).

// Ligar (passo 1): envia o administrador para o fornecedor escolhido.
// Âmbito: 'condominio' (documentos do condomínio, por omissão) ou 'plataforma'
// (ligação da instalação, usada pelos backups).
router.get('/config/armazenamento/:provedor/ligar', async (req, res) => {
  const provedor = String(req.params.provedor || '').toLowerCase();
  const ambito = req.query.ambito === 'plataforma' ? 'plataforma' : 'condominio';
  if (provedor === 'google_drive') {
    // O Drive usa as rotas próprias (Redirect URI registado no Google).
    return res.redirect(`${ROTAS_DRIVE.ligar}?ambito=${ambito}`);
  }
  if (!PROVEDORES_OAUTH.has(provedor)) {
    return res.redirect('/admin/config/armazenamento');
  }
  const p = storage.obterProvedor(provedor);
  const alvo = ambito === 'plataforma' ? null : req.condominioId;
  const estado = await p.estadoLigacao(alvo);
  if (!estado.ativo || !estado.credenciais) {
    // Mensagem amigável: o utilizador final nunca vê detalhes técnicos.
    req.flash('error_msg', `${p.rotulo()} ainda não está disponível nesta instalação. Contacte o administrador do GesCondu.`);
    return res.redirect('/admin/config/armazenamento');
  }

  const redirectUri = redirectUriDe(req, provedor);
  const state = crypto.randomBytes(18).toString('hex');
  // O estado fica na sessão e inclui condomínio e âmbito: o callback nunca
  // aceita nem o condomínio nem o âmbito vindos do browser.
  req.session.storageOauthState = { provedor, state, ambito, condominioId: ambito === 'plataforma' ? null : req.condominioId };
  const url = p.urlAutorizacao({ redirectUri, state, condominioId: req.session.storageOauthState.condominioId });
  return res.redirect(url);
});

// Ligar (passo 2): o fornecedor devolve o código de autorização.
router.get('/config/armazenamento/:provedor/callback', async (req, res) => {
  const provedor = String(req.params.provedor || '').toLowerCase();
  if (!PROVEDORES_OAUTH.has(provedor)) {
    return res.redirect('/admin/config/armazenamento');
  }
  const guardado = req.session.storageOauthState || null;
  delete req.session.storageOauthState;

  const { code, state, error } = req.query;
  if (error) {
    req.flash('error_msg', 'Autorização não concluída no fornecedor. Pode voltar a tentar.');
    return res.redirect('/admin/config/armazenamento');
  }
  if (!code) {
    req.flash('error_msg', 'Não foi recebido o código de autorização.');
    return res.redirect('/admin/config/armazenamento');
  }
  if (!guardado || guardado.provedor !== provedor || guardado.state !== state) {
    req.flash('error_msg', 'Pedido de autorização inválido (estado não confere). Tente novamente.');
    return res.redirect('/admin/config/armazenamento');
  }

  const p = storage.obterProvedor(provedor);
  try {
    const tokens = await p.trocarCodigo({
      code,
      redirectUri: redirectUriDe(req, provedor),
      // Âmbito guardado na sessão: 'condominio' liga a conta ao condomínio ativo,
      // 'plataforma' cria a ligação da instalação (usada pelos backups).
      condominioId: guardado.ambito === 'plataforma' ? null : guardado.condominioId,
      plataforma: guardado.ambito === 'plataforma',
    });
    await storage.inicializar();
    await audit({
      userId: req.user.id,
      acao: 'ligar_armazenamento',
      entidade: p.rotulo(),
      entidadeId: guardado.ambito === 'plataforma' ? null : guardado.condominioId,
      detalhes: { provedor, ambito: guardado.ambito || 'condominio', conta: tokens && tokens.conta ? tokens.conta : null },
    }).catch(() => {});
    const onde = guardado.ambito === 'plataforma' ? 'à plataforma' : 'a este condomínio';
    if (tokens && tokens.conta) {
      req.flash('success_msg', `${p.rotulo()} ligado ${onde} (${tokens.conta}).`);
    } else if (tokens && tokens.contaErro) {
      // A ligação foi criada, mas a conta não ficou identificada (por exemplo:
      // o scope `User.Read` não foi consentido no ecrã da Microsoft). Dizê-lo
      // é mais honesto do que mostrar uma conta que não é a real; a mensagem já
      // vem sanitizada do adaptador (nunca traz tokens).
      req.flash('success_msg', `${p.rotulo()} ligado ${onde}. Não foi possível identificar a conta ligada: ${tokens.contaErro}`);
    } else {
      req.flash('success_msg', `${p.rotulo()} ligado ${onde}.`);
    }
  } catch (err) {
    console.error(`[armazenamento] callback ${provedor}:`, err.message);
    req.flash('error_msg', `Não foi possível ligar ${p.rotulo()}: ${err.message}`);
  }
  return res.redirect('/admin/config/armazenamento');
});

// Desligar: remove os tokens da ligação (do condomínio ou da plataforma). Os
// ficheiros no fornecedor NÃO são apagados nem despartilhados.
router.post('/config/armazenamento/:provedor/desligar', async (req, res) => {
  const provedor = String(req.params.provedor || '').toLowerCase();
  const plataforma = req.query.ambito === 'plataforma' || req.body.ambito === 'plataforma';
  // P54-4 (reforço): desligar a ligação da PLATAFORMA (a dos backups) é operação
  // da instalação — só Super Admin. Correr ANTES do redirect para o Drive, senão
  // o 307 levava o pedido ao irmão `/config/drive/desligar` sem guarda nenhuma.
  if (recusarSePlataformaSemSuperAdmin(req, res, plataforma)) return;
  if (provedor === 'google_drive') {
    // 307 preserva o POST e o âmbito.
    return res.redirect(307, `${ROTAS_DRIVE.desligar}?ambito=${plataforma ? 'plataforma' : 'condominio'}`);
  }
  if (!PROVEDORES_OAUTH.has(provedor)) {
    return res.redirect('/admin/config/armazenamento');
  }
  const p = storage.obterProvedor(provedor);
  try {
    // O âmbito tem de ser explícito: sem chave de condomínio, os adaptadores
    // recusam-se a apagar uma ligação (protege a ligação de um condomínio de
    // ser removida por engano). Sem este argumento, "Desligar (plataforma)"
    // não fazia nada e o serviço continuava a aparecer ligado.
    await p.desligar(plataforma ? null : req.condominioId, { plataforma });
    await storage.inicializar();
    // Desligar o serviço de backup liberta o destino configurado — mas só se
    // deixar de existir QUALQUER ligação utilizável para ele (de plataforma ou
    // de outro condomínio). Sem esta verificação, desligar a ligação da
    // plataforma apagava um destino de backups que continuava a funcionar.
    if ((await storage.destinoDeBackup()) === provedor) {
      const restante = storage.ligacaoDeBackup(provedor);
      if (!restante || !restante.origem) await storage.definirDestinoDeBackup(null);
    }
    await audit({
      userId: req.user.id,
      acao: 'desligar_armazenamento',
      entidade: p.rotulo(),
      entidadeId: plataforma ? null : req.condominioId,
      detalhes: { provedor, ambito: plataforma ? 'plataforma' : 'condominio' },
    }).catch(() => {});
    req.flash('success_msg', `${p.rotulo()} desligado${plataforma ? ' (ligação da plataforma)' : ''}. Os ficheiros já guardados não foram apagados.`);
  } catch (err) {
    req.flash('error_msg', `Não foi possível desligar ${p.rotulo()}: ${err.message}`);
  }
  return res.redirect('/admin/config/armazenamento');
});

// Testar a ligação (sem criar pastas nem enviar ficheiros).
router.post('/config/armazenamento/:provedor/testar', async (req, res) => {
  const provedor = String(req.params.provedor || '').toLowerCase();
  const plataforma = req.query.ambito === 'plataforma' || req.body.ambito === 'plataforma';
  // P54-4 (reforço): testar a ligação da PLATAFORMA pode RENOVAR tokens e, se o
  // fornecedor os tiver revogado, removê-los — altera o estado da instalação.
  // Só Super Admin. ANTES do redirect para o Drive (o irmão não tem guarda).
  if (recusarSePlataformaSemSuperAdmin(req, res, plataforma)) return;
  if (provedor === 'google_drive') {
    return res.redirect(307, `${ROTAS_DRIVE.testar}?ambito=${plataforma ? 'plataforma' : 'condominio'}`);
  }
  if (!PROVEDORES_OAUTH.has(provedor)) {
    return res.redirect('/admin/config/armazenamento');
  }
  const p = storage.obterProvedor(provedor);
  const cidTeste = plataforma ? null : req.condominioId;
  const r = await p.testarLigacao(cidTeste);
  // O teste pode detetar que a autorização foi revogada no fornecedor: nesse
  // caso o adaptador remove os tokens guardados. Recarrega-se o estado para a
  // página deixar imediatamente de mostrar o serviço como "Ligado".
  await storage.inicializar().catch(() => {});
  if (r.ok) {
    await audit({ userId: req.user.id, acao: 'testar_armazenamento', entidade: p.rotulo(), detalhes: { ok: true, ambito: plataforma ? 'plataforma' : 'condominio' } }).catch(() => {});
    req.flash('success_msg', r.conta ? `✓ Ligação a ${p.rotulo()} estabelecida (${r.conta}).` : `✓ Ligação a ${p.rotulo()} estabelecida.`);
  } else {
    const removida = !p.isConfigured(cidTeste)
      ? ' A ligação foi removida porque a autorização já não é válida — ligue a conta novamente.'
      : '';
    req.flash('error_msg', `✕ Não foi possível testar ${p.rotulo()}: ${r.erro}${removida}`);
  }
  return res.redirect('/admin/config/armazenamento');
});

// ── Armazenamento principal (documentos) ───────────────────────────
// Só pode ser principal um serviço LIGADO neste condomínio. Os documentos
// continuam a ser gravados num único serviço (sem duplicação automática) e é
// este o serviço usado pelas automações de documentos.
router.post('/config/armazenamento/principal', async (req, res) => {
  const nome = String(req.body.provedor || '').trim().toLowerCase();
  try {
    const p = storage.obterProvedor(nome);
    if (!p) throw new Error('Serviço de armazenamento desconhecido.');
    if (!p.isConfigured(req.condominioId)) {
      throw new Error(`${p.rotulo()} não está ligado a este condomínio. Ligue o serviço antes de o tornar principal.`);
    }
    await storage.definirPrincipalDoCondominio(req.condominioId, nome);
    await audit({
      userId: req.user.id,
      acao: 'definir_armazenamento_principal',
      entidade: 'Condominio',
      entidadeId: req.condominioId,
      detalhes: { provedor: nome },
    }).catch(() => {});
    req.flash('success_msg', `Armazenamento principal dos documentos: ${p.rotulo()}.`);
  } catch (err) {
    req.flash('error_msg', `Não foi possível definir o armazenamento principal: ${err.message}`);
  }
  res.redirect('/admin/config/armazenamento');
});

// Compatibilidade com o nome anterior da rota.
router.post('/config/armazenamento/provedor', (req, res) => res.redirect(307, '/admin/config/armazenamento/principal'));

// ── Destino de backups (instalação) ────────────────────────────────
// Os backups usam a ligação JÁ EXISTENTE do serviço escolhido (uma ligação por
// serviço, sem contas duplicadas). Como o dump contém dados de todos os
// condomínios, a interface avisa quando a conta é a de um condomínio.
//
// Guarda: a escolha é da INSTALAÇÃO, não do condomínio ativo — só um Super
// Admin a pode fazer (`tenant.apenasSuperAdmin`, decidido por
// `users.role_global`). Sem isto, um admin de condomínio mudava o destino dos
// backups de todos os condomínios. A guarda corre ANTES do handler, pelo que um
// pedido recusado não grava nada.
router.post('/config/armazenamento/backups', tenant.apenasSuperAdmin, async (req, res) => {
  const escolha = String(req.body.provedor || '').trim().toLowerCase();
  try {
    if (!escolha || escolha === 'nenhum') {
      await storage.definirDestinoDeBackup(null);
      req.flash('success_msg', 'Backups passam a ser guardados apenas localmente no servidor.');
    } else {
      const p = storage.obterProvedor(escolha);
      if (!p) throw new Error('Serviço de armazenamento desconhecido.');
      // Mesma condição que o job de backups usa (`ligacaoParaBackup`): só se
      // aceita um destino que o job consiga MESMO usar. Antes bastava haver
      // uma configuração (ligação de plataforma OU do condomínio), e um destino
      // só com ligação de condomínio era aceite pela página mas ignorado pelo
      // job — os backups ficavam no servidor e a página dizia «Dropbox».
      const ligacao = storage.ligacaoDeBackup(escolha);
      if (!ligacao || !ligacao.origem) {
        throw new Error(`${p.rotulo()} não tem nenhuma ligação utilizável. Ligue o serviço antes de o escolher para backups.`);
      }
      await storage.definirDestinoDeBackup(escolha);
      req.flash(
        'success_msg',
        ligacao.conta
          ? `Destino dos backups: ${p.rotulo()} (${ligacao.conta}).`
          : `Destino dos backups: ${p.rotulo()}.`
      );
    }
    await audit({
      userId: req.user.id,
      acao: 'definir_destino_backups',
      entidade: 'Configuracao',
      detalhes: { provedor: escolha || null },
    }).catch(() => {});
  } catch (err) {
    req.flash('error_msg', `Não foi possível guardar o destino dos backups: ${err.message}`);
  }
  res.redirect('/admin/config/armazenamento');
});

// Upload do logótipo com tratamento de erro amigável (formato inválido não
// deve rebentar a página de Configuração).
function uploadLogotipo(req, res, next) {
  upload.single('logotipo')(req, res, (err) => {
    if (err) {
      req.flash('error_msg', err.message || 'Não foi possível carregar o logótipo.');
      return res.redirect('/admin/config');
    }
    return next();
  });
}

router.post('/config', uploadLogotipo, async (req, res) => {
  try {
    // NIF e IBAN: normalizar e validar antes de guardar (nunca confiar no browser).
    const nifValidado = validarNif(req.body.nif);
    if (!nifValidado.ok) {
      req.flash('error_msg', nifValidado.mensagem);
      return res.redirect('/admin/config');
    }
    const ibanValidado = validarIban(req.body.iban_principal);
    if (!ibanValidado.ok) {
      req.flash('error_msg', ibanValidado.mensagem);
      return res.redirect('/admin/config');
    }

    const dados = {
      designacao: req.body.designacao,
      administracao_nome: req.body.administracao_nome || null,
      website: req.body.website || null,
      nif: nifValidado.valor || null,
      morada: req.body.morada || null,
      codigo_postal: req.body.codigo_postal || null,
      localidade: req.body.localidade || null,
      email: req.body.email || null,
      telefone: req.body.telefone || null,
      iban_principal: ibanValidado.valor || null,
      outros_meios_pagamento: req.body.outros_meios_pagamento || null,
      dados_bancarios_adicionais: req.body.dados_bancarios_adicionais || null,
      identidade_visual: req.body.identidade_visual || 'designacao',
    };

    let condominio = await Condominio.findOne({ where: { id: req.condominioId } });
    if (!condominio) {
      req.flash('error_msg', 'Condomínio não encontrado.');
      return res.redirect('/admin/config');
    }
    await condominio.update(dados);

    // Logótipo: a extensão do ficheiro gravado vem do TIPO validado no
    // servidor (nunca do nome enviado pelo browser).
    if (req.file) {
      const ext = String(req.file.mimetype || '').toLowerCase() === 'image/jpeg' ? '.jpg' : '.png';
      const nome = `logo_${Date.now()}${ext}`;
      const destino = path.join(__dirname, '..', 'public', 'uploads', nome);
      fs.writeFileSync(destino, req.file.buffer);
      await condominio.update({ logotipo: nome });
    }

    clearCondominioCache();
    await audit({ userId: req.user.id, acao: 'editar_configuração', entidade: 'Condominio', entidadeId: condominio.id });
    req.flash('success_msg', 'Configuração guardada.');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao guardar a configuração.');
  }
  res.redirect('/admin/config');
});

// ═══════════════════════════════════════════════════════════════════
// Documentos e Automações (Configurações)
//
// P54-7 — as automações são configuração DE UM CONDOMÍNIO. O âmbito vem sempre
// do tenant (`req.condominioId`, já validado por `tenant.comCondominioAtivo`),
// NUNCA do corpo do pedido: aceitar um `condominioId` submetido seria deixar o
// cliente escolher de quem são as automações que está a alterar.
// ═══════════════════════════════════════════════════════════════════
router.get('/config/automacoes', async (req, res) => {
  const grupos = await listarAutomacoes(req.condominioId);
  res.render('admin/configuracao/automacoes', {
    titulo: 'Documentos e Automações',
    grupos,
    // ── P54-7 — linhas do estado de CONSULTA (padrão P54-0) ──────────
    // A página nasce em consulta, com o estado efetivo como TEXTO; o
    // formulário só existe depois de `Editar`. Construídas aqui porque o
    // Handlebars não compõe arrays (mesmo caminho do `linhasSmtp` do P54-2 e
    // do `linhasPrincipal` do P54-4).
    // ⛔ Nenhuma linha é `sensivel: true`: esta área só tem interruptores
    // sim/não — aqui não existe um único segredo.
    linhasAutomacoes: linhasDeConsulta(grupos),
  });
});

// ── Separador 5: Auditoria (antes com entrada própria no menu principal) ──
router.get('/config/auditoria', async (req, res) => {
  const logs = await AuditLog.findAll({
    include: [{ model: User, as: 'user', attributes: ['nome', 'email'] }],
    order: [['id', 'DESC']],
    limit: 300,
  });
  res.render('admin/configuracao/auditoria', { titulo: 'Auditoria', logs });
});

// Endereço antigo da auditoria (tinha entrada própria no menu principal):
// mantém os links existentes a funcionar.
router.get('/auditoria', (req, res) => res.redirect('/admin/config/auditoria'));

// P54-7 — gravação das automações do condomínio ATIVO. O âmbito vem do tenant
// (nunca do corpo) e a gravação recusa-se a correr sem ele, pelo que uma
// chamada direta sem contexto não altera as automações de ninguém.
router.post('/config/automacoes', async (req, res) => {
  try {
    const r = await guardarAutomacoes(req.body, req.condominioId);
    await audit({
      userId: req.user.id,
      acao: 'configurar_automacoes',
      entidade: 'Configuracao',
      // P54-7 — utilizador (pelo `audit`), condomínio e as chaves cujo EFEITO
      // mudou. ⛔ Só NOMES de campos: nunca valores.
      detalhes: { condominioId: req.condominioId, tipos: r.tipos, alterados: r.alterados },
    }).catch(() => {});
    req.flash('success_msg', r.alterados.length
      ? `Automações de documentos guardadas (${r.alterados.length} alteração(ões)).`
      : 'Automações de documentos guardadas — nada mudou.');
  } catch (err) {
    console.error('[automacoes]', err.message);
    // As mensagens do validador são escritas para o utilizador; qualquer outra
    // falha (BD, âmbito ausente) mantém a mensagem genérica — nunca se ecoa o
    // erro interno.
    const doValidador = err.motivo === 'submissao_incompleta' || err.motivo === 'campo_desconhecido';
    req.flash('error_msg', doValidador ? err.message : 'Não foi possível guardar as automações.');
  }
  res.redirect('/admin/config/automacoes');
});

// ═══════════════════════════════════════════════════════════════════
// Separador 4: Email / SMTP (antes na Central de Emails)
//
// A CONFIGURAÇÃO técnica do serviço de email é administração do condomínio,
// não operação da fila: a Central de Emails fica com a fila (reenviar,
// cancelar) e a configuração passa a viver aqui. Não há — nem pode haver —
// uma segunda configuração SMTP: as rotas abaixo usam o MESMO `helpers/mailer`
// que a fila usa para enviar.
//
// O envio do email de teste é uma AÇÃO DE VALIDAÇÃO desta configuração: usa a
// configuração JÁ GUARDADA (`obterConfigSmtp` lê a BD com prioridade sobre o
// `.env`), pelo que testa o que está efetivamente a ser usado nos envios reais.
//
// ── P30 — O ÂMBITO É DECIDIDO PELA ROTA, NUNCA PELO CORPO ──────────
//
// Há DOIS âmbitos e cada um tem o seu caminho EXPLÍCITO (não existe uma rota
// ambígua que grave global ou condomínio conforme o que o cliente envie):
//
//   · `/config/email/smtp`         → OVERRIDE do condomínio ATIVO
//                                    (`smtp_*:c<ID>`, id vindo do tenant da
//                                    sessão). Exige `admin` — guarda do router.
//   · `/config/email/smtp/global`  → configuração GLOBAL (`smtp_*`). Exige
//                                    `super_admin`. É a única via de escrita do
//                                    global: sem ela, o global ficava órfão
//                                    assim que o override passou a ser o âmbito
//                                    da página do condomínio.
//
// ⛔ Um `condominio_id` no corpo do pedido é IGNORADO: o âmbito vem de
//    `req.condominioId` (associação real validada pelo tenant) ou de nenhum
//    (global). Não há caminho de código do corpo até à chave gravada.
//
// ⛔ O SUPORTE NUNCA ESCREVE SMTP, em nenhum dos âmbitos. Este router não tem
//    entrada na allow-list de suporte (`helpers/suporte-allowlist.js`): o
//    acesso de suporte entra pelos routers declarados, e `configuracao` não é
//    um deles. É por isso que NÃO se acrescenta aqui uma guarda de suporte —
//    acrescentá-la seria admitir um caminho que hoje não existe.
// ═══════════════════════════════════════════════════════════════════
router.get('/config/email', async (req, res) => {
  // P30 — o estado é o EFETIVO do condomínio ATIVO (override → global → `.env`),
  // que é o que os envios deste condomínio vão usar.
  // `obterEstadoSmtp` nunca devolve a password — apenas o indicador e a ORIGEM.
  const estadoSmtp = await mailer.obterEstadoSmtp(req.condominioId);
  // ── P54-2 — linhas da CONSULTA para o padrão P54-0 ────────────────
  // Só o que o utilizador pode ver: valores de configuração e, para a password,
  // o ESTADO («Definida»/«Em falta»). ⛔ Não há aqui nenhum caminho que ponha a
  // password na vista: `obterEstadoSmtp` não a devolve, e a linha da password é
  // marcada `sensivel` para o parcial imprimir a máscara e IGNORAR o valor.
  // P30 — a linha da password diz também a ORIGEM (própria deste condomínio ou
  // herdada do global). É informação sobre o ESTADO, não sobre o valor: sem ela,
  // um administrador ficava convencido de ter definido uma password quando
  // apenas estava a herdar a da plataforma.
  const rotuloPassword = {
    propria: 'Definida neste condomínio',
    herdada: 'Herdada da configuração global',
    ausente: 'Em falta',
  }[estadoSmtp.passwordEstado] || 'Em falta';

  const linhasSmtp = [
    { rotulo: 'Servidor', valor: estadoSmtp.servidor },
    { rotulo: 'Porta', valor: estadoSmtp.porta },
    { rotulo: 'Utilizador', valor: estadoSmtp.utilizador },
    { rotulo: 'Remetente', valor: estadoSmtp.remetente, estado: estadoSmtp.nomeRemetente },
    { rotulo: 'Segurança', valor: estadoSmtp.seguranca },
    { rotulo: 'Password', sensivel: true, estado: rotuloPassword },
  ];
  res.render('admin/configuracao/email', {
    titulo: 'Email / SMTP',
    estadoSmtp,
    linhasSmtp,
    // P30 — a vista distingue «configuração deste condomínio» de «herdada da
    // global», para o âmbito da página ser explícito (como o P30 exige).
    ambitoSmtp: estadoSmtp.temOverride ? 'condominio' : 'global',
    // P54-3 (V11) — a vista pede o código 2FA apenas a quem o tem ativo.
    exige2fa: reautenticacao.exigeSegundoFator(req.user),
  });
});

// ── P54-3 — preparar a confirmação (emite o token ligado ao payload) ─
// É o passo que a interface faz quando o utilizador confirma na caixa do P54-2.
// Devolve JSON (é chamado por `fetch`) e NÃO grava nada.
//
// A ordem é deliberada: identidade → conteúdo → token.
//   · a identidade prova-se com a password da conta (e 2FA quando ativo), pelo
//     que um token NUNCA é emitido a quem não a conheça;
//   · o conteúdo é validado com o MESMO validador da gravação, para não se
//     confirmar aquilo que já se sabe que vai ser recusado;
//   · só então se emite o token, ligado à impressão do payload.
//
// P30 — o âmbito entra na OPERAÇÃO da confirmação (`smtp-config` vs
// `smtp-config-global`). É o que impede que uma confirmação preparada na
// página do condomínio sirva para gravar o global: os tokens são de uso único
// e a operação é um dos critérios de aceitação (`confirmacao-sensivel`).
function prepararConfirmacaoSmtp(operacao, limite) {
  return [limite, async (req, res) => {
    const re = reautenticacao.reautenticacaoValida(req);
    if (!re.ok) return res.status(403).json({ ok: false, erro: 'reautenticacao', mensagem: re.erro });

    const v = await mailer.validarConfigSmtp(corpoSmtp(req.body), req.condominioSmtp ?? null);
    if (!v.ok) {
      return res.status(400).json({
        ok: false,
        erro: 'invalido',
        // Só CÓDIGOS e a mensagem FIXA do catálogo — nunca valores.
        campos: v.erros.map((e) => ({ campo: e.campo, codigo: e.codigo, mensagem: e.mensagem })),
      });
    }

    const t = confirmacao.emitir(req, { operacao, impressao: impressaoDoPedido(req.body) });
    if (!t.ok) return res.status(409).json({ ok: false, erro: t.erro });

    return res.json({ ok: true, token: t.valor, expiraEm: t.expiraEm });
  }];
}

// Mensagens de recusa da confirmação. FIXAS, sem valores — a confirmação é um
// segredo de uso único e não pode aparecer em texto nenhum.
function mensagemDeConfirmacao(erro) {
  const M = {
    sem_confirmacao: 'A alteração tem de ser confirmada na página de configuração.',
    confirmacao_ausente: 'A alteração tem de ser confirmada na página de configuração.',
    confirmacao_invalida: 'A confirmação não é válida. Repita a alteração a partir da página.',
    confirmacao_expirada: 'A confirmação expirou. Repita a alteração.',
    confirmacao_de_outro_utilizador: 'A confirmação não pertence a esta conta.',
    payload_alterado: 'Os valores mudaram depois da confirmação. Reveja e confirme de novo.',
    operacao_obrigatoria: 'A alteração tem de ser confirmada na página de configuração.',
  };
  return M[erro] || 'A alteração tem de ser confirmada na página de configuração.';
}

// ── Guardar a configuração SMTP ────────────────────────────────────
// P54-3 — a gravação exige, TODAS:
//   · confirmação emitida pelo SERVIDOR (V10), ligada a esta sessão, a este
//     utilizador, a ESTA operação e AO PAYLOAD enviado, de uso único e com
//     prazo;
//   · reautenticação com a password da conta (V11);
//   · dentro do limite por utilizador (V12);
//   · tudo dentro de uma TRANSAÇÃO (V9): configuração + auditoria, ou nada.
//
// ⛔ Um `POST` direto ao endpoint, sem passar pela interface, não traz o token e
//    é recusado — a proteção não depende da página.
//
// P30 — UM SÓ HANDLER, dois âmbitos. `ambitoSmtp` é `null` (GLOBAL) ou o id do
// condomínio ativo; `operacao` distingue os tokens. ⛔ O âmbito NÃO vem do corpo:
// vem de `req.condominioSmtp`, fixado pela ROTA antes de chegar aqui. Não há
// segundo caminho de gravação, logo não há duas proteções P54-3 a divergir.
function guardarSmtp(scp) {
  return [limiteSmtpGravar, async (req, res) => {
    // O âmbito é resolvido UMA vez, a partir do que a rota fixou — nunca do corpo.
    const cid = scp.global ? null : req.condominioSmtp;

    // 1. Confirmação server-side. É consumida mesmo que algo falhe a seguir.
    const conf = confirmacao.validarEConsumir(req, {
      operacao: scp.operacao,
      valor: req.body._confirmacao,
      impressao: impressaoDoPedido(req.body),
    });
    if (!conf.ok) {
      console.error('[smtp] gravação recusada — confirmação: %s', conf.erro);
      req.flash('error_msg', mensagemDeConfirmacao(conf.erro));
      return res.redirect(scp.regresso);
    }

    // 2. Reautenticação. É a barreira que uma sessão roubada não vence.
    const re = reautenticacao.reautenticacaoValida(req);
    if (!re.ok) {
      // Fica registado o MOTIVO da recusa (nunca o valor submetido): sem isto,
      // uma gravação recusada era indistinguível de uma falha de BD no log.
      console.error('[smtp] gravação recusada — reautenticação');
      req.flash('error_msg', re.erro);
      return res.redirect(scp.regresso);
    }

    // 3. Transação: a configuração e o evento de auditoria vivem ou morrem juntos.
    const t = await sequelize.transaction();
    try {
      const r = await mailer.guardarConfigSmtp(corpoSmtp(req.body), { transaction: t, condominioId: cid });

      // V14 — registar QUE CAMPOS mudaram: nomes apenas. Nenhum valor entra aqui,
      // e a password entra pelo NOME, nunca pelo conteúdo nem por um digest.
      // P30 — o ÂMBITO fica registado em claro (`r.ambito`): a auditoria tem de
      // identificar sem ambiguidade se o que mudou foi o global ou o override de
      // um condomínio concreto. Continua a não haver um único valor.
      await audit({
        userId: req.user.id,
        acao: scp.global ? 'configurar_smtp_global' : 'configurar_smtp',
        entidade: 'Configuracao',
        entidadeId: cid || null,
        detalhes: { campos_alterados: r.alterados, ambito: r.ambito },
        transaction: t,
        rigoroso: true,
      });

      await t.commit();
      // ⛔ Só DEPOIS do commit: limpar a cache antes serviria uma configuração
      // que ainda podia reverter.
      mailer.limparCache(cid);
      req.flash('success_msg', scp.global
        ? 'Configuração SMTP global guardada.'
        : 'Configuração SMTP deste condomínio guardada.');
    } catch (err) {
      await t.rollback().catch(() => {});
      if (err && err.name === 'ErroValidacaoSmtp') {
        console.error('[smtp] gravação recusada pela validação');
        req.flash('error_msg', 'Configuração inválida — nada foi alterado.');
      } else {
        console.error('[smtp] erro ao guardar:', err.message);
        req.flash('error_msg', 'Não foi possível guardar a configuração SMTP. Nada foi alterado.');
      }
    }
    res.redirect(scp.regresso);
  }];
}

// ── Testar a ligação (verificação, sem enviar nada) ────────────────
// P30 — testa o âmbito EFETIVO do contexto: o override do condomínio ativo na
// página do condomínio, o global na página global. O âmbito vai no PRIMEIRO
// argumento POSICIONAL (ver o comentário de `testarLigacao` no mailer).
function testarSmtp(scp) {
  return [limiteSmtpAcoes, async (req, res) => {
    try {
      const r = await mailer.testarLigacao(scp.global ? null : req.condominioSmtp);
      if (r.ok) {
        await audit({ userId: req.user.id, acao: 'testar_smtp', entidade: 'Configuracao', detalhes: { ok: true, servidor: r.servidor } });
        req.flash('success_msg', '✓ Ligação SMTP estabelecida.');
      } else {
        req.flash('error_msg', `✕ ${r.erro}`);
      }
    } catch (err) {
      req.flash('error_msg', `✕ Não foi possível ligar ao servidor SMTP: ${mailer.mensagemErroAmigavel(err)}`);
    }
    res.redirect(scp.regresso);
  }];
}

// ── Enviar email de teste (envio IMEDIATO, fora da fila) ───────────
// P30 — o teste usa a configuração EFETIVA do âmbito: na página do condomínio,
// o override (ou o global herdado); na página global, o global. O nome do
// remetente segue a mesma prioridade dos envios reais.
function enviarTeste(scp) {
  return [limiteSmtpAcoes, async (req, res) => {
    const para = String(req.body.para || '').trim();
    if (!para) {
      req.flash('error_msg', 'Indique o email de destino do teste.');
      return res.redirect(scp.regresso);
    }
    const cid = scp.global ? null : req.condominioSmtp;
    const r = await mailer.enviarEmailTeste({
      para,
      assunto: req.body.assunto || 'Teste SMTP — GesCondu',
      mensagem: req.body.mensagem || 'Este é um email de teste do GesCondu.',
      condominioId: cid || undefined,
    });
    await audit({
      userId: req.user.id,
      acao: 'email_teste',
      entidade: 'EmailFila',
      detalhes: { ok: r.ok, para },
    }).catch(() => {});
    if (r.ok) {
      req.flash('success_msg', `✓ Email de teste enviado para ${para}.`);
    } else {
      req.flash('error_msg', `✕ Não foi possível enviar o email de teste: ${r.erro}`);
    }
    res.redirect(scp.regresso);
  }];
}

// ── P30 — REGISTO DAS ROTAS, COM O ÂMBITO FIXADO AQUI ──────────────
// ⛔ O middleware de âmbito é o ÚNICO sítio onde `req.condominioSmtp` é escrito.
//    Vem do TENANT (`req.condominioId`, já validado por `comCondominioAtivo`),
//    NUNCA do corpo: não há caminho de código que leve `req.body.condominio_id`
//    até à chave gravada.
//
// ⛔ `tenant.apenasSuperAdmin` na via GLOBAL e só nela: um `admin` de condomínio
//    não tem caminho — nem na UI nem por POST direto — para escrever o global.
//    A guarda corre antes do handler, pelo que um pedido recusado não lê nem
//    grava nada.
//
// A ordem é deliberada: `/smtp/global` é registada ANTES de `/smtp`, para que
// nenhuma evolução de rotas com parâmetros possa vir a apanhar a via global.
const OPERACAO_SMTP_GLOBAL = 'smtp-config-global';

// Âmbito do CONDOMÍNIO ATIVO. Exige a associação real (guarda do router).
const fixarAmbitoSmtp = (req, res, next) => { req.condominioSmtp = req.condominioId; next(); };
const SMTP_CONDOMINIO = { global: false, operacao: OPERACAO_SMTP, regresso: '/admin/config/email' };
const SMTP_GLOBAL_SCP = { global: true, operacao: OPERACAO_SMTP_GLOBAL, regresso: '/admin/config/email' };

router.post('/config/email/smtp/global/preparar',
  tenant.apenasSuperAdmin,
  (req, res, next) => { req.condominioSmtp = null; next(); },
  ...prepararConfirmacaoSmtp(OPERACAO_SMTP_GLOBAL, limiteSmtpGravar));

router.post('/config/email/smtp/global',
  tenant.apenasSuperAdmin,
  (req, res, next) => { req.condominioSmtp = null; next(); },
  ...guardarSmtp(SMTP_GLOBAL_SCP));

router.post('/config/email/smtp/preparar',
  fixarAmbitoSmtp,
  ...prepararConfirmacaoSmtp(OPERACAO_SMTP, limiteSmtpGravar));

router.post('/config/email/smtp',
  fixarAmbitoSmtp,
  ...guardarSmtp(SMTP_CONDOMINIO));

router.post('/config/email/smtp/testar',
  fixarAmbitoSmtp,
  ...testarSmtp(SMTP_CONDOMINIO));

router.post('/config/email/teste',
  fixarAmbitoSmtp,
  ...enviarTeste(SMTP_CONDOMINIO));

// ═══════════════════════════════════════════════════════════════════
// Google Drive — fluxo OAuth (Ligar / Callback / Desligar)
// ═══════════════════════════════════════════════════════════════════

// Passo 1 — o administrador clica "Ligar Google Drive" e é enviado para
// o Google para autorizar a aplicação (scope mínimo: drive.file).
// Âmbito: 'condominio' (por omissão — a conta fica associada ao condomínio
// ativo) ou 'plataforma' (conta da instalação, usada pelos backups).
router.get('/config/drive/ligar', async (req, res) => {
  const ambito = req.query.ambito === 'plataforma' ? 'plataforma' : 'condominio';
  const alvo = ambito === 'plataforma' ? null : req.condominioId;
  const estado = await drive.estadoLigacao(alvo);
  if (!estado.ativo || !estado.credenciais) {
    // Mensagem amigável: nunca se expõem detalhes técnicos de configuração.
    req.flash('error_msg', 'O Google Drive ainda não está disponível nesta instalação. Contacte o administrador do GesCondu.');
    return res.redirect('/admin/config/armazenamento#google-drive');
  }

  const redirectUri = drive.obterRedirectUri(req);
  const state = crypto.randomBytes(18).toString('hex');
  // O estado (com âmbito e condomínio) fica na sessão: o callback nunca
  // aceita o condomínio nem o âmbito vindos do browser.
  req.session.googleDriveState = { state, ambito, condominioId: alvo };
  const url = drive.construirUrlAutorizacao({ redirectUri, state });
  res.redirect(url);
});

// Passo 4/5/6 — o Google redireciona para aqui; troca o código pelos
// tokens e guarda-os na base de dados (da conta do condomínio ou da
// plataforma, conforme o âmbito pedido no passo 1).
router.get('/config/drive/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const guardado = req.session.googleDriveState;
  delete req.session.googleDriveState;
  const esperado = guardado && typeof guardado === 'object' ? guardado.state : guardado;
  const ambito = guardado && typeof guardado === 'object' ? guardado.ambito : 'plataforma';
  const condominioAlvo = guardado && typeof guardado === 'object' ? guardado.condominioId : null;

  if (error) {
    req.flash('error_msg', 'Autorização no Google não concluída. Se recusou o acesso, pode voltar a tentar.');
    return res.redirect('/admin/config/armazenamento#google-drive');
  }
  if (!code) {
    req.flash('error_msg', 'Não foi recebido o código de autorização do Google.');
    return res.redirect('/admin/config/armazenamento#google-drive');
  }
  if (esperado && state !== esperado) {
    req.flash('error_msg', 'Pedido de autorização inválido (estado não confere). Tente novamente.');
    return res.redirect('/admin/config/armazenamento#google-drive');
  }

  const redirectUri = drive.obterRedirectUri(req);
  try {
    await drive.trocarCodigo({
      code,
      redirectUri,
      // Âmbito guardado na sessão: 'condominio' guarda a conta no condomínio;
      // 'plataforma' (e fluxos antigos sem estado) guarda a conta da instalação.
      condominioId: ambito === 'plataforma' ? undefined : condominioAlvo,
    });
    await drive.inicializar();
    await audit({
      userId: req.user.id,
      acao: 'ligar_google_drive',
      entidade: 'GoogleDrive',
      entidadeId: ambito === 'plataforma' ? null : condominioAlvo,
      detalhes: { ambito },
    }).catch(() => {});
    const onde = ambito === 'plataforma' ? 'à plataforma' : 'a este condomínio';
    req.flash('success_msg', `Google Drive ligado ${onde}. Os documentos podem agora ser guardados no Drive.`);
  } catch (err) {
    console.error('[drive] erro no callback OAuth:', err.message);
    req.flash('error_msg', `Não foi possível ligar o Google Drive: ${err.message}`);
  }
  res.redirect('/admin/config/armazenamento#google-drive');
});

// Passo Desligar — remove a conta e os tokens (os ficheiros no Drive não
// são apagados). A confirmação é feita na interface.
// Âmbito: a conta do condomínio (por omissão) ou a da plataforma.
router.post('/config/drive/desligar', async (req, res) => {
  const plataforma = req.query.ambito === 'plataforma' || req.body.ambito === 'plataforma';
  // P54-4 (reforço): esta rota é o DESTINO do 307 de
  // `/config/armazenamento/google_drive/desligar` e é alcançável por POST direto
  // — a guarda tem de viver aqui também, senão bastava chamá-la diretamente.
  if (recusarSePlataformaSemSuperAdmin(req, res, plataforma)) return;
  try {
    await drive.desligar(plataforma ? null : req.condominioId, { plataforma });
    await drive.inicializar();
    if (plataforma && (await storage.destinoDeBackup()) === 'google_drive') {
      await storage.definirDestinoDeBackup(null);
    }
    await audit({
      userId: req.user.id,
      acao: 'desligar_google_drive',
      entidade: 'GoogleDrive',
      entidadeId: plataforma ? null : req.condominioId,
      detalhes: { ambito: plataforma ? 'plataforma' : 'condominio' },
    }).catch(() => {});
    req.flash('success_msg', `Google Drive desligado${plataforma ? ' (ligação da plataforma)' : ''}. Os ficheiros já guardados no Drive não foram apagados.`);
  } catch (err) {
    console.error('[drive] erro ao desligar:', err.message);
    req.flash('error_msg', `Não foi possível desligar o Google Drive: ${err.message}`);
  }
  res.redirect('/admin/config/armazenamento#google-drive');
});

// Guarda opções de armazenamento: pasta raiz do Drive e backups automáticos.
router.post('/config/drive/opcoes', async (req, res) => {
  // ── P54-4 (reforço) — âmbito GLOBAL ───────────────────────────────
  // Ambas as chaves escritas aqui vivem em `configuracoes`, que não tem
  // `condominio_id`: são da instalação. Um admin de condomínio NÃO as altera.
  // O âmbito NUNCA vem do corpo: não existe (nem passa a existir) um
  // `condominioId` de cliente que mude o destino da escrita — a guarda decide
  // pelo `users.role_global` do utilizador autenticado.
  if (recusarConfiguracaoGlobalSemSuperAdmin(req, res)) return;
  // ── P54-4 — campo OMITIDO preserva o valor; valor inválido é recusado ──
  // A regra do P54 §5 é explícita: «campo omitido → manter existente». Antes,
  // este handler escrevia SEMPRE as duas chaves, pelo que guardar apenas a
  // pasta (o formulário da vista só envia `pasta_raiz`) gravava
  // `drive_auto_backups='0'` — desligava a cópia automática dos backups para o
  // Drive sem o utilizador o pedir. Era uma alteração SILENCIOSA a uma opção
  // de PLATAFORMA (`configuracoes` não tem `condominio_id`).
  // Agora cada chave só é escrita quando o campo vem mesmo no corpo.
  const campos = {};

  if (Object.prototype.hasOwnProperty.call(req.body, 'pasta_raiz')) {
    const pastaRaiz = String(req.body.pasta_raiz || '').trim();
    // É um NOME de pasta, não um caminho: sem separadores nem caracteres de
    // controlo, com limite de comprimento. Vazio é aceite e significa «usar a
    // omissão da instalação» (`.env` ou «GesCondu»), como já acontecia.
    if (pastaRaiz.length > 100) {
      req.flash('error_msg', 'Não foi possível guardar: o nome da pasta não pode ter mais de 100 caracteres.');
      return res.redirect('/admin/config/armazenamento#google-drive');
    }
    if (/[/\\\u0000-\u001f]/.test(pastaRaiz)) {
      req.flash('error_msg', 'Não foi possível guardar: o nome da pasta não pode conter «/», «\\» nem caracteres de controlo.');
      return res.redirect('/admin/config/armazenamento#google-drive');
    }
    campos.google_drive_root_folder = pastaRaiz;
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'backups_drive')) {
    campos.drive_auto_backups = (req.body.backups_drive === 'on' || req.body.backups_drive === '1') ? '1' : '0';
  }

  if (Object.keys(campos).length === 0) {
    req.flash('error_msg', 'Não foi possível guardar: o pedido não trazia nenhum campo de configuração.');
    return res.redirect('/admin/config/armazenamento#google-drive');
  }

  try {
    for (const [chave, valor] of Object.entries(campos)) await setConfig(chave, valor);
    // Auditoria: os NOMES dos campos alterados e o nome da pasta (não é
    // segredo). Nesta área não existe nenhum valor que o seja.
    await audit({
      userId: req.user.id,
      acao: 'configurar_armazenamento_drive',
      entidade: 'GoogleDrive',
      detalhes: {
        campos: Object.keys(campos),
        pastaRaiz: campos.google_drive_root_folder === undefined ? null : campos.google_drive_root_folder,
      },
    }).catch(() => {});
    req.flash('success_msg', 'Opções de armazenamento guardadas.');
  } catch (err) {
    console.error('[drive] opções:', err.message);
    req.flash('error_msg', 'Não foi possível guardar as opções de armazenamento.');
  }
  res.redirect('/admin/config/armazenamento#google-drive');
});

// Testa a ligação atual ao Google Drive (sem criar pastas nem enviar nada).
router.post('/config/drive/testar', async (req, res) => {
  // Âmbito: a ligação da plataforma (backups) ou a do condomínio ativo.
  const plataforma = req.query.ambito === 'plataforma' || req.body.ambito === 'plataforma';
  // P54-4 (reforço): destino do 307 de
  // `/config/armazenamento/google_drive/testar` e alcançável por POST direto.
  if (recusarSePlataformaSemSuperAdmin(req, res, plataforma)) return;
  const cidTeste = plataforma ? null : req.condominioId;
  const r = await drive.testarLigacao(cidTeste);
  // Uma autorização revogada no Google faz o teste falhar e os tokens são
  // removidos: recarrega-se o estado para a página deixar de mostrar "Ligado".
  await drive.inicializar().catch(() => {});
  if (r.ok) {
    await audit({ userId: req.user.id, acao: 'testar_google_drive', entidade: 'GoogleDrive', detalhes: { ok: true, ambito: plataforma ? 'plataforma' : 'condominio' } }).catch(() => {});
    req.flash('success_msg', r.conta ? `✓ Ligação ao Google Drive estabelecida (${r.conta}).` : '✓ Ligação ao Google Drive estabelecida.');
  } else {
    const removida = !drive.isConfigured(cidTeste)
      ? ' A ligação foi removida porque a autorização já não é válida — ligue a conta novamente.'
      : '';
    req.flash('error_msg', `✕ Não foi possível testar o Google Drive: ${r.erro}${removida}`);
  }
  res.redirect('/admin/config/armazenamento#google-drive');
});

// Cria a estrutura de pastas no Google Drive (do condomínio ativo).
// ⛔ `isConfigured()` SEM condomínio responde pelo âmbito da PLATAFORMA (a
// conta que serve os backups e os condomínios sem conta própria). A árvore,
// porém, é criada com `req.condominioId` — logo a verificação tem de ser feita
// para ESSE condomínio: sem isto, um condomínio com a sua própria conta Google
// era recusado («não está ligado») só porque a plataforma não tinha ligação.
router.post('/config/drive/estrutura', async (req, res) => {
  if (!drive.isConfigured(req.condominioId)) {
    req.flash('error_msg', 'Google Drive não está ligado — ligue a conta Google primeiro.');
    return res.redirect('/admin/config/armazenamento#google-drive');
  }
  try {
    // Multi-condomínio: a árvore é <raiz>/<Condomínio>/<ano>/{tipos}; a pasta
    // do condomínio fica registada (condominios.drive_folder_id) para todos os
    // uploads seguintes (a pasta Backups é global e também é criada aqui).
    const estrutura = await drive.criarEstruturaPastas(req.condominioId);
    await audit({ userId: req.user.id, acao: 'criar_estrutura_drive', entidade: 'GoogleDrive', detalhes: { condominioId: req.condominioId } }).catch(() => {});
    req.flash('success_msg', 'Estrutura de pastas do condomínio criada/verificada no Google Drive (raiz → condomínio → ano → tipos).');
  } catch (err) {
    console.error(err);
    req.flash('error_msg', err.message);
  }
  res.redirect('/admin/config/armazenamento#google-drive');
});

module.exports = router;
