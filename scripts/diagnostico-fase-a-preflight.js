// ─────────────────────────────────────────────────────────────────────
// DIAGNÓSTICO V1–V6 (SOMENTE LEITURA) — pré-condição da Fase A
// (normalização do cálculo e arredondamento das quotas).
//
// Este ficheiro só executa SELECT. Não existe aqui qualquer
// INSERT / UPDATE / DELETE / ALTER / DROP / CREATE / TRUNCATE, nem chamada a
// Model.create / .update() / .destroy() / .save() / .upsert() / bulkCreate.
//
// Utilização (no servidor de produção, com BD ligada):
//   cd /opt/condofy && node scripts/diagnostico-fase-a-preflight.js
//
// V1 — quotas `pendente` futuras, por condomínio (frações distintas, min/max venc.)
// V2 — baseline de `parcialmente_paga` e `paga`, por condomínio
// V3 — soma da permilagem e grupos de igualdade EXATA, por condomínio
// V4 — distribuição de `valor_por_1000` e `fcr_percentagem` gravados
// V5 — confirmação do scope em routes/financeiro.js (getQuotaConfig() sem âmbito)
// V6 — testes/fixtures que fixam valores do comportamento antigo
//
// REGRA ANTI-BUG: nenhuma agregação de `permilagem` ou `valor` é feita sobre
// um JOIN com quotas. As agregações por fração usam subquery escalar, para não
// multiplicar linhas (o erro clássico do SUM sobre JOIN).
// ─────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { QueryTypes } = require('sequelize');

const RAIZ = path.join(__dirname, '..');

function linha(titulo) {
  console.log('');
  console.log('─'.repeat(72));
  console.log(titulo);
  console.log('─'.repeat(72));
}

function eur(c) {
  const sinal = c < 0 ? '-' : '';
  const n = Math.abs(Number(c) || 0);
  return `${sinal}${Math.floor(n / 100)},${String(n % 100).padStart(2, '0')} €`;
}

function txt(v, largura) {
  const s = String(v === null || v === undefined ? '' : v);
  if (s.length === largura) return s;
  if (s.length < largura) return s + ' '.repeat(largura - s.length);
  return s.slice(0, largura - 1) + '…';
}

function num(v) {
  return Number(v || 0);
}

// ── V0: coerência do próprio diagnóstico contra o schema ─────────────
// Evita o erro clássico de ir a produção com um nome de coluna/estado
// inventado. Lê os modelos e confirma que tudo o que as queries usam existe.

function v0Schema() {
  linha('V0. Coerência do diagnóstico contra o schema (evita erro de coluna)');

  const problemas = [];
  const confirmar = (cond, msg) => {
    if (!cond) problemas.push(msg);
    return cond;
  };

  const quota = lerFicheiro('models/Quota.js') || '';
  const fracao = lerFicheiro('models/Fracao.js') || '';

  const colunasQuota = [
    'condominio_id', 'fracao_id', 'ano', 'mes', 'valor', 'valor_base', 'valor_fcr',
    'valor_por_1000', 'permilagem_aplicada', 'fcr_percentagem', 'data_vencimento', 'estado',
  ];
  for (const c of colunasQuota) {
    // Procura a declaração no modelo, aceitando nomes entre crases ou simples.
    const re = new RegExp(`\\b${c}\\s*:\\s*\\{`);
    const re2 = new RegExp(`\\b${c}\\b`);
    confirmar(re.test(quota) || re2.test(quota), `models/Quota.js não declara «${c}»`);
  }

  const colunasFracao = ['condominio_id', 'designacao', 'permilagem', 'estado'];
  for (const c of colunasFracao) {
    const re = new RegExp(`\\b${c}\\b`);
    confirmar(re.test(fracao), `models/Fracao.js não declara «${c}»`);
  }

  // ⛔ A armadilha real que já custou um erro: `fracao_id` existe em QUOTA mas
  // NÃO em FRACAO. Confirmar que a coluna existe no modelo certo não basta —
  // é preciso confirmar que não é usada contra a tabela errada. Verificar
  // explicitamente que fracoes NÃO tem fracao_id (a chave é `id`), e que a FK
  // em quotas aponta para fracoes.id.
  const fracaoTemFracaoId = /\bfracao_id\s*:/.test(fracao);
  confirmar(
    !fracaoTemFracaoId,
    'models/Fracao.js declara fracao_id (a chave é `id`) — as queries que usam f.fracao_id estão erradas'
  );
  const fracaoTemId = /\bid\s*:\s*\{[^}]*primaryKey/.test(fracao);
  confirmar(fracaoTemId, 'models/Fracao.js não declara `id` como primaryKey');
  if (!fracaoTemFracaoId && fracaoTemId) {
    console.log('  ✓ fracoes: a chave é `id` (NÃO tem `fracao_id`) — a FK é quotas.fracao_id = fracoes.id');
  }

  // Os estados: extrair o ENUM do modelo e confirmar os que as queries usam.
  const mEnum = quota.match(/ENUM\(([^)]*)\)/);
  const estados = mEnum
    ? mEnum[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    : [];
  console.log(`  Estados declarados em models/Quota.js: ${estados.join(', ') || '(não encontrado)'}`);

  const usados = ['pendente', 'parcialmente_paga', 'paga', 'vencida', 'anulada'];
  for (const e of usados) {
    confirmar(estados.includes(e), `o estado «${e}» usado nas queries NÃO existe no ENUM`);
  }

  // Tipos, para saber o que a aritmética de cêntimos vai encontrar.
  const tipos = {};
  for (const m of quota.matchAll(/(\w+):\s*\{\s*type:\s*DataTypes\.([A-Z0-9.()\s,]+)/g)) {
    tipos[m[1]] = m[2].replace(/\s+/g, '');
  }
  const relevantes = ['valor', 'valor_base', 'valor_fcr', 'valor_por_1000', 'permilagem_aplicada', 'fcr_percentagem'];
  console.log('  Tipos relevantes em models/Quota.js:');
  for (const c of relevantes) {
    console.log(`    ${txt(c, 24)} ${tipos[c] || '(não detectado)'}`);
  }
  const permFracao = (fracao.match(/permilagem:\s*\{\s*type:\s*DataTypes\.([A-Z0-9.()\s,]+)/) || [])[1];
  console.log(`    ${txt('fracoes.permilagem', 24)} ${permFracao ? permFracao.replace(/\s+/g, '') : '(não detectado)'}`);

  // ⚠ Consequência para a igualdade EXATA (D3): se permilagem for DECIMAL(7,2),
  // não é possível armazenar 142,857‰ — só 142,86‰. Isto muda a leitura da
  // regra de agrupamento e tem de ser dito em voz alta.
  const dec = /DECIMAL\((\d+),\s*(\d+)\)/.exec(permFracao || '');
  if (dec && Number(dec[2]) < 3) {
    console.log('');
    console.log(`  ⚠ ATENÇÃO: fracoes.permilagem é DECIMAL(${dec[1]},${dec[2]}) — ${dec[2]} casas decimais.`);
    console.log('    Exemplos como «142,857‰» NÃO são representáveis: são gravados como 142,86‰.');
    console.log('    A igualdade exata (D3) compara o valor ARMAZENADO, não o valor pretendido.');
    console.log('    → ver Pontos a decidir (PD-A) no relatório.');
  }

  console.log('');
  if (problemas.length) {
    console.log('  ✗ PROBLEMAS ENCONTRADOS (corrigir antes de ir a produção):');
    for (const p of problemas) console.log(`      · ${p}`);
  } else {
    console.log('  ✓ Todas as colunas e estados usados pelo diagnóstico existem no schema.');
  }

  // ⛔ Validação estática de colunas qualificadas por alias (f.x, q.x).
  // Foi esta a lacuna que deixou passar `f.fracao_id`: o V0 confirmava que
  // `fracao_id` existe (em Quota) mas não que o ALIAS a que estava ligado era o
  // correto. Aqui extraem-se os aliases de cada query e verifica-se cada
  // `alias.coluna` contra o conjunto de colunas do modelo correspondente.
  const colunasPorAlias = {
    f: colunasFracao.concat(['id', 'andar', 'porta', 'transitado', 'observacoes']),
    q: colunasQuota.concat(['id', 'orcamento_id', 'periodo', 'numero_documento', 'data_emissao']),
  };
  const modeloPorAliasTabela = { fracoes: 'f', quotas: 'q' };

  const src = lerFicheiro('scripts/diagnostico-fase-a-preflight.js') || '';
  const errosAlias = [];
  // ⚠ Extrair as queries pelo ponto de chamada `S(\`...\`)`, NÃO por um par
  // genérico de backticks: o ficheiro tem dezenas de backticks em comentários e
  // em fragmentos como `id`, o que faz um pares genérico alinhar mal e nenhuma
  // query chegar a ser analisada (falso verde silencioso — medido: 0 queries).
  const reQuery = /\bS\(\s*`([\s\S]*?)`\s*\)/g;
  let mq;
  while ((mq = reQuery.exec(src)) !== null) {
    const sql = mq[1];
    if (!/\bFROM\s+(fracoes|quotas)\b/i.test(sql)) continue;
    // Aliases efetivamente usados nesta query.
    const usados = new Set();
    for (const t of Object.keys(modeloPorAliasTabela)) {
      const rx = new RegExp(`\\bFROM\\s+${t}\\s+(\\w+)`, 'i');
      const m = sql.match(rx);
      if (m) usados.add(m[1]);
      const rxJ = new RegExp(`\\bJOIN\\s+${t}\\s+(\\w+)`, 'i');
      const mj = sql.match(rxJ);
      if (mj) usados.add(mj[1]);
    }
    // Cada alias.coluna referenciado tem de existir no modelo desse alias.
    for (const al of usados) {
      const cols = colunasPorAlias[al];
      if (!cols) continue;
      const rxUso = new RegExp(`\\b${al}\\.(\\w+)`, 'g');
      let mu;
      while ((mu = rxUso.exec(sql)) !== null) {
        const col = mu[1];
        if (!cols.includes(col)) {
          errosAlias.push(`query usa «${al}.${col}» mas o alias «${al}» não tem essa coluna`);
        }
      }
    }
  }
  console.log('');
  if (errosAlias.length) {
    console.log('  ✗ COLUNAS CONTRA O ALIAS ERRADO:');
    for (const e of [...new Set(errosAlias)]) console.log(`      · ${e}`);
  } else {
    console.log('  ✓ Nenhuma coluna qualificada por alias está contra a tabela errada.');
  }
}


function lerFicheiro(rel) {
  try {
    return fs.readFileSync(path.join(RAIZ, rel), 'utf8');
  } catch (e) {
    return null;
  }
}

// ── V5 / V6: verificações de código (não precisam de BD) ─────────────

function v5ScopeConfig() {
  linha('V5. Âmbito da configuração de quotas (routes/financeiro.js)');

  const ficheiros = [
    'routes/financeiro.js',
    'routes/quotas-modulo.js',
    'routes/orcamento.js',
    'jobs/automatizacao.js',
  ];
  const teste = 'scripts/test-quotas-isolamento.js';

  let totalSemAmbito = 0;
  let totalComAmbito = 0;

  for (const rel of ficheiros) {
    const src = lerFicheiro(rel);
    if (src === null) {
      console.log(`  ${txt(rel, 32)} FICHEIRO NÃO ENCONTRADO`);
      continue;
    }
    const semAmbito = (src.match(/getQuotaConfig\(\s*\)/g) || []).length;
    const comAmbito = (src.match(/getQuotaConfig\([^)]+\)/g) || []).length;
    totalSemAmbito += semAmbito;
    totalComAmbito += comAmbito;
    const marca = semAmbito > 0 ? '  ← A CORRIGIR' : '';
    console.log(
      `  ${txt(rel, 32)} com âmbito: ${String(comAmbito).padStart(2)}   ` +
        `SEM âmbito: ${String(semAmbito).padStart(2)}${marca}`
    );
  }

  console.log('');
  console.log(`  TOTAL: ${totalComAmbito} chamadas com âmbito · ${totalSemAmbito} sem âmbito`);

  // Contexto das ocorrências sem âmbito: número de linha + bloco.
  const fin = lerFicheiro('routes/financeiro.js') || '';
  const linhas = fin.split(/\r?\n/);
  const ocorrencias = [];
  linhas.forEach((l, i) => {
    if (/getQuotaConfig\(\s*\)/.test(l)) ocorrencias.push(i + 1);
  });

  if (ocorrencias.length) {
    console.log('');
    console.log('  Ocorrências sem âmbito em routes/financeiro.js:');
    for (const n of ocorrencias) {
      const ini = Math.max(0, n - 6);
      const bloco = linhas.slice(ini, n + 3);
      const rota = bloco
        .map((l) => (l.match(/\brouter\.(get|post|put|patch|delete)\(\s*'([^']+)'/) || [])[2])
        .filter(Boolean)
        .pop();
      console.log(`    linha ${n}${rota ? `  →  rota mais próxima a montante: ${rota}` : ''}`);
      console.log(`      ${txt(linhas[n - 1].trim(), 68)}`);
    }
  } else {
    console.log('  (nenhuma ocorrência sem âmbito)');
  }

  // O que o teste de isolamento fixa hoje.
  const t = lerFicheiro(teste);
  if (t) {
    console.log('');
    console.log(`  Teste ${teste}:`);
    const esperados = t.match(/assert\.strictEqual\(\s*\((\w+)\.match\([^)]*\)\s*\|\|\s*\[\]\)\.length,\s*(\d+)/g) || [];
    if (esperados.length) {
      for (const e of esperados) {
        const m = e.match(/\((\w+)\.match\(([\s\S]*?)\)\s*\|\|\s*\[\]\)\.length,\s*(\d+)/);
        if (m) {
          const padrao = m[2].replace(/\s+/g, ' ').slice(0, 46);
          console.log(`    fixa o padrão ${txt(padrao, 48)} em ${m[3]} ocorrência(s)`);
        }
      }
    } else {
      console.log('    (não foi possível extrair contagens fixadas por regex — ver o ficheiro)');
    }
    const temSemAmbito = /getQuotaConfig\(\)/.test(t);
    console.log(`    contém asserção sobre getQuotaConfig() sem âmbito: ${temSemAmbito ? 'SIM' : 'não'}`);
  } else {
    console.log('');
    console.log(`  Teste ${teste}: NÃO ENCONTRADO`);
  }

  // A chamada problemática conhecida: é bloco morto (E3) ou rota ativa?
  //
  // ⚠ Lição aprendida: uma versão anterior desta verificação só procurava uma
  // definição posterior do MESMO caminho DENTRO do mesmo ficheiro. Isso é
  // insuficiente — o Express resolve por ORDEM DE MONTAGEM em app.js, e o
  // sombreamento mais comum é ENTRE ficheiros. O veredicto tem de olhar para:
  //   1) app.js: ordem de `app.use(prefixo, router)`;
  //   2) todos os routers montados no MESMO prefixo;
  //   3) quem declara o mesmo método+caminho, e em que ordem.
  const idx779 = linhas.findIndex((l) => /getQuotaConfig\(\s*\)/.test(l));
  if (idx779 >= 0) {
    let rotaMaisProxima = null;
    for (let i = idx779; i >= 0; i--) {
      const m = linhas[i].match(/\brouter\.(get|post|put|patch|delete)\(\s*'([^']+)'/);
      if (m) {
        rotaMaisProxima = { n: i + 1, metodo: m[1], rota: m[2] };
        break;
      }
    }
    // Sombreamento DENTRO do mesmo ficheiro (definição posterior idêntica).
    let sombreadaMesmoFicheiro = false;
    if (rotaMaisProxima) {
      sombreadaMesmoFicheiro = linhas.some(
        (l, i) =>
          i > idx779 &&
          new RegExp(
            `router\\.${rotaMaisProxima.metodo}\\(\\s*'${rotaMaisProxima.rota.replace(/[/:*]/g, '\\$&')}'`
          ).test(l)
      );
    }

    // Sombreamento ENTRE ficheiros, pela ordem de montagem do app.js.
    const analiseMontagem = analisarMontagem(rotaMaisProxima, 'routes/financeiro.js');

    console.log('');
    console.log(`  Contexto da ocorrência sem âmbito (linha ${idx779 + 1}):`);
    console.log(
      `    rota a montante : ${
        rotaMaisProxima
          ? `${rotaMaisProxima.metodo.toUpperCase()} ${rotaMaisProxima.rota} (linha ${rotaMaisProxima.n})`
          : 'não identificada'
      }`
    );
    console.log(
      `    sombra no próprio ficheiro : ${sombreadaMesmoFicheiro ? 'SIM' : 'não'}`
    );

    if (analiseMontagem.disponivel) {
      console.log('    ordem de montagem em app.js (mesmo prefixo):');
      for (const m of analiseMontagem.montagens) {
        const marca = m.ficheiro === 'routes/financeiro.js' ? '  ← este ficheiro' : '';
        const declara = m.declara
          ? `declara ${rotaMaisProxima ? rotaMaisProxima.metodo.toUpperCase() + ' ' + rotaMaisProxima.rota : ''}`
          : `${rotaMaisProxima ? 'não declara ' + rotaMaisProxima.metodo.toUpperCase() + ' ' + rotaMaisProxima.rota : 'não declara'}`;
        console.log(`      ${String(m.ordem).padStart(2)}. ${m.ficheiro.padEnd(30)} ${declara}${marca}`);
      }
      console.log('');
      if (analiseMontagem.primeiroQueServe) {
        const primeiro = analiseMontagem.primeiroQueServe;
        const ehOMesmo = primeiro.ficheiro === 'routes/financeiro.js';
        console.log(
          `    quem serve de facto : ${primeiro.ficheiro} (posição ${primeiro.ordem} na montagem)`
        );
        console.log(
          `    Veredicto           : ${
            ehOMesmo
              ? 'ALCANÇÁVEL — bug de âmbito com efeito em runtime'
              : `código MORTO por sombreamento ENTRE ficheiros — ${primeiro.ficheiro} é montado antes e serve a rota; sem efeito em runtime, a corrigir por higiene`
          }`
        );
      } else {
        console.log('    quem serve de facto : indeterminado (nenhum router montado declara a rota)');
        console.log('    Veredicto           : INDETERMINADO');
      }
    } else {
      console.log(
        `    Veredicto : ${sombreadaMesmoFicheiro ? 'código MORTO (E3) — sem efeito em runtime' : 'ALCANÇÁVEL no próprio ficheiro — mas não foi possível ler app.js para confirmar sombreamento entre ficheiros'}`
      );
    }
  }
}

// ── Análise da ordem de montagem em app.js ──────────────────────────
//
// Deriva, do app.js real, a lista ordenada de `app.use(prefixo, router)` para o
// prefixo da rota em estudo, e determina qual desses routers declara de facto a
// rota. O Express serve o PRIMEIRO que casa.
function analisarMontagem(rota, ficheiroAlvo) {
  const app = lerFicheiro('app.js');
  if (app === null || !rota) return { disponivel: false };

  const prefixo = '/admin'; // o prefixo da rota em estudo (financeiro.js é montado em /admin)

  // Extrair app.use('<prefixo>', <router>) por ordem, e resolver o caminho do router.
  const montagens = [];
  app.split(/\r?\n/).forEach((l, i) => {
    const m = l.match(
      /app\.use\(\s*'([^']+)'\s*,\s*(?:require\(\s*'([^']+)'\s*\)|(\w+))/
    );
    if (!m) return;
    if (m[1] !== prefixo) return;

    let ficheiro = m[2];
    if (!ficheiro && m[3]) {
      // Variável (ex.: rotasQuotasModulo): procurar o require correspondente no topo.
      const varRe = new RegExp(
        `(?:const|let|var)\\s+${m[3]}\\s*=\\s*require\\(\\s*'([^']+)'\\s*\\)`
      );
      const vm = app.match(varRe);
      if (vm) ficheiro = vm[1];
    }
    if (!ficheiro) return;
    if (!ficheiro.startsWith('.')) ficheiro = './' + ficheiro;
    const rel = ficheiro.replace(/^\.\/?/, '');
    const alvo = rel.endsWith('.js') ? rel : rel + '.js';

    // Este router declara a rota?
    const src = lerFicheiro(alvo);
    let declara = false;
    if (src) {
      const rx = new RegExp(
        `router\\.${rota.metodo}\\(\\s*'${rota.rota.replace(/[/:*]/g, '\\$&')}'`
      );
      declara = rx.test(src);
    }
    montagens.push({ ordem: montagens.length + 1, linha: i + 1, ficheiro: alvo, declara });
  });

  const primeiroQueServe = montagens.find((m) => m.declara) || null;
  const disponivel = montagens.some((m) => m.ficheiro === ficheiroAlvo);
  return { disponivel, montagens, primeiroQueServe };
}

// ── V6: testes/fixtures que fixam o comportamento antigo ─────────────

function v6Testes() {
  linha('V6. Testes e fixtures que fixam valores derivados do comportamento antigo');

  const dirScripts = path.join(RAIZ, 'scripts');
  let ficheiros = [];
  try {
    ficheiros = fs.readdirSync(dirScripts).filter((f) => /^test-.*\.js$/.test(f));
  } catch (e) {
    console.log('  Não foi possível ler scripts/.');
    return;
  }

  // Assinaturas do comportamento antigo que a Fase A altera.
  const assinaturas = [
    { id: 'A1', rotulo: 'FCR somado à base (base × pct / 100)', re: /baseC\s*\*\s*(pct|percentagem|P\.?)/i },
    { id: 'A2', rotulo: 'Math.round(totalC / n) repetido (inflação)', re: /new Array\(n\)\.fill\(|dividirEm\s*\(/ },
    { id: 'A3', rotulo: 'floor por mês + resto na última fração', re: /mensalC\[mensalC\.length\s*-\s*1\]|Math\.floor\([^)]*\/\s*nMeses/ },
    { id: 'A4', rotulo: 'resto na última parcela', re: /parcelas\[n\s*-\s*1\]\s*\+=/ },
    { id: 'A5', rotulo: 'tolerância de arredondamento (valor em cêntimos)', re: /<=\s*\d+\s*(?:,|\)|;)?\s*['"`,].*(?:c[êe]ntimo|arredondamento)|toler[âa]ncia.{0,40}c[êe]ntimo/i },
    { id: 'A6', rotulo: 'asserção base/FCR do modo preço com valores literais', re: /\[50,\s*5,\s*55\]/ },
    { id: 'A7', rotulo: 'round(anual / nCobrancas) × ocorrências', re: /Math\.round\(valorAnualC\s*\/\s*nCobrancas\)/ },
    { id: 'A8', rotulo: 'duplicação da fórmula no browser', re: /Math\.round\([^)]*\/\s*1000\s*\*\s*valorPor1000C\)/ },
    { id: 'A9', rotulo: 'contagem de getQuotaConfig() sem âmbito', re: /getQuotaConfig\(\)/ },
  ];

  const achados = [];
  for (const f of ficheiros) {
    const src = lerFicheiro(path.join('scripts', f));
    if (src === null) continue;
    const linhas = src.split(/\r?\n/);
    for (const a of assinaturas) {
      linhas.forEach((l, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(l)) return; // ignorar comentários
        if (a.re.test(l)) {
          achados.push({ ficheiro: `scripts/${f}`, linhaArq: i + 1, sig: a.id, rotulo: a.rotulo, texto: l.trim() });
        }
      });
    }
  }

  // A view (fora de scripts/, mas é onde a fórmula está duplicada).
  const view = lerFicheiro('views/admin/quotas/gerar.handlebars');
  if (view) {
    view.split(/\r?\n/).forEach((l, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
      if (/Math\.round\([^)]*\/\s*1000\s*\*\s*valorPor1000C\)/.test(l)) {
        achados.push({
          ficheiro: 'views/admin/quotas/gerar.handlebars',
          linhaArq: i + 1,
          sig: 'A8',
          rotulo: 'duplicação da fórmula no browser',
          texto: l.trim(),
        });
      }
      if (/Math\.round\(baseC\s*\*\s*pctFcr\(\)\s*\/\s*100\)/.test(l)) {
        achados.push({
          ficheiro: 'views/admin/quotas/gerar.handlebars',
          linhaArq: i + 1,
          sig: 'A1',
          rotulo: 'FCR somado à base (base × pct / 100)',
          texto: l.trim(),
        });
      }
    });
  }

  const porSig = {};
  for (const a of achados) {
    if (!porSig[a.sig]) porSig[a.sig] = [];
    porSig[a.sig].push(a);
  }

  console.log('  Assinaturas do comportamento antigo encontradas em testes/view:');
  console.log('');
  if (!achados.length) {
    console.log('    (nenhuma — verificar manualmente)');
  }
  for (const a of assinaturas) {
    const lista = porSig[a.id] || [];
    const marca = lista.length ? '⚠' : '·';
    console.log(`  ${marca} ${a.id} — ${txt(a.rotulo, 52)} ${String(lista.length).padStart(2)} ocorrência(s)`);
    for (const o of lista.slice(0, 6)) {
      console.log(`        ${txt(`${o.ficheiro}:${o.linhaArq}`, 46)} ${txt(o.texto, 60)}`);
    }
    if (lista.length > 6) console.log(`        … e mais ${lista.length - 6}`);
  }

  // Asserções sobre igualdade/determinismo que possam colidir com a regra nova.
  console.log('');
  console.log('  Asserções que verificam igualdade entre frações idênticas:');
  const reIgual = /igual|mesmo valor|iguais/i;
  let nIgual = 0;
  for (const f of ficheiros) {
    const src = lerFicheiro(path.join('scripts', f));
    if (!src) continue;
    src.split(/\r?\n/).forEach((l, i) => {
      if (/assert/.test(l) && reIgual.test(l)) {
        nIgual++;
        if (nIgual <= 10) console.log(`        ${txt(`scripts/${f}:${i + 1}`, 46)} ${txt(l.trim(), 62)}`);
      }
    });
  }
  if (!nIgual) console.log('        (nenhuma)');

  console.log('');
  console.log('  Ficheiros de teste que importam os motores afetados:');
  const motores = ['quotas-calc', 'distribuicao', 'plano.js', 'relatorio-financeiro', 'recibos'];
  for (const f of ficheiros) {
    const src = lerFicheiro(path.join('scripts', f));
    if (!src) continue;
    const usados = motores.filter((m) => new RegExp(`require\\([^)]*${m.replace('.', '\\.')}`).test(src));
    if (usados.length) {
      console.log(`        ${txt(`scripts/${f}`, 46)} ${usados.join(', ')}`);
    }
  }

  // Inventário linha-a-linha das asserções que fixam valores concretos do
  // comportamento antigo, nos ficheiros que tocam os motores afetados.
  console.log('');
  console.log('  Inventário das asserções a revisitar (valores literais em cêntimos/euros):');

  const alvos = ficheiros.filter((f) => {
    const src = lerFicheiro(path.join('scripts', f));
    return src && /require\([^)]*(quotas-calc|distribuicao|plano|relatorio-financeiro|recibos)/.test(src);
  });

  const reLiteral = /assert[^;]*?(?:\d+,\s*\d+\s*€|\b\d{2,}\s*c\b|\[[^\]]*\d+[^\]]*\]|strictEqual\([^,]+,\s*-?\d+)/;
  let nAssert = 0;
  for (const f of alvos) {
    const src = lerFicheiro(path.join('scripts', f));
    const linhas = src.split(/\r?\n/);
    const relevantes = [];
    linhas.forEach((l, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
      if (/assert/.test(l) && reLiteral.test(l)) relevantes.push({ n: i + 1, t: l.trim() });
    });
    if (!relevantes.length) continue;
    console.log('');
    console.log(`    scripts/${f}  (${relevantes.length} asserção(ões) com valores literais)`);
    for (const r of relevantes) {
      nAssert++;
      console.log(`      ${txt(`:${r.n}`, 7)} ${txt(r.t, 84)}`);
    }
  }
  if (!nAssert) console.log('      (nenhuma)');
  console.log('');
  console.log(`  TOTAL: ${nAssert} asserções com valores literais em ${alvos.length} ficheiro(s) de teste.`);
  console.log('  → nenhuma é alterada sem justificação escrita no commit.');
}

// ── V1–V4: consultas (só SELECT) ─────────────────────────────────────

async function main() {
  const sequelize = require('../config/database');

  console.log('');
  console.log('════════════════════════════════════════════════════════════════════');
  console.log(' PRÉ-CONDIÇÃO V1–V6 · FASE A (só SELECT · nenhum dado alterado)');
  console.log('════════════════════════════════════════════════════════════════════');

  // V0, V5 e V6 são verificações de código/schema — correm sempre, mesmo sem BD.
  v0Schema();
  v5ScopeConfig();
  v6Testes();

  let ligado = true;
  try {
    await sequelize.authenticate();
  } catch (err) {
    ligado = false;
    console.log('');
    console.log('════════════════════════════════════════════════════════════════════');
    console.log(' BASE DE DADOS INACESSÍVEL — V1–V4 não podem correr aqui');
    console.log('════════════════════════════════════════════════════════════════════');
    console.log('');
    console.log('  ' + (err && err.message ? err.message : err));
    console.log('');
    console.log('  Este ambiente é o clone local: não tem acesso à BD de produção.');
    console.log('  V1–V4 têm de correr no servidor:');
    console.log('    cd /opt/condofy && node scripts/diagnostico-fase-a-preflight.js');
    console.log('');
    console.log('  Nota: V5–V6 JÁ CORRERAM acima (são verificações de código-fonte).');
    console.log('  Nenhum dado foi lido nem alterado.');
    process.exitCode = 0;
  }

  if (!ligado) return;

  const S = (sql) => sequelize.query(sql, { type: QueryTypes.SELECT });

  // ══ V1 ══════════════════════════════════════════════════════════════
  linha('V1. Quotas `pendente` futuras — o universo que a Fase A pode recalcular');
  console.log('  Critério: estado = pendente E data_vencimento >= CURDATE()');
  console.log('');

  const v1 = await S(`
    SELECT q.condominio_id,
           COALESCE(c.designacao, '(sem condomínio)') AS designacao,
           COUNT(*)                        AS n_quotas,
           COUNT(DISTINCT q.fracao_id)     AS n_fracoes,
           MIN(q.data_vencimento)          AS venc_min,
           MAX(q.data_vencimento)          AS venc_max,
           MIN(q.ano)                      AS ano_min,
           MAX(q.ano)                      AS ano_max,
           SUM(q.valor)                    AS valor_total
    FROM quotas q
    LEFT JOIN condominios c ON c.id = q.condominio_id
    WHERE q.estado = 'pendente' AND q.data_vencimento >= CURDATE()
    GROUP BY q.condominio_id, c.designacao
    ORDER BY n_quotas DESC
  `);

  if (!v1.length) {
    console.log('  (nenhuma quota pendente futura)');
  } else {
    console.log(
      `  ${txt('cond', 6)}${txt('designação', 28)}${txt('quotas', 8)}${txt('frações', 8)}` +
        `${txt('ano', 10)}${txt('venc. min', 12)}${txt('venc. max', 12)}${txt('valor', 14)}`
    );
    let sN = 0, sF = 0, sV = 0;
    for (const r of v1) {
      console.log(
        `  ${txt(r.condominio_id, 6)}${txt(r.designacao, 28)}${txt(r.n_quotas, 8)}${txt(r.n_fracoes, 8)}` +
          `${txt(`${r.ano_min}–${r.ano_max}`, 10)}${txt(String(r.venc_min).slice(0, 10), 12)}` +
          `${txt(String(r.venc_max).slice(0, 10), 12)}${txt(eur(Number(r.valor_total) * 100), 14)}`
      );
      sN += num(r.n_quotas);
      sF += num(r.n_fracoes);
      sV += Number(r.valor_total) || 0;
    }
    console.log('');
    console.log(`  TOTAL: ${sN} quotas pendentes futuras · ${sV.toFixed(2).replace('.', ',')} € · ${v1.length} condomínio(s)`);
  }

  // ══ V2 ══════════════════════════════════════════════════════════════
  linha('V2. Baseline de quotas `parcialmente_paga` e `paga` — o que NÃO pode variar');
  console.log('  Este é o número que tem de ficar idêntico antes e depois da Fase A.');
  console.log('');

  const v2 = await S(`
    SELECT q.condominio_id,
           COALESCE(c.designacao, '(sem condomínio)') AS designacao,
           SUM(CASE WHEN q.estado = 'pendente'          THEN 1 ELSE 0 END) AS n_pendente,
           SUM(CASE WHEN q.estado = 'parcialmente_paga' THEN 1 ELSE 0 END) AS n_parcial,
           SUM(CASE WHEN q.estado = 'paga'              THEN 1 ELSE 0 END) AS n_paga,
           SUM(CASE WHEN q.estado = 'vencida'           THEN 1 ELSE 0 END) AS n_vencida,
           SUM(CASE WHEN q.estado = 'anulada'           THEN 1 ELSE 0 END) AS n_anulada,
           COUNT(*) AS n_total
    FROM quotas q
    LEFT JOIN condominios c ON c.id = q.condominio_id
    GROUP BY q.condominio_id, c.designacao
    ORDER BY n_total DESC
  `);

  console.log(
    `  ${txt('cond', 6)}${txt('designação', 26)}${txt('pend', 8)}${txt('parcial', 9)}` +
      `${txt('paga', 8)}${txt('vencida', 9)}${txt('anulada', 8)}${txt('total', 8)}`
  );
  let tParcial = 0, tPaga = 0, tTotal = 0;
  for (const r of v2) {
    console.log(
      `  ${txt(r.condominio_id, 6)}${txt(r.designacao, 26)}${txt(r.n_pendente, 8)}${txt(r.n_parcial, 9)}` +
        `${txt(r.n_paga, 8)}${txt(r.n_vencida, 9)}${txt(r.n_anulada, 8)}${txt(r.n_total, 8)}`
    );
    tParcial += num(r.n_parcial);
    tPaga += num(r.n_paga);
    tTotal += num(r.n_total);
  }
  console.log('');
  console.log(`  BASELINE GLOBAL: ${tParcial} parcialmente pagas · ${tPaga} pagas · ${tTotal} quotas no total`);
  console.log('  → estes valores têm de ser idênticos após C3 (recálculo).');

  // Quantas quotas parcialmente pagas estão em risco de grupo misto (D2)?
  linha('V2b. Grupos mistos em risco (D2 · all-or-nothing por grupo)');
  console.log('  Grupos de igualdade EXATA que contenham ≥1 fração com quota pendente futura');
  console.log('  E ≥1 fração com quota parcialmente_paga ou paga.');
  console.log('');

  // ⚠ Colunas reais (confirmadas em models/Fracao.js e models/Quota.js):
  //   fracoes : id, condominio_id, designacao, permilagem DECIMAL(7,2), estado
  //   quotas  : id, condominio_id, fracao_id, ano, mes, valor,
  //             data_vencimento, estado ENUM(...)
  // A tabela `fracoes` NÃO tem `fracao_id` — o erro anterior era f.fracao_id.
  // A chave é fracoes.id, e a FK é quotas.fracao_id = fracoes.id.
  const v2b = await S(`
    SELECT t.condominio_id,
           t.permilagem,
           COUNT(DISTINCT t.fracao_id)    AS n_membros,
           SUM(t.tem_pendente_futura)     AS n_com_pendente,
           SUM(t.tem_paga_ou_parcial)     AS n_com_paga
    FROM (
      SELECT f.condominio_id,
             f.id AS fracao_id,
             CAST(f.permilagem AS CHAR) AS permilagem,
             MAX(CASE WHEN q.estado = 'pendente' AND q.data_vencimento >= CURDATE() THEN 1 ELSE 0 END) AS tem_pendente_futura,
             MAX(CASE WHEN q.estado IN ('parcialmente_paga','paga') THEN 1 ELSE 0 END)                 AS tem_paga_ou_parcial
      FROM fracoes f
      JOIN quotas q ON q.fracao_id = f.id
      GROUP BY f.condominio_id, f.id, CAST(f.permilagem AS CHAR)
    ) t
    GROUP BY t.condominio_id, t.permilagem
    HAVING n_com_pendente > 0 AND n_com_paga > 0
    ORDER BY t.condominio_id, n_membros DESC
  `);

  if (!v2b.length) {
    console.log('  (nenhum grupo misto — a regra D2 não terá efeito prático hoje)');
  } else {
    console.log(
      `  ${txt('cond', 6)}${txt('permilagem', 16)}${txt('membros', 9)}${txt('c/pend.', 10)}${txt('c/paga', 9)}`
    );
    for (const r of v2b) {
      console.log(
        `  ${txt(r.condominio_id, 6)}${txt(r.permilagem, 16)}${txt(r.n_membros, 9)}` +
          `${txt(r.n_com_pendente, 10)}${txt(r.n_com_paga, 9)}`
      );
    }
    console.log('');
    console.log(`  ${v2b.length} grupo(s) misto(s) — com D2, estes grupos ficam CONGELADOS no recálculo.`);
  }

  // ══ V3 ══════════════════════════════════════════════════════════════
  linha('V3. Permilagem por condomínio e grupos de igualdade EXATA');
  console.log('  Base: frações ATIVAS (é o conjunto que a geração usa).');
  console.log('');

  const v3 = await S(`
    SELECT f.condominio_id,
           COALESCE(c.designacao, '(sem condomínio)') AS designacao,
           COUNT(*)                    AS n_fracoes,
           SUM(f.permilagem)           AS soma_permilagem,
           MIN(f.permilagem)           AS perm_min,
           MAX(f.permilagem)           AS perm_max
    FROM fracoes f
    LEFT JOIN condominios c ON c.id = f.condominio_id
    WHERE f.estado = 'ativo'
    GROUP BY f.condominio_id, c.designacao
    ORDER BY f.condominio_id
  `);

  console.log(
    `  ${txt('cond', 6)}${txt('designação', 26)}${txt('frações', 9)}${txt('Σ permilagem', 14)}` +
      `${txt('desvio 1000', 14)}${txt('R1 máx.', 10)}`
  );
  for (const r of v3) {
    const soma = Number(r.soma_permilagem) || 0;
    const desvio = soma - 1000;
    const marca = Math.abs(desvio) > 0.01 ? '  ← E1 possível' : '';
    console.log(
      `  ${txt(r.condominio_id, 6)}${txt(r.designacao, 26)}${txt(r.n_fracoes, 9)}` +
        `${txt(soma.toFixed(4).replace('.', ','), 14)}` +
        `${txt((desvio >= 0 ? '+' : '') + desvio.toFixed(4).replace('.', ','), 14)}` +
        `${txt(`≤${(num(r.n_fracoes) * 100).toFixed(0)} c`, 10)}${marca}`
    );
  }

  console.log('');
  console.log('  Grupos de igualdade EXATA e quantos são efetivamente "singulares":');
  console.log('');

  const v3b = await S(`
    SELECT f.condominio_id,
           CAST(f.permilagem AS CHAR) AS permilagem,
           COUNT(*)                   AS n_fracoes
    FROM fracoes f
    WHERE f.estado = 'ativo'
    GROUP BY f.condominio_id, CAST(f.permilagem AS CHAR)
    ORDER BY f.condominio_id, n_fracoes DESC, CAST(f.permilagem AS DECIMAL(12,6)) ASC
  `);

  const porCond = {};
  for (const r of v3b) {
    if (!porCond[r.condominio_id]) porCond[r.condominio_id] = [];
    porCond[r.condominio_id].push(r);
  }

  for (const [cid, grupos] of Object.entries(porCond)) {
    const nGrupos = grupos.length;
    const nFracoes = grupos.reduce((s, g) => s + num(g.n_fracoes), 0);
    const maiores = grupos.filter((g) => num(g.n_fracoes) > 1);
    console.log(`  condomínio ${cid}: ${nFracoes} frações → ${nGrupos} grupos`);
    console.log(`      R1 máximo depois da Fase A: ±${(nGrupos * 1)} cêntimo(s) (era ±${nFracoes} cêntimo(s))`);
    if (maiores.length) {
      console.log('      grupos com mais de um membro (a igualdade passa a ser garantida):');
      for (const g of maiores.slice(0, 12)) {
        console.log(`        ${txt(g.permilagem, 14)} × ${g.n_fracoes}`);
      }
      if (maiores.length > 12) console.log(`        … e mais ${maiores.length - 12} grupo(s)`);
    } else {
      console.log('      (todos os grupos são singulares — a igualdade não altera nada hoje)');
    }
  }

  // ══ V4 ══════════════════════════════════════════════════════════════
  linha('V4. `valor_por_1000` e `fcr_percentagem` gravados nas quotas');
  console.log('  Se houver quotas com fcr_percentagem NULL/0, a mudança de fórmula (D1)');
  console.log('  não as afeta — mas convém saber quantas são.');
  console.log('');

  const v4 = await S(`
    SELECT q.condominio_id,
           q.valor_por_1000,
           q.fcr_percentagem,
           COUNT(*) AS n_quotas,
           MIN(q.data_vencimento) AS venc_min,
           MAX(q.data_vencimento) AS venc_max,
           SUM(CASE WHEN q.data_vencimento >= CURDATE() AND q.estado = 'pendente' THEN 1 ELSE 0 END) AS n_futuras_pend
    FROM quotas q
    GROUP BY q.condominio_id, q.valor_por_1000, q.fcr_percentagem
    ORDER BY q.condominio_id, n_quotas DESC
  `);

  console.log(
    `  ${txt('cond', 6)}${txt('valor_por_1000', 16)}${txt('fcr_%', 10)}${txt('quotas', 9)}` +
      `${txt('venc. min', 12)}${txt('venc. max', 12)}${txt('fut.pend', 10)}`
  );
  for (const r of v4) {
    const fcr = r.fcr_percentagem === null ? 'NULL' : String(r.fcr_percentagem);
    const marca = r.fcr_percentagem === null ? '  ← NULL' : '';
    console.log(
      `  ${txt(r.condominio_id, 6)}${txt(r.valor_por_1000, 16)}${txt(fcr, 10)}${txt(r.n_quotas, 9)}` +
        `${txt(String(r.venc_min).slice(0, 10), 12)}${txt(String(r.venc_max).slice(0, 10), 12)}` +
        `${txt(r.n_futuras_pend, 10)}${marca}`
    );
  }

  // Configuração efetiva por condomínio (chaves com sufixo :c<id>).
  console.log('');
  console.log('  Configuração efetiva (tabela `configuracoes`, chaves de quotas):');
  console.log('');

  const v4b = await S(`
    SELECT chave, valor
    FROM configuracoes
    WHERE chave LIKE 'quota_valor_1000%'
       OR chave LIKE 'quota_fcr_percentagem%'
       OR chave LIKE 'quota_valor_permilagem%'
    ORDER BY chave
  `);

  if (!v4b.length) {
    console.log('    (nenhuma chave de configuração de quotas gravada — usa-se o default de código)');
  } else {
    for (const r of v4b) {
      const escopo = /:c\d+$/.test(r.chave) ? 'condomínio' : 'GLOBAL (fallback)';
      console.log(`    ${txt(r.chave, 44)} ${txt(r.valor, 14)} ${escopo}`);
    }
  }

  // Diferença mensurável que a Fase A vai introduzir (D1), por condomínio.
  console.log('');
  console.log('  Impacto medido de D1 (FCR como componente do total vs. FCR somado à base):');
  console.log('');

  const v4c = await S(`
    SELECT q.condominio_id,
           q.fcr_percentagem,
           COUNT(DISTINCT q.fracao_id) AS n_fracoes,
           SUM(CASE WHEN q.data_vencimento >= CURDATE() AND q.estado = 'pendente' THEN 1 ELSE 0 END) AS n_futuras_pend
    FROM quotas q
    WHERE q.fcr_percentagem IS NOT NULL AND q.fcr_percentagem > 0
    GROUP BY q.condominio_id, q.fcr_percentagem
    ORDER BY q.condominio_id
  `);

  if (!v4c.length) {
    console.log('    (nenhuma quota com FCR > 0 — a mudança de fórmula não altera valores hoje)');
  } else {
    console.log(
      `  ${txt('cond', 6)}${txt('fcr_%', 10)}${txt('frações', 9)}${txt('fut.pend', 10)}` +
        `${txt('Δ/quota (10 €)', 16)}${txt('Δ/quota (100 €)', 18)}`
    );
    for (const r of v4c) {
      const pct = Number(r.fcr_percentagem) || 0;
      // Comparação da semântica: FCR sobre a base vs FCR componente do total.
      const dq = (totalC) => {
        const velho = (() => {
          const baseC = Math.round((totalC * 100) / (100 + pct));
          const fcrC = Math.round((baseC * pct) / 100);
          return baseC + fcrC;
        })();
        const novo = Math.round((totalC * 100) / (100 + pct)) +
          Math.round((totalC * 100) / (100 + pct));
        return novo - totalC;
      };
      const t10 = Math.round((1000 * 100) / (100 + pct));
      const t100 = Math.round((10000 * 100) / (100 + pct));
      console.log(
        `  ${txt(r.condominio_id, 6)}${txt(pct, 10)}${txt(r.n_fracoes, 9)}${txt(r.n_futuras_pend, 10)}` +
          `${txt(`${dq(t10) >= 0 ? '+' : ''}${dq(t10)} c`, 16)}` +
          `${txt(`${dq(t100) >= 0 ? '+' : ''}${dq(t100)} c`, 18)}`
      );
    }
    console.log('');
    console.log('  (Δ = cêntimos por quota entre a semântica antiga e a nova, para um total base de');
    console.log('   10 € e 100 € respetivamente. Valores pequenos são esperados — o efeito real está');
    console.log('   na SOMA anual, não na quota individual.)');
  }

  // Coerência dos valores gravados: valor = valor_base + valor_fcr?
  linha('V4d. Coerência dos valores já gravados (valor = base + FCR?)');
  const v4d = await S(`
    SELECT q.condominio_id,
           COUNT(*) AS n_incoerentes,
           SUM(CASE WHEN q.data_vencimento >= CURDATE() AND q.estado = 'pendente' THEN 1 ELSE 0 END) AS n_futuras
    FROM quotas q
    WHERE q.valor_base IS NOT NULL AND q.valor_fcr IS NOT NULL
      AND ABS(q.valor - (q.valor_base + q.valor_fcr)) > 0.004
    GROUP BY q.condominio_id
    ORDER BY n_incoerentes DESC
  `);
  if (!v4d.length) {
    console.log('  (todas as quotas com base+FCR gravados fecham ao cêntimo)');
  } else {
    console.log(`  ${txt('cond', 6)}${txt('incoerentes', 14)}${txt('dessas, futuras pendentes', 30)}`);
    for (const r of v4d) {
      console.log(`  ${txt(r.condominio_id, 6)}${txt(r.n_incoerentes, 14)}${txt(r.n_futuras, 30)}`);
    }
  }

  await sequelize.close();
}

main().catch((err) => {
  console.error('');
  console.error('Erro no diagnóstico:', err && err.message ? err.message : err);
  process.exit(1);
});
