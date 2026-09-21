# Microsoft OneDrive no GesCondu

Guia de configuração da integração OneDrive (documentos de um condomínio e/ou
backups da instalação).

**Não é necessária uma conta Microsoft nova.** A integração usa autorização
*delegada*: a aplicação age em nome de uma conta que já exista (pessoal ou
empresarial). Se a conta for pessoal, o OneDrive incluído chega.

---

## 1. Visão geral

| Conceito | Onde vive | Para que serve |
|---|---|---|
| **Documentos** | Ligação **por condomínio** (`storage:tokens:onedrive:c<id>`) | Ficheiros dos documentos do condomínio. É o «armazenamento principal» |
| **Backups** | Ligação da **plataforma/instalação** (`storage:tokens:onedrive:plataforma`) | Cópia cloud do dump da base de dados (contém dados de **todos** os condomínios) |

São **duas ligações independentes, com tokens próprios**. Podem usar a **mesma
conta** — é uma segunda autorização, com o mesmo `CLIENT_ID`/`SECRET`. Desligar
uma **não** afeta a outra.

A cópia **local** do backup é sempre obrigatória; a cópia cloud é opcional e
pode ser outro serviço (ex.: documentos no OneDrive + backups no Dropbox).

---

## 2. Criar a App Registration no Microsoft Entra ID

1. Abra <https://entra.microsoft.com> → **App registrations** → **New registration**.
2. **Name:** `GesCondu` (qualquer nome serve).
3. **Supported account types:**
   - conta **pessoal** (outlook.com / hotmail / live) → **«Accounts in any
     organizational directory and personal Microsoft accounts»**;
   - conta **empresarial** → «Accounts in any organizational directory» **ou**
     «Accounts in this organizational directory only» (nesse caso use
     `ONEDRIVE_TENANT=<id-do-tenant>` em vez de `common`).
4. **Redirect URI** → plataforma **Web** (não «Single-page application»):
   - produção: `https://<o-teu-domínio>/admin/config/armazenamento/onedrive/callback`
   - local: `http://localhost:3000/admin/config/armazenamento/onedrive/callback`
5. **Certificates & secrets** → **New client secret** → copie o **Value**
   (ver §4: **Value**, não **Secret ID**).

### Regras do Redirect URI

- Tem de coincidir **exatamente**: esquema, host, porta e **caminho**
  (o caminho é *case-sensitive*). Um redirect não registado dá **`AADSTS50011`**.
- `https` é obrigatório, **exceto em loopback** (`localhost` / `127.0.0.1`),
  onde `http` é aceite.
- O **portal aceita `http://localhost`** mas **rejeita `http://127.0.0.1`**
  (para esse é preciso editar o manifesto, atributo `replyUrlsWithType`).
- Em loopback a **porta é ignorada** no matching, o **caminho não**. Não registe
  dois URIs de loopback que só difiram na porta.
- Em apps que aceitam **contas pessoais**, o redirect URI **não pode** ter
  *query strings*.

---

## 3. Permissões (Microsoft Graph, todas DELEGADAS)

| Permissão | Para quê | Consentimento administrativo |
|---|---|---|
| `Files.ReadWrite` | ler/escrever os ficheiros do utilizador (o OneDrive da conta) | **Não** |
| `offline_access` | refresh token — a ligação renova-se sozinha | **Não** |
| `User.Read` | `GET /me` — identificar **qual** conta ficou ligada | **Não** |

**Não use:**

- `Files.ReadWrite.All` — delegada, exige consentimento administrativo e dá
  acesso a *todos* os ficheiros a que o utilizador chega;
- qualquer permissão de **aplicação** (`Files.ReadWrite` / `Files.ReadWrite.All`)
  — exige consentimento administrativo e dá acesso a **todos** os drives do tenant;
- `User.Read.All`, `Directory.Read.All`, `Sites.*` — desnecessárias.

> Numa conta **escolar/empresarial** cujo tenant tenha o *consentimento do
> utilizador* desativado, qualquer permissão delegada precisa de aprovação de um
> administrador do tenant. Numa conta **pessoal**, o próprio utilizador consente.

---

## 4. Client Secret: **Value** vs **Secret ID**

No portal, cada secret tem **duas** strings:

- **Secret ID** — o identificador do secret (um GUID). **Não serve** para autenticar.
- **Value** — o segredo propriamente dito. **Só é mostrado uma vez**, ao criar.
  É **este** que vai para `ONEDRIVE_CLIENT_SECRET`.

Usar o Secret ID dá **`invalid_client`** na troca de código. Os secrets
**expiram**: se a ligação deixar de renovar, confirme primeiro a validade.

---

## 5. Variáveis de ambiente

```dotenv
ONEDRIVE_ENABLED=true
ONEDRIVE_CLIENT_ID=<Application (client) ID>
ONEDRIVE_CLIENT_SECRET=<Value do client secret>
ONEDRIVE_TENANT=common
ONEDRIVE_REDIRECT_URI=https://<o-teu-domínio>/admin/config/armazenamento/onedrive/callback
ONEDRIVE_ROOT_FOLDER=
```

### Ativar a integração

**`ONEDRIVE_ENABLED=true` é o que ativa a integração.** Sem isto:

- o serviço não aparece como disponível para ligação na página
  (Configuração → Armazenamento e Backups);
- nenhuma operação usa o OneDrive, mesmo com `CLIENT_ID`/`SECRET` preenchidos.

O default é `false` em **dois** sítios — `.env.example` e `docker-compose.yml`
(`ONEDRIVE_ENABLED: ${ONEDRIVE_ENABLED:-false}`). Numa instalação em Docker,
defina a variável no `.env` que acompanha o `docker-compose.yml`.

`ONEDRIVE_TENANT` aceita `common` (contas pessoais e organizacionais),
`organizations`, `consumers` ou um id/domínio de tenant. **`common` é o correto
para contas pessoais.**

`ONEDRIVE_ROOT_FOLDER` é a pasta raiz na conta (precedência: configuração
guardada na BD → esta variável → `GesCondu`).

### `ENCRYPTION_KEY` (obrigatória)

Os tokens são guardados **cifrados** (AES-256-GCM) na tabela `configuracoes`.
Sem `ENCRYPTION_KEY` válida (32 bytes) não se lê nem se escreve nenhuma
credencial:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Sem ela, o OAuth pode até concluir no browser, mas a gravação falha e a página
mostra um erro administrativo (o sintoma aparece **depois** da autorização).

---

## 6. Ligar as contas

1. **Documentos (condomínio):** Configuração → Armazenamento e Backups →
   cartão «Microsoft OneDrive» → **Ligar Microsoft OneDrive**. Autorize com a
   conta pretendida (o fluxo força `prompt=select_account`, por isso pode
   escolher a conta mesmo com sessão Microsoft aberta no browser).
   Depois, em «Armazenamento dos documentos», escolha-o como principal.

2. **Backups (instalação):** no cartão «Backups» → **Ligar conta da plataforma
   (Microsoft OneDrive)**. É uma segunda autorização, independente da anterior.
   Depois escolha OneDrive como destino dos backups.

   *Alternativa:* se não existir ligação de plataforma, o job usa a ligação do
   primeiro condomínio que tenha o serviço ligado. Funciona, mas os backups de
   todos os condomínios ficam nessa conta — a página avisa.

3. Confirme com **Testar ligação** em cada cartão.

### Estrutura de pastas criada

```
<raiz>/
├── Backups/                     ← infraestrutura (global)
└── <Condomínio>/
    └── <ano>/{Assembleias, Quotas, Recibos, Despesas, Contratos, Outros}
        └── Fornecedores/<nome>/<subpasta>
```

Os nomes são sanitizados antes de chegar ao Graph: `: * ? " < > |` viram `-`,
caracteres de controlo viram **espaço** (não desaparecem — `Ata\u0001de` dá
`Ata de`, e não `Atade`), pontos e espaços finais são aparados, e nomes
reservados (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9`,
`desktop.ini`, prefixos `~$`/`_vti_`) recebem um `_` à frente.

Num **caminho de pasta** `\` e `/` viram espaço (para a raiz `/GesCondu`
continuar a dar `GesCondu` e não `-GesCondu`); num **nome de ficheiro** viram
`_`, porque um nome de ficheiro nunca pode criar subpastas. Um segmento que
fique vazio é descartado; nomes normais ficam **inalterados** (sem prefixos nem
colisões desnecessárias).

---

## 7. Erros frequentes

| Sintoma / erro | Causa | Resolução |
|---|---|---|
| **`AADSTS50194`** — «Application … is not configured as a multi-tenant application» | App Registration single-tenant a usar `common` | Mude «Supported account types» para incluir contas pessoais, ou use `ONEDRIVE_TENANT=<id-do-tenant>` |
| **`AADSTS50011`** — «The reply URL specified in the request does not match…» | Redirect URI diferente do registado | Registe exatamente o URI indicado (esquema/host/porta/caminho); confirme que está na plataforma **Web** e que `ONEDRIVE_REDIRECT_URI` não tem barra final a mais |
| **`invalid_client`** | Secret ID em vez do **Value**, secret expirado, ou `CLIENT_ID` de outra app | Copie o **Value**; crie um secret novo se tiver expirado |
| **`invalid_grant`** / ligação «Ligação inválida» | Autorização revogada pelo utilizador ou expirada | Volte a ligar a mesma conta na página |
| **`AADSTS65001`** / consentimento | Consentimento não concedido para os scopes | Autorize novamente; numa conta empresarial pode ser preciso um administrador |
| Serviço não aparece para ligar | `ONEDRIVE_ENABLED` não está `true` | Ative e reinicie (§5) |
| «Não foi possível identificar a conta ligada» | O scope `User.Read` não foi consentido | Confirme `User.Read` nas API permissions e volte a autorizar |
| Ligação feita mas os documentos não abrem | O principal do condomínio é outro serviço, ou a conta ligada não é a que criou os ficheiros | Ligue a **mesma** conta que criou os ficheiros; os documentos antigos continuam legíveis pelo localizador |
| Erro de cifra no callback | `ENCRYPTION_KEY` ausente/inválida | Configure a chave (§5) e volte a ligar |

---

## 8. Verificação real (antes de usar em produção)

O script exercita o adaptador **verdadeiro** contra a API real, sem base de
dados e sem guardar tokens em ficheiros:

```powershell
$env:ONEDRIVE_CLIENT_ID='<client id>'; $env:ONEDRIVE_CLIENT_SECRET='<secret value>'
npm run verificar:provedores -- --provedor onedrive
```

Antes de correr, registe o redirect URI indicado pelo script
(`http://localhost:53682/callback` por omissão). Host e porta são configuráveis
(`--host`, `--porta`); **não** use `127.0.0.1` como default — o portal rejeita
esse URI.

O script verifica, pela ordem: URL de autorização, troca do código, identificação
da conta, credenciais cifradas em repouso, estado da ligação, estrutura de
pastas, pasta de documentos, upload, localizador `od:`, descarga, streaming,
renovação automática do token, pasta de fornecedores, ligação de plataforma e
isolamento, pasta de backups, ausência de links públicos e desligar.

---

## 9. O que o GesCondu **não** faz com o OneDrive

- **Não cria links públicos** nem partilhas (`/invite`, `/createLink`). Os
  documentos são servidos sempre pelo backend, depois de verificar
  utilizador → condomínio → documento.
- **Não apaga ficheiros ao desligar** uma ligação: desligar remove apenas os
  tokens; os ficheiros ficam na conta.
- **Não copia** documentos entre serviços: cada condomínio grava num único
  serviço (o principal).
- **Não duplica** as pastas: a criação é idempotente (um `409` significa
  «já existe»).
