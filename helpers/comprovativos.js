// ─────────────────────────────────────────────────────────────────────
// Comprovativos de pagamento — upload partilhado.
// Usado tanto no registo do pagamento (POST /admin/pagamentos) como na
// gestão posterior (Quotas → Comprovativos: anexar/substituir).
// Armazenamento local em storage/comprovativos com nome seguro.
// ─────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const DIR_COMPROVATIVOS = path.join(__dirname, '..', 'storage', 'comprovativos');

const MIME_PERMITIDOS = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function nomeSeguro(nome) {
  return String(nome || 'ficheiro')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120);
}

function garantirDir() {
  fs.mkdirSync(DIR_COMPROVATIVOS, { recursive: true });
  return DIR_COMPROVATIVOS;
}

function apagarComprovativo(ficheiro) {
  if (!ficheiro) return;
  try {
    const caminho = path.join(DIR_COMPROVATIVOS, path.basename(String(ficheiro)));
    if (fs.existsSync(caminho)) fs.unlinkSync(caminho);
  } catch (err) {
    // ficheiro já não existe — ignorar
  }
}

function caminhoComprovativo(pagamento) {
  if (!pagamento || !pagamento.comprovativo_ficheiro) return null;
  return path.join(DIR_COMPROVATIVOS, path.basename(String(pagamento.comprovativo_ficheiro)));
}

function existeComprovativo(pagamento) {
  const caminho = caminhoComprovativo(pagamento);
  return Boolean(caminho) && fs.existsSync(caminho);
}

// Middleware multer: um único campo "comprovativo", 12 MB, PDF/JPG/PNG/WEBP/GIF.
const uploadComprovativo = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      cb(null, garantirDir());
    },
    filename(req, file, cb) {
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${nomeSeguro(file.originalname)}`);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const mime = String(file.mimetype || '').toLowerCase();
    if (MIME_PERMITIDOS.has(mime)) cb(null, true);
    else cb(new Error('Formato não suportado (PDF, JPG, PNG, WEBP ou GIF).'));
  },
}).single('comprovativo');

module.exports = {
  DIR_COMPROVATIVOS,
  nomeSeguro,
  apagarComprovativo,
  caminhoComprovativo,
  existeComprovativo,
  uploadComprovativo,
  MIME_PERMITIDOS,
};
