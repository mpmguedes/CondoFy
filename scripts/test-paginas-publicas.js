// ═══════════════════════════════════════════════════════════════════
// Páginas legais públicas — Política de Privacidade e Termos de Utilização
//
// Monta o router real (routes/publicas.js) num servidor Express com o mesmo
// motor de vistas do app.js (layouts + partials + helpers) e SEM qualquer
// autenticação: é assim que se prova que as páginas são públicas.
//
// Verifica:
//  · GET /politica-privacidade e GET /termos respondem 200 sem sessão;
//  · não redirecionam para o login nem exigem condomínio ativo;
//  · o conteúdo essencial é servido no HTML (não depende de JavaScript);
//  · o título, o layout público e o rodapé são os da aplicação;
//  · as ligações internas apontam para rotas existentes (sem links quebrados);
//  · a identificação/contacto vêm da configuração: com variáveis LEGAL_*
//    definidas desaparecem os marcadores «[CONFIGURAR …]».
// Utilização: node scripts/test-paginas-publicas.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { engine } = require('express-handlebars');

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const router = require('../routes/publicas');

// ── App de teste: mesmo motor de vistas do app.js, sem autenticação ──
const app = express();
app.engine('handlebars', engine({
  defaultLayout: 'main',
  helpers: require('../helpers/handlebars-helpers'),
  layoutsDir: path.join(RAIZ, 'views', 'layouts'),
  partialsDir: path.join(RAIZ, 'views', 'partials'),
  runtimeOptions: { allowProtoPropertiesByDefault: true, allowProtoMethodsByDefault: true },
}));
app.set('view engine', 'handlebars');
app.set('views', path.join(RAIZ, 'views'));

// Visitante ANÓNIMO: nenhum req.user, nenhuma sessão, nenhum condomínio.
app.use((req, res, next) => {
  req.isAuthenticated = () => false;
  req.user = null;
  req.flash = () => req;
  res.locals.user = null;
  res.locals.isAdmin = false;
  res.locals.meusCondominios = [];
  res.locals.condominioAtivo = null;
  res.locals.condominio = null;
  res.locals.currentPath = req.path;
  res.locals.appName = 'GesCondu';
  res.locals.currentYear = new Date().getFullYear();
  res.locals.sessaoAvisoMs = 120000;
  res.locals.sessaoIdleMs = 7200000;
  next();
});
app.use('/', router);

const pedir = (url) => new Promise((resolve, reject) => {
  const servidor = app.listen(0, '127.0.0.1', () => {
    http.get({ host: '127.0.0.1', port: servidor.address().port, path: url }, (res) => {
      let corpo = '';
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => {
        servidor.close();
        resolve({ status: res.statusCode, corpo, cabecalhos: res.headers });
      });
    }).on('error', (e) => { servidor.close(); reject(e); });
  });
});

// Ligações internas declaradas nas páginas (só estas são permitidas).
// Ficam de fora os recursos estáticos (folhas de estilo, scripts, imagens),
// que são ficheiros e não rotas.
const LIGACOES_PERMITIDAS = new Set(['/', '/politica-privacidade', '/termos', '/login']);
const RECURSO_ESTATICO = /^\/(css|js|img)\/|\.(css|js|png|jpe?g|svg|webp|ico|woff2?)(\?|$)/i;

function ligacoesInternas(html) {
  return [...html.matchAll(/href="(\/[^"#]*)"/g)]
    .map((m) => m[1])
    .filter((h) => !RECURSO_ESTATICO.test(h));
}

async function main() {
  // ── 1. Política de Privacidade ─────────────────────────────────────
  let r = await pedir('/politica-privacidade');
  assert.strictEqual(r.status, 200, 'GET /politica-privacidade responde 200 sem sessão');
  assert.strictEqual(r.cabecalhos.location, undefined, 'não redireciona (sem Location)');
  assert.ok(
    r.corpo.includes('<title>Política de Privacidade · GesCondu</title>'),
    'título da página correto'
  );
  assert.ok(r.corpo.includes('class="auth-page pagina-legal"'), 'usa a casca pública das páginas legais');
  // Os controlos de aparência (tema e tamanho do texto) existem apenas depois
  // de iniciar sessão: nas páginas públicas não aparecem.
  assert.ok(!r.corpo.includes('data-tema-toggle') && !r.corpo.includes('data-fonte-opcao'), 'páginas públicas sem controlos de aparência');

  // Conteúdo essencial servido no HTML (sem depender de JavaScript).
  const conteudoPolitica = [
    ['identificação da aplicação', 'GesCondu'],
    ['domínio apresentado a partir do pedido', '127.0.0.1'],
    ['responsável pelo tratamento', 'Responsável pelo tratamento'],
    ['categorias de dados', 'Dados pessoais tratados'],
    ['contas e autenticação', 'Contas, autenticação e segurança de acesso'],
    ['integração Google Drive', 'Integração com o Google Drive'],
    ['permissão concreta do Drive', 'https://www.googleapis.com/auth/drive.file'],
    ['utilização limitada (Google)', 'api-services-user-data-policy'],
    ['revogação do acesso Google', 'myaccount.google.com/permissions'],
    ['outras integrações', 'Outras integrações de armazenamento'],
    ['finalidades', 'Finalidades do tratamento'],
    ['fundamentos de licitude', 'Fundamentos de licitude'],
    ['partilha e prestadores', 'Partilha de dados e prestadores de serviços'],
    ['transferências internacionais', 'fora do Espaço Económico Europeu'],
    ['conservação', 'Prazo de conservação'],
    ['retenção dos backups', 'cópias diárias 30 dias'],
    ['segurança', 'Segurança da informação'],
    ['direitos RGPD', 'Direitos dos titulares dos dados'],
    ['autoridade de controlo', 'Comissão Nacional de Proteção de Dados'],
    ['cookies e armazenamento local', 'Cookies e armazenamento local do navegador'],
    ['preferência de tema', 'gescondu-tema'],
    ['preferência de tamanho de texto', 'gescondu-fonte'],
    ['sem publicidade', 'Não são utilizados cookies de'],
    ['serviços externos', 'Serviços externos e respetivas políticas'],
    ['alterações', 'Alterações a esta política'],
    ['contacto', 'Contacto'],
  ];
  for (const [nome, marca] of conteudoPolitica) {
    assert.ok(r.corpo.includes(marca), `política: secção/afirmação presente — ${nome}`);
  }
  assert.ok(!/<script>[\s\S]{0,80}document\.write/.test(r.corpo), 'política: conteúdo servido no HTML, sem document.write');
  assert.strictEqual(ligacoesInternas(r.corpo).filter((h) => !LIGACOES_PERMITIDAS.has(h)).length, 0, 'política: sem ligações internas quebradas');

  // Elementos de configuração em falta: marcados, nunca inventados.
  assert.ok(r.corpo.includes('Elementos por configurar'), 'política: avisa dos elementos por configurar');
  assert.ok(r.corpo.includes('[CONFIGURAR EMAIL DE CONTACTO]'), 'política: marcador do email de contacto');
  assert.ok(r.corpo.includes('[CONFIGURAR IDENTIFICAÇÃO DO RESPONSÁVEL PELO TRATAMENTO]'), 'política: marcador do responsável');
  assert.ok(r.corpo.includes('LEGAL_EMAIL'), 'política: indica a variável a definir');
  assert.ok(!/NIF\s+\d/.test(r.corpo), 'política: nenhum NIF inventado');

  // ── 2. Termos de Utilização ────────────────────────────────────────
  let t = await pedir('/termos');
  assert.strictEqual(t.status, 200, 'GET /termos responde 200 sem sessão');
  assert.strictEqual(t.cabecalhos.location, undefined, 'termos: não redireciona (sem Location)');
  assert.ok(t.corpo.includes('<title>Termos de Utilização · GesCondu</title>'), 'termos: título correto');
  assert.ok(t.corpo.includes('class="auth-page pagina-legal"'), 'termos: mantém a casca das páginas legais');
  const conteudoTermos = [
    ['objeto', 'Objeto'],
    ['aceitação', 'Aceitação e âmbito'],
    ['utilização da plataforma', 'Utilização da plataforma'],
    ['contas e acesso', 'Contas e acesso'],
    ['dados e conteúdos', 'Dados e conteúdos'],
    ['documentos', 'Documentos'],
    ['integrações externas', 'Integrações externas'],
    ['disponibilidade', 'Disponibilidade e manutenção'],
    ['utilização indevida', 'Utilização indevida'],
    ['malware', 'malware'],
    ['propriedade intelectual', 'Propriedade intelectual'],
    ['responsabilidade', 'Responsabilidade'],
    ['alterações', 'Alterações aos termos'],
    ['lei aplicável', 'Lei aplicável e resolução de litígios'],
    ['contacto', 'Contacto'],
  ];
  for (const [nome, marca] of conteudoTermos) {
    assert.ok(t.corpo.includes(marca), `termos: secção presente — ${nome}`);
  }
  assert.ok(/exclui ou limita responsabilidades/.test(t.corpo), 'termos: cláusula de responsabilidade equilibrada');
  assert.ok(/direitos do utilizador enquanto\s+consumidor/.test(t.corpo), 'termos: salvaguarda os direitos do consumidor');
  assert.strictEqual(ligacoesInternas(t.corpo).filter((h) => !LIGACOES_PERMITIDAS.has(h)).length, 0, 'termos: sem ligações internas quebradas');

  // ── 3. Rodapé público com as duas ligações ─────────────────────────
  for (const [nome, html] of [['política', r.corpo], ['termos', t.corpo]]) {
    const rodape = html.slice(html.indexOf('class="auth-foot'));
    assert.ok(rodape.includes('href="/politica-privacidade"'), `${nome}: rodapé liga à Política de Privacidade`);
    assert.ok(rodape.includes('href="/termos"'), `${nome}: rodapé liga aos Termos de Utilização`);
    assert.ok(rodape.includes('© 2026 GesCondu'), `${nome}: rodapé mantém a nota de copyright`);
    assert.ok(html.includes('Voltar ao GesCondu'), `${nome}: ligação de regresso à aplicação`);
  }
  // As outras páginas públicas (entrada e escolha de condomínio) têm as mesmas ligações.
  for (const ficheiro of ['views/auth/login.handlebars', 'views/condominios/meus.handlebars']) {
    const src = ler(ficheiro);
    assert.ok(src.includes('<footer class="auth-foot">'), `${ficheiro}: rodapé público mantido`);
    assert.ok(
      src.includes('· <a href="/politica-privacidade">Política de Privacidade</a> · <a href="/termos">Termos de Utilização</a>'),
      `${ficheiro}: rodapé com as ligações legais`
    );
  }

  // ── 4. Sem autenticação no router (defesa contra regressões) ───────
  const fonte = ler('routes/publicas.js');
  const proibidos = [
    "require('../helpers/tenant')",
    "require('../helpers/eAdmin')",
    'isAuthenticated',
    'passport',
    'router.use(',
  ];
  for (const proibido of proibidos) {
    assert.ok(!fonte.includes(proibido), `routes/publicas.js sem autenticação, sessão ou condomínio ativo (${proibido})`);
  }
  assert.ok(/router\.get\('\/politica-privacidade'/.test(fonte), 'rota /politica-privacidade registada');
  assert.ok(/router\.get\('\/termos'/.test(fonte), 'rota /termos registada');
  assert.ok(ler('app.js').includes("app.use('/', require('./routes/publicas'));"), 'router montado no app.js');

  // ── 5. Identificação vinda da configuração ─────────────────────────
  const antes = {
    LEGAL_ENTIDADE: process.env.LEGAL_ENTIDADE,
    LEGAL_NIF: process.env.LEGAL_NIF,
    LEGAL_MORADA: process.env.LEGAL_MORADA,
    LEGAL_EMAIL: process.env.LEGAL_EMAIL,
    LEGAL_TELEFONE: process.env.LEGAL_TELEFONE,
  };
  try {
    process.env.LEGAL_ENTIDADE = 'Entidade de Teste, Lda.';
    process.env.LEGAL_NIF = '500000000';
    process.env.LEGAL_MORADA = 'Rua de Teste 1, Lisboa';
    process.env.LEGAL_EMAIL = 'privacidade@exemplo.pt';
    process.env.LEGAL_TELEFONE = '210000000';
    r = await pedir('/politica-privacidade');
    assert.ok(r.corpo.includes('Entidade de Teste, Lda.'), 'com configuração: mostra o responsável');
    assert.ok(r.corpo.includes('500000000'), 'com configuração: mostra o NIF');
    assert.ok(r.corpo.includes('mailto:privacidade@exemplo.pt'), 'com configuração: liga o email de contacto');
    assert.ok(r.corpo.includes('210000000'), 'com configuração: mostra o telefone');
    assert.ok(!r.corpo.includes('[CONFIGURAR EMAIL DE CONTACTO]'), 'com configuração: sem marcadores');
    assert.ok(!r.corpo.includes('Elementos por configurar'), 'com configuração: sem caixa de elementos em falta');
    t = await pedir('/termos');
    assert.ok(t.corpo.includes('Entidade de Teste, Lda.') && t.corpo.includes('mailto:privacidade@exemplo.pt'), 'termos: usa a mesma identificação');
  } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // A versão dos documentos é a mesma nas duas páginas e está declarada no router.
  assert.ok(r.corpo.includes(`Versão ${require('../routes/publicas').VERSAO}`), 'versão do documento apresentada');
  assert.strictEqual(require('../routes/publicas').VERSAO, '1.0', 'versão declarada no router');

  console.log('✓ Testes das páginas legais públicas passaram (sem BD, visitante anónimo).');
}

main().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
