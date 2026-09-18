// ─────────────────────────────────────────────────────────────────────
// Política de sessão — bloqueio automático por inatividade.
//
// Sem limite absoluto de duração: a sessão dura enquanto houver atividade.
// Ao fim de SESSION_IDLE_MINUTOS sem pedidos, a sessão é encerrada e o
// utilizador é obrigado a autenticar-se novamente (cobre também o caso de
// hibernação/retoma do equipamento: ao acordar, o intervalo já passou).
//
// Configuração (opcional):
//   SESSION_IDLE_MINUTOS   minutos de inatividade até encerrar (defeito: 120)
//   SESSION_AVISO_SEGUNDOS segundos de aviso antes de expirar (defeito: 120)
// ─────────────────────────────────────────────────────────────────────
// Nota sobre o ACESSO DE SUPORTE: terminar a sessão tem de terminar também a
// concessão de suporte, senão o registo ficava `ativo` em `acessos_suporte` até
// ao prazo — uma janela aberta sem ninguém do outro lado. Todas as saídas de
// sessão (logout explícito, inatividade, conta desativada) passam por
// `terminarSuporteDaSessao()`. A autorização em si já não dependeria do registo
// (a sessão morreu), mas o ESTADO tem de refletir a realidade.
const suporte = require('./suporte');

const CHAVE_ULTIMA = 'sessaoUltimaAtividade';
const CHAVE_INICIO = 'sessaoInicio';

// Rotas do próprio mecanismo de sessão (não bloqueiam nem renovam por si):
//  · /sessao/estado  → consulta (usada ao acordar de hibernação); nunca renova
//  · /sessao/renovar → renovação explícita (o clique em "Continuar sessão")
const ROTA_ESTADO = '/sessao/estado';

// Ficheiros estáticos não contam como atividade do utilizador.
const CAMINHO_ESTATICO = /^\/(css|js|img|uploads|favicon)\b/;

function minutosDeInatividade(valor) {
  const n = parseInt(valor, 10);
  if (!Number.isFinite(n) || n <= 0) return 120;
  return Math.min(n, 24 * 60); // teto de 24 h
}

function segundosDeAviso(valor) {
  const n = parseInt(valor, 10);
  if (!Number.isFinite(n) || n <= 0) return 120;
  return Math.min(n, 30 * 60);
}

const MINUTOS_INATIVIDADE = minutosDeInatividade(process.env.SESSION_IDLE_MINUTOS);
const SEGUNDOS_AVISO = segundosDeAviso(process.env.SESSION_AVISO_SEGUNDOS);
const IDLE_MS = MINUTOS_INATIVIDADE * 60 * 1000;
const AVISO_MS = SEGUNDOS_AVISO * 1000;

// Instante (ms) a partir do qual a inatividade já expirou. null = sem marca.
function expiraEm(sessao, agora) {
  if (!sessao || !sessao[CHAVE_ULTIMA]) return null;
  return Number(sessao[CHAVE_ULTIMA]) + IDLE_MS;
}

function expirada(sessao, agora) {
  const limite = expiraEm(sessao, agora);
  if (limite === null) return false;
  return (agora || Date.now()) > limite;
}

// Regista atividade: mantém o início da sessão e atualiza a última atividade.
function marcarAtividade(sessao, agora) {
  if (!sessao) return;
  const t = agora || Date.now();
  if (!sessao[CHAVE_INICIO]) sessao[CHAVE_INICIO] = t;
  sessao[CHAVE_ULTIMA] = t;
}

// Limpa as marcas de sessão (usado ao encerrar por inatividade).
function limparMarcas(sessao) {
  if (!sessao) return;
  delete sessao[CHAVE_ULTIMA];
  delete sessao[CHAVE_INICIO];
  delete sessao.condominio_ativo_id;
  delete sessao.pendente2faLogin;
  delete sessao.pendente2faAtivar;
}

// Termina o acesso de suporte associado à sessão (se existir).
//
// É BEST-EFFORT: a expiração absoluta e a revalidação em cada pedido já
// garantem que nada flui por um acesso órfão. Esta chamada existe para o estado
// ficar correto (transparência e auditoria), pelo que uma falha de BD NUNCA
// pode impedir o logout — daí o `catch`.
//
// `origem` distingue PORQUE a sessão acabou (logout, inatividade, conta
// desativada). Não é decorativo: sem isto, os três casos ficariam
// indistinguíveis no histórico de auditoria, e uma sessão que morreu por
// inatividade apareceria como um término deliberado.
async function terminarSuporteDaSessao(req, origem = suporte.ORIGEM.LOGOUT) {
  if (!req || !req.session) return;
  try {
    await suporte.terminarPorSessao(req, origem);
  } catch (err) {
    console.error('[suporte/logout]', err.message);
  }
}

function ePedidoTecnico(req) {
  return req.path === ROTA_ESTADO || req.path === '/sessao/renovar';
}

function eFetch(req) {
  if (req.xhr) return true;
  const aceita = String(req.headers.accept || '');
  return aceita.includes('application/json');
}

// Middleware: encerra a sessão autenticada sem atividade dentro do limite.
function middlewareSessao(req, res, next) {
  if (!req.session) return next();
  const autenticado = typeof req.isAuthenticated === 'function' ? req.isAuthenticated() : false;
  if (!autenticado) return next();
  if (CAMINHO_ESTATICO.test(req.path)) return next();

  const agora = Date.now();

  // Consulta de estado: não renova nem bloqueia (o handler responde).
  if (req.path === ROTA_ESTADO) return next();

  if (expirada(req.session, agora)) {
    return encerrarPorInatividade(req, res);
  }

  marcarAtividade(req.session, agora);
  return next();
}

// Middleware: a conta continua a poder usar a plataforma?
//
// O estado da conta (`ativo`) e a confirmação de email só eram verificados no
// momento do login, pelo que uma sessão já aberta continuava a valer depois de a
// conta ser desativada. Esta verificação corre em cada pedido, para que a
// desativação de uma conta produza efeito imediato — tal como acontece com o
// acesso a um condomínio, que é revalidado em cada pedido por `tenant`.
// Só atua quando o estado é explicitamente negativo; contas sem o campo (dados
// antigos ou objetos de teste incompletos) não são afetadas.
function verificarContaAtiva(req, res, next) {
  const utilizador = req.user;
  if (!req.isAuthenticated || !req.isAuthenticated() || !utilizador) return next();
  const desativada = utilizador.ativo === false || utilizador.ativo === 0;
  const emailPorConfirmar = utilizador.email_confirmado === false;
  if (!desativada && !emailPorConfirmar) return next();

  const encerrar = (cb) => {
    limparMarcas(req.session);
    terminarSuporteDaSessao(req, suporte.ORIGEM.CONTA_DESATIVADA).then(() => {
      if (typeof req.logout === 'function') req.logout(() => cb());
      else cb();
    });
  };
  encerrar(() => {
    if (eFetch(req)) {
      return res.status(401).json({ autenticado: false, contaInativa: true });
    }
    return res.redirect('/login?conta=inativa');
  });
}

// Encerra a sessão (mantém a sessão express para o redirecionamento) e
// devolve a resposta adequada ao tipo de pedido.
function encerrarPorInatividade(req, res) {
  const encerrar = (cb) => {
    limparMarcas(req.session);
    terminarSuporteDaSessao(req, suporte.ORIGEM.INATIVIDADE).then(() => {
      if (typeof req.logout === 'function') {
        req.logout(() => cb());
      } else {
        cb();
      }
    });
  };
  encerrar(() => {
    if (eFetch(req)) {
      return res.status(401).json({ autenticado: false, expirada: true });
    }
    return res.redirect('/login?expirada=1');
  });
}

module.exports = {
  CHAVE_ULTIMA,
  CHAVE_INICIO,
  IDLE_MS,
  AVISO_MS,
  MINUTOS_INATIVIDADE,
  SEGUNDOS_AVISO,
  minutosDeInatividade,
  segundosDeAviso,
  expiraEm,
  expirada,
  marcarAtividade,
  limparMarcas,
  terminarSuporteDaSessao,
  middlewareSessao,
  verificarContaAtiva,
  encerrarPorInatividade,
};
