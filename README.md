# 📋 Hidro Forte — Emissão de Certidões — Documentação Técnica

## Visão Geral

Aplicativo **Electron** (desktop) que automatiza a emissão de **5 certidões fiscais brasileiras** via web scraping. Possui sistema de **autenticação com dois níveis de acesso** (Administrador/Funcionário), relatório com controle de vencimentos, notificações por e-mail, sincronização na nuvem via Firebase e visualização remota de PDFs entre múltiplos PCs.

**Stack:** Electron 28 · Puppeteer 21 · Firebase Admin · Nodemailer · electron-builder

---

## Arquitetura do Projeto

```
certidao-app/
├── 📄 package.json                    # Config do app + build (main: src/main/main.js)
├── 📄 README.md                       # Esta documentação
├── 🖼️ logo.png                        # Logo da Hidro Forte (sidebar + login)
├── 🖼️ icon.png                        # Ícone do executável
│
├── 📁 src/
│   ├── 📁 main/
│   │   └── main.js                    # Processo principal Electron (~795 linhas)
│   │                                  #   IPC handlers, DB local, Firebase sync, email, auth
│   │
│   ├── 📁 renderer/
│   │   ├── index.html                 # HTML estrutural (~360 linhas)
│   │   ├── renderer.js                # Lógica do renderer (~930 linhas)
│   │   └── styles.css                 # CSS da interface (~900 linhas)
│   │
│   ├── 📁 scrapers/
│   │   ├── chrome.js                  # Detecção do Chrome (dev/prod) (~32 linhas)
│   │   ├── federal.js                 # Certidão Federal — Receita Federal (~534 linhas)
│   │   ├── estadual.js                # Certidão Estadual — SEFAZ Tocantins (~672 linhas)
│   │   ├── fgts.js                    # Certidão FGTS — Caixa Econômica (~410 linhas)
│   │   ├── trabalhista.js             # CNDT — TST (~598 linhas)
│   │   └── palmas.js                  # Certidão Municipal — Prefeitura de Palmas (~392 linhas)
│   │
│   ├── 📁 services/
│   │   ├── email.js                   # Nodemailer: teste, nova cert, vencimentos (~308 linhas)
│   │   └── firebase.js                # Firestore + PDF base64 + auth + anti-dup (~540 linhas)
│   │
│   └── 📁 config/
│       └── firebase-credentials.json  # Service account do Firebase Admin SDK
│
├── 📁 chrome-bundled/                 # Chrome v121 para build portátil
├── 📁 certidões/                      # PDFs auto-organizados por empresa (auto-criada)
│   └── {RAZÃO SOCIAL - XX.XXX.XXX-XXXX-XX}/
└── 📁 dist/
    ├── HidroForte-Certidoes.exe       # Executável portátil
    └── win-unpacked/                  # Build descompactado (abertura instantânea)
```

---

## Autenticação e Controle de Acesso

### Tela de Login
- Logo da Hidro Forte + campos de usuário/senha
- Opção "Salvar senha" (desmarcada por padrão, usa `localStorage`)
- Tecla Enter para submeter
- Senhas armazenadas no Firebase com hash SHA-256

### Dois Níveis de Acesso

| Funcionalidade | Administrador | Funcionário |
|---|---|---|
| Emitir certidões | ✅ | ✅ |
| Ver relatório | ✅ | ✅ |
| Visualizar PDF / Abrir pasta | ✅ | ✅ |
| Deletar certidões | ✅ | ❌ |
| Notificações (e-mail) | ✅ | ❌ |
| Administração (usuários) | ✅ | ❌ |

### Admin Padrão
Na primeira execução, é criado automaticamente no Firebase:
- **Usuário:** `admin` / **Senha:** `admin`
- ⚠️ Recomenda-se trocar na primeira utilização.

### Firebase Collection: `usuarios`

| Campo | Tipo | Descrição |
|---|---|---|
| `usuario` | string | Nome de login (lowercase) |
| `senha_hash` | string | SHA-256 da senha |
| `nivel` | string | `administrador` ou `funcionario` |
| `criado_em` | string | ISO 8601 |
| `criado_por` | string | Quem cadastrou |

---

## Interface — 4 Páginas (+1 admin)

### Página 1: Emitir Certidões
- Campo CNPJ com auto-formatação e busca automática de empresa (API opencnpj)
- Grid com 5 cards de certidão, cada um com botão "Emitir"
- Botão "🚀 Emitir Todas as Certidões"
- Log de status com feedback em tempo real

### Página 2: Relatório
- **4 stat cards:** Total, Ativas (verde), Alerta (amarelo), Vencidas (vermelho)
- **Gráfico donut** (Chart.js): distribuição Ativas/Alerta/Vencidas
- **Barra de pesquisa:** filtra por nome da empresa ou CNPJ
- **Tabela ordenável:** headers clicáveis com seta ▲/▼ (empresa, tipo, status, vencimento, dias)
- **Ações por registro:**
  - 👁️ Visualizar PDF (abre local ou baixa da nuvem)
  - 📂 Abrir pasta da empresa
  - 🗑️ Excluir — **somente Administrador** (modal com checkbox para deletar arquivo do disco)

### Página 3: Notificações *(somente Administrador)*
- Configuração de e-mail: remetente Gmail, senha de app, destinatários
- Toggles: notificações ativas, verificar ao abrir
- Botões: salvar config, enviar teste, verificar vencimentos agora
- Status bar com feedback visual

### Página 4: Administração *(somente Administrador)*
- Formulário para cadastrar novo acesso (usuário, senha, nível)
- Tabela com todos os usuários cadastrados (badges de nível)
- Botão para deletar acessos (não é possível deletar a si mesmo)

### Sidebar
- Logo da Hidro Forte no topo
- Menu de navegação (itens visíveis conforme nível de acesso)
- Nome do usuário logado + botão de logout

---

## Camada de Dados

### Persistência Local (JSON)
- **Arquivo:** `{app.getPath('userData')}/certidoes-db.json`
- **Funções:** `lerDB()`, `salvarDB(db)` (com migração automática de schemas antigos)

```js
{
  registros: [{
    cnpj: "01419973000122",
    tipo: "federal",              // federal | estadual | fgts | trabalhista | palmas
    validade: "09/08/2026",       // DD/MM/AAAA ou ""
    razao_social: "...",
    nome_fantasia: "...",
    data_emissao: "10/02/2026",
    arquivo: "C:\\...\\certidões\\EMPRESA\\CERTIDÃO FEDERAL - ....pdf",
    pasta_empresa: "C:\\...\\certidões\\EMPRESA",
    atualizado_em: "2026-02-10T...",
    notificacao_enviada: false
  }],
  config_email: {
    remetente: "...",
    senha_app: "...",
    destinatarios: ["..."],
    dias_alerta: 15,
    ativo: true,
    verificar_ao_abrir: true
  },
  ultima_verificacao_vencimentos: "2026-02-10"  // Anti-duplicação local
}
```

### Firebase Firestore (Nuvem)
- **Projeto:** `certidoes-app-c1aef`
- **Service account:** `src/config/firebase-credentials.json`

| Collection | Documento | Conteúdo |
|---|---|---|
| `certidoes` | `{cnpj}_{tipo}` | Dados da certidão (sem caminhos locais) |
| `pdf_storage` | `{cnpj}_{tipo}` | PDF em base64 (~50-300KB cada) |
| `config` | `email` | Configuração de e-mail |
| `config` | `controle` | Anti-duplicação de vencimentos (data + hostname) |
| `usuarios` | `{usuario}` | Login, senha hash, nível de acesso |

### Sincronização Nuvem ↔ Local
- **Ao iniciar:** Firebase init → puxa registros da nuvem → mescla com local (critério: `atualizado_em` mais recente) → envia local pra nuvem → sincroniza config de e-mail → upload de PDFs que não estão na nuvem
- **Ao emitir:** salva local + registra no Firestore + upload do PDF base64
- **Ao deletar:** remove local + remove do Firestore + remove PDF base64
- **Config e-mail:** salva local + envia pra nuvem

---

## Visualização Remota de PDFs

O sistema permite que PDFs emitidos em um PC sejam visualizados em qualquer outro:

1. **Ao emitir** → PDF é salvo localmente + convertido para base64 e armazenado no Firestore (`pdf_storage`)
2. **Botão 👁️ "Visualizar PDF":**
   - Se o arquivo existe localmente → abre direto
   - Se não → baixa do Firestore → salva na pasta da empresa → abre
   - Na próxima vez, já abre local (sem download)
3. **Limite:** PDFs até 900KB (Firestore tem limite de 1MB por documento)

---

## Notificações por E-mail

### Configuração
- **SMTP:** Gmail via Nodemailer (autenticação com "Senha de App")
- **Credenciais padrão:** `controladoriahfsaneamento@gmail.com`

### 3 Tipos de E-mail
| Tipo | Quando | Conteúdo |
|---|---|---|
| **Teste** | Botão "📤 Enviar Teste" | HTML com confirmação de funcionamento |
| **Nova Certidão** | Ao emitir qualquer certidão | Empresa, tipo, validade, dias restantes |
| **Alerta de Vencimentos** | Ao abrir o app (automático) | Resumo de todas as certidões vencendo em X dias |

### Anti-duplicação (Multi-PC)
O alerta de vencimentos roda ao abrir o app, mas só **um PC por dia** envia:
1. Checa Firestore: `config/controle.ultima_verificacao_vencimentos === hoje?`
2. Se sim → ignora
3. Se não → envia e-mail → marca no Firestore (trava todos os PCs) + marca no JSON local
4. **Fallback:** se Firestore estiver offline, usa o JSON local como trava

---

## Scrapers — Arquitetura por Certidão

### Padrão de Interface
Todos os scrapers exportam `obterPDF(cnpj)`:
```js
const { pdf, dados, validade } = await obterPDF('01419973000122');
// pdf: Buffer do PDF
// dados: Object com informações extraídas
// validade: "DD/MM/AAAA" ou null
```

### 1. Federal (`src/scrapers/federal.js`)
- **Método:** Puppeteer-extra + Stealth Plugin
- **Captcha:** hCaptcha invisível (resolvido pelo stealth)
- **Validade:** Extraída do PDF via pdf.js 3.11.174 CDN no browser Puppeteer
  - Polyfill: `window.DOMMatrix = class DOMMatrix {}`
  - Regex: "válida até", "Validade:", "efeitos até"

### 2. Estadual (`src/scrapers/estadual.js`)
- **Método:** Puppeteer (navegação completa)
- **Captcha:** reCAPTCHA v2 → CapMonster (`node-capmonster`)
- **Site:** SEFAZ Tocantins (framework GeneXus)
- **Validade:** Calculada: emissão + 30 dias

### 3. FGTS (`src/scrapers/fgts.js`)
- **Método:** HTTP requests (axios) + Puppeteer (HTML → PDF)
- **Captcha:** Não tem
- **Validade:** Extraída do HTML da certidão via regex

### 4. Trabalhista (`src/scrapers/trabalhista.js`)
- **Método:** Puppeteer (navegação completa)
- **Captcha:** Captcha de imagem → CapMonster (até 5 tentativas)
- **Validade:** Extraída do PDF via pdf.js CDN

### 5. Municipal Palmas (`src/scrapers/palmas.js`)
- **Método:** HTTP requests (axios + cheerio)
- **Captcha:** Não tem (apenas CSRF token)
- **Validade:** Extraída do PDF via decodificação manual (ASCII85 + zlib + escapes octais)

---

## Componentes Compartilhados

### `src/scrapers/chrome.js`
Resolve o caminho do Chrome:
1. **Build:** `process.resourcesPath/chrome-win64/chrome.exe`
2. **Dev:** `~/.cache/puppeteer/chrome/win64-121.0.6167.85/chrome-win64/chrome.exe`

### CapMonster
- **API Key:** `67b2de76287ddb82e2a5ff5ffc5aba5c`
- Usado por: Estadual (reCAPTCHA v2) + Trabalhista (captcha de imagem)

### API opencnpj
- **Endpoint:** `https://api.opencnpj.org/{CNPJ}` (gratuita, timeout 10s)
- **Retorno:** `razao_social`, `nome_fantasia`
- **Uso:** Busca de empresa na UI + nome das pastas auto-save

---

## Sistema de Pastas Auto-organizadas

- **Base:** `certidões/` ao lado do .exe (prod) ou raiz do projeto (dev)
- **Por empresa:** `certidões/{RAZÃO SOCIAL - XX.XXX.XXX-XXXX-XX}/`
- **Sanitização:** `/` → `-`, remove `\:*?"<>|`
- **Nome do arquivo:** `CERTIDÃO FEDERAL - 01419973000122 (EMITIDA DD MM AAAA) (VALIDADE DD MM AAAA).pdf`
- **Sem diálogos:** Tudo auto-save, sem `dialog.showSaveDialog`

---

## IPC Channels

| Channel | Direção | Descrição |
|---|---|---|
| `emitir-{tipo}` | renderer → main | Emite certidão individual |
| `emitir-todas` | renderer → main | Emite as 5 certidões em sequência |
| `buscar-empresa` | renderer → main | Consulta API opencnpj |
| `registrar-certidao` | renderer → main | Salva/atualiza no DB + Firebase + envia e-mail |
| `listar-registros` | renderer → main | Retorna todos os registros |
| `deletar-certidao` | renderer → main | Remove do DB + Firebase + PDF (opcional) |
| `visualizar-pdf` | renderer → main | Abre PDF local ou baixa da nuvem |
| `abrir-pasta-empresa` | renderer → main | Abre pasta no explorador |
| `abrir-pasta-certidoes` | renderer → main | Abre pasta raiz das certidões |
| `carregar-config-email` | renderer → main | Retorna config de e-mail |
| `salvar-config-email` | renderer → main | Salva config local + Firebase |
| `enviar-email-teste` | renderer → main | Dispara e-mail de teste |
| `verificar-vencimentos` | renderer → main | Verificação manual de vencimentos |
| `login` | renderer → main | Autentica usuário via Firebase |
| `cadastrar-usuario` | renderer → main | Cria novo acesso (admin only) |
| `listar-usuarios` | renderer → main | Lista todos os usuários |
| `deletar-usuario` | renderer → main | Remove acesso de usuário |
| `progresso` | main → renderer | Mensagens durante emitir-todas |
| `notificacao-enviada` | main → renderer | Feedback de alerta automático |
| `firebase-sync-concluida` | main → renderer | Notifica o renderer para re-atualizar o relatório |

---

## Relatório — Detalhes Técnicos

### Status (Badges)
| Condição | Badge | Cor |
|---|---|---|
| `dias > 15` ou sem validade | ATIVO | Verde (#16a34a) |
| `0 < dias ≤ 15` | ALERTA | Amarelo (#d97706) |
| `dias ≤ 0` | VENCIDO | Vermelho (#ef4444) |

### Ordenação da Tabela
| Coluna | Método |
|---|---|
| Empresa | `localeCompare('pt-BR')` alfabético |
| Tipo | `localeCompare('pt-BR')` no nome completo |
| Status | VENCIDO (0) → ALERTA (1) → ATIVO (2) |
| Vencimento | Parsing `DD/MM/AAAA` → timestamp |
| Dias p/ Vencer | Numérico (null = 99999, vai pro final) |

---

## Build

```bash
npm run build       # Gera dist/HidroForte-Certidoes.exe (~168MB portátil)
npm run build:dir   # Gera dist/win-unpacked/ (abertura instantânea, pasta com arquivos)
```

**Configuração (package.json):**
```json
{
  "main": "src/main/main.js",
  "build": {
    "files": ["src/**/*", "icon.png", "logo.png", "package.json", "node_modules/**/*"],
    "extraResources": [{ "from": "chrome-bundled", "to": "chrome-win64" }],
    "asar": false
  }
}
```

- **Chrome bundled:** v121.0.6167.85 (win64)
- **`asar: false`** é obrigatório (Puppeteer + módulos nativos)

---

## Dependências

| Pacote | Uso |
|---|---|
| `electron` 28 | Framework desktop |
| `electron-builder` 24 | Build portable exe |
| `puppeteer` 21 | Web scraping (Federal, FGTS, Trabalhista, Estadual) |
| `puppeteer-extra` + stealth | Anti-detecção de bot (Federal) |
| `axios` | HTTP requests (FGTS, Palmas, opencnpj) |
| `cheerio` | Parser HTML (Palmas) |
| `node-capmonster` | reCAPTCHA v2 + captcha imagem |
| `firebase-admin` | Firestore + PDF sync na nuvem |
| `nodemailer` | Envio de e-mails via Gmail SMTP |
| `iconv-lite` | Encoding de caracteres |

---

## Problemas Resolvidos

| Problema | Causa | Solução |
|---|---|---|
| Build não funciona em outro PC | Puppeteer v21+ armazena Chrome em `~/.cache/` | Chrome copiado para `chrome-bundled/`, `chrome.js` resolve path |
| `DOMMatrix is not defined` | pdf-parse não funciona no Electron | pdf.js CDN via Puppeteer page (Federal, Trabalhista) |
| Federal extraía validade +180 dias | Fallback incorreto | Reescrito com pdf.js CDN, sem fallback |
| PDF de Palmas é imagem | ASCII85 + FlateDecode | Decodificador manual + zlib + escapes octais |
| CNPJ com `/` quebra pastas | Caractere proibido no Windows | `sanitizarNomePasta()` troca `/` por `-` |
| Bucket Firebase não existe | Storage não provisionado | PDFs armazenados no Firestore como base64 |
| E-mail duplicado entre PCs | 5 PCs abrem o app no mesmo dia | Anti-dup via Firestore (`config/controle`) com fallback local |
| Relatório vazio após sync | Firebase sync assíncrona terminava depois do render | Main envia `firebase-sync-concluida` ao renderer para re-renderizar |

---

## Manutenção

1. **UI/CSS:** editar `src/renderer/styles.css`
2. **Lógica do renderer:** editar `src/renderer/renderer.js`
3. **Novo scraper:** criar `src/scrapers/novo.js` com `obterPDF(cnpj)` → adicionar handler em `src/main/main.js`
4. **reCAPTCHA SEFAZ-TO mudou:** atualizar site key em `src/scrapers/estadual.js`
5. **Captcha TST mudou:** ajustar seletor em `src/scrapers/trabalhista.js`
6. **Atualizar Chrome:** copiar novo para `chrome-bundled/`
7. **Firebase:** credenciais em `src/config/firebase-credentials.json`
8. **E-mail:** configuração padrão em `src/services/email.js` (CONFIG_PADRAO)
9. **Usuários:** gerenciados pela página de Administração (admin) ou direto no Firestore (`usuarios`)
10. **Logo:** substituir `logo.png` na raiz do projeto
