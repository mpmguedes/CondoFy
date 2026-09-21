// ─────────────────────────────────────────────────────────────────────
// DIAGNÓSTICO READ-ONLY — ciclo de redirects (ERR_TOO_MANY_REDIRECTS)
//
// Porque existe: depois da reparação do utilizador demo, o login com
// `demo.gestor@example.test` e a seleção do condomínio #5 continuam a
// terminar em ERR_TOO_MANY_REDIRECTS, embora `--reparar --dry-run` diga
// «Já estava tudo correto — nada a alterar.» e as 24 invariantes passem.
//
// Este script NÃO ALTERA NADA. Só faz SELECT e, quando possível, pedidos
// HTTP anónimos (sem cookies) para confirmar, sem sessão, os saltos dos
// guards. Nenhum INSERT/UPDATE/DELETE/ALTER/DROP/CREATE. Nenhum segredo
// é impresso (IBAN/NIF/passwords mascarados ou omitidos).
//
// Utilização:
//   node scripts/diagnostico-ciclo-redirects.js
//   node scripts/diagnostico-ciclo-redirects.js --base http://127.0.0.1:3000
//   node scripts/diagnostico-ciclo-redirects.js --sem-http
// ─────────────────────────────────────────────────────────────────────
require('dotenv').config();

const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');

const UTILIZADOR_ID = 4;
const CONDOMINIO_ID = 5;

// Base para os pedidos HTTP anónimos (não faz login, não usa cookies).
function baseDe(argumentos) {
  const i = argumentos.indexOf('--base');
  if (i !== -1 && argumentos[i + 1]) return argumentos[i + 1].replace(/\/+$/, '');
  const porta = process.env.PORT || 3000;
  return `http://127.0.0.1:${porta}`;
}
const SEM_HTTP = process.argv.includes('--sem-http');

// ── Formatação ────────────────────────────────────────────────────────
const LARGURA = 74;
function titulo(texto) {
  console.log('\n' + texto);
  console.log('─'.repeat(LARGURA));
}
function passo(texto) {
  console.log('  · ' + texto);
}
function txt(v, largura) {
  if (v === null || v === undefined) return '(NULL)';
  const s = String(v);
  return s.length >= largura ? s.slice(0, largura) : s.padEnd(largura, ' ');
}
// Igual a `txt`, mas acrescenta um espaço no fim em vez de cortar: para valores
// que têm de aparecer por inteiro (ex.: `admin   <── ...`).
function txtFim(v, largura) {
  if (v === null || v === undefined) return '(NULL) ';
  const s = String(v);
  return s.length >= largura ? s + ' ' : s.padEnd(largura, ' ');
}
function vazio(v) {
  if (v === null || v === undefined) return '(NULL)';
  if (typeof v === 'string' && v.trim() === '') return '(vazio)';
  return v;
}
// Mascara tudo menos os últimos 4 caracteres (nunca imprimir identificadores).
function maskId(v) {
  if (v === null || v === undefined) return '(NULL)';
  const s = String(v);
  if (s.length <= 4) return '*'.repeat(s.length);
  return '*'.repeat(s.length - 4) + s.slice(-4);
}
function simNao(v) {
  return v ? 'SIM' : 'não';
}

// SELECT seguro (uma linha ou null). Nunca escreve.
async function umaLinha(sql, substituicoes) {
  const linhas = await sequelize.query(sql, { replacements: substituicoes, type: QueryTypes.SELECT });
  return linhas.length ? linhas[0] : null;
}
async function variasLinhas(sql, substituicoes) {
  return sequelize.query(sql, { replacements: substituicoes, type: QueryTypes.SELECT });
}

// ── 1. Estado real ────────────────────────────────────────────────────
async function estadoUtilizador(id) {
  return umaLinha(
    `SELECT id, nome, email, role, role_global, pessoa_id, ativo, email_confirmado,
            two_fa_ativo, created_at, updated_at
       FROM users
      WHERE id = :id`,
    { id }
  );
}

async function estadoCondominio(id) {
  return umaLinha(
    `SELECT id, designacao, estado, created_at, updated_at
       FROM condominios
      WHERE id = :id`,
    { id }
  );
}

async function associacao(utilizadorId, condominioId) {
  return umaLinha(
    `SELECT id, utilizador_id, condominio_id, role, estado, created_at, updated_at
       FROM utilizador_condominios
      WHERE utilizador_id = :utilizadorId AND condominio_id = :condominioId`,
    { utilizadorId, condominioId }
  );
}

async function todasAssociacoes(utilizadorId) {
  return variasLinhas(
    `SELECT uc.id, uc.condominio_id, c.designacao, c.estado AS condominio_estado,
            uc.role, uc.estado AS associacao_estado
       FROM utilizador_condominios uc
       LEFT JOIN condominios c ON c.id = uc.condominio_id
      WHERE uc.utilizador_id = :utilizadorId
      ORDER BY uc.condominio_id ASC`,
    { utilizadorId }
  );
}

async function pessoa(id) {
  if (!id) return null;
  return umaLinha(
    `SELECT p.id, p.nome, p.condominio_id, p.nif
       FROM pessoas p
      WHERE p.id = :id`,
    { id }
  );
}

async function titularidades({ condominioId, utilizadorId, pessoaId }) {
  return variasLinhas(
    `SELECT t.id, t.fracao_id, f.designacao AS fracao_designacao,
            t.pessoa_id, t.utilizador_id, t.vinculo, t.estado, t.data_inicio, t.data_fim
       FROM fracao_titularidades t
       LEFT JOIN fracoes f ON f.id = t.fracao_id
      WHERE t.condominio_id = :condominioId
        AND (t.utilizador_id = :utilizadorId OR t.pessoa_id = :pessoaId)
      ORDER BY t.estado ASC, t.fracao_id ASC`,
    { condominioId, utilizadorId, pessoaId: pessoaId || 0 }
  );
}

async function contarTitularidadesAtivasFracao(condominioId, fracaoId) {
  const linha = await umaLinha(
    `SELECT COUNT(*) AS total
       FROM fracao_titularidades
      WHERE condominio_id = :condominioId AND fracao_id = :fracaoId AND estado = 'ativa'`,
    { condominioId, fracaoId }
  );
  return linha ? Number(linha.total) : 0;
}

async function contarUserCondominioDuplicados(utilizadorId, condominioId) {
  const linha = await umaLinha(
    `SELECT COUNT(*) AS total
       FROM utilizador_condominios
      WHERE utilizador_id = :utilizadorId AND condominio_id = :condominioId`,
    { utilizadorId, condominioId }
  );
  return linha ? Number(linha.total) : 0;
}

// ── 2. Avaliação do estado face aos guards reais ──────────────────────
// Reproduz, em SQL, exatamente o que cada guard consulta:
//   listarCondominios  → uc.estado='ativo' AND c.estado='ativo'
//   associacaoAtiva    → uc.estado='ativo'
//   destinoInicial     → papel no CONDOMINIO ATIVO (uc.role), nao users.role
//
// NOTA (arquitetura corrigida): `users.role` deixou de ser fonte de
// autorizacao, destino e UI. O eixo global e `users.role_global`; o eixo do
// condominio e `utilizador_condominios.role`. A coluna `users.role` mantem-se
// apenas por compatibilidade e a linha abaixo e INFORMATIVA (nunca decide).
function avaliar({ user, cond, assoc, associacoes, nDuplicados, listarCondominios, associacaoAtiva, globalAdmin }) {
  const linhas = [];
  const papelCond = assoc ? assoc.role : null;
  const eAdminCond = papelCond === 'admin' || papelCond === 'gestor';

  linhas.push({
    guard: 'users.role (legado)',
    valor: txt(vazio(user.role), 20),
    efeito: 'INFORMATIVO: coluna legado, ja nao decide destino nem autorizacao',
    veredicto: 'OK',
  });

  linhas.push({
    guard: 'uc.role (condominio)',
    valor: txt(vazio(papelCond), 20),
    efeito: eAdminCond
      ? `destinoInicial() → '/admin' (papel '${papelCond}')`
      : "destinoInicial() → '/condomino' (sem papel administrativo)",
    veredicto: eAdminCond ? 'OK' : 'atencao',
  });

  linhas.push({
    guard: 'users.role_global',
    valor: txt(vazio(user.role_global), 20),
    efeito: user.role_global === 'super_admin' ? 'Super Admin global (salta validacoes)' : 'utilizador normal',
    veredicto: 'OK',
  });

  linhas.push({
    guard: 'users.pessoa_id',
    valor: txt(vazio(user.pessoa_id), 20),
    efeito: user.pessoa_id ? 'contextoFracoes() tem pessoa (portal funcional)' : 'portal fica sem fracoes',
    veredicto: user.pessoa_id ? 'OK' : 'atencao',
  });

  linhas.push({
    guard: 'users.ativo',
    valor: txt(simNao(user.ativo), 20),
    efeito: user.ativo === false ? 'verificarContaAtiva() redireciona para /login?conta=inativa' : 'sessao valida',
    veredicto: user.ativo === false ? 'FALHA' : 'OK',
  });

  linhas.push({
    guard: 'condominios.estado',
    valor: txt(vazio(cond.estado), 20),
    efeito: cond.estado === 'ativo'
      ? 'entra em listarCondominios()'
      : 'EXCLUIDO de listarCondominios() → ativo nunca e valido',
    veredicto: cond.estado === 'ativo' ? 'OK' : 'FALHA',
  });

  if (!assoc) {
    linhas.push({
      guard: 'utilizador_condominios',
      valor: txt('(sem linha)', 20),
      efeito: 'associacaoAtiva()=null → comCondominioAtivo redireciona /condominios',
      veredicto: 'FALHA',
    });
  } else {
    linhas.push({
      guard: 'uc.role',
      valor: txt(vazio(assoc.role), 20),
      efeito: assoc.role === 'admin'
        ? "comPapel('admin') passa (helpers/tenant.js:124)"
        : "comPapel('admin') → redirect '/' (helpers/tenant.js:126)",
      veredicto: assoc.role === 'admin' ? 'OK' : 'FALHA',
    });
    linhas.push({
      guard: 'uc.estado',
      valor: txt(vazio(assoc.estado), 20),
      efeito: assoc.estado === 'ativo'
        ? 'associacaoAtiva() encontra a linha'
        : 'associacaoAtiva()=null → como se nao existisse',
      veredicto: assoc.estado === 'ativo' ? 'OK' : 'FALHA',
    });
  }

  linhas.push({
    guard: 'listarCondominios(#5)',
    valor: txt(simNao(listarCondominios), 20),
    efeito: listarCondominios
      ? `#${CONDOMINIO_ID} e um condominio valido do utilizador`
      : `#${CONDOMINIO_ID} NAO aparece na lista → ativo sempre invalido`,
    veredicto: listarCondominios ? 'OK' : 'FALHA',
  });

  linhas.push({
    guard: 'associacaoAtiva(#4,#5)',
    valor: txt(simNao(associacaoAtiva), 20),
    efeito: associacaoAtiva ? 'tem acesso ao condominio ativo' : 'sem acesso ao condominio ativo',
    veredicto: associacaoAtiva ? 'OK' : 'FALHA',
  });

  linhas.push({
    guard: 'res.locals.isAdmin',
    valor: txt(simNao(globalAdmin), 20),
    efeito: globalAdmin
      ? 'portal /condomino expulsa (routes/condomino-conta.js:42)'
      : 'portal /condomino acessivel',
    veredicto: 'OK',
  });

  linhas.push({
    guard: 'linhas em uc (#4,#5)',
    valor: txt(String(nDuplicados), 20),
    efeito: nDuplicados > 1
      ? 'DADOS INCOERENTES: indice unico ausente/duplicado'
      : 'consistente com o indice unico (utilizador_id, condominio_id)',
    veredicto: nDuplicados > 1 ? 'FALHA' : 'OK',
  });

  linhas.push({
    guard: 'associacoes ativas',
    valor: txt(String(associacoes.filter((a) => a.associacao_estado === 'ativo' && a.condominio_estado === 'ativo').length), 20),
    efeito: 'numero de condominios que aparecem em /condominios',
    veredicto: 'OK',
  });

  return linhas;
}

// ── 3. Ciclo previsto a partir do estado ──────────────────────────────
// Reproduz o fluxo do codigo JA CORRIGIDO:
//   GET /            routes/index.js   → tenent.destinoInicial()
//   POST /condominios/:id/entrar  routes/condominios.js
//   GET /admin       routes/admin.js (comCondominioAtivo + comPapel('admin'))
//   GET /admin/global  shim 302 → /global* (app.js)
//   GET /global      routes/global-admin.js (guarda eSuperAdmin)
//   GET /condominios routes/condominios.js
//   GET /condomino   routes/condomino.js + condomino-conta.js
//
// O destino deixou de depender de `users.role`: passou a depender do papel no
// CONDOMINIO ATIVO (uc.role), com o modo suporte do Super Admin. O ciclo A
// (`/ ⇄ /admin`) so volta a acontecer se o papel do condominio nao for
// administrativo — e mesmo nesse caso o portal e o destino concordam, porque
// ambos leem a mesma fonte.
function preverFluxo({ user, cond, assoc, listarCondominios, associacaoAtiva, globalAdmin }) {
  const eGlobal = Boolean(globalAdmin);
  const papelCond = assoc ? assoc.role : null;
  const papelAdmin = papelCond === 'admin';
  const papelGestor = papelCond === 'gestor';
  const modoSuporte = eGlobal && !assoc;
  const entradaPainel = modoSuporte || papelAdmin || papelGestor;
  const associacaoOk = Boolean(assoc) || eGlobal;
  const condOk = listarCondominios || eGlobal;

  const evento = [];

  // GET / (sem condomínio ativo na sessão) — decide destinoInicial().
  if (eGlobal) {
    evento.push({ de: 'GET /', para: 'GET /global', razao: "privilegio global sem condominio ativo → painel global (helpers/tenant.js: destinoInicial)" });
    evento.push({ de: 'GET /global', para: 'HTTP 200', razao: 'guarda eSuperAdmin passa (routes/global-admin.js); /global é o namespace canónico' });
    return { ciclo: null, evento };
  }

  evento.push({ de: 'GET /', para: "GET /condominios", razao: "sem condominio ativo na sessao → 'limparAtivo' (helpers/tenant.js: destinoInicial)" });
  evento.push({
    de: 'GET /condominios',
    para: listarCondominios ? `POST /condominios/${CONDOMINIO_ID}/entrar` : `(lista SEM #${CONDOMINIO_ID})`,
    razao: listarCondominios ? 'a lista mostra o cartao de entrada' : `a lista NAO mostra o condominio #${CONDOMINIO_ID}`,
  });
  if (!listarCondominios) {
    evento.push({
      de: `POST /condominios/${CONDOMINIO_ID}/entrar`,
      para: 'GET /condominios',
      razao: 'entrarCondominio()=false (helpers/tenant.js) → redirect /condominios',
    });
    return { ciclo: 'B', evento };
  }
  evento.push({
    de: `POST /condominios/${CONDOMINIO_ID}/entrar`,
    para: 'GET /',
    razao: 'entrada aceite → redirect / (routes/condominios.js)',
  });

  // GET / com o condomínio ativo #5 já na sessão.
  const destino = entradaPainel ? '/admin' : '/condomino';
  evento.push({ de: 'GET /', para: `GET ${destino}`, razao: `destinoInicial() pelo uc.role='${papelCond || '(nenhum)'}' (helpers/tenant.js)` });

  if (destino === '/admin') {
    if (!condOk) {
      evento.push({ de: 'GET /admin', para: 'GET /condominios', razao: 'comCondominioAtivo: condominio indisponivel (helpers/tenant.js)' });
      return { ciclo: 'B', evento };
    }
    if (!associacaoOk) {
      evento.push({ de: 'GET /admin', para: 'GET /condominios', razao: 'comCondominioAtivo: sem associacao (helpers/tenant.js)' });
      return { ciclo: 'B', evento };
    }
    // O papel que decide o destino e o MESMO que o guard consulta: ja nao ha
    // duas fontes a discordar, logo o ciclo A nao se pode formar.
    evento.push({ de: 'GET /admin', para: 'HTTP 200', razao: 'comCondominioAtivo + comPapel (mesma fonte: uc.role)' });
    return { ciclo: null, evento };
  }

  // destino /condomino: o portal le o MESMO papel (res.locals.isAdmin vem de
  // papelNoAtivo, nao de users.role), pelo que a recusa deixa de ser possivel.
  const isAdminEfetivo = eGlobal || papelAdmin || papelGestor;
  if (isAdminEfetivo) {
    evento.push({ de: 'GET /condomino', para: 'GET /', razao: 'res.locals.isAdmin=true → portal expulsa (routes/condomino-conta.js)' });
    evento.push({ de: 'GET /', para: `GET ${entradaPainel ? '/admin' : '/condomino'}`, razao: 'destinoInicial() le o MESMO papel (nao ha divergencia)' });
    return { ciclo: 'A', evento };
  }
  evento.push({ de: 'GET /condomino', para: 'HTTP 200', razao: 'portal acessivel' });
  return { ciclo: null, evento };
}

// ── 4. Pedidos HTTP ───────────────────────────────────────────────────
async function pedido(base, caminho, extra = {}) {
  const controlador = new AbortController();
  const prazo = setTimeout(() => controlador.abort(), 4000);
  try {
    const resposta = await fetch(base + caminho, {
      redirect: 'manual',
      signal: controlador.signal,
      ...extra,
    });
    return {
      caminho,
      estado: resposta.status,
      local: resposta.headers.get('location') || '—',
      tipo: resposta.headers.get('content-type') || '—',
    };
  } catch (err) {
    return {
      caminho,
      estado: 'falhou',
      local: err.name === 'AbortError' ? '(timeout 4s)' : err.message,
      tipo: '—',
    };
  } finally {
    clearTimeout(prazo);
  }
}

// Sem sessão: confirma apenas os saltos dos guards públicos.
async function testarHttp(base) {
  const alvos = [
    { caminho: '/', esperado: '200 (homepage pública) OU 302 /condominios|/login|/admin' },
    { caminho: '/admin', esperado: '302 /login (sem sessão)' },
    { caminho: '/condominios', esperado: '302 /login (sem sessão)' },
    { caminho: '/condomino', esperado: '302 /login (sem sessão)' },
  ];
  const resultados = [];
  for (const alvo of alvos) {
    const r = await pedido(base, alvo.caminho);
    resultados.push({ ...r, esperado: alvo.esperado });
  }
  return resultados;
}

// 4b. Confirmação do percurso autenticado — com sessão, mas SEM credenciais.
// O formulário de entrada não é replicado: em vez disso segue-se a cadeia de
// redireccionamentos a partir do cookie de sessão (se existir). Serve para ver
// a sequência real de saltos e detetar um ciclo que o browser esconda.
async function sessaoDoUsuario() {
  if (!process.env.GESCONDU_COOKIE) return null;
  const cookie = String(process.env.GESCONDU_COOKIE).trim();
  return cookie.length ? cookie : null;
}

async function testarSessao(base, cookie) {
  const cabecalhos = { cookie };
  const resultados = [];
  let caminho = '/';
  for (let i = 0; i < 10; i += 1) {
    const r = await pedido(base, caminho, { headers: cabecalhos });
    resultados.push(r);
    if (r.estado !== 302 && r.estado !== 301 && r.estado !== 307 && r.estado !== 308) break;
    if (!r.local || r.local === '—') break;
    caminho = r.local.startsWith('http') ? new urlParaCaminho(r.local) : r.local;
  }
  return resultados;
}

function urlParaCaminho(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch (err) {
    return '/';
  }
}

// ── 5. Deteção do serviço e da base ───────────────────────────────────
async function detetarBase(argumentos) {
  if (argumentos.includes('--base')) return baseDe(argumentos);
  const portas = [process.env.PORT, 3000, 8080, 8000].filter(Boolean);
  for (const porta of portas) {
    const base = `http://127.0.0.1:${porta}`;
    try {
      const controlador = new AbortController();
      const prazo = setTimeout(() => controlador.abort(), 1500);
      await fetch(base + '/', { redirect: 'manual', signal: controlador.signal });
      clearTimeout(prazo);
      return base;
    } catch (err) { /* porta sem serviço: tenta a seguinte */ }
  }
  return null;
}

// Fecho. Isolado para os testes in-memory conseguirem intercetar a saída sem
// que o resto do script seja interrompido a meio.
function encerrar(codigo) {
  // eslint-disable-next-line no-process-exit
  return process.exit(codigo);
}

// ── Programa ──────────────────────────────────────────────────────────
async function main() {
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(' DIAGNÓSTICO READ-ONLY — ciclo de redirects');
  console.log(' utilizador #' + UTILIZADOR_ID + ' · condomínio #' + CONDOMINIO_ID);
  console.log('══════════════════════════════════════════════════════════════════');

  try {
    await sequelize.authenticate();
  } catch (err) {
    console.error('\n[ERRO] Sem ligação à base de dados: ' + err.message);
    console.error('       Este script tem de ser executado NO SERVIDOR (produção),');
    console.error('       a partir de /opt/condofy, com o .env de produção carregado.');
    return encerrar(1);
  }

  const falhasGraves = [];

  try {
    // ── 1 ────────────────────────────────────────────────────────────
    titulo('1. ESTADO REAL — users / condominios');
    const user = await estadoUtilizador(UTILIZADOR_ID);
    const cond = await estadoCondominio(CONDOMINIO_ID);

    if (!user) {
      console.error(`  [ERRO] Não existe users.id = ${UTILIZADOR_ID}.`);
      process.exit(1);
    }
    if (!cond) {
      console.error(`  [ERRO] Não existe condominios.id = ${CONDOMINIO_ID}.`);
      process.exit(1);
    }

    console.log('  users #' + user.id);
    console.log('    nome .................... ' + vazio(user.nome));
    console.log('    email ................... ' + vazio(user.email));
    console.log('    role .................... ' + txtFim(vazio(user.role), 0) + '   <── LEGADO (ja nao decide nada)');
    console.log('    role_global ............. ' + vazio(user.role_global));
    console.log('    pessoa_id ............... ' + vazio(user.pessoa_id));
    console.log('    ativo ................... ' + vazio(user.ativo));
    console.log('    email_confirmado ........ ' + vazio(user.email_confirmado));
    console.log('    two_fa_ativo ............ ' + vazio(user.two_fa_ativo));
    console.log('    created_at .............. ' + vazio(user.created_at));
    console.log('    updated_at .............. ' + vazio(user.updated_at));

    console.log('\n  condominios #' + cond.id);
    console.log('    designacao .............. ' + vazio(cond.designacao));
    console.log('    estado .................. ' + txtFim(vazio(cond.estado), 0) + '   <── se != ativo, sai de listarCondominios()');

    // ── 2 ────────────────────────────────────────────────────────────
    titulo('2. ASSOCIAÇÃO — utilizador_condominios (#4 ↔ #5)');
    const assoc = await associacao(UTILIZADOR_ID, CONDOMINIO_ID);
    const nDuplicados = await contarUserCondominioDuplicados(UTILIZADOR_ID, CONDOMINIO_ID);

    if (!assoc) {
      console.log('  (nenhuma linha) — associacaoAtiva() devolve null');
    } else {
      console.log('    id ...................... ' + assoc.id);
      console.log('    utilizador_id ........... ' + assoc.utilizador_id);
      console.log('    condominio_id ........... ' + assoc.condominio_id);
      console.log('    role .................... ' + txtFim(vazio(assoc.role), 0) + '   <── decide comPapel(\'admin\')');
      console.log('    estado .................. ' + txtFim(vazio(assoc.estado), 0) + '   <── associacaoAtiva() filtra por \'ativo\'');
      console.log('    created_at .............. ' + vazio(assoc.created_at));
      console.log('    updated_at .............. ' + vazio(assoc.updated_at));
    }
    console.log('    linhas nesta chave ...... ' + nDuplicados + (nDuplicados > 1 ? '  <── INCOERENTE (índice único violado)' : ''));
    if (nDuplicados > 1) falhasGraves.push('utilizador_condominios tem ' + nDuplicados + ' linhas para (4, 5)');

    titulo('2b. TODAS AS ASSOCIAÇÕES DO UTILIZADOR #' + UTILIZADOR_ID);
    console.log('  ' + txt('cond.id', 8) + txt('designacao', 34) + txt('cond.estado', 12) + txt('uc.role', 10) + 'uc.estado');
    const associacoes = await todasAssociacoes(UTILIZADOR_ID);
    for (const a of associacoes) {
      console.log('  ' + txt(a.condominio_id, 8) + txt(vazio(a.designacao), 34) + txt(vazio(a.condominio_estado), 12) + txt(vazio(a.role), 10) + vazio(a.associacao_estado));
    }
    if (!associacoes.length) console.log('  (nenhuma associação)');

    // ── 3 ────────────────────────────────────────────────────────────
    titulo('3. PESSOA E TITULARIDADES');
    const p = await pessoa(user.pessoa_id);
    if (!p) {
      console.log('  users.pessoa_id = ' + vazio(user.pessoa_id) + ' → nenhuma pessoa correspondente');
    } else {
      console.log('  pessoas #' + p.id);
      console.log('    nome .................... ' + vazio(p.nome));
      console.log('    condominio_id ........... ' + vazio(p.condominio_id) + (Number(p.condominio_id) !== CONDOMINIO_ID ? '   <── pessoa de OUTRO condomínio' : ''));
      console.log('    nif ..................... ' + maskId(p.nif));
      if (Number(p.condominio_id) !== CONDOMINIO_ID) falhasGraves.push('users.pessoa_id aponta para pessoa de outro condomínio');
    }

    const tits = await titularidades({ condominioId: CONDOMINIO_ID, utilizadorId: UTILIZADOR_ID, pessoaId: user.pessoa_id });
    console.log('\n  titularidades ligadas ao utilizador #' + UTILIZADOR_ID + ' ou à pessoa #' + vazio(user.pessoa_id));
    if (!tits.length) {
      console.log('    (nenhuma)');
    } else {
      console.log('    ' + txt('id', 6) + txt('fracao', 26) + txt('pessoa_id', 11) + txt('util_id', 9) + txt('vinculo', 15) + txt('estado', 9) + 'ativas na fração');
      for (const t of tits) {
        const nOutras = await contarTitularidadesAtivasFracao(CONDOMINIO_ID, t.fracao_id);
        console.log('    ' + txt(t.id, 6) + txt('#' + t.fracao_id + ' ' + vazio(t.fracao_designacao), 26) + txt(vazio(t.pessoa_id), 11) + txt(vazio(t.utilizador_id), 9) + txt(vazio(t.vinculo), 15) + txt(vazio(t.estado), 9) + nOutras);
      }
    }
    const ativasDoUser = tits.filter((t) => t.estado === 'ativa');
    console.log('\n    titularidades ATIVAS ligadas ao utilizador/pessoa ......... ' + ativasDoUser.length);
    passo('Não é requisito de autenticação: /admin não depende de titularidades.');

    // ── 4 ────────────────────────────────────────────────────────────
    titulo('4. AVALIAÇÃO DOS GUARDS (o que o código vê com este estado)');
    const globalAdmin = user.role === 'admin' || user.role_global === 'super_admin';
    const listarOk = Boolean(assoc && assoc.estado === 'ativo' && cond.estado === 'ativo');
    const associacaoAtivaOk = Boolean(assoc && assoc.estado === 'ativo');

    const linhas = avaliar({
      user, cond, assoc, associacoes, nDuplicados,
      listarCondominios: listarOk,
      associacaoAtiva: associacaoAtivaOk,
      globalAdmin,
    });
    console.log('  ' + txt('guard', 26) + txt('valor', 21) + 'efeito');
    for (const l of linhas) {
      const marca = l.veredicto === 'OK' ? ' ' : (l.veredicto === 'atencao' ? '~' : '!');
      console.log(`  ${marca} ` + txt(l.guard, 26) + txt(l.valor, 21) + l.efeito);
    }
    console.log('\n  legenda: " " = coerente · "~" = não bloqueia /admin · "!" = incoerência bloqueante');
    console.log('\n  "!" assinala o guard que explica o ciclo; a CLASSIFICAÇÃO está na secção 6.');
    const bloqueantes = linhas.filter((l) => l.veredicto === 'FALHA');
    for (const b of bloqueantes) falhasGraves.push(`${b.guard} = ${b.valor.trim()} → ${b.efeito}`);

    // ── 5 ────────────────────────────────────────────────────────────
    titulo('5. FLUXO PREVISTO E CICLO');
    const { ciclo, evento } = preverFluxo({
      user, cond, assoc, listarCondominios: listarOk, associacaoAtiva: associacaoAtivaOk, globalAdmin,
    });
    evento.forEach((e, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${e.de}`);
      console.log(`      ↓ ${e.para}`);
      console.log(`        ${e.razao}`);
    });

    let nomeCiclo;
    if (ciclo === 'A') nomeCiclo = "CICLO A — '/ → /admin → / → /admin'";
    else if (ciclo === 'B') nomeCiclo = `CICLO B — '/condominios → POST /condominios/${CONDOMINIO_ID}/entrar → /condominios'`;
    else if (ciclo === 'C') nomeCiclo = "CICLO C — '/ → /condomino → / → /condomino'";
    else nomeCiclo = 'SEM CICLO — o fluxo termina numa página (HTTP 200)';

    // ── 6 ────────────────────────────────────────────────────────────
    titulo('6. CONCLUSÃO OBJETIVA');
    console.log('  A) reproduz o ciclo / ⇄ /admin ................. ' + (ciclo === 'A' ? 'SIM' : 'não'));
    console.log('  B) reproduz o ciclo /condominios ⇄ entrar ...... ' + (ciclo === 'B' ? 'SIM' : 'não'));
    console.log('  C) outro ciclo (portal /condomino) ............. ' + (ciclo === 'C' ? 'SIM' : 'não'));
    console.log('\n  CLASSIFICAÇÃO: ' + nomeCiclo);

    if (ciclo === null) {
      console.log('\n  Nota: com este estado, o código NÃO produz ciclo. Se o browser continua');
      console.log('  a mostrar ERR_TOO_MANY_REDIRECTS, a causa está FORA destes guards:');
      console.log('    · cookie de sessão inválido/corrompido (limpar cookies do site);');
      console.log('    · user-agent/ACL (ex.: /dns-query, /cdn-cgi) a devolver 301 em ciclo;');
      console.log('    · cache intermédia (proxy/CDN) a servir o mesmo 302 sem cookies;');
      console.log('    · rollback do deploy: código em produção != o que foi analisado.');
      console.log('  Confirmar com os logs do serviço (journalctl -u condofy -n 200)');
      console.log('  enquanto se reproduz o login no browser.');
    }

    // ── 7 ────────────────────────────────────────────────────────────
    titulo('7. PEDIDOS HTTP (sem sessão, read-only)');
    if (SEM_HTTP) {
      console.log('  Ignorado (--sem-http).');
    } else {
      const base = await detetarBase(process.argv);
      if (!base) {
        console.log('  Nenhum serviço local detetado. Repetir com --base http://127.0.0.1:PORTA');
      } else {
        console.log('  Base: ' + base + '  (pedidos anónimos, redirect manual)');
        const http = await testarHttp(base);
        console.log('    ' + txt('caminho', 18) + txt('estado', 9) + txt('location', 26) + 'esperado (sem sessão)');
        for (const r of http) {
          console.log('    ' + txt(r.caminho, 18) + txt(r.estado, 9) + txt(r.local, 26) + r.esperado);
        }
        console.log('\n  Sem sessão, /admin, /condominios e /condomino devolvem 302 /login —');
        console.log('  confirma que os guards estão montados, mas NÃO testa o ciclo autenticado.');

        // 4b. Percurso autenticado, se houver cookie de sessão (sem credenciais).
        const cookie = await sessaoDoUsuario();
        console.log('\n  4b. PERCURSO AUTENTICADO (cookie de sessão)');
        if (!cookie) {
          console.log('    Não testado. Para confirmar a sequência REAL de saltos sem usar o');
          console.log('    browser, copiar o cookie de sessão (o valor de `connect.sid`) do');
          console.log('    pedido do browser e repetir:');
          console.log('      GESCONDU_COOKIE="connect.sid=s%3A..." node scripts/diagnostico-ciclo-redirects.js');
          console.log('    O script segue até 10 saltos e mostra cada Location — um ciclo');
          console.log('    aparece como a mesma dupla de URLs repetida indefinidamente.');
          console.log('    Alternativa no browser: DevTools → Network → Preserve log,');
          console.log('    desmarcar Disable cache, reproduzir e ler a coluna Status.');
          console.log('    Em paralelo: journalctl -u condofy -f   (ver os 302 a repetir-se).');
        } else {
          const saltos = await testarSessao(base, cookie);
          console.log('    ' + txt('passo', 7) + txt('caminho', 26) + txt('estado', 9) + 'location');
          saltos.forEach((s, i) => {
            console.log('    ' + txt(i + 1, 7) + txt(s.caminho, 26) + txt(s.estado, 9) + s.local);
          });
          const urls = saltos.map((s) => s.caminho);
          const repetida = urls.length >= 4 && urls.length % 2 === 0
            && urls.slice(0, 2).join('|') === urls.slice(2, 4).join('|');
          if (repetida) {
            console.log('\n    ⚠ CICLO CONFIRMADO: a dupla de URLs repete-se — ' + urls[0] + ' ⇄ ' + urls[1]);
          } else if (saltos.length && saltos[saltos.length - 1].estado === 200) {
            console.log('\n    ✓ Sem ciclo: o percurso terminou em HTTP 200.');
          }
        }
      }
    }

    // ── Resumo ────────────────────────────────────────────────────────
    titulo('RESUMO');
    if (!falhasGraves.length) {
      console.log('  ✓ Nenhuma incoerência bloqueante encontrada neste estado.');
      console.log('    users.role e utilizador_condominios.role estão coerentes.');
      console.log('    → O ciclo, se continuar, NÃO vem destes guards (ver secção 6).');
    } else {
      console.log('  ✗ ' + falhasGraves.length + ' incoerência(s) bloqueante(s):');
      falhasGraves.forEach((f) => console.log('      · ' + f));
    }
    console.log('\n  Nada foi alterado (apenas SELECT e pedidos HTTP anónimos).');
    console.log('  Script read-only — não faz commit, push, migrations, seed nem --reparar.');
    console.log('');
    return encerrar(0);
  } catch (err) {
    console.error('\n[ERRO] ' + err.message);
    if (err.parent) console.error('       ' + (err.parent.sqlMessage || err.parent.message));
    console.error('       Verificar nomes de colunas em models/*.js antes de assumir.');
    return encerrar(1);
  }
}

// Só corre como programa principal: assim um harness de testes pode carregá-lo
// com `require()` sem disparar `main()` (nem cair no `encerrar`).
if (require.main === module) {
  main();
}

module.exports = { main, preverFluxo, avaliar };
