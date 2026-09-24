// ═══════════════════════════════════════════════════════════════════
// P54-4 (REFORÇO) — MUTAÇÃO das guardas de autorização GLOBAL.
//
// `scripts/test-armazenamento-p54.js` passa. Isso, sozinho, não prova nada:
// um teste que passa também passa quando a guarda está ausente e ele não olha
// para lá. Aqui quebra-se o código de propósito, uma mutação de cada vez, e
// exige-se que o teste FALHE — e que falhe PELA RAZÃO CERTA.
//
// Fecham-se os dois achados de segurança do relatório do P54-4:
//   1. o âmbito `?ambito=plataforma` (a ligação da instalação) passou a exigir
//      Super Admin em `desligar`, `testar` e nos irmãos diretos do Google Drive;
//   2. `POST /config/drive/opcoes` (configuração GLOBAL) passou a exigir
//      Super Admin.
//
// Mutações (alvo: a rota — a autorização vive SÓ no servidor):
//   1. a guarda de plataforma deixa de recusar (ação corre para um admin);
//   2. o `desligar` perde a invocação da guarda;
//   3. o `testar` perde a invocação da guarda;
//   4. o irmão `POST /config/drive/desligar` perde a invocação da guarda;
//   5. o irmão `POST /config/drive/testar` perde a invocação da guarda;
//   6. a guarda de configuração global deixa de recusar;
//   7. o `drive/opcoes` perde a invocação da guarda.
//
// ── Nomes de backup próprios (árvore partilhada) ───────────────────
// Outros harnesses varrem `^\.mutation-backup-\d+-\d+\.tmp$` e afastam tudo o
// que encontram — incluindo o backup de uma execução alheia ainda a correr.
// Este usa o prefixo `mutation-backup-armp54-`, que não casa com aquele padrão.
// Ainda assim, NUNCA correr em paralelo com outro harness de mutação.
//
// ⛔ NUNCA se usa `git checkout` para restaurar (reverteria trabalho real).
//    Backup com Buffer + verificação por sha256 no `finally`.
//
// Utilização: node scripts/test-mutacao-armazenamento-p54.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const backupMut = require('./helpers/backup-mutacao');
const correrProc = require('./helpers/correr-processo');

const RAIZ = path.join(__dirname, '..');
const PREFIXO = 'mutation-backup-armp54-';
const SCRIPT = 'test-armazenamento-p54.js';
const ROTA = 'routes/configuracao.js';
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

let nTestes = 0;
const feito = (nome) => { nTestes += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

const RESULTADO = { PASSOU: 'passou', FALHOU: 'falhou', INTERROMPIDO: 'interrompido' };

function correrTeste() {
  const r = correrProc.executarOuFalhar(process.execPath, [path.join(RAIZ, 'scripts', SCRIPT)], {
    cwd: RAIZ, timeout: 120000,
  });
  if (r.estado === correrProc.ESTADO.PASSOU) return { resultado: RESULTADO.PASSOU, saida: r.saida };
  if (r.estado === correrProc.ESTADO.INTERROMPIDO) return { resultado: RESULTADO.INTERROMPIDO, saida: r.saida };
  return { resultado: RESULTADO.FALHOU, saida: r.saida };
}

// Restauro em BUFFER (byte a byte): reescrever via `utf8` reintroduziria CRLF
// na árvore inteira e `git diff --check` não o veria.
function mutacao({ nome, ficheiro, de, para, espera }) {
  titulo(nome);
  const alvo = path.join(RAIZ, ficheiro);
  const originalBuf = fs.readFileSync(alvo);
  const original = originalBuf.toString('utf8');
  const bkp = backupMut.criar({ alvo, ficheiro, raiz: RAIZ, prefixo: PREFIXO });

  try {
    assert.ok(original.includes(de), `mutação impossível: o padrão a mutar não existe em ${ficheiro}`);
    const mutado = original.replace(de, para);
    assert.notStrictEqual(mutado, original, `mutação «${nome}»: nada mudou`);
    fs.writeFileSync(alvo, Buffer.from(mutado, 'utf8'));

    const { resultado, saida } = correrTeste();
    assert.notStrictEqual(resultado, RESULTADO.INTERROMPIDO,
      `execução interrompida (timeout/SIGTERM) ao testar «${nome}»: inconclusivo — voltar a correr`);
    assert.notStrictEqual(resultado, RESULTADO.PASSOU,
      `mutação NÃO detetada: ${SCRIPT} continuou a passar com «${nome}» aplicada`);
    assert.ok(espera.test(saida),
      `mutação detetada pela razão ERRADA: esperava ${espera} na saída do teste.\n`
      + `Saída observada:\n${saida.split('\n').slice(-12).join('\n')}`);
    feito(`«${nome}» → ${SCRIPT} FALHA pela razão certa (${espera})`);
  } finally {
    const restauro = backupMut.restaurar(bkp);
    assert.ok(restauro.ok, `restauro de ${ficheiro} não ficou idêntico ao original`);
    backupMut.limpar(bkp);
    assert.strictEqual(hash(fs.readFileSync(alvo)), hash(originalBuf),
      `restauro de ${ficheiro} não ficou idêntico ao original`);
  }
}

// A invocação literal da guarda de plataforma (presente em 4 rotas).
const CHAMADA_PLATAFORMA = "if (recusarSePlataformaSemSuperAdmin(req, res, plataforma)) return;";
// A invocação literal da guarda de configuração global (presente em 1 rota).
const CHAMADA_GLOBAL = 'if (recusarConfiguracaoGlobalSemSuperAdmin(req, res)) return;';

const MUTACOES = [
  {
    // ⛔ Achado 1, no seu núcleo: sem esta recusa, um admin de condomínio
    // alcança a ligação da PLATAFORMA (a dos backups) por POST direto.
    nome: 'a guarda de plataforma deixa de recusar (devolve sempre `false`)',
    ficheiro: ROTA,
    de: 'function recusarSePlataformaSemSuperAdmin(req, res, plataforma) {\n  if (!plataforma) return false;',
    para: 'function recusarSePlataformaSemSuperAdmin(req, res, plataforma) {\n  if (true) return false;\n  if (!plataforma) return false;',
    espera: /C15: a ação de desligar NÃO corre/,
  },
  {
    // Remove a invocação em `desligar` — a porta abre-se só nessa rota.
    nome: '`desligar` deixa de invocar a guarda',
    ficheiro: ROTA,
    de: '  // o 307 levava o pedido ao irmão `/config/drive/desligar` sem guarda nenhuma.\n'
      + `  ${CHAMADA_PLATAFORMA}\n`,
    para: '  // (guarda removida pela mutação)\n',
    espera: /C15: a ação de desligar NÃO corre/,
  },
  {
    // Remove a invocação em `testar`.
    nome: '`testar` deixa de invocar a guarda',
    ficheiro: ROTA,
    de: '  // Só Super Admin. ANTES do redirect para o Drive (o irmão não tem guarda).\n'
      + `  ${CHAMADA_PLATAFORMA}\n`,
    para: '  // (guarda removida pela mutação)\n',
    espera: /C16: a ação de testar NÃO corre/,
  },
  {
    // O irmão direto do Google Drive — alcançável sem passar pelo 307.
    nome: 'o irmão `POST /config/drive/desligar` perde a guarda',
    ficheiro: ROTA,
    de: '  // — a guarda tem de viver aqui também, senão bastava chamá-la diretamente.\n'
      + `  ${CHAMADA_PLATAFORMA}\n`,
    para: '  // (guarda removida pela mutação)\n',
    espera: /C17: drive\/desligar NÃO corre/,
  },
  {
    nome: 'o irmão `POST /config/drive/testar` perde a guarda',
    ficheiro: ROTA,
    de: '  // `/config/armazenamento/google_drive/testar` e alcançável por POST direto.\n'
      + `  ${CHAMADA_PLATAFORMA}\n`,
    para: '  // (guarda removida pela mutação)\n',
    espera: /C17: drive\/testar NÃO corre/,
  },
  {
    // ⛔ Achado 2, no seu núcleo: sem esta recusa, um admin de condomínio
    // escreve a configuração GLOBAL (`configuracoes` não tem `condominio_id`).
    nome: 'a guarda de configuração global deixa de recusar',
    ficheiro: ROTA,
    de: 'function recusarConfiguracaoGlobalSemSuperAdmin(req, res) {\n  if (tenant.eSuperAdmin(req.user)) return false;',
    para: 'function recusarConfiguracaoGlobalSemSuperAdmin(req, res) {\n  if (true) return false;\n  if (tenant.eSuperAdmin(req.user)) return false;',
    espera: /C20: um admin de condomínio NÃO grava a pasta global/,
  },
  {
    nome: '`drive/opcoes` deixa de invocar a guarda',
    ficheiro: ROTA,
    de: '  // pelo `users.role_global` do utilizador autenticado.\n'
      + `  ${CHAMADA_GLOBAL}\n`,
    para: '  // (guarda removida pela mutação)\n',
    espera: /C20: um admin de condomínio NÃO grava a pasta global/,
  },
];

console.log('P54-4 (reforço) — testes de mutação: autorização GLOBAL de armazenamento');

// Varrimento de arranque: uma execução morta a meio deixa um backup órfão E o
// alvo mutado. Cada backup é uma CÓPIA INTEGRAL do original.
backupMut.varrerResiduos({ raiz: RAIZ, prefixo: PREFIXO });

// ── Pré-condição: sem mutação, o teste tem de PASSAR ────────────────
titulo('Pré-condição: o teste passa no código atual');
const inicial = correrTeste();
assert.notStrictEqual(inicial.resultado, RESULTADO.INTERROMPIDO,
  'execução interrompida na pré-condição: inconclusivo');
assert.strictEqual(inicial.resultado, RESULTADO.PASSOU,
  `${SCRIPT} já falhava ANTES de qualquer mutação — a prova por mutação seria vazia:\n`
  + inicial.saida.split('\n').slice(-15).join('\n'));
feito(`${SCRIPT} passa sem mutação (a prova tem base)`);

for (const m of MUTACOES) mutacao(m);

console.log(`\n✓ ${nTestes} verificações: ${MUTACOES.length} mutações, todas detetadas pela razão certa.`);
console.log('✓ Todos os alvos restaurados byte a byte (sha256 conferido).');
