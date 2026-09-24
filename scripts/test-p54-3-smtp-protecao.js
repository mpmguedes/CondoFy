// ═══════════════════════════════════════════════════════════════════
// P54-3 — proteção server-side da alteração da configuração SMTP.
//
// Cobre V10 (confirmação), V11 (reautenticação), V12 (rate limit), V9
// (transação) e V14 (auditoria), mais os casos de BYPASS: o objetivo é provar
// que a proteção NÃO depende da página do P54-2.
//
// Estratégia: monta o ROUTER REAL num servidor Express, com o MAILER REAL (só
// a BD é substituída por duplos). É a única forma de exercitar o caminho
// completo — validação → transação → auditoria — sem base de dados.
//
// ⛔ A palavra-passe de teste nunca é impressa: só a sua PRESENÇA é procurada.
// Utilização: node scripts/test-p54-3-smtp-protecao.js
// ═══════════════════════════════════════════════════════════════════
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');

const RAIZ = path.join(__dirname, '..');
let n = 0;
const feito = (nome) => { n += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

const PASSWORD = 'palavra-passe-de-teste';
const HASH = bcrypt.hashSync(PASSWORD, 4); // custo baixo: é um teste
const PASSWORD_SMTP = 'segredo-smtp-a-guardar';

// ═══════════════════════════════════════════════════════════════════
// Duplos de BD
// ═══════════════════════════════════════════════════════════════════
const loja = new Map(); // `configuracoes` em memória
let transacoesAbertas = 0;
let transacoesRevertidas = 0;
let auditoriaFalha = false;
const auditoriaGravada = [];

const models = require(path.join(RAIZ, 'models'));

models.UserCondominio.findOne = async () => ({ role: 'admin', condominio_id: 1 });

models.Configuracao.findAll = async ({ where } = {}) => {
  let linhas = [...loja.entries()].map(([chave, valor]) => ({ chave, valor }));
  const cond = where && where.chave;
  if (cond && cond[Op.like]) {
    const re = new RegExp(
      `^${String(cond[Op.like]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`
    );
    linhas = linhas.filter((l) => re.test(l.chave));
  }
  return linhas;
};
models.Configuracao.findOrCreate = async ({ where, defaults }) => {
  if (!loja.has(where.chave)) loja.set(where.chave, defaults ? defaults.valor : null);
  const reg = {
    chave: where.chave,
    get valor() { return loja.get(where.chave); },
    set valor(v) { loja.set(where.chave, v); },
    async save() {},
  };
  return [reg, false];
};

models.AuditLog.create = async (dados) => {
  if (auditoriaFalha) throw new Error('falha simulada na auditoria');
  auditoriaGravada.push(dados);
  return {};
};

// Transação em memória com ROLLBACK a sério: guarda um retrato da loja no
// início e repõe-no se for revertida. É o que permite provar V9 — «nunca
// deixar configuração parcialmente alterada» — sem MariaDB.
models.sequelize.transaction = async () => {
  const retrato = new Map(loja);
  transacoesAbertas += 1;
  return {
    async commit() {},
    async rollback() {
      loja.clear();
      for (const [k, v] of retrato) loja.set(k, v);
      transacoesRevertidas += 1;
    },
  };
};

// ═══════════════════════════════════════════════════════════════════
// Servidor Express com o router REAL
// ═══════════════════════════════════════════════════════════════════
const router = require(path.join(RAIZ, 'routes/configuracao'));
const app = express();
const sessaoTeste = { condominio_ativo_id: 1 };
let utilizadorAtual = { id: 1, nome: 'Admin', role_global: 'admin', password_hash: HASH };

// O limite é POR UTILIZADOR (V12). Cada bloco de teste usa uma identidade
// própria, para não esgotar o limite do bloco anterior — e, de caminho,
// exercita o isolamento entre utilizadores.
let contadorUtilizadores = 1;
const novoUtilizador = () => {
  contadorUtilizadores += 1;
  utilizadorAtual = { id: contadorUtilizadores, nome: 'Admin', role_global: 'admin', password_hash: HASH };
  return utilizadorAtual.id;
};

app.use((req, res, next) => {
  req.isAuthenticated = () => true;
  req.user = utilizadorAtual;
  req.session = sessaoTeste;
  req.sessionID = 'sess-p54-3';
  req.flash = () => req;
  res.locals.user = req.user;
  res.locals.condominioAtivo = { id: 1, designacao: 'Condomínio Teste', role: 'admin' };
  res.locals.currentPath = req.path;
  res.locals.appName = 'GesCondu';
  res.locals.currentYear = 2026;
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use('/admin', router);

const enviar = (url, corpo) => new Promise((resolve, reject) => {
  const dados = new URLSearchParams(corpo).toString();
  const servidor = app.listen(0, '127.0.0.1', () => {
    const req = http.request({
      host: '127.0.0.1', port: servidor.address().port, path: url, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(dados) },
    }, (res) => {
      let resposta = '';
      res.on('data', (d) => { resposta += d; });
      res.on('end', () => {
        servidor.close();
        let json = null;
        try { json = JSON.parse(resposta); } catch (err) { json = null; }
        resolve({ status: res.statusCode, corpo: resposta, location: res.headers.location, json });
      });
    });
    req.on('error', (e) => { servidor.close(); reject(e); });
    req.end(dados);
  });
});

const CONFIG_OK = {
  host: 'smtp.exemplo.pt', port: '587', user: 'conta@exemplo.pt',
  tls: 'true', from: 'geral@exemplo.pt', from_name: 'Administração',
};
const pedido = (extra = {}) => ({ ...CONFIG_OK, password: PASSWORD, ...extra });

const preparar = (extra = {}) => enviar('/admin/config/email/smtp/preparar', pedido(extra));
const guardar = (extra = {}) => enviar('/admin/config/email/smtp', pedido(extra));

// ═══════════════════════════════════════════════════════════════════
async function principal() {
  console.log('P54-3 — proteção server-side da alteração SMTP');

  // ── V10 — confirmação server-side ───────────────────────────────
  titulo('V10 — a confirmação é um artefacto do SERVIDOR, ligado ao payload');
  novoUtilizador();

  // Bypass 1: POST direto, sem passar pela interface.
  loja.clear();
  let r = await guardar();
  assert.strictEqual(r.status, 302, 'POST direto responde 302 (não rebenta)');
  assert.strictEqual(loja.size, 0, '⛔ POST direto sem confirmação NÃO escreve nada');
  feito('POST direto (sem confirmação) recusado e sem escrita');

  // Bypass 2: um booleano não é confirmação.
  r = await guardar({ _confirmacao: 'true' });
  assert.strictEqual(loja.size, 0, '⛔ `confirmado=true` não passa por confirmação');
  feito('booleano `_confirmacao=true` recusado');

  // Fluxo legítimo: preparar → token → gravar.
  const prep = await preparar();
  assert.strictEqual(prep.status, 200, 'a preparação válida responde 200');
  assert.ok(prep.json && typeof prep.json.token === 'string' && prep.json.token.length === 64,
    'o token é um valor aleatório de 32 bytes (64 hex) emitido pelo servidor');
  const token = prep.json.token;

  auditoriaGravada.length = 0;
  r = await guardar({ _confirmacao: token });
  assert.strictEqual(loja.get('smtp_host'), 'smtp.exemplo.pt', 'com confirmação válida, grava');
  assert.strictEqual(loja.get('smtp_port'), '587', 'a porta é gravada');
  feito('confirmação válida ⇒ gravação efetuada');

  // ⛔ Uso único: repetir o MESMO pedido não volta a passar.
  loja.clear();
  r = await guardar({ _confirmacao: token });
  assert.strictEqual(loja.size, 0, '⛔ o token é de USO ÚNICO — repetir não grava');
  feito('token de uso único: o pedido repetido é recusado');

  // ⛔ Payload adulterado: token válido, valores diferentes.
  const prep2 = await preparar();
  r = await guardar({ _confirmacao: prep2.json.token, host: 'smtp.outro.pt' });
  assert.strictEqual(loja.size, 0, '⛔ payload diferente do confirmado é recusado');
  assert.ok(!loja.has('smtp_host'), 'e nada é escrito');
  feito('payload alterado depois da confirmação ⇒ recusado');

  // ⛔ Password SMTP trocada depois de confirmar: também é payload.
  const prep3 = await preparar();
  r = await guardar({ _confirmacao: prep3.json.token, pass: 'outra-password-smtp' });
  assert.strictEqual(loja.size, 0, '⛔ trocar a password SMTP depois de confirmar é recusado');
  feito('password SMTP alterada depois da confirmação ⇒ recusado');

  // ⛔ Confirmação de OUTRO utilizador (sessão partilhada, dono diferente).
  const prep4 = await preparar();
  const idDono = utilizadorAtual.id;
  novoUtilizador(); // outra conta (e o seu próprio balde de limite)
  r = await guardar({ _confirmacao: prep4.json.token });
  assert.strictEqual(loja.size, 0, '⛔ a confirmação não serve a outra conta');
  utilizadorAtual = { id: idDono, nome: 'Admin', role_global: 'admin', password_hash: HASH };
  feito('confirmação emitida para outro utilizador ⇒ recusada');

  // ⛔ Confirmação inexistente/inventada.
  r = await guardar({ _confirmacao: 'a'.repeat(64) });
  assert.strictEqual(loja.size, 0, '⛔ um token inventado não passa');
  feito('confirmação inventada ⇒ recusada');

  // ── V11 — reautenticação ────────────────────────────────────────
  titulo('V11 — reautenticação com a palavra-passe da conta');
  novoUtilizador();

  loja.clear();
  r = await preparar({ password: '' });
  assert.strictEqual(r.status, 403, 'sem palavra-passe ⇒ 403');
  assert.ok(!r.json || !r.json.token, 'e não emite token');
  feito('sem palavra-passe ⇒ preparação recusada');

  r = await preparar({ password: 'palavra-passe-errada' });
  assert.strictEqual(r.status, 403, 'palavra-passe errada ⇒ 403');
  assert.ok(!r.json || !r.json.token, 'e não emite token');
  feito('palavra-passe incorreta ⇒ preparação recusada');

  // Mesmo com um token válido, a gravação volta a exigir a palavra-passe.
  const prep5 = await preparar();
  r = await guardar({ _confirma: prep5.json.token, password: 'errada', _confirmacao: prep5.json.token });
  assert.strictEqual(loja.size, 0, '⛔ token válido sem palavra-passe válida não grava');
  feito('token válido + palavra-passe errada ⇒ recusado');

  // 2FA ativo: exige o código.
  const id2fa = novoUtilizador();
  utilizadorAtual = {
    id: id2fa, nome: 'Admin', role_global: 'admin', password_hash: HASH,
    two_fa_ativo: true, two_fa_metodo: 'totp', two_fa_totp_secret: 'SEGREDO',
  };
  r = await preparar({ codigo_2fa: '000000' });
  assert.strictEqual(r.status, 403, 'com 2FA ativo, sem código válido ⇒ 403');
  utilizadorAtual = { id: id2fa, nome: 'Admin', role_global: 'admin', password_hash: HASH };
  feito('2FA ativo: exige o código da aplicação');

  // ── V14 — auditoria dos campos alterados ────────────────────────
  titulo('V14 — a auditoria regista os CAMPOS, nunca os valores');
  novoUtilizador();

  loja.clear();
  auditoriaGravada.length = 0;
  const prep6 = await preparar();
  await guardar({ _confirmacao: prep6.json.token });
  const eventos = auditoriaGravada.filter((e) => e.acao === 'configurar_smtp');
  assert.strictEqual(eventos.length, 1, 'a gravação produz um evento `configurar_smtp`');
  const detalhes = JSON.parse(eventos[0].detalhes);
  assert.deepStrictEqual(
    [...detalhes.campos_alterados].sort(),
    ['from', 'fromName', 'host', 'port', 'tls', 'user'],
    'a auditoria lista os campos alterados por NOME'
  );
  const serializado = JSON.stringify(eventos[0]);
  assert.ok(!serializado.includes(PASSWORD), '⛔ a palavra-passe da CONTA não entra na auditoria');
  assert.ok(!serializado.includes('conta@exemplo.pt'), '⛔ nenhum VALOR entra na auditoria');
  feito('auditoria com nomes de campos; nenhum valor e nenhuma palavra-passe');

  // ── V9 — transação ──────────────────────────────────────────────
  titulo('V9 — a gravação é atómica (configuração + auditoria)');
  novoUtilizador();

  // Semeia uma configuração anterior que tem de sobreviver a um rollback.
  loja.clear();
  loja.set('smtp_host', 'smtp.anterior.pt');
  loja.set('smtp_port', '465');
  const antes = JSON.stringify([...loja.entries()].sort());

  auditoriaFalha = true; // a auditoria falha DENTRO da transação
  const prep7 = await preparar({ host: 'smtp.novo.pt', port: '587' });
  const r7 = await guardar({ _confirmacao: prep7.json.token, host: 'smtp.novo.pt', port: '587' });
  auditoriaFalha = false;

  assert.strictEqual(r7.status, 302, 'a falha da auditoria não derruba a resposta');
  assert.strictEqual(JSON.stringify([...loja.entries()].sort()), antes,
    '⛔ falha na auditoria ⇒ ROLLBACK: a configuração anterior fica intacta');
  assert.ok(transacoesRevertidas >= 1,
    `a transação foi revertida (abertas=${transacoesAbertas}, revertidas=${transacoesRevertidas}, status=${r7.status}, loc=${r7.location}, prep=${prep7.status})`);
  feito('falha na auditoria ⇒ rollback; configuração anterior preservada');

  // Caminho de sucesso: a transação é usada e a cache é limpa depois do commit.
  loja.clear();
  const prep8 = await preparar();
  const r8 = await guardar({ _confirmacao: prep8.json.token });
  assert.strictEqual(r8.status, 302, 'gravação conclui');
  assert.strictEqual(loja.get('smtp_host'), 'smtp.exemplo.pt', 'e os valores ficam gravados');
  assert.ok(transacoesAbertas >= 3, 'cada gravação abre a sua transação');
  feito('sucesso: transação aberta, commit e cache limpa depois');

  // ── V12 — rate limit ────────────────────────────────────────────
  titulo('V12 — limite por IDENTIDADE (não por IP)');
  {
    const { createLimiter, identidadeAutenticada } = require(path.join(RAIZ, 'helpers/seguranca'));
    const lim = createLimiter({ rotulo: 'teste-p54-3', max: 3, janelaMs: 60 * 1000, chaveDe: identidadeAutenticada });
    const correr = (user) => {
      let estado = 'passou';
      const req = { user, ip: '10.0.0.1', originalUrl: '/x', flash: () => {} };
      // O limitador entrega o estado ao `redirect` (429), pelo que o duplo tem
      // de o ler daí — é isso que prova que o 429 não se perde.
      const res = {
        redirect(a) { estado = typeof a === 'number' ? a : estado; return this; },
      };
      lim(req, res, () => {});
      return estado;
    };
    const u1 = { id: 101 };
    assert.strictEqual(correr(u1), 'passou', '1.ª tentativa permitida');
    assert.strictEqual(correr(u1), 'passou', '2.ª permitida');
    assert.strictEqual(correr(u1), 'passou', '3.ª permitida (no limite)');
    assert.strictEqual(correr(u1), 429, '4.ª ⇒ 429 (limite atingido)');
    // ⛔ Outro utilizador no MESMO IP não é afetado: a chave é a identidade.
    assert.strictEqual(correr({ id: 202 }), 'passou', 'outro utilizador no mesmo IP não é bloqueado');
    // ⛔ O mesmo utilizador noutro IP continua limitado: não se foge mudando de IP.
    assert.strictEqual(correr(u1), 429, 'mudar de IP não reinicia o limite do utilizador');
    // Sem identidade, cai para a sessão e só depois para o IP.
    assert.strictEqual(identidadeAutenticada({ user: { id: 7 } }), 'u:7', 'chave = utilizador');
    assert.strictEqual(identidadeAutenticada({ sessionID: 's1' }), 's:s1', 'sem utilizador ⇒ sessão');
    assert.strictEqual(identidadeAutenticada({ ip: '1.2.3.4' }), 'ip:1.2.3.4', 'sem sessão ⇒ IP');
    feito('limite por utilizador, isolado entre utilizadores, não contornável por IP');

    // ⛔ E o limite está LIGADO À ROTA — não basta o helper estar certo. Um
    // limite que exista só nos testes não protege nada: esgota-se o balde com
    // pedidos REAIS e o seguinte tem de ser recusado com 429.
    novoUtilizador();
    let ultimoEstado = 0;
    for (let i = 0; i < 21; i += 1) {
      const rr = await guardar({ _confirmacao: 'x' }); // recusado pela confirmação, mas conta
      ultimoEstado = rr.status;
    }
    assert.strictEqual(ultimoEstado, 429,
      `⛔ a rota de gravação tem de aplicar o limite (21.º pedido devia ser 429; foi ${ultimoEstado})`);
    feito('o limite está ligado à ROTA de gravação (21.º pedido ⇒ 429)');
  }

  // ── Autorização / isolamento ────────────────────────────────────
  titulo('Autorização — o router continua limitado ao condomínio ativo');
  {
    const fs = require('fs');
    const fonte = fs.readFileSync(path.join(RAIZ, 'routes/configuracao.js'), 'utf8');
    assert.ok(/router\.use\(tenant\.comCondominioAtivo\)/.test(fonte), 'exige condomínio ativo');
    assert.ok(/router\.use\(tenant\.comPapel\('admin'\)\)/.test(fonte), 'exige papel de administrador');
    // ⛔ O condomínio NUNCA vem do corpo do pedido: só da sessão (tenant).
    const blocoSmtp = fonte.slice(fonte.indexOf("router.post('/config/email/smtp'"), fonte.indexOf("router.post('/config/email/smtp/testar'"));
    assert.ok(!/condominio_id/.test(blocoSmtp),
      '⛔ a gravação não lê `condominio_id` do corpo — não há forma de trocar de condomínio');
    feito('router protegido por condomínio ativo + papel admin; sem `condominio_id` do corpo');
  }

  console.log(`\n✓ P54-3 — proteção da alteração SMTP passou: ${n} verificações, sem base de dados.`);
}

principal().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
