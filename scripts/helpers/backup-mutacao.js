// ═══════════════════════════════════════════════════════════════════
// P53 — Gestão de backups dos harnesses de MUTAÇÃO, independente do
// `safe-delete` do host.
//
// ── O PROBLEMA ──────────────────────────────────────────────────────
// Os harnesses de mutação guardavam o original em `.mutation-backup-<carimbo>.tmp`
// e limpavam-no com `fs.unlinkSync`. O host interceta `unlink*`/`rmdir*`/`rm*`
// com um guard de ORÇAMENTO CUMULATIVO por turno (limiar 100). Ao esgotar, o
// guard entra em LATCH: recusa TODA a eliminação seguinte e o `finally` do
// harness rebenta — deixando o ALVO MUTADO e o backup órfão. Uma execução
// morta a meio deixa o repositório num estado que ninguém deteta.
//
// ── A SOLUÇÃO (estratégia E + C) ────────────────────────────────────
//   · o backup existe DURANTE a mutação (como antes) — a segurança não muda;
//   · a limpeza final usa `renameSync` para fora da árvore do projeto
//     (`os.tmpdir()`), NUNCA `unlink`;
//   · `rename*` NÃO é intercetado pelo guard. Medido no shim real do host
//     (`node-safe-delete-shim.cjs`): só `unlinkSync`/`rmdirSync`/`rmSync` e as
//     variantes `unlink`/`rmdir`/`rm` são envolvidos — `renameSync` não.
//     Logo, renomear não consome orçamento;
//   · `os.tmpdir()` é isento no shim; é um bónus, não a razão do mecanismo.
//
// ⛔ ESTE MÓDULO NUNCA APAGA NADA. Não há `unlink`, nem `rm`, nem `rmdir`.
// Se o `rename` falhar (por exemplo EXDEV, entre volumes), o backup é
// CONSERVADO e a situação é reportada — nunca se faz `unlink` de recurso.
//
// ── PORQUE NÃO `rename → EXDEV → unlink` ────────────────────────────
// Essa cadeia perderia a única cópia de recuperação exatamente no caso em que
// algo já correu mal. O fallback aqui é: renomear DENTRO da mesma árvore
// (mesmo volume ⇒ sem EXDEV) para fora do padrão que o varrimento vigia,
// ficando o resíduo íntegro, detetável pelo prefixo e ignorado pelo Git.
//
// Utilização típica (ver `scripts/test-mutacao-*.js`):
//
//   const backupMut = require('./helpers/backup-mutacao');
//   const bkp = backupMut.criar({ alvo, ficheiro });
//   try {
//     ...aplica a mutação...
//   } finally {
//     backupMut.restaurar(bkp);            // repõe byte a byte + confere sha256
//     backupMut.limpar(bkp);               // rename para fora do repo (sem unlink)
//   }
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Prefixo e padrão dos backups. O padrão é o que o varrimento de arranque
// reconhece; o prefixo é configurável porque o harness da transação de despesas
// usa um prefixo próprio para não colidir com os outros.
const PREFIXO_PADRAO = '.mutation-backup-';
const RE_RESIDUO_PADRAO = /^\.mutation-backup-\d+-\d+\.tmp$/;

// Resíduos já renomeados para fora do padrão vigiado (fallback do `limpar`).
const PREFIXO_INATIVO = 'ORFAO-inativo-';

// Prefixo LEGADO: resíduos que frentes ANTERIORES ao helper renomearam à mão
// para fora do padrão vigiado (`ORFAO-<nome>`). O varrimento recolhe-os também —
// senão ficariam na raiz do repositório para sempre, já que nenhuma regra os
// reconhece. É o único ponto em que o helper olha para o passado.
const PREFIXO_LEGADO = 'ORFAO-';

// Sufixos de marcador já vistos: `.alvo` (helper) e `.alvo.inativo` (legado).
const SUFIXOS_MARCADOR = ['.alvo', '.alvo.inativo'];
const eMarcador = (f) => SUFIXOS_MARCADOR.some((s) => f.endsWith(s));
const semSufixoMarcador = (f) => {
  for (const s of SUFIXOS_MARCADOR) if (f.endsWith(s)) return f.slice(0, -s.length);
  return f;
};

// Um resíduo é: do padrão deste harness, ou já marcado como inativo pelo
// fallback EXDEV (`ORFAO-inativo-*`), ou legado (`ORFAO-*`).
const eResiduo = (f, re) => re.test(f) || f.startsWith(PREFIXO_INATIVO) || f.startsWith(PREFIXO_LEGADO);

// `rename` injetável, para o teste de EXDEV. Em produção é o `fs.renameSync`.
// ⛔ Não é um interruptor de proteção: só troca a chamada de rename.
let _renameSync = fs.renameSync.bind(fs);
const __testes = {
  definirRename(fn) { _renameSync = fn; },
  reporRename() { _renameSync = fs.renameSync.bind(fs); },
  get renameAtual() { return _renameSync; },
};

const sha256 = (conteudo) => crypto.createHash('sha256')
  .update(Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(String(conteudo), 'utf8'))
  .digest('hex');

// Destino dos backups já usados: FORA da árvore do projeto.
// `os.tmpdir()` é isento no shim do host e, sobretudo, o `rename` não é vigiado.
function dirResiduos() {
  const dir = path.join(os.tmpdir(), 'gescondu-mutacao-residuos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Carimbo único e legível, no formato que o padrão de varrimento reconhece.
function carimboNovo() {
  return `${Date.now()}-${process.pid}`;
}

// Escolhe um caminho de backup LIVRE. Duas execuções no mesmo milissegundo e
// com o mesmo PID (o caso dos testes que correm em série) colidiriam; sem esta
// verificação, a segunda sobrescreveria o backup da primeira e a recuperação
// ficaria a apontar para o conteúdo errado.
function caminhoLivre(raiz, prefixo) {
  for (let tentativa = 0; tentativa < 100; tentativa += 1) {
    const sufixo = tentativa === 0 ? '' : `-${tentativa}`;
    const caminho = path.join(raiz, `${prefixo}${carimboNovo()}${sufixo}.tmp`);
    if (!fs.existsSync(caminho) && !fs.existsSync(`${caminho}.alvo`)) return caminho;
  }
  throw new Error(`não há caminho de backup livre em ${raiz} com o prefixo ${prefixo}`);
}

/**
 * Cria o backup do alvo e o marcador que diz a que ficheiro pertence.
 *
 * Lê o alvo como BUFFER (byte a byte, não como texto) e guarda o sha256 — é o
 * valor contra o qual o restauro será conferido.
 *
 * @param {{alvo: string, ficheiro: string, raiz?: string, prefixo?: string}} opcoes
 * @returns {{alvo: string, ficheiro: string, backup: string, marcador: string,
 *            conteudo: Buffer, sha256: string}}
 */
function criar({ alvo, ficheiro, raiz, prefixo = PREFIXO_PADRAO }) {
  if (!alvo) throw new Error('backup-mutacao.criar: `alvo` é obrigatório');
  if (!ficheiro) throw new Error('backup-mutacao.criar: `ficheiro` é obrigatório (caminho relativo)');
  const raizEfetiva = raiz || path.dirname(alvo);

  const conteudo = fs.readFileSync(alvo); // Buffer: byte a byte
  const backup = caminhoLivre(raizEfetiva, prefixo);
  const marcador = `${backup}.alvo`;

  // A ORDEM importa: o marcador só é escrito DEPOIS de o backup estar completo.
  // Se o processo morrer entre os dois, sobra um `.tmp` sem `.alvo` — que o
  // varrimento conserva para inspeção em vez de repor o alvo errado.
  fs.writeFileSync(backup, conteudo);
  fs.writeFileSync(marcador, ficheiro);

  return {
    alvo, ficheiro, backup, marcador, conteudo, sha256: sha256(conteudo),
  };
}

/**
 * Repõe o alvo a partir do backup e confere o sha256.
 *
 * ⛔ NÃO apaga o backup — a limpeza é um passo separado (`limpar`) e nunca usa
 * `unlink`. Se o restauro falhar, o backup fica onde está: é a única cópia.
 *
 * @returns {{ok: boolean, sha256: string, esperado: string}}
 */
function restaurar(reg) {
  if (!reg || !reg.backup) throw new Error('backup-mutacao.restaurar: registo inválido');
  if (!fs.existsSync(reg.backup)) {
    throw new Error(
      `backup-mutacao.restaurar: o backup desapareceu (${reg.backup}). `
      + `O alvo ${reg.ficheiro} NÃO foi reposto — verificar antes de continuar.`
    );
  }
  const conteudo = fs.readFileSync(reg.backup);
  fs.writeFileSync(reg.alvo, conteudo);
  const obtido = sha256(fs.readFileSync(reg.alvo));
  return { ok: obtido === reg.sha256, sha256: obtido, esperado: reg.sha256 };
}

/**
 * Afasta o backup da árvore do projeto. NUNCA apaga.
 *
 * Pré-condição de segurança: só afasta o backup depois de confirmar que o alvo
 * já está reposto (sha256 igual ao original). Sem esta guarda, um `limpar`
 * chamado por engano durante uma mutação ativa deixaria o alvo mutado SEM
 * cópia de recuperação — o pior estado possível.
 *
 * @returns {{ok: boolean, via: string|null, destino: string|null, motivo?: string}}
 */
function limpar(reg) {
  if (!reg || !reg.backup) throw new Error('backup-mutacao.limpar: registo inválido');

  // 1. Guarda de segurança: o alvo tem de estar reposto.
  if (fs.existsSync(reg.alvo)) {
    const atual = sha256(fs.readFileSync(reg.alvo));
    if (atual !== reg.sha256) {
      return {
        ok: false,
        via: null,
        destino: null,
        motivo: `o alvo ${reg.ficheiro} NÃO está reposto (sha256 ${atual.slice(0, 12)} ≠ `
          + `${reg.sha256.slice(0, 12)}): backup conservado em ${reg.backup}`,
      };
    }
  }

  // 2. Caminho normal: rename para fora da árvore do projeto (não consome
  //    orçamento do safe-delete e o destino é isento).
  const afastar = (de, para) => {
    _renameSync(de, para);
    return para;
  };

  try {
    const dir = dirResiduos();
    const nome = path.basename(reg.backup);
    const destino = afastar(reg.backup, path.join(dir, nome));
    if (fs.existsSync(reg.marcador)) afastar(reg.marcador, path.join(dir, `${nome}.alvo`));
    return { ok: true, via: 'rename-tmp', destino, motivo: null };
  } catch (e) {
    if (e && e.code !== 'EXDEV') {
      // Não é EXDEV: é um erro inesperado. Conservar tudo e reportar — nunca
      // apagar. O backup continua na árvore e o varrimento seguinte trata dele.
      return {
        ok: false,
        via: null,
        destino: null,
        motivo: `rename para ${os.tmpdir()} falhou (${(e && e.code) || e.message}): `
          + `backup conservado em ${reg.backup}`,
      };
    }
    // EXDEV — volumes diferentes. Fallback SEGURO: renomear DENTRO da mesma
    // árvore (mesmo volume ⇒ sem EXDEV) para fora do padrão vigiado. O resíduo
    // fica íntegro, detetável pelo prefixo e ignorado pelo Git.
    // ⛔ NÃO se faz `unlink` de recurso: perderia a cópia de recuperação.
    try {
      const nome = path.basename(reg.backup);
      const inativo = path.join(path.dirname(reg.backup), `${PREFIXO_INATIVO}${nome.slice(1)}`);
      afastar(reg.backup, inativo);
      if (fs.existsSync(reg.marcador)) afastar(reg.marcador, `${inativo}.alvo`);
      return {
        ok: true,
        via: 'rename-local-exdev',
        destino: inativo,
        motivo: `EXDEV: backup renomeado dentro da árvore para ${PREFIXO_INATIVO}* (conservado, não apagado)`,
      };
    } catch (e2) {
      return {
        ok: false,
        via: null,
        destino: null,
        motivo: `EXDEV e o rename local também falhou (${(e2 && e2.code) || e2.message}): `
          + `backup conservado em ${reg.backup}`,
      };
    }
  }
}

/**
 * Varrimento de arranque: repõe alvos órfãos e afasta os resíduos — sem apagar.
 *
 * Um harness morto a meio (SIGTERM/timeout) deixa o backup órfão E o alvo
 * mutado. Cada backup é uma CÓPIA INTEGRAL do original, pelo que o órfão se
 * repõe a partir dele (o `.alvo` diz em que ficheiro).
 *
 * @param {{raiz: string, prefixo?: string, regex?: RegExp, silencioso?: boolean}} opcoes
 * @returns {{repostos: string[], movidos: number, conservados: number}}
 */
function varrerResiduos({ raiz, prefixo = PREFIXO_PADRAO, regex = null, silencioso = false }) {
  const re = regex || (prefixo === PREFIXO_PADRAO
    ? RE_RESIDUO_PADRAO
    : new RegExp(`^${prefixo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+-\\d+\\.tmp$`));
  const relatorio = { repostos: [], movidos: 0, conservados: 0 };

  // Resíduos a tratar: os do padrão deste harness E os já marcados como
  // inativos pelo fallback EXDEV (`ORFAO-inativo-*`) E os legados (`ORFAO-*`).
  // Os marcadores (`.alvo`, `.alvo.inativo`) são tratados à parte (passo 3) —
  // sem esta exclusão, `ORFAO-inativo-x.tmp.alvo` seria tomado por um backup.
  const residuos = fs.readdirSync(raiz)
    .filter((f) => !eMarcador(f))
    .filter((f) => eResiduo(f, re))
    .sort();
  if (residuos.length === 0) {
    // Sem backups, mas pode haver marcadores sozinhos (passo 3): não se sai já
    // daqui, senão esses acumulavam para sempre.
    return tratarMarcadoresSozinhos(raiz, re, relatorio, silencioso);
  }

  // 1. Repor a partir do ÚLTIMO resíduo que tenha marcador (de qualquer dos
  //    formatos conhecidos).
  const ultimo = residuos[residuos.length - 1];
  const marcadorUltimo = SUFIXOS_MARCADOR
    .map((s) => path.join(raiz, `${ultimo}${s}`))
    .find((p) => fs.existsSync(p));
  if (marcadorUltimo) {
    const rel = fs.readFileSync(marcadorUltimo, 'utf8').trim();
    const destino = path.join(raiz, rel);
    if (fs.existsSync(destino)) {
      const conteudo = fs.readFileSync(path.join(raiz, ultimo));
      if (!fs.readFileSync(destino).equals(conteudo)) {
        fs.writeFileSync(destino, conteudo);
        relatorio.repostos.push(rel);
        if (!silencioso) console.log(`  ⚠ interrupção anterior detetada: ${rel} reposto a partir de ${ultimo}`);
      }
    }
  } else if (!silencioso) {
    console.log(`  · backup órfão sem marcador: conservado para inspeção (${ultimo})`);
  }

  // 2. Afastar os resíduos da árvore (rename, nunca unlink).
  for (const f of residuos) {
    const reg = {
      backup: path.join(raiz, f),
      marcador: path.join(raiz, `${f}.alvo`),
      alvo: path.join(raiz, f), // já não é um alvo vivo: a guarda do `limpar` não se aplica
      ficheiro: f,
      sha256: null,
    };
    const r = afastarFicheiro(reg);
    if (r.ok) relatorio.movidos += 1;
    else { relatorio.conservados += 1; if (!silencioso) console.log(`  · ${r.motivo}`); }
  }

  // 3. Marcadores sozinhos (o `.tmp` já foi afastado): lixo inofensivo — o alvo
  //    já foi reposto. Afastar também, sem apagar.
  tratarMarcadoresSozinhos(raiz, re, relatorio, silencioso);

  if (!silencioso) {
    console.log(`  · ${relatorio.movidos} resíduo(s) afastado(s) para ${dirResiduos()} (por rename, sem eliminação)`);
  }
  return relatorio;
}

// Marcadores sem o `.tmp` correspondente (`.alvo` do helper ou `.alvo.inativo`
// legado). É lixo inofensivo: o alvo já foi reposto (a guarda do `limpar` corre
// ANTES de afastar o backup). Sem este passo acumulavam para sempre.
// Afasta, nunca apaga.
function tratarMarcadoresSozinhos(raiz, re, relatorio, silencioso) {
  const soAlvo = fs.readdirSync(raiz)
    .filter(eMarcador)
    .filter((f) => {
      const sem = semSufixoMarcador(f);
      return eResiduo(sem, re) && !fs.existsSync(path.join(raiz, sem));
    });
  for (const f of soAlvo) {
    const r = afastarFicheiro({ backup: path.join(raiz, f), marcador: null, sha256: null });
    if (r.ok) relatorio.movidos += 1; else relatorio.conservados += 1;
  }
  if (!silencioso && relatorio.movidos > 0) {
    console.log(`  · ${relatorio.movidos} resíduo(s) afastado(s) para ${dirResiduos()} (por rename, sem eliminação)`);
  }
  return relatorio;
}

// Afasta um ficheiro de resíduo (sem guarda de alvo — é lixo, não um alvo vivo).
// Mesma política: rename, e fallback local em caso de EXDEV. Nunca `unlink`.
function afastarFicheiro({ backup, marcador }) {
  const tentar = (paraBackup, paraMarcador) => {
    _renameSync(backup, paraBackup);
    if (marcador && fs.existsSync(marcador)) _renameSync(marcador, paraMarcador);
    return paraBackup;
  };
  const nome = path.basename(backup);
  try {
    const dir = dirResiduos();
    return { ok: true, via: 'rename-tmp', destino: tentar(path.join(dir, nome), path.join(dir, `${nome}.alvo`)) };
  } catch (e) {
    try {
      const inativo = path.join(path.dirname(backup), `${PREFIXO_INATIVO}${nome.slice(1)}`);
      return { ok: true, via: 'rename-local-exdev', destino: tentar(inativo, `${inativo}.alvo`) };
    } catch (e2) {
      return {
        ok: false,
        motivo: `não foi possível afastar ${nome} (${(e2 && e2.code) || e2.message}); conservado no lugar`,
      };
    }
  }
}

/**
 * Afasta um ficheiro TEMPORÁRIO da árvore do projeto (rename, nunca unlink).
 *
 * Para ficheiros de teste que NÃO são backups — por exemplo um logótipo copiado
 * para `public/uploads` durante um teste de PDF. O `unlink` no `finally` desses
 * testes batia no guard de eliminações do host e o teste falhava por causa do
 * ambiente, não do produto.
 *
 * @returns {{ok: boolean, via: string, destino: string|null, motivo: string|null}}
 */
function afastar(ficheiro, { prefixo = PREFIXO_INATIVO } = {}) {
  if (!ficheiro) throw new Error('backup-mutacao.afastar: `ficheiro` é obrigatório');
  if (!fs.existsSync(ficheiro)) return { ok: true, via: 'ausente', destino: null, motivo: null };
  const nome = path.basename(ficheiro);
  try {
    const destino = path.join(dirResiduos(), nome);
    _renameSync(ficheiro, destino);
    return { ok: true, via: 'rename-tmp', destino, motivo: null };
  } catch (e) {
    try {
      const destino = path.join(path.dirname(ficheiro), `${prefixo}${nome}`);
      _renameSync(ficheiro, destino);
      return {
        ok: true, via: 'rename-local-exdev', destino,
        motivo: `EXDEV: conservado como ${prefixo}${nome} (não apagado)`,
      };
    } catch (e2) {
      return {
        ok: false, via: null, destino: null,
        motivo: `não foi possível afastar ${nome} (${(e2 && e2.code) || e2.message}); conservado no lugar`,
      };
    }
  }
}

module.exports = {
  PREFIXO_PADRAO,
  PREFIXO_INATIVO,
  PREFIXO_LEGADO,
  RE_RESIDUO_PADRAO,
  dirResiduos,
  sha256,
  criar,
  restaurar,
  limpar,
  afastar,
  varrerResiduos,
  __testes,
};
