// ═══════════════════════════════════════════════════════════════════
// T8 — Testes de MUTAÇÃO (provam que os testes do suporte MORDEM).
//
// Um teste que passa não prova nada se não falhar quando o código é quebrado.
// Aqui aplica-se, uma a uma, uma mutação REAL ao código-fonte, corre-se o teste
// que a deve detetar e verifica-se que ele FALHA. No fim, restaura-se o
// ficheiro BYTE A BYTE e confirma-se com o hash.
//
// ⛔ NUNCA se usa `git checkout` para restaurar (reverteria trabalho real).
//    Backup com `fs.copyFileSync` + verificação por hash.
//
// Mutações cobertas:
//   1. remover o crivo de leitura (`somenteLeitura`) do crivo de admissão;
//   2. remover uma rota da allow-list;
//   3. remover `condominio_id` do `where` de `/quotas` (o bug original);
//   4. remover a guarda global de `/condomino`;
//   5. remover a máscara de uma vista de suporte.
//
// Utilização: node scripts/test-mutacao-suporte.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
let nTestes = 0;
const feito = (nome) => { nTestes += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// Corre um script de teste num processo separado e devolve `true` se PASSOU.
function testePassa(script) {
  try {
    execFileSync(process.execPath, [path.join(RAIZ, 'scripts', script)], {
      cwd: RAIZ, stdio: 'pipe', timeout: 120000,
    });
    return true;
  } catch (e) {
    return false;
  }
}

// Aplica uma mutação, corre o teste (tem de FALHAR), e restaura o ficheiro.
//
// O restauro é SEMPRE byte a byte, no `finally` — nunca `git checkout`. Se o
// processo for morto a meio (SIGTERM/timeout), pode ficar um backup órfão: por
// isso o teste começa por varrer o diretório (`varrerBackupsOrfaos`) e os
// backups são escritos com o ORIGINAL, pelo que um órfão nunca perde conteúdo.
function mutacao({ nome, ficheiro, de, para, global = false, script, esperaFalharEm = null }) {
  titulo(nome);
  const alvo = path.join(RAIZ, ficheiro);
  const original = fs.readFileSync(alvo, 'utf8');
  const hashOriginal = hash(original);

  // Backup ao lado (nunca `git checkout`).
  const backup = path.join(RAIZ, `.mutation-backup-${Date.now()}.tmp`);
  fs.writeFileSync(backup, original);

  try {
    assert.ok(original.includes(de),
      `mutação impossível: o padrão a mutar não existe em ${ficheiro}`);
    const mutado = global
      ? original.split(de).join(para)
      : original.replace(de, para);
    assert.notStrictEqual(mutado, original, `mutação ${nome}: nada mudou`);
    fs.writeFileSync(alvo, mutado);

    const passou = testePassa(script);
    assert.ok(!passou,
      `mutação NÃO detetada: ${script} continuou a passar com «${nome}» aplicada`);
    feito(`«${nome}» → ${script} FALHA (a mutação é detetada)`);
  } finally {
    // Restauro byte a byte + verificação por hash.
    fs.writeFileSync(alvo, fs.readFileSync(backup));
    fs.unlinkSync(backup);
    assert.strictEqual(hash(fs.readFileSync(alvo, 'utf8')), hashOriginal,
      `restauro de ${ficheiro} não ficou idêntico ao original`);
  }
}

(async () => {
  console.log('T8 — testes de mutação do suporte diagnóstico');

  // Varrimento de arranque: se uma execução anterior foi morta a meio, pode ter
  // ficado um backup órfão no diretório. Como cada backup guarda uma CÓPIA
  // INTEGRAL do ficheiro original, o órfão é apenas lixo — remove-se aqui, para
  // que `git status` no fim da fase fique limpo.
  for (const f of fs.readdirSync(RAIZ)) {
    if (/^\.mutation-backup-\d+\.tmp$/.test(f)) {
      fs.unlinkSync(path.join(RAIZ, f));
      console.log(`  · removido backup órfão de uma execução anterior: ${f}`);
    }
  }

  // ── 1. Remover o crivo de leitura do crivo de admissão ───────────
  // Sem `somenteLeitura`, um POST num caminho da lista seria admitido —
  // a allow-list passaria a ser de CAMINHOS, não de OPERAÇÕES.
  mutacao({
    nome: '1. remover o crivo de leitura (somenteLeitura) da admissão',
    ficheiro: 'helpers/suporte-allowlist.js',
    de: 'return tenant.somenteLeitura(req, res, (err2) => {',
    para: 'return (() => { const err2 = null; return ((req2, res2, next2) => {',
    script: 'test-allow-list-suporte.js',
  });

  // ── 2. Remover uma rota da allow-list ────────────────────────────
  // `/quotas` está em DOIS módulos (`quotas-modulo`, que serve o pedido, e
  // `financeiro`, que o serve se a ordem de montagem mudar). Remover de UM só
  // não quebra nada — é precisamente essa a defesa em profundidade. A mutação
  // remove das DUAS listas, que é a remoção efetiva da superfície.
  // O teste T1 por módulo tem de detetar que a rota deixou de ser servida.
  mutacao({
    nome: '2. remover /quotas da allow-list (todos os módulos que a listam)',
    ficheiro: 'helpers/suporte-allowlist.js',
    de: "    { padrao: /^\\/quotas$/, rotulo: '/quotas' },",
    para: "    { padrao: /^\\/quotasNAOEXISTE$/, rotulo: '/quotas' },",
    global: true,
    script: 'test-allow-list-suporte.js',
  });

  // ── 3. Remover `condominio_id` do `where` de /quotas ─────────────
  // O bug ORIGINAL (§3). Com o âmbito retirado, o T4 tem de detetar que a
  // consulta deixou de filtrar — e/ou que apareceram dados de B.
  mutacao({
    nome: '3. remover condominio_id do where de /quotas (bug original)',
    ficheiro: 'routes/quotas-modulo.js',
    de: 'Quota.findAll({ where: { ano, condominio_id: cid } }),',
    para: 'Quota.findAll({ where: { ano } }),',
    script: 'test-t4-suporte-isolamento.js',
  });

  // ── 4. Remover a guarda global de /condomino ─────────────────────
  // Sem a guarda, o suporte entra no portal. O T5 tem de detetar.
  mutacao({
    nome: '4. remover a guarda global de /condomino',
    ficheiro: 'app.js',
    de: "app.use('/condomino', tenant.bloqueioSuporteNaSessao);",
    para: "app.use('/condomino', (req, res, next) => next());",
    script: 'test-suporte.js',
  });

  // ── 5. Remover a máscara de uma vista de suporte ─────────────────
  // A vista de condóminos de suporte passa a mostrar o email por inteiro.
  mutacao({
    nome: '5. remover a máscara de email na vista de suporte (/condominos)',
    ficheiro: 'views/admin/condominos/listar-suporte.handlebars',
    de: '{{maskEmail',
    para: '{{emailMostradoOu',
    script: 'test-mascara-vistas.js',
  });

  // ── 6. Repor a admissão do router `admin` restrita à sua própria lista ─
  // É o bug que a prova HTTP por módulo apanhou: `admin.js` é o PRIMEIRO router
  // montado sob `/admin` e a sua guarda de papel é `router.use` — logo corre
  // para TODOS os caminhos, incluindo `/quotas`, `/despesas`, `/contas`, …
  // Se a sua admissão só conhecer a lista de `admin`, RECUSA o suporte nessas
  // rotas antes de elas chegarem ao router que as serve — e a admissão de
  // `financeiro`/`quotas-modulo`/… torna-se código morto. O T1 por módulo tem
  // de detetar (a rota admitida passa a ser recusada).
  mutacao({
    nome: '6. restringir a admissão de `admin` à sua própria lista (bug do router-frente)',
    ficheiro: 'helpers/suporte-allowlist.js',
    de: "  const admitir = modulo === 'admin'\n    ? (caminho) => caminhoAdmitidoEmAlgumModulo(caminho)\n    : (caminho) => caminhoAdmitido(modulo, caminho);",
    para: '  const admitir = (caminho) => caminhoAdmitido(modulo, caminho);',
    script: 'test-allow-list-suporte.js',
  });

  // ── 7. Remover a exceção da rede de segurança de `admin.js` ──────
  // A rede de segurança no fim de `admin.js` reencaminha o suporte sobrante
  // para `/admin`. Sem a exceção `caminhoAdmitidoEmAlgumModulo`, interceta os
  // pedidos admitidos que pertencem a routers POSTERIORES — o suporte passa a
  // ver um 302 `/admin` em vez da rota. É a segunda metade do mesmo defeito,
  // detetada pelo mesmo T1 por módulo.
  mutacao({
    nome: '7. remover a exceção da rede de segurança de /admin (interceta routers seguintes)',
    ficheiro: 'routes/admin.js',
    de: 'if (allowlistSuporte.caminhoAdmitidoEmAlgumModulo(req.path)) return next();',
    para: 'if (false) return next();',
    script: 'test-allow-list-suporte.js',
  });

  // ── 8. Módulo NOVO na LISTA sem router declarado ─────────────────
  // A deriva que motivou esta alteração: um módulo entra na `LISTA` e fica
  // ADMITIDO ao suporte sem nunca ser exercitado por HTTP nem verificado
  // quanto a efeitos laterais. Antes desta fase, nada falhava (era um falso
  // verde: o verificador §23 saltava-o em silêncio). Agora o portão de
  // coerência e o teste T1 têm de detetar.
  mutacao({
    nome: '8. módulo novo na LISTA sem router declarado (deriva da fonte única)',
    ficheiro: 'helpers/suporte-allowlist.js',
    de: "  // Relatórios. Ver `routes/relatorios.js`.",
    para: "  inventado: [{ padrao: /^\\/inventado$/, rotulo: '/inventado' }],\n\n  // Relatórios. Ver `routes/relatorios.js`.",
    script: 'test-allow-list-suporte.js',
  });

  // ── 9. Rota admitida retirada do teste (deriva do teste) ─────────
  // O inverso: o teste deixa de pedir uma rota que continua admitida. Sem a
  // asserção de coerência, a rota ficaria admitida mas nunca exercitada —
  // exatamente o mesmo falso verde, pela porta do teste.
  mutacao({
    nome: '9. remover /despesas das rotas exercitadas no teste (deriva do teste)',
    ficheiro: 'scripts/test-allow-list-suporte.js',
    de: "'/despesas', '/movimentos', '/contas']",
    para: "'/movimentos', '/contas']",
    script: 'test-allow-list-suporte.js',
  });

  console.log(`\n✓ Testes de mutação passaram (${nTestes} mutações, todas detetadas e revertidas).`);
})().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
