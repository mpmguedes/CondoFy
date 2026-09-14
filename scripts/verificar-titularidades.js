// ─────────────────────────────────────────────────────────────────────
// Verificação da tabela `fracao_titularidades` numa MariaDB real (READ-ONLY).
//
// Usar DEPOIS de `npm run db:migrate`, com o .env a apontar para a base de
// dados (o mesmo .env da aplicação):
//
//   npm run db:migrate
//   node scripts/verificar-titularidades.js                  # resume
//   node scripts/verificar-titularidades.js --amostra 10      # mostra 10 linhas
//
// O que confirma: a tabela existe com as colunas certas, os três índices, os
// TIPOS ENUM que a MariaDB cria, o preenchimento inicial a partir de
// `fracao_pessoas` (contagens, datas, contas ligadas) e a coerência dos
// períodos (sem titular cessado marcado como ativo, sem sobreposições para o
// mesmo vínculo). Não escreve nada: só faz SELECT/SHOW.
// ─────────────────────────────────────────────────────────────────────
'use strict';

const { Sequelize } = require('sequelize');
const config = require('../config/config');

const env = process.env.NODE_ENV || 'development';
const cfg = config[env];
const sequelize = new Sequelize(cfg.database, cfg.username, cfg.password, {
  host: cfg.host,
  port: cfg.port,
  dialect: cfg.dialect,
  logging: false,
  timezone: cfg.timezone,
});

const args = process.argv.slice(2);
const posicional = (nome, porOmissao) => {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : porOmissao;
};
const AMOSTRA = posicional('amostra', 0);

const falhas = [];
const avisos = [];
const ok = [];
const falhar = (m) => { falhas.push(m); console.log(`  ✗ ${m}`); };
const avisar = (m) => { avisos.push(m); console.log(`  ! ${m}`); };
const passar = (m) => { ok.push(m); console.log(`  ✓ ${m}`); };

async function consultar(sql, replacements) {
  const [linhas] = await sequelize.query(sql, { replacements });
  return linhas;
}

async function main() {
  await sequelize.authenticate();
  console.log(`Base de dados: ${cfg.database}@${cfg.host}:${cfg.port}\n`);

  // ── 1. A tabela existe e tem as colunas esperadas ─────────────────
  console.log('1. Estrutura da tabela');
  const colunas = await consultar('SHOW COLUMNS FROM fracao_titularidades');
  if (!colunas.length) {
    falhar('tabela `fracao_titularidades` não existe — a migration não correu?');
    return;
  }
  const porCampo = new Map(colunas.map((c) => [c.Field, c]));
  const esperadas = {
    condominio_id: 'int unsigned',
    fracao_id: 'int unsigned',
    pessoa_id: 'int unsigned',
    utilizador_id: 'int unsigned',
    vinculo: 'enum',
    data_inicio: 'date',
    data_fim: 'date',
    estado: 'enum',
    motivo_cessacao: 'varchar',
    created_by: 'int unsigned',
  };
  for (const [campo, tipo] of Object.entries(esperadas)) {
    const c = porCampo.get(campo);
    if (!c) { falhar(`falta a coluna ${campo}`); continue; }
    if (!String(c.Type).toLowerCase().startsWith(tipo)) falhar(`coluna ${campo}: tipo ${c.Type} (esperado ${tipo}…)`);
  }
  if (Object.keys(esperadas).every((c) => porCampo.has(c))) passar(`${colunas.length} colunas, com os campos esperados`);
  const vinculo = porCampo.get('vinculo');
  const estado = porCampo.get('estado');
  if (vinculo && /proprietario/.test(vinculo.Type) && /arrendatario/.test(vinculo.Type) && /usufrutuario/.test(vinculo.Type)) {
    passar(`ENUM vinculo: ${vinculo.Type}`);
  } else if (vinculo) {
    falhar(`ENUM vinculo inesperado: ${vinculo.Type}`);
  }
  if (estado && /ativa/.test(estado.Type) && /cessada/.test(estado.Type)) {
    passar(`ENUM estado: ${estado.Type}`);
  } else if (estado) {
    falhar(`ENUM estado inesperado: ${estado.Type}`);
  }

  // ── 2. Índices ────────────────────────────────────────────────────
  console.log('\n2. Índices');
  const indices = await consultar('SHOW INDEX FROM fracao_titularidades');
  const porNome = new Map();
  for (const i of indices) {
    if (!porNome.has(i.Key_name)) porNome.set(i.Key_name, { colunas: [], unique: Number(i.Non_unique) === 0 });
    porNome.get(i.Key_name).colunas.push(i.Column_name);
  }
  for (const nome of ['ft_condominio_fracao_estado', 'ft_utilizador_estado', 'ft_pessoa_estado']) {
    const idx = porNome.get(nome);
    if (idx) passar(`${nome} (${idx.colunas.join(', ')})`);
    else falhar(`índice ${nome} em falta`);
  }
  const unicos = [...porNome.entries()].filter(([nome, i]) => i.unique && nome !== 'PRIMARY');
  if (unicos.length) falhar(`índices únicos inesperados: ${unicos.map(([n]) => n).join(', ')} (o histórico exige vários períodos)`);
  else passar('sem índices únicos além da chave primária');

  // ── 3. Tipos ENUM da MariaDB (ficam no esquema) ───────────────────
  console.log('\n3. Tipos ENUM da MariaDB');
  const tipos = await consultar(
    `SELECT TYPE_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fracao_titularidades' AND DATA_TYPE = 'enum'`
  );
  if (tipos.length) passar(`${tipos.length} tipo(s) ENUM presentes: ${tipos.map((t) => t.TYPE_NAME).join(', ')}`);
  else avisar('sem tipos ENUM no esquema (a MariaDB não os criou — não afeta o funcionamento)');

  // ── 4. Preenchimento inicial ──────────────────────────────────────
  console.log('\n4. Preenchimento inicial (a partir de fracao_pessoas)');
  const [{ n: nTitulos }] = await consultar('SELECT COUNT(*) AS n FROM fracao_titularidades');
  const [{ n: nVinculos }] = await consultar('SELECT COUNT(*) AS n FROM fracao_pessoas');
  console.log(`  titularidades: ${nTitulos} · vínculos antigos (fracao_pessoas): ${nVinculos}`);
  const [{ semVinculo }] = await consultar(
    `SELECT COUNT(*) AS semVinculo FROM fracao_titularidades t
      LEFT JOIN fracao_pessoas fp
        ON fp.fracao_id = t.fracao_id AND fp.pessoa_id = t.pessoa_id AND fp.vinculo = t.vinculo
      WHERE fp.id IS NULL`
  );
  if (Number(nTitulos) === 0 && Number(nVinculos) > 0) {
    falhar(`há ${nVinculos} vínculo(s) antigos e nenhuma titularidade: o preenchimento inicial não correu`);
  } else if (Number(semVinculo) > 0) {
    avisar(`${semVinculo} titularidade(s) criadas pela aplicação (não vêm de fracao_pessoas) — esperado se já houve alterações de titular`);
  } else if (Number(nTitulos) >= Number(nVinculos)) {
    passar('todas as titularidades correspondem a vínculos antigos (preenchimento inicial completo)');
  } else {
    avisar(`menos titularidades (${nTitulos}) do que vínculos antigos (${nVinculos}) — confirme se algum foi removido na administração`);
  }

  const [{ datas }] = await consultar(
    'SELECT COUNT(*) AS datas FROM fracao_titularidades WHERE data_inicio IS NULL'
  );
  if (Number(datas) === 0) passar('todas as titularidades têm data de início');
  else avisar(`${datas} titularidade(s) sem data de início (dados anteriores sem data de criação)`);

  const Orf = await consultar(
    `SELECT COUNT(*) AS n FROM fracao_titularidades
      WHERE pessoa_id IS NULL AND utilizador_id IS NULL`
  );
  if (Number(Orf[0].n) === 0) passar('todas as titularidades identificam uma pessoa ou uma conta');
  else avisar(`${Orf[0].n} titularidade(s) sem pessoa e sem conta (não concedem acesso a ninguém)`);

  // ── 5. Coerência dos períodos ─────────────────────────────────────
  console.log('\n5. Coerência dos períodos');
  const [{ incoerentes }] = await consultar(
    `SELECT COUNT(*) AS incoerentes FROM fracao_titularidades
      WHERE (estado = 'ativa' AND data_fim IS NOT NULL AND data_fim < CURDATE())
         OR (estado = 'cessada' AND data_fim IS NULL)
         OR (data_inicio IS NOT NULL AND data_fim IS NOT NULL AND data_fim < data_inicio)`
  );
  if (Number(incoerentes) === 0) passar('nenhum período incoerente (estado vs datas, início ≤ fim)');
  else falhar(`${incoerentes} período(s) incoerentes: estado/datas a corrigir`);

  const sobrepostos = await consultar(
    `SELECT a.id AS a_id, b.id AS b_id, a.fracao_id, a.vinculo, a.pessoa_id
       FROM fracao_titularidades a
       JOIN fracao_titularidades b
         ON a.fracao_id = b.fracao_id AND a.vinculo = b.vinculo AND a.id < b.id
        AND a.estado = 'ativa' AND b.estado = 'ativa'
        AND (a.pessoa_id <=> b.pessoa_id) = 0
      LIMIT 5`
  );
  if (!sobrepostos.length) passar('sem dois titulares ATIVOS diferentes com o mesmo vínculo na mesma fração');
  else falhar(`${sobrepostos.length} situação(ões) de dois titulares ativos com o mesmo vínculo (mudança de proprietário a meio): ids ${sobrepostos.map((s) => `${s.a_id}/${s.b_id} (fração ${s.fracao_id})`).join(', ')}`);

  const [{ contasAmbiguas }] = await consultar(
    `SELECT COUNT(*) AS contasAmbiguas FROM (
        SELECT t.id FROM fracao_titularidades t
        JOIN users u ON u.pessoa_id = t.pessoa_id AND u.pessoa_id IS NOT NULL
        GROUP BY t.id HAVING COUNT(*) > 1
      ) x`
  );
  if (Number(contasAmbiguas) === 0) passar('sem titularidades com mais de uma conta associada à mesma pessoa');
  else avisar(`${contasAmbiguas} titularidade(s) em que a pessoa tem mais de uma conta (a autorização decide pelas datas/vínculo, mas vale a pena arrumar em Utilizadores)`);

  // ── 6. Ligação à conta (utilizador_id) ────────────────────────────
  console.log('\n6. Contas ligadas');
  const [{ comConta }] = await consultar('SELECT COUNT(*) AS comConta FROM fracao_titularidades WHERE utilizador_id IS NOT NULL');
  const [{ semConta }] = await consultar('SELECT COUNT(*) AS semConta FROM fracao_titularidades WHERE utilizador_id IS NULL AND pessoa_id IS NOT NULL');
  console.log(`  com conta: ${comConta} · sem conta (titular registado, sem acesso): ${semConta}`);
  const [{ contaDeOutraPessoa }] = await consultar(
    `SELECT COUNT(*) AS contaDeOutraPessoa FROM fracao_titularidades t
      JOIN users u ON u.id = t.utilizador_id
      WHERE t.pessoa_id IS NOT NULL AND u.pessoa_id IS NOT NULL AND u.pessoa_id <> t.pessoa_id`
  );
  if (Number(contaDeOutraPessoa) === 0) passar('nenhuma titularidade liga a conta de outra pessoa');
  else falhar(`${contaDeOutraPessoa} titularidade(s) ligam uma conta que pertence a outra pessoa (incoerência grave)`);

  // ── 7. Amostra (opcional) ─────────────────────────────────────────
  if (AMOSTRA > 0) {
    console.log(`\n7. Amostra (${AMOSTRA} linhas mais recentes)`);
    const amostra = await consultar(
      `SELECT t.id, t.condominio_id, t.fracao_id, f.designacao, t.pessoa_id, p.nome AS pessoa,
              t.utilizador_id, t.vinculo, t.data_inicio, t.data_fim, t.estado, t.motivo_cessacao
         FROM fracao_titularidades t
         LEFT JOIN fracoes f ON f.id = t.fracao_id
         LEFT JOIN pessoas p ON p.id = t.pessoa_id
        ORDER BY t.id DESC LIMIT ?`,
      [AMOSTRA]
    );
    for (const l of amostra) {
      console.log(
        `  #${l.id} c${l.condominio_id} fração ${l.fracao_id}${l.designacao ? ` (${l.designacao})` : ''} · ` +
        `${l.vinculo} · ${l.pessoa || l.pessoa_id || '—'}${l.utilizador_id ? ` (conta #${l.utilizador_id})` : ' (sem conta)'} · ` +
        `${l.data_inicio || '—'} → ${l.data_fim || 'em curso'} · ${l.estado}${l.motivo_cessacao ? ` · ${l.motivo_cessacao}` : ''}`
      );
    }
  }

  // ── Resumo ────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Verificações ok: ${ok.length} · avisos: ${avisos.length} · falhas: ${falhas.length}`);
  if (falhas.length) {
    console.log('\nFALHAS:');
    falhas.forEach((f) => console.log(`  · ${f}`));
    process.exitCode = 1;
  } else if (avisos.length) {
    console.log('\nAvisos (não impedem o funcionamento):');
    avisos.forEach((a) => console.log(`  · ${a}`));
  } else {
    console.log('Tudo conforme: a tabela de titularidades está coerente com os dados existentes.');
  }
}

main()
  .catch((err) => {
    console.error(`\n✗ Não foi possível verificar: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
