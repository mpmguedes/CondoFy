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
const backupMut = require('./helpers/backup-mutacao');
const correrProc = require('./helpers/correr-processo');

const RAIZ = path.join(__dirname, '..');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
let nTestes = 0;
const feito = (nome) => { nTestes += 1; console.log(`  ✓ ${nome}`); };
const titulo = (t) => console.log(`\n── ${t}`);

// Corre um script de teste num processo separado e devolve `true` se PASSOU.
//
// ⚠️ Distingue-se «o teste FALHOU» de «o teste foi INTERROMPIDO». Uma execução
// morta pelo `timeout` (SIGTERM) também é apanhada pelo `catch`, mas NÃO é uma
// deteção: trata-se de um processo sem desfecho. Se for tomada por deteção, a
// mutação dá-se por boa num estado em que pode não ter sido restaurada — foi
// assim que uma execução interrompida deixou `routes/documentos.js` mutado no
// working copy e a suíte a falhar no T4.0 com uma «regressão» fantasma.
const RESULTADO = { PASSOU: 'passou', FALHOU: 'falhou', INTERROMPIDO: 'interrompido' };

function resultadoDoTeste(script) {
  // ⛔ P53-FOLLOWUP: o filho corre com stdin em `ignore` (ver o helper). Sem
  // isto, um `EBUSY` do host fazia o filho NUNCA arrancar e o `catch` lia esse
  // erro de infraestrutura como «o teste FALHOU» — isto é, como mutação
  // detetada. Por isso a execução passa por `correrProc`, que distingue
  // «correu e falhou» (deteção) de «não chegou a correr» (aborta).
  const r = correrProc.executarOuFalhar(process.execPath, [path.join(RAIZ, 'scripts', script)], {
    cwd: RAIZ, timeout: 120000,
  });
  // `executarOuFalhar` já abortou em falha de spawn; resta separar o desfecho.
  if (r.estado === correrProc.ESTADO.PASSOU) return RESULTADO.PASSOU;
  return r.estado === correrProc.ESTADO.INTERROMPIDO ? RESULTADO.INTERROMPIDO : RESULTADO.FALHOU;
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

  // Backup ao lado (nunca `git checkout`). O nome guarda o CAMINHO do alvo,
  // relativizado e sem barras, para que um órfão deixado por uma execução morta
  // a meio possa ser REPOSTO pelo varrimento de arranque em vez de só apagado.
  // Sem isto, uma interrupção entre a mutação e o `finally` deixava o ficheiro
  // mutado para sempre e a suíte a acusar uma regressão que não existe.
  const bkp = backupMut.criar({ alvo, ficheiro, raiz: RAIZ });

  try {
    assert.ok(original.includes(de),
      `mutação impossível: o padrão a mutar não existe em ${ficheiro}`);
    const mutado = global
      ? original.split(de).join(para)
      : original.replace(de, para);
    assert.notStrictEqual(mutado, original, `mutação ${nome}: nada mudou`);
    fs.writeFileSync(alvo, mutado);

    const resultado = resultadoDoTeste(script);
    // Uma execução interrompida não prova nada — e, sobretudo, não pode ser
    // confundida com uma deteção. Aborta já (o `finally` repõe o ficheiro).
    assert.notStrictEqual(resultado, RESULTADO.INTERROMPIDO,
      `execução interrompida (timeout/SIGTERM) ao testar «${nome}»: inconclusivo, ` +
      'a mutação não conta como detetada — voltar a correr');
    assert.notStrictEqual(resultado, RESULTADO.PASSOU,
      `mutação NÃO detetada: ${script} continuou a passar com «${nome}» aplicada`);
    feito(`«${nome}» → ${script} FALHA (a mutação é detetada)`);
  } finally {
    // Restauro byte a byte + verificação por hash.
    backupMut.restaurar(bkp);
    backupMut.limpar(bkp);
    assert.strictEqual(hash(fs.readFileSync(alvo, 'utf8')), hashOriginal,
      `restauro de ${ficheiro} não ficou idêntico ao original`);
  }
}

(async () => {
  console.log('T8 — testes de mutação do suporte diagnóstico');

  // Varrimento de arranque: se uma execução anterior foi morta a meio (SIGTERM,
  // timeout, Ctrl-C), ficou um backup órfão E — o que é pior — o ficheiro alvo
  // ficou MUTADO no working copy. Apanhar o órfão e apagá-lo não bastava: o
  // conteúdo mutado ficava para sempre e a suíte passava a acusar uma regressão
  // que não existe (foi exatamente o que aconteceu com `routes/documentos.js`).
  //
  // Cada backup é uma CÓPIA INTEGRAL do original, pelo que o órfão se REPÕE. O
  // `.alvo` diz em que ficheiro; sem ele não se adivinha o destino e o backup é
  // conservado para inspeção (nunca se apaga prova).
  backupMut.varrerResiduos({ raiz: RAIZ });

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

  // ── 10. A decisão única de vista deixa de consultar `req.suporte` ─
  // É o defeito EXATO do ACHADO-01, na sua forma mínima e ALCANÇÁVEL: a função
  // que decide a vista passa a devolver sempre a vista do condomínio. Os três
  // ramos que hoje fazem `res.render(vistaDeDocumentos(req, …))` — incluindo os
  // dois de recibos (`recibos-anos`, `recibos`) — deixam de minimizar em
  // suporte. O T4.0 tem de detetar que o suporte passou a receber a vista
  // administrativa.
  //
  // A mutação é feita na FUNÇÃO DE DECISÃO, não num `return` de ramo: repor um
  // nome literal num ramo específico não bastaria para o teste morder, porque a
  // decisão continuaria a minimizar. O risco que importa é a remoção do
  // princípio (a vista depende de `req.suporte`), não a de uma ocorrência.
  mutacao({
    nome: '10. a decisão de vista deixa de consultar req.suporte (ACHADO-01)',
    ficheiro: 'routes/documentos.js',
    de: '  return req.suporte ? VISTA_SUPORTE : `admin/documentos/${alvo}`;',
    para: '  return `admin/documentos/${alvo}`;',
    script: 'test-t4-suporte-isolamento.js',
  });

  // ── 11. O ramo de recibos volta a RENDERIZAR SEM CONSULTAR o suporte ─
  // A forma exata que o ACHADO-01 tinha: o ramo `?pasta=recibos` faz
  // `return res.render(<vista de gestão>)` com o nome LITERAL, decidindo a
  // vista por si ANTES da decisão única. É a mutação que repõe o defeito
  // ORIGINAL, e o T4.0 tem de a apanhar.
  //
  // A asserção correspondente NÃO é «o handler tem de ter um `return`»: é «em
  // suporte só a vista minimizada pode ser renderizada». Um ramo que renderize
  // por si continua correto desde que renderize a vista minimizada.
  mutacao({
    nome: '11. ramo de recibos volta a renderizar sem consultar o suporte (ACHADO-01)',
    ficheiro: 'routes/documentos.js',
    de: "      return res.render(vistaDeDocumentos(req, 'recibos-anos'), {",
    para: "      return res.render('admin/documentos/recibos-anos', {",
    script: 'test-t4-suporte-isolamento.js',
  });

  // ── 12. A vista de gestão dos recibos perde a capacidade de gestão ─
  // O T6.c fixa que `recibos.handlebars` é uma vista de GESTÃO (tem «Enviar por
  // email»/«Eliminar» e imprime o UID). Se essa capacidade desaparecer, a
  // justificação para a excluir do suporte muda — e a decisão tem de ser
  // revista, não herdada. A mutação remove a ligação de eliminação.
  mutacao({
    nome: '12. vista de gestão dos recibos perde a ação de eliminar (base da exclusão)',
    ficheiro: 'views/admin/documentos/recibos.handlebars',
    de: '<form action="/admin/documentos/{{id}}/eliminar" method="POST"',
    para: '<form action="/admin/documentos/{{id}}/inativo" method="POST"',
    script: 'test-mascara-vistas.js',
  });

  // ═══════════════════════════════════════════════════════════════════
  // ACHADO-02 — auditoria da consulta
  // ═══════════════════════════════════════════════════════════════════

  // ── 13. A telemetria deixa de registar a rota REAL (passa nula) ────
  // Muta a fonte do dado: `req.path` → `undefined`. O evento continua a ser
  // criado (a ação existe), mas sem rota — e é isso que o T4.5(a) e o
  // test-suporte medem. Prova que a asserção morde o CONTEÚDO, não a existência
  // do evento.
  mutacao({
    nome: '13. o registo da consulta deixa de usar req.path (rota perdida)',
    ficheiro: 'helpers/tenant.js',
    de: '    rota: req.path,',
    para: '    rota: undefined,',
    script: 'test-t4-suporte-isolamento.js',
  });

  // ── 14. O registo passa a ser condicionado (deixa de registar TODOS) ─
  // O contrato é «cada consulta admitida deixa o SEU evento». Aqui o registo
  // passa a ser suprimido quando a rota é `/documentos` — o T4.5(a)/(c)/(d) e o
  // test-suporte (D) contam eventos, pelo que a supressão tem de ser detetada.
  // Prova que os testes medem a COMPLETUDE do registo, não só a sua existência.
  mutacao({
    nome: '14. o registo passa a ser condicionado (uma rota deixa de ser registada)',
    ficheiro: 'helpers/suporte.js',
    de: '  if (!Number.isFinite(id) || id <= 0) return false;',
    para: "  if (!Number.isFinite(id) || id <= 0) return false;\n  if (rota === '/documentos') return false;",
    script: 'test-t4-suporte-isolamento.js',
  });

  // ── 15. A rota registada passa a incluir a query string ───────────
  // `req.path` → `req.originalUrl`. O evento continua a existir, mas a rota
  // deixa de ser canónica: `/documentos?pasta=recibos` passa a ser gravado na
  // íntegra. O T4.5(b) verifica que «recibos»/«2026» NÃO aparecem no evento.
  mutacao({
    nome: '15. a rota registada passa a incluir a query string (não canónica)',
    ficheiro: 'helpers/tenant.js',
    de: '    rota: req.path,',
    para: '    rota: req.originalUrl,',
    script: 'test-t4-suporte-isolamento.js',
  });

  // ── 16. O registo deixa de acontecer (telemetria removida) ────────
  // Mutação de EXISTÊNCIA: sem a chamada no guard, nenhum evento é criado. É a
  // base de tudo — se esta passasse, as restantes seriam irrelevantes.
  mutacao({
    nome: '16. o guard deixa de registar a consulta (telemetria removida)',
    ficheiro: 'helpers/suporte-allowlist.js',
    de: '        tenant.auditarConsulta(req);\n',
    para: '',
    script: 'test-suporte.js',
  });

  // ── 17. O acesso vigente ANTERIOR deixa de ser fechado (P58) ──────
  // É a regressão ORIGINAL do ACHADO-04: `iniciar()` criava sempre um registo
  // novo e deixava o anterior `ativo` até expirar. Aqui remove-se a limpeza por
  // completo — o novo acesso é criado sem que nada feche o anterior.
  //
  // O teste que a deteta é `test-suporte-unicidade.js`, e fá-lo no caso 11, onde
  // a constraint da BD está DELIBERADAMENTE desligada: com a rede da BD ligada,
  // o índice único mascararia a remoção da lógica da aplicação e a mutação
  // passaria por acidente.
  mutacao({
    nome: '17. o acesso vigente anterior deixa de ser fechado (P58)',
    ficheiro: 'helpers/suporte.js',
    de: '  const anteriores = await encerrarVigentesDoPar({\n'
      + '    utilizadorId: req.user.id,\n'
      + '    condominioId,\n'
      + '    req,\n'
      + '    atorId: req.user.id,\n'
      + '  });',
    para: '  const anteriores = { total: 0, terminados: 0, ids: [] };',
    script: 'test-suporte-unicidade.js',
  });

  // ── 18. A limpeza passa a fechar os acessos ERRADOS (P58) ─────────
  // O filtro passa a selecionar os estados TERMINAIS em vez dos VIVOS: a
  // limpeza corre, não rebenta, e não fecha nada do que interessa. É o modo de
  // falha mais traiçoeiro dos dois — parece que a lógica existe. Deixa outra
  // vez dois acessos vivos do mesmo par.
  mutacao({
    nome: '18. a limpeza passa a fechar os acessos terminais em vez dos vivos (P58)',
    ficheiro: 'helpers/suporte.js',
    de: "        estado: { [require('sequelize').Op.notIn]: ESTADOS_TERMINAIS },",
    para: "        estado: { [require('sequelize').Op.in]: ESTADOS_TERMINAIS },",
    script: 'test-suporte-unicidade.js',
  });

  console.log(`\n✓ Testes de mutação passaram (${nTestes} mutações, todas detetadas e revertidas).`);
})().catch((e) => {
  console.error('✗ FALHA:', e.message);
  process.exit(1);
});
