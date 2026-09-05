// Testes do helper Google Drive (parte sem rede/base de dados).
// Utilização: node scripts/test-drive.js
const assert = require('assert');

// Ambiente de teste (credenciais fictícias — apenas para validar lógica)
process.env.GOOGLE_DRIVE_ENABLED = 'true';
process.env.GOOGLE_CLIENT_ID = 'cliente-teste.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'segredo-teste';
process.env.GOOGLE_REFRESH_TOKEN = '';

const drive = require('../helpers/drive');

function descodificarQuery(url) {
  const q = url.split('?')[1] || '';
  const out = {};
  for (const parte of q.split('&')) {
    const [k, v] = parte.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return out;
}

async function main() {
  // 1. Sem tokens → não configurado
  assert.strictEqual(drive.isConfigured(), false, 'sem refresh token → não configurado');

  // 2. Modo legado (.env) → configurado
  process.env.GOOGLE_REFRESH_TOKEN = 'token-legado-teste';
  assert.strictEqual(drive.isConfigured(), true, 'refresh token no .env → configurado');
  process.env.GOOGLE_REFRESH_TOKEN = '';

  // 3. Feature desativada → nunca configurado
  process.env.GOOGLE_REFRESH_TOKEN = 'token-legado-teste';
  process.env.GOOGLE_DRIVE_ENABLED = 'false';
  assert.strictEqual(drive.isConfigured(), false, 'GOOGLE_DRIVE_ENABLED=false → desativado');
  process.env.GOOGLE_DRIVE_ENABLED = 'true';
  process.env.GOOGLE_REFRESH_TOKEN = '';

  // 4. URL de autorização OAuth (parâmetros corretos e scope mínimo)
  const url = drive.construirUrlAutorizacao({
    redirectUri: 'http://localhost:3000/admin/config/drive/callback',
    state: 'estado-de-teste-123',
  });
  const q = descodificarQuery(url);
  assert.strictEqual(q.client_id, 'cliente-teste.apps.googleusercontent.com', 'client_id na URL');
  assert.strictEqual(q.redirect_uri, 'http://localhost:3000/admin/config/drive/callback', 'redirect_uri na URL');
  assert.strictEqual(q.state, 'estado-de-teste-123', 'state presente');
  assert.strictEqual(q.access_type, 'offline', 'access_type=offline (refresh token)');
  assert.strictEqual(q.prompt, 'consent', 'prompt=consent');
  assert.ok(q.scope.includes('drive.file'), 'scope drive.file');
  assert.ok(!q.scope.includes('gmail') && !q.scope.includes('calendar'), 'sem scopes desnecessários');

  // 5. Redirect URI derivado do pedido (sem GOOGLE_REDIRECT_URI)
  delete process.env.GOOGLE_REDIRECT_URI;
  const ru = drive.obterRedirectUri({ protocol: 'http', get: () => 'localhost:3000' });
  assert.strictEqual(ru, 'http://localhost:3000/admin/config/drive/callback', 'redirect derivado');
  process.env.GOOGLE_REDIRECT_URI = 'https://condofy.exemplo.pt/admin/config/drive/callback';
  assert.strictEqual(
    drive.obterRedirectUri({ protocol: 'http', get: () => 'localhost:3000' }),
    'https://condofy.exemplo.pt/admin/config/drive/callback',
    'GOOGLE_REDIRECT_URI tem prioridade'
  );

  console.log('✓ Testes do helper Google Drive passaram (sem rede).');
}

main().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
