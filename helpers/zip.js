// ─────────────────────────────────────────────────────────────────────
// ZIP mínimo, sem dependências externas.
//
// O projeto não tem nenhuma biblioteca de ZIP (`archiver`, `adm-zip`, `jszip`
// não existem nas dependências) e a exportação de dados tem de produzir um
// ficheiro único e inspecionável. Usa apenas `zlib` (deflate) e implementa o
// formato ZIP clássico:
//
//   [cabeçalho local + dados] × N
//   [diretório central] × N
//   [fim do diretório central]
//
// Detalhes relevantes para quem mantiver isto:
//  · método 8 (deflate) por omissão e 0 (armazenado) quando o conteúdo é
//    pequeno ou já está comprimido — nos dois casos o CRC-32 é calculado;
//  · nomes em UTF-8 com o bit 11 do campo de flags ligado, para acentos
//    ("Comunicações", "Fração") funcionarem em qualquer sistema;
//  · sem "data descriptors": os tamanhos e o CRC são escritos antes dos dados,
//    o que simplifica a leitura por qq ferramenta;
//  · entradas de pasta não são necessárias — o caminho com "/" cria a pasta.
// ─────────────────────────────────────────────────────────────────────
const zlib = require('zlib');

const ASSINATURA_LOCAL = 0x04034b50;
const ASSINATURA_CENTRAL = 0x02014b50;
const ASSINATURA_FIM = 0x06054b50;
const FLAG_UTF8 = 0x0800;

// ── CRC-32 (tabela calculada uma vez) ───────────────────────────────
const TABELA_CRC = (() => {
  const tabela = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tabela[n] = c;
  }
  return tabela;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = TABELA_CRC[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── Data/hora no formato MS-DOS ─────────────────────────────────────
function dataDos(data) {
  const d = data instanceof Date ? data : new Date();
  const hora = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const dia = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { hora, dia };
}

// ── Caminhos seguros dentro do ZIP ──────────────────────────────────
// Nunca permite caminhos absolutos nem ".." (evita extrações para fora da
// pasta de destino).
function nomeSeguro(nome) {
  return String(nome || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((parte) => parte && parte !== '.' && parte !== '..')
    .join('/');
}

// ── Constrói o ZIP ──────────────────────────────────────────────────
// entradas: [{ nome, conteudo (Buffer|string), comprimir? }]
function zipar(entradas = [], { data = new Date(), nivel = 6 } = {}) {
  const { hora, dia } = dataDos(data);
  const locais = [];
  const centrais = [];
  let deslocamento = 0;

  for (const entrada of entradas) {
    const nome = nomeSeguro(entrada.nome);
    if (!nome) continue;
    const conteudo = Buffer.isBuffer(entrada.conteudo) ? entrada.conteudo : Buffer.from(String(entrada.conteudo ?? ''), 'utf8');
    const nomeBuffer = Buffer.from(nome, 'utf8');
    const crc = crc32(conteudo);

    // Comprime só quando compensa (conteúdos pequenos ficam armazenados).
    let metodo = 0;
    let dados = conteudo;
    if (entrada.comprimir !== false && conteudo.length > 64) {
      const comprimido = zlib.deflateRawSync(conteudo, { level: nivel });
      if (comprimido.length < conteudo.length) {
        metodo = 8;
        dados = comprimido;
      }
    }

    const cabecalho = Buffer.alloc(30);
    cabecalho.writeUInt32LE(ASSINATURA_LOCAL, 0);
    cabecalho.writeUInt16LE(20, 4); // versão necessária
    cabecalho.writeUInt16LE(FLAG_UTF8, 6);
    cabecalho.writeUInt16LE(metodo, 8);
    cabecalho.writeUInt16LE(hora, 10);
    cabecalho.writeUInt16LE(dia, 12);
    cabecalho.writeUInt32LE(crc, 14);
    cabecalho.writeUInt32LE(dados.length, 18);
    cabecalho.writeUInt32LE(conteudo.length, 22);
    cabecalho.writeUInt16LE(nomeBuffer.length, 26);
    cabecalho.writeUInt16LE(0, 28); // sem campo extra
    locais.push(cabecalho, nomeBuffer, dados);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ASSINATURA_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // versão que criou
    central.writeUInt16LE(20, 6); // versão necessária
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(metodo, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(dia, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(dados.length, 20);
    central.writeUInt32LE(conteudo.length, 24);
    central.writeUInt16LE(nomeBuffer.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comentário
    central.writeUInt16LE(0, 34); // disco inicial
    central.writeUInt16LE(0, 36); // atributos internos
    central.writeUInt32LE(0, 38); // atributos externos
    central.writeUInt32LE(deslocamento, 42);
    centrais.push(central, nomeBuffer);

    deslocamento += cabecalho.length + nomeBuffer.length + dados.length;
  }

  const corpoLocal = Buffer.concat(locais);
  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  const nEntradas = centrais.length / 2;
  fim.writeUInt32LE(ASSINATURA_FIM, 0);
  fim.writeUInt16LE(0, 4);
  fim.writeUInt16LE(0, 6);
  fim.writeUInt16LE(nEntradas, 8);
  fim.writeUInt16LE(nEntradas, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(corpoLocal.length, 16);
  fim.writeUInt16LE(0, 20);

  return Buffer.concat([corpoLocal, diretorio, fim]);
}

// Lê um ZIP produzido por `zipar` (usado nos testes: prova que o ficheiro é
// válido e que os conteúdos voltam intactos).
function lerZip(buffer) {
  const entradas = [];
  let pos = 0;
  while (pos + 4 <= buffer.length && buffer.readUInt32LE(pos) === ASSINATURA_LOCAL) {
    const metodo = buffer.readUInt16LE(pos + 8);
    const crc = buffer.readUInt32LE(pos + 14);
    const comprimentoComprimido = buffer.readUInt32LE(pos + 18);
    const comprimentoOriginal = buffer.readUInt32LE(pos + 22);
    const nomeLen = buffer.readUInt16LE(pos + 26);
    const extraLen = buffer.readUInt16LE(pos + 28);
    const inicioNome = pos + 30;
    const inicioDados = inicioNome + nomeLen + extraLen;
    const nome = buffer.slice(inicioNome, inicioNome + nomeLen).toString('utf8');
    const dados = buffer.slice(inicioDados, inicioDados + comprimentoComprimido);
    const conteudo = metodo === 8 ? zlib.inflateRawSync(dados) : dados;
    entradas.push({ nome, metodo, crc, conteudo, crcValido: crc32(conteudo) === crc, tamanhoOk: conteudo.length === comprimentoOriginal });
    pos = inicioDados + comprimentoComprimido;
  }
  return entradas;
}

module.exports = { zipar, lerZip, crc32, nomeSeguro };
