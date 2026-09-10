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

### Códigos de resposta (nunca se entrega o documento)

| Situação | Resposta |
|---|---|
| Sem sessão / sem condomínio ativo | **401** |
| Documento de outro condomínio (id adulterado) | **403** |
| Sem permissão (condómino, documento não disponibilizado) | **403** |
| Documento inexistente | **404** |
| Documento sem ficheiro (só referência externa) | **404** |
| Falha do fornecedor de armazenamento | **502** |
| Serviço de armazenamento do condomínio desligado | **503** |

Trocar um id autorizado por outro de outro condomínio
(`/admin/documentos/123/ficheiro` → `/admin/documentos/124/ficheiro`) resulta
em **403** e a mensagem é igual à de um documento inexistente (não se revela
o condomínio alheio). Testado em `scripts/test-documentos-acesso.js`.

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

| Provedor | Chave | Ligação | Identificador do ficheiro |
|---|---|---|---|
| Google Drive | `google_drive` | por condomínio (ou conta da plataforma) | id do ficheiro (sem prefixo) |
| Dropbox | `dropbox` | por condomínio | `dbx:<id>` |
| Microsoft OneDrive | `onedrive` | por condomínio | `od:<id>` |

Um condomínio pode ter **vários serviços ligados ao mesmo tempo**, mas apenas
**um é o armazenamento principal** — é nele que ficam os documentos. Não há
duplicação automática de documentos por estarem vários serviços ligados.

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
| `storage:principal:c<id>` | armazenamento principal dos documentos do condomínio |
| `storage:tokens:<provedor>:c<id>` | contas autorizadas do condomínio |
| `storage:raiz:<provedor>:c<id>` | pasta raiz opcional (por provedor/condomínio) |
| `storage:backup` | destino dos backups da instalação |
| `storage:tokens:<provedor>:plataforma` | contas autorizadas da plataforma (backups) |

Compatibilidade: a chave antiga `storage:provedor:c<id>` continua a ser lida e
mantida em escrita; a ligação global antiga do Google Drive
(`google_drive_tokens`) é a ligação de **plataforma** do Drive e serve de
fallback aos condomínios sem conta própria; a pasta raiz global
(`google_drive_root_folder`) mantém a prioridade. Uma instalação existente
comporta-se como antes. `STORAGE_PROVIDER` define o serviço por omissão.

**Isolamento:** cada condomínio tem o seu armazenamento principal, as suas
contas e a sua árvore de pastas. Os tokens de um condomínio nunca são usados
por outro — e, fora do Google Drive (que tem conta de plataforma desde o
início), não existe fallback para a conta da plataforma (testado em
`scripts/test-storage-provedores.js`).

## 2.1 Credenciais cifradas em repouso

Os tokens OAuth de armazenamento **nunca são guardados em texto simples** na
tabela `configuracoes`. A cifragem está centralizada num único sítio —
`helpers/armazenamento/cifra.js`, usado exclusivamente por
`helpers/armazenamento/ligacoes.js` — pelo que nenhuma outra camada precisa de
saber se um valor está cifrado.

* **Algoritmo:** AES-256-GCM (authenticated encryption), nonce novo e aleatório
  por cada valor, com o nome da chave de configuração como dados autenticados
  adicionais (AAD). Copiar um token de um condomínio para outro na base de
  dados deixa de decifrar — reforça o isolamento multi-tenant.
* **Formato gravado (versionado):** `enc:v1:<kid>:<iv>:<tag>:<ciphertext>`
  (`kid` = impressão curta da chave usada, o que permite rotação futura). Valores
  antigos em texto simples continuam legíveis e são reconhecidos pelo formato.
* **Chave da instalação:** `ENCRYPTION_KEY` (32 bytes em base64 ou hex, gerada
  aleatoriamente; nunca vai para o Git). Geração:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
* **Sem chave:** nenhuma credencial é lida nem escrita (as operações falham de
  forma segura, com uma mensagem administrativa visível em Configurações →
  Armazenamento e Backups); a aplicação não guarda nada em texto simples.
* **Migração transparente:** ao ler uma credencial ainda em texto simples, ela é
  imediatamente substituída pela versão cifrada — sem obrigar a voltar a
  autorizar contas. Para converter tudo de uma vez:
  `node scripts/migrar-tokens-cifrados.js` (e `--verificar` para só confirmar).
* **Rotação de chave:** `ENCRYPTION_KEY_OLD` (uma ou várias, separadas por
  vírgula) permitem decifrar valores antigos; depois de trocar a chave em
  `ENCRYPTION_KEY`, o script de migração recifra tudo com a chave nova.
* **Nunca expostos:** a chave e os tokens não são registados em log, não são
  enviados para o browser, não aparecem em mensagens de erro nem em URLs (a
  cache em memória só contém tokens já decifrados, para uso interno).

Fora do âmbito desta cifragem (registado para tarefa separada): a password SMTP
(`smtp_pass` em `configuracoes`).

## 2.2 Backups (conceito separado)
Os backups são da **instalação** (o dump contém dados de todos os
condomínios), por isso:

* usam uma **ligação de plataforma** (nunca a conta de um condomínio — isso
  daria a esse condomínio acesso aos dados dos outros);
* podem ficar num **serviço diferente** do armazenamento dos documentos
  (ex.: documentos no Google Drive, backups no Dropbox);
* sem destino ligado, os backups ficam apenas em `backups/local/` no servidor;
* a arquitetura não impede vários destinos no futuro (basta permitir uma lista
  em `storage:backup`).

## 2.2 Configuração: o `.env` é só técnico

As credenciais dos fornecedores (client id/secret da aplicação GesCondu,
redirect URIs e chaves técnicas) pertencem à **instalação** e vivem no `.env`
(variáveis documentadas em `.env.example`): `GOOGLE_*`, `DROPBOX_*`,
`ONEDRIVE_*`, `STORAGE_PROVIDER`, `DOC_LINK_*`.

Tudo o que é **por condomínio** (que serviços estão ligados, qual é o
principal, destino de backups, pasta raiz) é configurado na própria interface
em **Configurações → Armazenamento e Backups**, por OAuth — nunca editando o
`.env`.

Se a instalação ainda não tiver as credenciais técnicas de um serviço, a
interface mostra apenas: **“Disponível após configuração pelo administrador do
GesCondu.”** Não são apresentadas mensagens como “desativado no `.env`” nem
qualquer detalhe técnico ao utilizador final.

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

* Os uploads de documentos passam todos pela fachada (`helpers/storage`) e usam
  o **armazenamento principal do condomínio** — incluindo as automações de
  documentos (`helpers/document-actions.js`), assembleias, convocatórias,
  quotas, recibos, documentos e fornecedores. As descargas usam o localizador
  do ficheiro, pelo que continuam a funcionar depois de mudar de serviço.
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
* Vários destinos de backup (por tipo: diário/semanal/mensal) é a evolução
  natural seguinte: `storage:backup` passaria a guardar uma lista.
