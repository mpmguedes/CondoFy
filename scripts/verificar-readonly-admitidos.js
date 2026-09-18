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
const allowlist = require('../helpers/suporte-allowlist');
const L = allowlist.LISTA;

// O mapa módulo → ficheiro vem da FONTE ÚNICA (`helpers/suporte-allowlist`),
// não de uma cópia local. Antes este ficheiro tinha o seu próprio `FICHEIROS`,
// e um módulo novo na `LISTA` era aqui silenciosamente IGNORADO («sem ficheiro
// mapeado — ignorado») sem fazer falhar nada. Ver `ROUTERS` no allow-list.
const FICHEIROS = allowlist.ROUTERS;

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
let nNaoLocalizados = 0;
console.log('§23 — GETs admitidos: verificação de read-only\n');

// ── Portão de coerência LISTA ↔ ROUTERS ────────────────────────────
// Antes de verificar seja o que for, garantir que a lista de módulos e o mapa
// de routers concordam. Sem isto, um módulo novo na `LISTA` era aqui ignorado
// em silêncio e o verificador devolvia sucesso — um falso verde.
const co = allowlist.incoerencias((f) => fs.existsSync(path.join(RAIZ, f)));
if (co.semRouter.length || co.ficheiroInexistente.length || co.routersOrfaos.length) {
  console.log('✗ INCOERÊNCIA entre a LISTA e o mapa de routers:');
  for (const m of co.semRouter) console.log(`    · módulo «${m}» está na LISTA mas NÃO declara router`);
  for (const { modulo, ficheiro } of co.ficheiroInexistente) {
    console.log(`    · módulo «${modulo}» aponta para «${ficheiro}», que não existe`);
  }
  for (const m of co.routersOrfaos) console.log(`    · router declarado para «${m}», que NÃO está na LISTA`);
  console.log('\n  Nenhum módulo pode ser admitido ao suporte sem router declarado e existente.');
  console.log('  Declare-o em `ROUTERS` (`helpers/suporte-allowlist.js`).');
  process.exit(1);
}

for (const [mod, entradas] of Object.entries(L)) {
  const ficheiro = FICHEIROS[mod];
  if (!ficheiro) {
    // Inalcançável com o portão acima, mas mantém-se como falha explícita para
    // que uma futura alteração do portão não reintroduza o salto silencioso.
    nNaoLocalizados += 1;
    console.log(`  ✗ ${mod}: módulo da LISTA sem ficheiro de router mapeado\n`);
    continue;
  }
  const fonte = fs.readFileSync(path.join(RAIZ, ficheiro), 'utf8');

  for (const e of entradas) {
    const rota = e.rotulo.replace(/:id$/, ':id');
    const bloco = blocoDoHandler(fonte, 'get', e.padrao.source.includes('\\d+') ? rota : rota)
      || blocoDoHandler(fonte, 'get', rota);
    if (!bloco) {
      // FALHA, não salto: a rota está admitida na LISTA mas não se encontrou o
      // handler no router declarado. Ou o router mudou, ou a `LISTA` mente —
      // em qualquer dos casos a rota deixou de estar verificada.
      nNaoLocalizados += 1;
      console.log(`  ✗ ${mod}  ${e.rotulo}  → handler NÃO LOCALIZADO em ${ficheiro}`);
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

console.log(
  `Resumo: ${nOk} GET(s) read-only · ${nSuspeitos} com efeito lateral · ${nNaoLocalizados} não verificado(s).`
);
if (nSuspeitos > 0 || nNaoLocalizados > 0) process.exitCode = 1;
