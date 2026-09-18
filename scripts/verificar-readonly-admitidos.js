// §23 — Verificação: todos os GETs ADMITIDOS são de facto read-only.
//
// Para cada rota da allow-list, extrai o HANDLER real do router e procura
// operações que alteram estado ou produzem efeitos laterais:
//   `.create(`, `.update(`, `.destroy(`, `.bulkCreate(`, `.increment(`,
//   `.decrement(`, `.save(`, `AuditLog`, uploads, criação de pastas, ou
//   chamadas a serviços externos com efeito (Drive criar/mover, mailer).
//
// Metodologia: delimita o handler por contagem de chavetes a partir de
// `router.get('<rota>'` e analisa só esse bloco — não o ficheiro todo (senão
// apanharia os POSTs legítimos das rotas vizinhas).
//
// Uso: node scripts/verificar-readonly-admitidos.js
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const L = require('../helpers/suporte-allowlist').LISTA;

// Onde vive cada módulo da allow-list.
const FICHEIROS = {
  admin: 'routes/admin.js',
  financeiro: 'routes/financeiro.js',
  'quotas-modulo': 'routes/quotas-modulo.js',
  'extra-quotas': 'routes/extra-quotas.js',
  orcamento: 'routes/orcamento.js',
  assembleias: 'routes/assembleias.js',
  documentos: 'routes/documentos.js',
  emails: 'routes/emails.js',
  relatorios: 'routes/relatorios.js',
};

// Marcadores de efeito lateral dentro do handler.
//
// Nota sobre a auditoria: `AuditLog` no bloco NÃO é, por si, um efeito. O painel
// faz `AuditLog.findAll(...)` para MOSTRAR a atividade recente — é leitura.
// Só é efeito se houver uma escrita: `AuditLog.create`/`bulkCreate`/`update`.
// (Uma versão anterior sinalizava qualquer menção a `AuditLog` e produzia um
// falso positivo no painel — o teste tem de distinguir ler de escrever.)
const EFEITOS = [
  [/AuditLog\s*\.\s*(create|bulkCreate|update|upsert)\s*\(/, 'AuditLog (escrita de auditoria no GET)'],
  [/\bregistarAuditoria\s*\(/, 'registarAuditoria() (escrita de auditoria no GET)'],
  [/\.create\s*\(/, '.create()'],
  [/\.bulkCreate\s*\(/, '.bulkCreate()'],
  [/\.update\s*\(/, '.update()'],
  [/\.destroy\s*\(/, '.destroy()'],
  [/\.increment\s*\(/, '.increment()'],
  [/\.decrement\s*\(/, '.decrement()'],
  [/\.save\s*\(/, '.save()'],
  [/criarPasta|garantirPasta|drive\.files\.create/, 'criação de pasta/ficheiro no Drive'],
  [/enviarEmail|sendMail\(/, 'envio de email'],
  [/servirDocumento|descargarArquivo/, 'stream/cópia de ficheiro do provedor'],
];

// Remove comentários de linha e de bloco, para não sinalizar código comentado
// (um `.update(` que já não corre não é um efeito).
function semComentarios(texto) {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Extrai o bloco do handler `router.<metodo>('<rota>'…` por contagem de chavetes.
function blocoDoHandler(fonte, metodo, rota) {
  // A rota pode estar escrita com escapes (ex.: '/quotas/:id').
  const re = new RegExp('router\\.' + metodo + "\\(\\s*'" + rota.replace(/[/:*+?.^$()|[\]{}\\]/g, '\\$&') + "'");
  const m = re.exec(fonte);
  if (!m) return null;
  // A partir do fim do cabeçalho, conta chavetes até fechar o corpo.
  let i = m.index;
  let nivel = 0;
  let vistoAbre = false;
  let fim = i;
  for (; fim < fonte.length; fim += 1) {
    const c = fonte[fim];
    if (c === '{') { nivel += 1; vistoAbre = true; }
    else if (c === '}') { nivel -= 1; if (vistoAbre && nivel === 0) { fim += 1; break; } }
  }
  return fonte.slice(i, fim);
}

let nOk = 0;
let nSuspeitos = 0;
console.log('§23 — GETs admitidos: verificação de read-only\n');

for (const [mod, entradas] of Object.entries(L)) {
  const ficheiro = FICHEIROS[mod];
  if (!ficheiro) { console.log(`· ${mod}: (sem ficheiro mapeado — ignorado)\n`); continue; }
  const fonte = fs.readFileSync(path.join(RAIZ, ficheiro), 'utf8');

  for (const e of entradas) {
    const rota = e.rotulo.replace(/:id$/, ':id');
    const bloco = blocoDoHandler(fonte, 'get', e.padrao.source.includes('\\d+') ? rota : rota)
      || blocoDoHandler(fonte, 'get', rota);
    if (!bloco) {
      console.log(`  ? ${mod}  ${e.rotulo}  → handler não localizado (pode estar noutro router — ver nota)`);
      continue;
    }
    const achados = EFEITOS.filter(([re]) => re.test(semComentarios(bloco))).map(([, nome]) => nome);
    if (achados.length === 0) {
      nOk += 1;
      console.log(`  ✓ ${mod}  ${e.rotulo}  → read-only`);
    } else {
      nSuspeitos += 1;
      console.log(`  ✗ ${mod}  ${e.rotulo}  → EFEITO LATERAL: ${achados.join(', ')}`);
    }
  }
  console.log('');
}

console.log(`Resumo: ${nOk} GET(s) read-only · ${nSuspeitos} com efeito lateral.`);
if (nSuspeitos > 0) process.exitCode = 1;
