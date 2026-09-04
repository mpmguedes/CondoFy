const { Readable } = require('stream');
const { google } = require('googleapis');

function isConfigured() {
  return (
    process.env.GOOGLE_DRIVE_ENABLED === 'true' &&
    Boolean(process.env.GOOGLE_CLIENT_ID) &&
    Boolean(process.env.GOOGLE_CLIENT_SECRET) &&
    Boolean(process.env.GOOGLE_REFRESH_TOKEN)
  );
}

function getAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

function getDrive() {
  return google.drive({ version: 'v3', auth: getAuth() });
}

async function encontrarOuCriarPasta(nome, parentId) {
  const drive = getDrive();
  let q = `mimeType='application/vnd.google-apps.folder' and name='${nome}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;

  const res = await drive.files.list({ q, fields: 'files(id, name)', pageSize: 1 });
  if (res.data.files.length) {
    return res.data.files[0].id;
  }
  const criada = await drive.files.create({
    requestBody: {
      name: nome,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : [],
    },
    fields: 'id',
  });
  return criada.data.id;
}

// Cria (se necessário) a estrutura: Condomínio/<ano>/<pastas> e Condomínio/Backups.
async function criarEstruturaPastas(ano = new Date().getFullYear()) {
  const raizNome = process.env.GOOGLE_DRIVE_ROOT_FOLDER || 'Condomínio';
  const raizId = await encontrarOuCriarPasta(raizNome);
  const anoId = await encontrarOuCriarPasta(String(ano), raizId);

  const nomes = ['Assembleias', 'Quotas', 'Recibos', 'Despesas', 'Contratos', 'Outros'];
  const subpastas = {};
  for (const nome of nomes) {
    subpastas[nome] = await encontrarOuCriarPasta(nome, anoId);
  }
  const backupsId = await encontrarOuCriarPasta('Backups', raizId);

  return { raizId, anoId, subpastas, backupsId };
}

// Devolve o id da pasta do ano/tipo adequado (cria a estrutura se necessário).
async function pastaParaDocumento(tipo, ano) {
  const estrutura = await criarEstruturaPastas(ano || new Date().getFullYear());
  const mapa = {
    ata: 'Assembleias',
    convocatoria: 'Assembleias',
    aviso_quota: 'Quotas',
    recibo: 'Recibos',
    fatura: 'Despesas',
    contrato: 'Contratos',
    relatorio: 'Outros',
    orcamento: 'Outros',
    outro: 'Outros',
  };
  const sub = mapa[tipo] || 'Outros';
  return estrutura.subpastas[sub];
}

// Faz upload de um Buffer para o Drive.
async function uploadArquivo({ nome, mimeType, buffer, parentFolderId }) {
  const drive = getDrive();
  const res = await drive.files.create({
    requestBody: {
      name: nome,
      mimeType: mimeType || 'application/pdf',
      parents: parentFolderId ? [parentFolderId] : [],
    },
    media: { mimeType: mimeType || 'application/pdf', body: Readable.from(buffer) },
    fields: 'id, webViewLink, size',
  });
  return {
    driveFileId: res.data.id,
    url: res.data.webViewLink || null,
    tamanho: res.data.size ? parseInt(res.data.size, 10) : null,
  };
}

module.exports = { isConfigured, getDrive, criarEstruturaPastas, pastaParaDocumento, uploadArquivo, encontrarOuCriarPasta };
