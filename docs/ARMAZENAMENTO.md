# Armazenamento de documentos e acesso seguro

Documento de referência da camada de armazenamento do GesCondu: serviços
suportados, isolamento por condomínio e — sobretudo — **como os documentos são
acedidos**.

## 1. Invariante de segurança (obrigatório)

> Nenhum documento do GesCondu é acessível por link direto sem autorização no
> GesCondu.

Consequências práticas, todas verificadas por testes (`scripts/test-documentos-acesso.js`):

1. O ficheiro é sempre entregue pelo **backend do GesCondu** (streaming), nunca
   por um link do fornecedor de armazenamento.
2. **Não são criados links públicos** (“qualquer pessoa com o link”). Os
   adaptadores não expõem sequer métodos de partilha: o contrato
   (`helpers/armazenamento/contrato.js`) proíbe `linkPublico`,
   `criarLinkParticipa…`/`criarLinkPartilha` e equivalentes, e o teste falha se
   algum aparecer.
3. Antes de servir um ficheiro verifica-se, por esta ordem:
   1. existe sessão/autenticação válida? (`req.user` / `req.isAuthenticated()`)
   2. quem é o utilizador autenticado? (`req.user.id`)
   3. a que condomínio pertence? (`req.condominioId`, **sempre da sessão**)
   4. o documento pertence a esse condomínio?
      (`documentos.condominio_id === req.condominioId`)
   5. tem permissão para **este** documento? (admin/gestor: todos; condómino:
      apenas os marcados como disponíveis)
4. A autorização é **Utilizador → Condomínio → Documento**. Nunca existe
   Utilizador → Documento: um id de outro condomínio devolve o mesmo erro de um
   id inexistente (não se revela a existência de documentos alheios).
5. Nada é decidido pelo que vem no pedido: ids, caminhos, nomes de ficheiro e
   `condominioId` vindos do browser não dão acesso a nada.

Tudo isto vive em `helpers/documentos-acesso.js`, que é o **único** caminho de
serviço de ficheiros.

### Rotas

| Rota | Quem | Verificação |
|---|---|---|
| `GET /admin/documentos/:id/ficheiro` | admin/gestor (router de documentos) | condomínio ativo + papel + documento do condomínio |
| `GET /condomino/documentos/:id/ficheiro` | condómino autenticado | condomínio ativo + `disponivel_condominos = true` |
| `GET /documentos/ficheiro/:token` | sem sessão (destinatários externos) | token assinado, ligado a um documento e a um condomínio, com validade limitada |

`?descarregar=1` troca `inline` por `attachment`. As respostas levam
`Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` e
`Content-Security-Policy: sandbox`. Cada acesso é registado na auditoria
(`abrir_documento`, com `via` = `sessao`, `sessao_condomino` ou
`link_temporario`).

### Links temporários (emails)

Emails para destinatários **sem conta** no GesCondu (fornecedores, endereços
escritos à mão) levam um link temporário:

* emitido apenas depois de um administrador autenticado pedir o envio;
* assinado com HMAC-SHA256 (`DOC_LINK_SECRET` ou `SESSION_SECRET`);
* ligado a **um** documento e **um** condomínio, e a uma validade
  (`DOC_LINK_TTL_HOURS`, 7 dias por omissão);
* se o segredo não estiver configurado, os links temporários ficam **desativados**
  e os emails seguem sem link (`DOC_LINK_TEMPORARIO=0` também os desliga);
* é possível servir o documento e confirmar que continua a pertencer ao
  condomínio indicado no token.

Emails para condóminos levam a rota autenticada (`/condomino/documentos/…`), que
exige sessão. Em nenhum caso é enviado o URL do fornecedor.

## 2. Serviços suportados

| Provedor | Chave | Estado | Identificador do ficheiro |
|---|---|---|---|
| Google Drive | `google_drive` | ligação da plataforma (fluxo existente) | id do ficheiro (sem prefixo) |
| Dropbox | `dropbox` | ligação por condomínio | `dbx:<id>` |
| Microsoft OneDrive | `onedrive` | ligação por condomínio | `od:<id>` |

O identificador é guardado em `documentos.drive_file_id` (nome histórico,
`STRING(191)`). Valores **sem prefixo conhecido** são ids antigos do Google
Drive — nenhum documento existente precisa de migração. Como o provedor de
leitura é decidido pelo próprio localizador, **mudar de serviço não torna
ilegíveis os documentos já guardados** (`helpers/armazenamento/locator.js`).

### Escolha do serviço por condomínio

Chaves da tabela `configuracoes` (sem migração de esquema; a coluna `chave` é
`STRING(120)`):

| Chave | Conteúdo |
|---|---|
| `storage:provedor:c<id>` | provedor escolhido pelo condomínio |
| `storage:tokens:<provedor>:c<id>` | tokens OAuth da ligação do condomínio |
| `storage:raiz:<provedor>:c<id>` | pasta raiz opcional (por provedor/condomínio) |

Compatibilidade: a ligação global antiga (`google_drive_tokens`) e a pasta raiz
global (`google_drive_root_folder`) continuam a ser usadas quando o condomínio
não tem ligação própria — uma instalação existente comporta-se como antes.
`STORAGE_PROVIDER` define o provedor por omissão (sem escolha do condomínio).

**Isolamento:** cada condomínio tem o seu provedor, a sua ligação e a sua
árvore de pastas (`<raiz>/<Condomínio>/<ano>/…`). Os tokens de um condomínio
nunca são usados por outro (testado em `scripts/test-storage-provedores.js`).

### Estrutura de pastas

Igual em todos os provedores (planners puros em
`helpers/armazenamento/estrutura.js`):

```
<raiz>/
├── Backups/                      ← infraestrutura (global)
├── <Condomínio A>/
│   └── <ano>/{Assembleias,Quotas,Recibos,Despesas,Contratos,Outros,
│                Fornecedores/<nome>/<subpasta>}
└── <Condomínio B>/…
```

O condomínio é resolvido **sempre** pelo `condominio_id` — nunca por nome de
ficheiro, fração, tipo, ano ou email.

## 3. Como acrescentar um serviço novo

1. Criar `helpers/armazenamento/provedores/<nome>.js` a cumprir
   `helpers/armazenamento/contrato.js` (a lista de métodos e as assinaturas
   estão no cabeçalho desse ficheiro).
2. Registá-lo em `helpers/armazenamento/provedores/index.js` e, se tiver
   prefixo próprio, em `PREFIXOS` (`helpers/armazenamento/locator.js`).
3. Passar `contrato.verificarRegisto(require('./helpers/armazenamento/provedores'))`
   (é o que o teste faz) e correr `node scripts/test-storage-provedores.js`.
4. Nada nas rotas, nas vistas ou na lógica de documentos precisa de mudar: a
   fachada `helpers/storage` resolve o provedor.

Regras para um adaptador novo: nunca criar partilhas/links públicos; nunca
devolver tokens, caminhos técnicos ou ids em mensagens de erro; exigir
`condominioId` para escritas; e devolver `{ provedorFileId, tamanho, pastaId }`
no upload.

## 4. Onde está cada peça

| Ficheiro | Papel |
|---|---|
| `helpers/storage.js` | fachada única (API histórica + multi-provedor) |
| `helpers/armazenamento/contrato.js` | contrato dos provedores e verificador |
| `helpers/armazenamento/ligacoes.js` | provedor e ligações por condomínio (com fallback legado) |
| `helpers/armazenamento/locator.js` | localizadores `gd:`/`dbx:`/`od:` |
| `helpers/armazenamento/estrutura.js` | planners puros da hierarquia de pastas |
| `helpers/armazenamento/http.js` | cliente HTTP (fetch nativo) dos provedores |
| `helpers/armazenamento/provedores/*` | adaptadores (Google Drive, Dropbox, OneDrive) |
| `helpers/documentos-acesso.js` | **autorização + serviço de ficheiros + links** |
| `routes/documentos-link.js` | rota pública do link temporário |

## 5. Notas e trabalho seguinte

* Vários módulos ainda chamam `helpers/drive` diretamente (assembleias,
  convocatórias, financeiro, fornecedores, avisos, `jobs/backup`). Continuam a
  funcionar (usam a ligação Google Drive da plataforma); a migração para a
  fachada deve ser feita módulo a módulo, sem alterar comportamento.
* Os tokens das ligações são guardados em texto simples na tabela
  `configuracoes`, como acontecia com o Google Drive. Cifrá-los exige uma
  chave de aplicação (`ENCRYPTION_KEY`) e é uma evolução separada.
* O logótipo do condomínio continua a ser gravado em `public/uploads` (ficheiro
  de imagem servido como estático, agora com validação de tipo no servidor).
  Se se pretender que nem o logótipo seja servido por URL direto, terá de passar
  a ser servido por uma rota autenticada, como os documentos.
* `GET /admin/documentos/drive/pasta` continua a abrir a pasta do condomínio no
  painel do Google Drive: é um atalho de administração, não um caminho de
  acesso a documentos.
