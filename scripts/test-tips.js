// ═══════════════════════════════════════════════════════════════════
// Tips contextuais do backoffice — MOTOR e CATÁLOGO.
//
// O motor (`helpers/tips.js`) é a única camada que decide que sugestão pode ser
// apresentada. Aqui exercita-se essa decisão SEM base de dados: as condições
// são funções puras e a dispensa é um mapa em memória.
//
// Uma dependência é substituída de propósito: o modelo `RecomendacaoEstado`
// (a parte que persiste a dispensa) não existe sem BD. A persistência a sério é
// exercitada à parte, com o modelo em duplo, no fim deste ficheiro.
//
// O que estes testes protegem:
//  · o tip só aparece quando a situação EXISTE mesmo (nenhum zero é um tip);
//  · sem condomínio não há tips (o âmbito é por condomínio);
//  · um gestor não recebe tips cujo destino exige `admin`;
//  · a ordem é por prioridade e é determinística;
//  · dispensar esconde, o prazo expira e o estado real vence o histórico;
//  · dispensar num condomínio não esconde noutro;
//  · identificador manipulado é recusado e a ação é sempre fixa e interna;
//  · os tips e as recomendações do portal não se cruzam (partilham a tabela).
//
// Utilização: node scripts/test-tips.js
// ═══════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Modelo em duplo: este teste não persiste nada por omissão.
const modelsPath = require.resolve(path.join(__dirname, '..', 'models'));
require.cache[modelsPath] = {
  id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [],
  exports: { RecomendacaoEstado: {} },
};

const tips = require('../helpers/tips');
const rec = require('../helpers/recomendacoes');

const DIA = 24 * 60 * 60 * 1000;
const AGORA = Date.parse('2026-09-21T10:00:00.000Z');
const CID = 7;

// ── Contexto de base ────────────────────────────────────────────────
// Um condomínio em ordem: nada a sugerir. Cada teste acrescenta só o que quer
// provar, para que a condição testada seja a única diferença.
const CALMO = {
  condominioId: CID,
  papel: 'admin',
  agora: AGORA,
  fracoes: { n: 12, permilagemTotal: 1000, permilagemOk: true, semTitular: 0 },
  contas: { n: 2, fundoReserva: 1 },
  assembleias: { realizadasSemAta: 0 },
  backup: { destino: 'google_drive', temLigacoes: true },
};

const idsDe = (extra = {}, ctx = CALMO) => tips.elegiveis({ ...ctx, ...extra }).map((t) => t.id);
const umDe = (id, extra = {}, ctx = CALMO, dispensas = {}) =>
  tips.elegiveis({ ...ctx, ...extra }, dispensas).find((t) => t.id === id) || null;

// ── 1. Condomínio em ordem → nenhuma sugestão ─────────────────────
function testeCondominioEmOrdem() {
  assert.deepStrictEqual(idsDe(), [], 'condomínio em ordem: nenhuma sugestão');
  assert.deepStrictEqual(tips.elegiveis(), [], 'sem contexto: nenhuma sugestão');
  assert.strictEqual(tips.escolher(CALMO, {}).total, 0, 'total zero quando está tudo em ordem');
  console.log('  ✓ condomínio em ordem → nenhuma sugestão');
}

// ── 2. Sem condomínio → nada (o âmbito é por condomínio) ──────────
function testeSemCondominio() {
  for (const condominioId of [undefined, null, 0, -1, 'abc', 1.5]) {
    const lista = tips.elegiveis({ ...CALMO, condominioId, fracoes: { n: 0 } });
    assert.deepStrictEqual(lista, [], `condominioId ${String(condominioId)}: sem tips`);
  }
  console.log('  ✓ sem condomínio válido → nenhum tip (âmbito por condomínio)');
}

// ── 3. Estrutura: frações por definir ─────────────────────────────
function testeFracoesPorDefinir() {
  const tip = umDe('fracoes_por_definir', { fracoes: { n: 0, permilagemTotal: 0, permilagemOk: true, semTitular: 0 } });
  assert.ok(tip, 'sem frações: o tip existe');
  assert.strictEqual(tip.tipo, 'conclusao', 'tipo «por completar»');
  assert.strictEqual(tip.acao.url, '/admin/fracoes', 'ação aponta para as frações');
  assert.strictEqual(tip.dismissivel, true, 'pode ser dispensado');
  // Com frações, desaparece — e os tips que dependem de frações não aparecem
  // quando não há nenhuma (não se pede para rever o que não existe).
  assert.strictEqual(umDe('fracoes_por_definir'), null, 'com frações: não aparece');
  assert.strictEqual(umDe('permilagem_incompleta', { fracoes: { n: 0, permilagemOk: false, permilagemTotal: 0 } }), null,
    'sem frações: não se fala de permilagem');
  assert.strictEqual(umDe('fracoes_sem_titular', { fracoes: { n: 0, permilagemOk: true, semTitular: 3 } }), null,
    'sem frações: não se fala de titulares');
  console.log('  ✓ estrutura: sem frações → «por completar» (e os dependentes calam-se)');
}

// ── 4. Estrutura: permilagem que não fecha 1000‰ ──────────────────
function testePermilagemIncompleta() {
  const tip = umDe('permilagem_incompleta', { fracoes: { n: 12, permilagemTotal: 765, permilagemOk: false, semTitular: 0 } });
  assert.ok(tip, 'permilagem a 765‰: o tip existe');
  assert.strictEqual(tip.tipo, 'risco', 'tipo «risco de erro operacional»');
  assert.ok(/765‰/.test(tip.mensagem), 'a mensagem diz o total real');
  assert.ok(/1000‰/.test(tip.mensagem), 'a mensagem diz o total esperado');
  assert.strictEqual(umDe('permilagem_incompleta'), null, 'permilagem a 1000‰: não aparece');
  console.log('  ✓ estrutura: permilagem que não fecha → «risco», com o total real');
}

// ── 5. Estrutura: frações sem titular ────────────────────────────
function testeFracoesSemTitular() {
  const tip = umDe('fracoes_sem_titular', { fracoes: { n: 12, permilagemOk: true, semTitular: 4 } });
  assert.ok(tip, '4 frações sem titular: o tip existe');
  assert.ok(/4 fração/.test(tip.mensagem), 'a mensagem diz quantas');
  assert.strictEqual(umDe('fracoes_sem_titular', { fracoes: { n: 12, permilagemOk: true, semTitular: 0 } }), null,
    'todas com titular: não aparece');
  console.log('  ✓ estrutura: frações sem titular → «por completar», com a contagem');
}

// ── 6. Financeiro: contas e Fundo de Reserva ─────────────────────
function testeContas() {
  const semContas = umDe('contas_por_definir', { contas: { n: 0, fundoReserva: 0 } });
  assert.ok(semContas, 'sem contas: o tip existe');
  assert.strictEqual(semContas.acao.url, '/admin/contas/nova', 'ação aponta para criar conta');
  // Sem contas, o tip do Fundo de Reserva NÃO aparece: não se repetem avisos.
  assert.strictEqual(umDe('conta_fundo_reserva_em_falta', { contas: { n: 0, fundoReserva: 0 } }), null,
    'sem contas: o aviso do Fundo não se soma ao das contas');

  const semFundo = umDe('conta_fundo_reserva_em_falta', { contas: { n: 3, fundoReserva: 0 } });
  assert.ok(semFundo, 'contas sem conta de fundo: o tip existe');
  assert.ok(/Fundo Comum de Reserva/.test(semFundo.mensagem), 'a mensagem nomeia o fundo');
  assert.strictEqual(umDe('conta_fundo_reserva_em_falta', { contas: { n: 3, fundoReserva: 1 } }), null,
    'com conta de fundo: não aparece');
  console.log('  ✓ financeiro: contas e Fundo de Reserva (sem avisos repetidos)');
}

// ── 7. Assembleias: realizadas sem ata ───────────────────────────
function testeAssembleiasSemAta() {
  const tip = umDe('assembleias_sem_ata', { assembleias: { realizadasSemAta: 2 } });
  assert.ok(tip, 'assembleias sem ata: o tip existe');
  assert.ok(/2 assembleia/.test(tip.mensagem), 'a mensagem diz quantas');
  assert.strictEqual(umDe('assembleias_sem_ata', { assembleias: { realizadasSemAta: 0 } }), null,
    'todas com ata: não aparece');
  console.log('  ✓ assembleias: realizadas sem ata → «por completar»');
}

// ── 8. Backups: só neste servidor ────────────────────────────────
function testeBackupSemCopiaExterna() {
  const tip = umDe('backup_sem_copia_externa', { backup: { destino: null, temLigacoes: true } });
  assert.ok(tip, 'sem destino e com ligações: o tip existe');
  assert.strictEqual(tip.tipo, 'compreensao', 'tipo «vale a pena saber»');
  assert.ok(/cópia local continua/.test(tip.mensagem), 'a mensagem tranquiliza: a cópia local continua a ser feita');
  assert.strictEqual(tip.acao.url, '/admin/config/armazenamento', 'ação aponta para o armazenamento');
  // Com destino escolhido, deixa de haver o que sugerir.
  assert.strictEqual(umDe('backup_sem_copia_externa', { backup: { destino: 'dropbox', temLigacoes: true } }), null,
    'com destino escolhido: não aparece');
  // Sem NENHUMA ligação a ação não é sequer possível: a página de armazenamento
  // já explica como ligar um serviço, por isso o tip não repete isso.
  assert.strictEqual(umDe('backup_sem_copia_externa', { backup: { destino: null, temLigacoes: false } }), null,
    'sem ligações: não aparece (a ação não é possível e a página já o explica)');
  console.log('  ✓ backups: só neste servidor → «vale a pena saber», sem alarme');
}

// ── 9. Público: um gestor não recebe tips de admin ───────────────
function testePublico() {
  const contexto = { ...CALMO, backup: { destino: null, temLigacoes: true } };
  const comoAdmin = tips.elegiveis({ ...contexto, papel: 'admin' }).map((t) => t.id);
  const comoGestor = tips.elegiveis({ ...contexto, papel: 'gestor' }).map((t) => t.id);
  assert.ok(comoAdmin.includes('backup_sem_copia_externa'), 'admin vê o tip do armazenamento');
  assert.ok(!comoGestor.includes('backup_sem_copia_externa'), 'gestor NÃO vê o tip do armazenamento (destino exige admin)');
  assert.deepStrictEqual(tips.elegiveis({ ...contexto, papel: 'leitura' }), [], 'papel de leitura: nenhum tip');
  assert.deepStrictEqual(tips.elegiveis({ ...contexto, papel: null }), [], 'sem papel (suporte): nenhum tip');
  // Todos os tips de gestor continuam visíveis ao admin.
  const gestor = tips.elegiveis({ ...contexto, papel: 'gestor', fracoes: { n: 0 } }).map((t) => t.id);
  const admin = tips.elegiveis({ ...contexto, papel: 'admin', fracoes: { n: 0 } }).map((t) => t.id);
  for (const id of gestor) assert.ok(admin.includes(id), `admin também vê «${id}»`);
  console.log('  ✓ público: gestor não recebe tips cujo destino exige admin');
}

// ── 10. Prioridade e ordem determinística ────────────────────────
function testePrioridade() {
  assert.ok(tips.PRIORIDADE.risco > tips.PRIORIDADE.conclusao, 'risco acima de por completar');
  assert.ok(tips.PRIORIDADE.conclusao > tips.PRIORIDADE.compreensao, 'por completar acima de vale a pena saber');
  assert.ok(tips.PRIORIDADE.compreensao > tips.PRIORIDADE.descoberta, 'vale a pena saber acima de funcionalidade pouco óbvia');

  const contexto = {
    ...CALMO,
    fracoes: { n: 12, permilagemTotal: 765, permilagemOk: false, semTitular: 2 },
    contas: { n: 0, fundoReserva: 0 },
  };
  const lista = tips.elegiveis(contexto);
  assert.ok(lista.length >= 3, 'várias situações elegíveis ao mesmo tempo');
  assert.strictEqual(lista[0].id, 'permilagem_incompleta', 'o risco vem primeiro');
  assert.strictEqual(lista[0].prioridade, tips.PRIORIDADE.risco, 'prioridade do primeiro');
  // Ordem estável: avaliar duas vezes dá exatamente a mesma sequência.
  assert.deepStrictEqual(tips.elegiveis(contexto).map((t) => t.id), lista.map((t) => t.id), 'ordem determinística');
  console.log('  ✓ prioridade: risco primeiro e ordem determinística');
}

// ── 11. Limite: apresenta no máximo 3, sem perder o resto ────────
function testeLimite() {
  const contexto = {
    ...CALMO,
    fracoes: { n: 12, permilagemTotal: 765, permilagemOk: false, semTitular: 2 },
    contas: { n: 3, fundoReserva: 0 },
    assembleias: { realizadasSemAta: 1 },
    backup: { destino: null, temLigacoes: true },
  };
  const escolha = tips.escolher(contexto, {});
  assert.strictEqual(escolha.limite, tips.LIMITE_APRESENTACAO, 'limite por omissão');
  assert.strictEqual(escolha.apresentar.length, tips.LIMITE_APRESENTACAO, 'apresenta no máximo o limite');
  assert.ok(escolha.total > escolha.apresentar.length, 'há mais do que os apresentados');
  assert.strictEqual(escolha.outras.length, escolha.total - escolha.apresentar.length, 'as restantes ficam identificadas');
  assert.deepStrictEqual(
    [...escolha.apresentar, ...escolha.outras].map((t) => t.id),
    tips.elegiveis(contexto).map((t) => t.id),
    'não se perde nenhuma: apresentadas + outras = elegíveis'
  );
  // Limite explícito (diagnóstico) e limite zero.
  assert.strictEqual(tips.escolher(contexto, {}, 1).apresentar.length, 1, 'limite 1 é respeitado');
  assert.strictEqual(tips.escolher(contexto, {}, 0).apresentar.length, 0, 'limite 0 não apresenta nada');
  console.log('  ✓ limite: no máximo 3 apresentados, o resto fica elegível');
}

// ── 12. Dispensa: esconde, expira, e o estado real vence ─────────
function testeDispensa() {
  const contexto = { ...CALMO, fracoes: { n: 12, permilagemTotal: 765, permilagemOk: false, semTitular: 0 } };
  const chave = tips.chaveDeDispensa('permilagem_incompleta', CID);
  assert.ok(chave, 'a chave de dispensa existe');

  const dispensas = { [chave]: { dispensada_em: new Date(AGORA), dispensada_ate: new Date(AGORA + 30 * DIA), intervalo_dias: 30 } };
  assert.strictEqual(umDe('permilagem_incompleta', {}, { ...contexto, agora: AGORA }, dispensas), null,
    'dispensado: não aparece');
  assert.strictEqual(umDe('permilagem_incompleta', {}, { ...contexto, agora: AGORA + 10 * DIA }, dispensas), null,
    'dentro do intervalo: continua escondido');
  assert.ok(umDe('permilagem_incompleta', {}, { ...contexto, agora: AGORA + 31 * DIA }, dispensas),
    'passado o intervalo: volta a aparecer');

  // O ESTADO REAL manda: resolvida a permilagem, desaparece mesmo com a dispensa
  // em vigor (e mesmo com a dispensa já expirada).
  const resolvido = { ...CALMO, fracoes: { n: 12, permilagemTotal: 1000, permilagemOk: true, semTitular: 0 } };
  assert.strictEqual(umDe('permilagem_incompleta', {}, { ...resolvido, agora: AGORA + DIA }, dispensas), null,
    'resolvida: desaparece apesar da dispensa em vigor');
  assert.strictEqual(umDe('permilagem_incompleta', {}, { ...resolvido, agora: AGORA + 400 * DIA }, dispensas), null,
    'resolvida: não ressuscita quando a dispensa expira');
  console.log('  ✓ dispensa: esconde, expira, e o estado real vence o histórico');
}

// ── 13. Âmbito: dispensar num condomínio não esconde noutro ──────
function testeAmbitoPorCondominio() {
  const contexto = (condominioId) => ({ ...CALMO, condominioId, fracoes: { n: 0 } });
  const dispensas = {
    [tips.chaveDeDispensa('fracoes_por_definir', 7)]: { dispensada_em: new Date(AGORA), dispensada_ate: new Date(AGORA + 30 * DIA), intervalo_dias: 30 },
  };
  assert.strictEqual(umDe('fracoes_por_definir', {}, contexto(7), dispensas), null, 'condomínio 7: dispensado, não aparece');
  assert.ok(umDe('fracoes_por_definir', {}, contexto(8), dispensas), 'condomínio 8: a dispensa do 7 não o esconde');
  // A chave inclui mesmo o condomínio.
  assert.notStrictEqual(tips.chaveDeDispensa('fracoes_por_definir', 7), tips.chaveDeDispensa('fracoes_por_definir', 8),
    'chaves distintas por condomínio');
  console.log('  ✓ âmbito: a dispensa é por condomínio (não vaza entre condomínios)');
}

// ── 14. Identificador inválido/manipulado ────────────────────────
function testeIdentificadorInvalido() {
  for (const id of ['', 'inexistente', '../../etc/passwd', 'https://exemplo.pt', 'PERMILAGEM_INCOMPLETA',
    'permilagem_incompleta ', null, undefined, 'constructor', '2fa_ativo']) {
    assert.strictEqual(tips.porId(id), null, `id «${String(id)}» não corresponde a nenhum tip`);
    assert.strictEqual(tips.podeDispensar(id), false, `id «${String(id)}» não pode ser dispensado`);
  }
  // A ação NUNCA vem do browser: é sempre da definição e sempre interna.
  for (const tip of tips.elegiveis({ ...CALMO, fracoes: { n: 0 } })) {
    assert.ok(!/^https?:/i.test(tip.acao.url), `ação interna (${tip.acao.url})`);
    assert.ok(tip.acao.url.startsWith('/admin'), `ação dentro do backoffice (${tip.acao.url})`);
  }
  console.log('  ✓ identificador inválido/manipulado → recusado, sem ação arbitrária');
}

// ── 15. Catálogo: nenhum tip inventado, tudo coerente ────────────
function testeCatalogoCoerente() {
  const definicoes = tips.definicoes();
  assert.ok(definicoes.length > 0, 'há tips registados');
  const ids = definicoes.map((d) => d.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'identificadores únicos');
  for (const d of definicoes) {
    assert.ok(d.id.length <= 40, `id «${d.id}» cabe na chave de dispensa`);
    assert.ok(tips.PRIORIDADE[d.tipo] > 0, `tipo ${d.tipo} tem prioridade definida`);
    assert.ok(tips.TIPOS[d.tipo], `tipo ${d.tipo} tem rótulo`);
    assert.ok(['gestor', 'admin'].includes(d.publico), `público de «${d.id}» é um papel real`);
    assert.ok(tips.podeDispensar(d.id), `«${d.id}» é dispensável`);
    // A chave cabe na coluna (STRING(60)).
    assert.ok(tips.chaveDeDispensa(d.id, 123456).length <= 60, `chave de «${d.id}» cabe em 60 caracteres`);
  }
  // Módulos que NÃO existem (placeholders) não podem ter tips: não há estado
  // real a avaliar. Ver docs/TIPS-CONTEXTUAIS.md.
  for (const proibido of ['votacoes', 'tickets', 'seguros', 'amenidades', 'documentos_novos', 'avisos_novos']) {
    assert.ok(!ids.includes(proibido), `não existe tip para «${proibido}»`);
  }

  // ── P34: o motor só conhece papéis de CONDOMÍNIO ──────────────────
  // `helpers/tips.js` decide pelo papel DENTRO do condomínio (`admin`/`gestor`)
  // e não distingue um Super Admin (`users.role_global`, avaliado em
  // `helpers/tenant.js`). Se um tip passasse a exigir «só Super Admin», o CTA
  // seria um beco sem saída: apareceria a quem não o pode abrir — e o motor
  // não teria como o saber. A decisão é NÃO ensinar o motor a distinguir
  // Super Admin (seria um segundo motor de tips, e o Super Admin é um papel de
  // PLATAFORMA, não de condomínio): os CTAs apontam para páginas do
  // backoffice que o papel de condomínio já governa.
  for (const ficheiro of ['helpers/tips.js', 'helpers/tips/contexto.js', 'helpers/tips/registo-administracao.js']) {
    const fonte = fs.readFileSync(path.join(__dirname, '..', ficheiro), 'utf8');
    assert.ok(
      !/apenasSuperAdmin|super_admin|role_global|eSuperAdmin/.test(fonte),
      `${ficheiro} não conhece Super Admin — nenhum CTA pode ficar inalcançável (P34)`
    );
  }
  // Um tip tem sempre título, ação e mensagem (via condição satisfeita).
  for (const tip of tips.elegiveis({
    ...CALMO, fracoes: { n: 0 }, contas: { n: 0 }, assembleias: { realizadasSemAta: 1 },
    backup: { destino: null, temLigacoes: true },
  })) {
    assert.ok(tip.titulo && tip.titulo.length > 3, `«${tip.id}» tem título`);
    assert.ok(tip.mensagem && tip.mensagem.length > 20, `«${tip.id}» tem explicação`);
    assert.ok(tip.acao && tip.acao.texto && tip.acao.url, `«${tip.id}» tem ação`);
    assert.ok(tip.rotulo, `«${tip.id}» tem rótulo do tipo`);
    assert.ok(tip.icone, `«${tip.id}» tem ícone`);
  }
  console.log('  ✓ catálogo: ids únicos, coerentes e sem módulos inexistentes');
}

// ── 16. Tips e recomendações do portal não se cruzam ─────────────
function testeSemCruzamentoComPortal() {
  // Partilham a tabela `recomendacao_estados`, mas cada motor valida a chave
  // contra o SEU registo: um identificador de um nunca é aceite pelo outro.
  assert.strictEqual(tips.podeDispensar('2fa_ativo'), false, 'o motor de tips recusa a recomendação do portal');
  assert.strictEqual(rec.podeDispensar('permilagem_incompleta'), false, 'o motor do portal recusa um tip');
  for (const d of tips.definicoes()) {
    assert.strictEqual(rec.porId(d.id), null, `«${d.id}» não colide com uma recomendação do portal`);
  }
  // As chaves de dispensa têm o prefixo do seu motor.
  assert.ok(tips.chaveDeDispensa('fracoes_por_definir', 7).startsWith('tip:'), 'as chaves de tips são namespaced');
  console.log('  ✓ tips e recomendações do portal não se cruzam (tabela partilhada, registos separados)');
}

// ── 17. Robustez: registos estranhos nunca escondem por engano ────
function testeRegistosRobustos() {
  const contexto = { ...CALMO, fracoes: { n: 0 } };
  const chave = tips.chaveDeDispensa('fracoes_por_definir', CID);
  for (const registo of [null, {}, { dispensada_ate: null, dispensada_em: null }, { dispensada_em: 'não é uma data' }]) {
    const dispensas = { [chave]: registo };
    assert.ok(umDe('fracoes_por_definir', {}, contexto, dispensas),
      `registo ${JSON.stringify(registo)}: não esconde por engano`);
  }
  // Registo antigo sem `dispensada_ate`: usa `dispensada_em` + intervalo.
  const antigo = { dispensada_em: new Date(AGORA), intervalo_dias: 30 };
  assert.strictEqual(umDe('fracoes_por_definir', {}, { ...contexto, agora: AGORA + 10 * DIA }, { [chave]: antigo }), null,
    'registo antigo dentro do intervalo: esconde');
  assert.ok(umDe('fracoes_por_definir', {}, { ...contexto, agora: AGORA + 31 * DIA }, { [chave]: antigo }),
    'registo antigo passado o intervalo: volta a aparecer');
  // Chave de dispensa sem condomínio válido não existe (nunca esconde nada).
  for (const c of [null, undefined, 0, -3, 'x']) {
    assert.strictEqual(tips.chaveDeDispensa('fracoes_por_definir', c), null, `sem condomínio (${String(c)}) não há chave`);
  }
  console.log('  ✓ registos robustos: nunca esconde por engano');
}

// ── 18. Persistência: recusa registos inválidos ──────────────────
async function testePersistenciaInvalida() {
  assert.deepStrictEqual(await tips.carregarDispensas(null), {}, 'sem conta não há dispensas');
  const semConta = await tips.registarDispensa({ userId: null, tip: 'fracoes_por_definir', condominioId: CID });
  assert.strictEqual(semConta.ok, false, 'sem conta não se regista');
  const semAmbito = await tips.registarDispensa({ userId: 1, tip: 'fracoes_por_definir', condominioId: null });
  assert.strictEqual(semAmbito.ok, false, 'sem condomínio não se regista');
  const desconhecido = await tips.registarDispensa({ userId: 1, tip: 'inexistente', condominioId: CID });
  assert.strictEqual(desconhecido.ok, false, 'tip desconhecido não é registado');
  const doPortal = await tips.registarDispensa({ userId: 1, tip: '2fa_ativo', condominioId: CID });
  assert.strictEqual(doPortal.ok, false, 'uma recomendação do portal não é registada pelo motor de tips');
  console.log('  ✓ persistência: recusa registos inválidos');
}

// ── 19. Persistência a sério (modelo em duplo) ───────────────────
async function testePersistenciaComDuplo() {
  // Duplo mínimo do modelo: só o que `registarDispensa`/`carregarDispensas` usam.
  const linhas = [];
  const duplo = {
    findAll: async ({ where }) => linhas.filter((l) => l.user_id === where.user_id),
    findOne: async ({ where }) => {
      const linha = linhas.find((l) => l.user_id === where.user_id && l.recomendacao === where.recomendacao) || null;
      // Como o modelo real: a instância sabe atualizar-se (é o que o motor usa
      // para renovar uma dispensa já existente em vez de a duplicar).
      if (!linha) return null;
      return { ...linha, update: async (campos) => Object.assign(linha, campos) };
    },
    create: async (dados) => { linhas.push({ ...dados }); return dados; },
  };
  // Substitui o modelo já em cache (o motor guarda a referência no momento do require).
  require.cache[modelsPath].exports.RecomendacaoEstado = duplo;
  // `helpers/tips.js` já resolveu `RecomendacaoEstado` no require inicial, pelo
  // que se injeta pela mesma via: um novo require devolve o módulo em cache.
  delete require.cache[require.resolve('../helpers/tips')];
  const tipsComDuplo = require('../helpers/tips');

  const criada = await tipsComDuplo.registarDispensa({ userId: 42, tip: 'fracoes_por_definir', condominioId: CID, agora: AGORA });
  assert.strictEqual(criada.ok, true, 'dispensa registada');
  assert.strictEqual(criada.criada, true, 'primeira vez: criada');
  assert.strictEqual(linhas.length, 1, 'uma linha gravada');
  assert.strictEqual(linhas[0].recomendacao, `tip:fracoes_por_definir@c${CID}`, 'a chave gravada tem o âmbito');
  assert.strictEqual(linhas[0].intervalo_dias, tips.DIAS_REAPRESENTACAO_PADRAO, 'intervalo por omissão');
  assert.strictEqual(new Date(linhas[0].dispensada_ate).getTime() - AGORA, 30 * DIA, 'a dispensa dura 30 dias');

  // Segunda dispensa da mesma chave ATUALIZA em vez de duplicar.
  const repetida = await tipsComDuplo.registarDispensa({ userId: 42, tip: 'fracoes_por_definir', condominioId: CID, agora: AGORA + DIA });
  assert.strictEqual(repetida.criada, false, 'segunda vez: atualizada');
  assert.strictEqual(linhas.length, 1, 'continua a haver uma só linha');

  const carregadas = await tipsComDuplo.carregarDispensas(42);
  assert.ok(carregadas[`tip:fracoes_por_definir@c${CID}`], 'a dispensa é carregada pela chave com âmbito');
  // E o efeito é o esperado na decisão: deixa de aparecer neste condomínio.
  assert.strictEqual(
    tipsComDuplo.elegiveis({ ...CALMO, agora: AGORA + DIA, fracoes: { n: 0 } }, carregadas).find((t) => t.id === 'fracoes_por_definir'),
    undefined,
    'com a dispensa carregada, o tip não é apresentado'
  );
  console.log('  ✓ persistência a sério: grava, atualiza e volta a ler (chave com âmbito)');
}

// ── 20. Apresentação: o parcial mostra o que o motor decidiu ─────
function testeParcialRenderiza() {
  const fs = require('fs');
  const handlebars = require('handlebars');
  // Registam-se os helpers REAIS da aplicação antes de compilar: o parcial é
  // renderizado com a mesma instância que a app usa. Sem isto, um parcial que
  // passe a usar um helper da aplicação falharia aqui com «Missing helper» —
  // um falso negativo do harness, não um defeito do produto (foi exatamente o
  // que aconteceu com o helper `ne`, que existe em
  // `helpers/handlebars-helpers.js`).
  const appHelpers = require('../helpers/handlebars-helpers');
  Object.entries(appHelpers).forEach(([nome, fn]) => handlebars.registerHelper(nome, fn));
  const parcial = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', '_tips.handlebars'), 'utf8');
  const template = handlebars.compile(parcial);

  // Sem tips (ou sem contexto) → nada é apresentado, nem o cabeçalho da secção.
  const vazio = template({ tips: { apresentar: [], total: 0, outras: [], limite: 0 } });
  assert.strictEqual(vazio.trim(), '', 'sem tips: saída vazia');
  assert.ok(!template({}).includes('Sugestões'), 'sem contexto: a secção não aparece');
  assert.ok(!template({}).includes('Dispensar'), 'sem contexto: nenhum botão');

  // Com tips → título, explicação, ação e dispensa, tal como o motor decidiu.
  const escolha = tips.escolher(
    { ...CALMO, fracoes: { n: 12, permilagemTotal: 765, permilagemOk: false, semTitular: 0 } },
    {}
  );
  const html = template({ tips: escolha });
  assert.ok(html.includes('Sugestões'), 'com tips: a secção aparece');
  assert.ok(html.includes('A permilagem das frações não soma 1000‰'), 'o título é apresentado');
  assert.ok(html.includes('765‰'), 'a explicação é apresentada');
  assert.ok(html.includes('Atenção ao cálculo'), 'o rótulo do tipo é apresentado');
  assert.ok(html.includes('href="/admin/fracoes"'), 'a ação é apresentada');
  assert.ok(html.includes('action="/admin/tips/permilagem_incompleta/dispensar"'), 'a dispensa é apresentada');
  assert.ok(html.includes('method="POST"'), 'a dispensa é um POST');
  // O parcial nunca decide: não inventa condições nem destinos.
  assert.ok(!html.includes('fracoes_por_definir'), 'só se apresenta o tip elegível');

  // Destino de regresso: o parcial LIMITA-SE a transportar o valor que a página
  // indicou em `tips.voltar` (quem o valida é a rota, com lista fechada). Sem
  // `voltar` não há campo nenhum — o servidor cai em `/admin`.
  const comVoltar = template({ tips: { ...escolha, voltar: '/admin/config/armazenamento' } });
  assert.ok(
    comVoltar.includes('<input type="hidden" name="voltar" value="/admin/config/armazenamento">'),
    'com `voltar`: o campo é transportado no formulário'
  );
  assert.ok(!html.includes('name="voltar"'), 'sem `voltar`: nenhum campo de regresso é inventado');
  console.log('  ✓ apresentação: o parcial mostra exatamente o que o motor decidiu');
}

// ── Execução ────────────────────────────────────────────────────────
(async () => {
  testeCondominioEmOrdem();
  testeSemCondominio();
  testeFracoesPorDefinir();
  testePermilagemIncompleta();
  testeFracoesSemTitular();
  testeContas();
  testeAssembleiasSemAta();
  testeBackupSemCopiaExterna();
  testePublico();
  testePrioridade();
  testeLimite();
  testeDispensa();
  testeAmbitoPorCondominio();
  testeIdentificadorInvalido();
  testeCatalogoCoerente();
  testeSemCruzamentoComPortal();
  testeRegistosRobustos();
  testeParcialRenderiza();
  await testePersistenciaInvalida();
  await testePersistenciaComDuplo();
  console.log('✓ Testes dos tips contextuais passaram (sem base de dados).');
})().catch((err) => {
  console.error('✗ ' + err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
