// ═══════════════════════════════════════════════════════════════════
// Verificação REAL das APIs Dropbox e OneDrive (corre na sua máquina).
//
// Este script exercita os ADAPTADORES VERDADEIROS do GesCondu
// (helpers/armazenamento/provedores/*) contra as APIs reais, numa instalação
// temporária em memória: não precisa de base de dados, não toca no `.env` da
// aplicação e não guarda tokens em nenhum ficheiro.
//
// Faz, pela ordem: OAuth (com servidor de retorno em localhost) → identificação
// da conta → estrutura de pastas → upload de um PDF de teste → descarga →
// streaming → renovação de token → destino de backups → desligar.
//
// Utilização (exemplo Dropbox):
//   $env:DROPBOX_APP_KEY='...'; $env:DROPBOX_APP_SECRET='...'
//   node scripts/verificar-provedores-reais.js --provedor dropbox
//
// (OneDrive: ONEDRIVE_CLIENT_ID / ONEDRIVE_CLIENT_SECRET / --provedor onedrive)
//
// Antes de correr, registe no fornecedor o redirect URI indicado pelo script
// (http://127.0.0.1:53682/callback por omissão). Nunca são impressos tokens,
// segredos ou chaves; os erros são apresentados já saneados.
// ═══════════════════════════════════════════════════════════════════
const http = require('http');
const crypto = require('crypto');

// ── Argumentos ──────────────────────────────────────────────────────
function argumento(nome, defeito = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : defeito;
}

const PROVEDOR = String(argumento('provedor', '')).toLowerCase();
const PORTA = Number(argumento('porta', 53682));
const CID = Number(argumento('condominio', 1));
const ANO = new Date().getFullYear();

if (!['dropbox', 'onedrive'].includes(PROVEDOR)) {
  console.error('Indique o serviço: --provedor dropbox  ou  --provedor onedrive');
  process.exit(2);
}

// Credenciais técnicas da instalação (nunca ficam em ficheiros do projeto).
const CREDENCIAIS = {
  dropbox: { enabled: 'DROPBOX_ENABLED', id: 'DROPBOX_APP_KEY', segredo: 'DROPBOX_APP_SECRET' },
  onedrive: { enabled: 'ONEDRIVE_ENABLED', id: 'ONEDRIVE_CLIENT_ID', segredo: 'ONEDRIVE_CLIENT_SECRET' },
}[PROVEDOR];

const REDIRECT_URI = `http://127.0.0.1:${PORTA}/callback`;

// ── Instalação temporária em memória (sem BD) ───────────────────────
// A chave de cifragem é aleatória por execução: valida o caminho de cifragem
// real sem reutilizar segredos de produção.
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env[CREDENCIAIS.enabled] = 'true';
process.env.STORAGE_PROVIDER = PROVEDOR;
// Redirect URI usado pelo adaptador quando a variável de ambiente não existe.
process.env[PROVEDOR === 'dropbox' ? 'DROPBOX_REDIRECT_URI' : 'ONEDRIVE_REDIRECT_URI'] = REDIRECT_URI;

const loja = new Map();
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: {
    Configuracao: {
      findAll: async () => [...loja.entries()].map(([chave, valor]) => ({ chave, valor })),
      findOne: async ({ where }) => (loja.has(where.chave) ? { chave: where.chave, valor: loja.get(where.chave) } : null),
      findOrCreate: async ({ where, defaults }) => {
        if (!loja.has(where.chave)) loja.set(where.chave, defaults ? defaults.valor : null);
        return [{ valor: loja.get(where.chave), save: async () => {} }];
      },
    },
    Condominio: {
      findByPk: async () => ({ id: CID, designacao: 'Condomínio de Verificação', estado: 'ativo', drive_folder_id: null }),
      findOne: async () => null,
      update: async () => {},
    },
    Documento: { findOne: async () => null, findAll: async () => [] },
  },
};
const configPath = require.resolve('../helpers/config');
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true, children: [], paths: [],
  exports: {
    getConfig: async (chave, defeito = null) => (loja.has(chave) ? loja.get(chave) : defeito),
    setConfig: async (chave, valor) => { loja.set(chave, valor); return { chave, valor }; },
  },
};

const cifra = require('../helpers/armazenamento/cifra');
const ligacoes = require('../helpers/armazenamento/ligacoes');
const provedor = require(`../helpers/armazenamento/provedores/${PROVEDOR === 'dropbox' ? 'dropbox' : 'onedrive'}`);
const { sanitizar } = require('../helpers/armazenamento/http');

// ── Relatório ───────────────────────────────────────────────────────
const passos = [];
function registar(nome, ok, detalhe = '') {
  passos.push({ nome, ok, detalhe: sanitizar(detalhe).slice(0, 300) });
  const marca = ok ? '✓' : '✗';
  console.log(`  ${marca} ${nome}${detalhe ? ' — ' + sanitizar(detalhe).slice(0, 200) : ''}`);
  return ok;
}

function verificarCredenciais() {
  const id = String(process.env[CREDENCIAIS.id] || '').trim();
  const segredo = String(process.env[CREDENCIAIS.segredo] || '').trim();
  if (id && segredo) return true;
  console.error('');
  console.error(`✗ Faltam as credenciais de ${PROVEDOR === 'dropbox' ? 'Dropbox' : 'Microsoft'}.`);
  if (PROVEDOR === 'dropbox') {
    console.error('');
    console.error('  1. https://www.dropbox.com/developers/apps → Create app');
    console.error('     · Choose an API: Scoped access');
    console.error('     · Choose the type of access: Full Dropbox (ou App folder, para testes)');
    console.error('  2. No separador Permissions, ative: files.content.write, files.content.read,');
    console.error('     account_info.read');
    console.error(`  3. No separador OAuth 2 → Redirect URIs, acrescente: ${REDIRECT_URI}`);
    console.error('  4. Copie App key e App secret e defina:');
    console.error("     $env:DROPBOX_APP_KEY='<app key>'; $env:DROPBOX_APP_SECRET='<app secret>'");
  } else {
    console.error('');
    console.error('  1. https://entra.microsoft.com → App registrations → New registration');
    console.error('     · Supported account types: Accounts in any organizational directory and personal');
    console.error('       Microsoft accounts (para OneDrive pessoal) — ou só a organização, se for empresarial');
    console.error(`     · Redirect URI: plataforma "Web" → ${REDIRECT_URI}`);
    console.error('  2. Certificates & secrets → New client secret (copie o Value)');
    console.error('  3. API permissions → Microsoft Graph → Delegated: offline_access, Files.ReadWrite, User.Read');
    console.error('  4. Defina:');
    console.error("     $env:ONEDRIVE_CLIENT_ID='<application (client) id>'; $env:ONEDRIVE_CLIENT_SECRET='<secret value>'");
    console.error('     (opcional) $env:ONEDRIVE_TENANT=\'common\' ou o id do tenant');
  }
  console.error('');
  return false;
}

// ── OAuth com retorno em localhost ──────────────────────────────────
function esperarCodigo(state) {
  return new Promise((resolve, reject) => {
    const servidor = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${PORTA}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const erro = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const stateRecebido = url.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>GesCondu — verificação concluída.</h2><p>Pode fechar esta janela e voltar ao terminal.</p>');
      servidor.close();
      if (erro) return reject(new Error(`Autorização recusada: ${url.searchParams.get('error_description') || erro}`));
      if (!code) return reject(new Error('Não foi recebido o código de autorização.'));
      if (stateRecebido !== state) return reject(new Error('Estado OAuth não confere (possível pedido cruzado).'));
      resolve(code);
    });
    servidor.on('error', reject);
    servidor.listen(PORTA, '127.0.0.1', () => {
      console.log('');
      console.log(`  Servidor de retorno à escuta em ${REDIRECT_URI}`);
    });
    setTimeout(() => {
      servidor.close();
      reject(new Error('Tempo esgotado à espera da autorização (15 minutos).'));
    }, 15 * 60 * 1000).unref();
  });
}

function pdfDeTeste() {
  // PDF mínimo válido, gerado localmente (sem ficheiros externos).
  return Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    'utf8'
  );
}

async function lerFluxo(fluxo) {
  const pedacos = [];
  for await (const c of fluxo) pedacos.push(Buffer.from(c));
  return Buffer.concat(pedacos);
}

// ── Verificação ─────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(` Verificação real: ${provedor.rotulo()}  (condomínio de teste #${CID})`);
  console.log('══════════════════════════════════════════════════════════════');

  if (!verificarCredenciais()) process.exit(2);
  if (!ligacoes.cifraDisponivel()) {
    console.error('✗ Cifragem indisponível (ENCRYPTION_KEY).');
    process.exit(2);
  }

  // 1. OAuth
  const state = crypto.randomBytes(18).toString('hex');
  const url = provedor.urlAutorizacao({ redirectUri: REDIRECT_URI, state, condominioId: CID });
  registar('URL de autorização construído', Boolean(url && url.startsWith('http')));
  console.log('');
  console.log('  Abra este endereço no navegador e autorize o acesso:');
  console.log('');
  console.log(`  ${url}`);
  console.log('');

  const codigo = await esperarCodigo(state);
  const tokens = await provedor.trocarCodigo({ code: codigo, redirectUri: REDIRECT_URI, condominioId: CID });
  registar('Código trocado por tokens', Boolean(tokens && (tokens.access_token || tokens.refresh_token)), `conta: ${tokens && tokens.conta ? tokens.conta : '(não identificada)'}`);

  // 2. Cifragem em repouso (o valor guardado tem de estar cifrado)
  const chaveGuardada = ligacoes.chaveTokens(PROVEDOR, CID);
  const bruto = loja.get(chaveGuardada);
  registar('Credenciais cifradas em repouso', cifra.estaCifrado(bruto), cifra.estaCifrado(bruto) ? 'formato enc:v1' : 'valor não cifrado');
  registar('Credenciais não ficam em texto simples', !String(bruto || '').includes(String(tokens.access_token || 'x')), 'sem access_token no valor guardado');

  // 3. Estado da ligação e teste de ligação
  const estado = await provedor.estadoLigacao(CID);
  registar('estadoLigacao devolve ligação ativa', estado.ligado === true, `conta: ${estado.conta || '—'}`);
  const teste = await provedor.testarLigacao(CID);
  registar('testarLigacao OK', teste.ok === true, teste.ok ? `conta: ${teste.conta || '—'}` : teste.erro);

  // 4. Estrutura de pastas
  const arvore = await provedor.criarEstruturaPastas(CID, ANO);
  const pastas = Object.keys(arvore.subpastas || {});
  registar('criarEstruturaPastas', Boolean(arvore.anoId) && pastas.length >= 6, `${pastas.length} pastas do ano`);
  registar('pasta de backups acessível', Boolean(arvore.backupsId), String(arvore.backupsId).slice(0, 80));

  const pastaDocumento = await provedor.pastaParaDocumento('ata', ANO, CID);
  registar('pastaParaDocumento', Boolean(pastaDocumento), String(pastaDocumento).slice(0, 80));

  // 5. Upload
  const conteudo = pdfDeTeste();
  const nome = `verificacao_gescondu_${Date.now()}.pdf`;
  const up = await provedor.uploadArquivo({ nome, mimeType: 'application/pdf', buffer: conteudo, parentFolderId: pastaDocumento, condominioId: CID });
  const localizador = up.localizador || up.provedorFileId || up.driveFileId || null;
  registar('uploadArquivo', Boolean(localizador), `localizador: ${String(localizador).slice(0, 40)}…`);
  registar('localizador com prefixo do provedor', String(localizador || '').startsWith(PROVEDOR === 'dropbox' ? 'dbx:' : 'od:'), String(localizador || '').split(':')[0] + ':');

  // 6. Descarga e streaming (o caminho usado pelo GesCondu para servir documentos)
  const descarregado = await provedor.descarregarArquivo(localizador.replace(/^(dbx|od):/, ''), CID);
  registar('descarregarArquivo devolve o ficheiro', Buffer.compare(Buffer.from(descarregado), conteudo) === 0, `${descarregado.length} bytes, conteúdo idêntico`);

  const abertura = await provedor.abrirFluxo(localizador.replace(/^(dbx|od):/, ''), CID);
  const porFluxo = await lerFluxo(abertura.fluxo);
  registar('abrirFluxo (streaming) devolve o ficheiro', Buffer.compare(porFluxo, conteudo) === 0, `${porFluxo.length} bytes, conteúdo idêntico`);

  // 7. Renovação de token (força a expiração e repete uma operação)
  const atuais = (await ligacoes.lerTokens(PROVEDOR, CID)).tokens;
  await ligacoes.guardarTokens(PROVEDOR, CID, { ...atuais, expiry_date: Date.now() - 60 * 1000 });
  const depoisDeExpirar = await provedor.descarregarArquivo(localizador.replace(/^(dbx|od):/, ''), CID);
  const renovados = (await ligacoes.lerTokens(PROVEDOR, CID)).tokens;
  registar('renovação automática do token', Buffer.compare(Buffer.from(depoisDeExpirar), conteudo) === 0, `access token renovado: ${Boolean(renovados && renovados.access_token && renovados.access_token !== atuais.access_token)}`);
  registar('tokens renovados continuam cifrados', cifra.estaCifrado(loja.get(chaveGuardada)), 'formato enc:v1');

  // 8. Pasta de fornecedores e de backups (backups usam ligação de plataforma)
  const pastasFornecedor = await provedor.pastaParaFornecedor({ condominioId: CID, nome: 'Fornecedor de Verificação', ano: ANO, subpasta: 'Comprovativos' });
  registar('pastaParaFornecedor', Boolean(pastasFornecedor.subpastaId), String(pastasFornecedor.subpastaId).slice(0, 80));
  const pastaBackups = await provedor.pastaDeBackups();
  registar('pastaDeBackups (plataforma)', Boolean(pastaBackups), String(pastaBackups).slice(0, 80));

  // 9. Invariante de segurança: não existem links públicos de ficheiros/pastas
  registar('não expõe link de pasta (sem partilha pública)', provedor.linkPasta('x') === null, 'linkPasta devolve null');

  // 10. Desligar (remove as credenciais; os ficheiros no fornecedor não são apagados)
  await provedor.desligar(CID);
  const depoisDeDesligar = await ligacoes.lerTokens(PROVEDOR, CID);
  registar('desligar remove as credenciais', !depoisDeDesligar.tokens, 'sem tokens após desligar');
  registar('desligar não deixa credenciais na BD', !loja.get(chaveGuardada), String(loja.get(chaveGuardada)));

  // ── Resumo ────────────────────────────────────────────────────────
  const falhas = passos.filter((p) => !p.ok);
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(` Resumo: ${passos.length - falhas.length}/${passos.length} passos com sucesso`);
  if (falhas.length) {
    console.log('');
    console.log(' Passos com falha (envie esta lista tal como está):');
    for (const f of falhas) console.log(`  ✗ ${f.nome}: ${f.detalhe}`);
  }
  console.log('');
  console.log(` Ficheiro de teste criado no fornecedor: ${nome}`);
  console.log(`   (pode apagá-lo na pasta ${String(pastaDocumento).slice(0, 80)};`);
  console.log('    o GesCondu não apaga ficheiros ao desligar um serviço.)');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(falhas.length ? 1 : 0);
}

main().catch((err) => {
  console.error('');
  console.error('✗ Falha na verificação: ' + sanitizar(err && err.message));
  if (err && err.codigo) console.error('  código: ' + err.codigo);
  console.error('');
  process.exit(1);
});
