require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const emailService = require('../services/email');
const firebaseService = require('../services/firebase');
const { configurarAutoUpdate } = require('./updater');

// Polyfill para File - necessário para undici no Electron
const { Blob } = require('buffer');
if (typeof globalThis.File === 'undefined') {
    globalThis.File = class File extends Blob {
        constructor(chunks, name, options = {}) {
            super(chunks, options);
            this.name = name;
            this.lastModified = options.lastModified || Date.now();
        }
    };
}

let mainWindow;

// ============ PERSISTÊNCIA LOCAL (JSON) ============
// Armazena registros de certidões emitidas para o relatório
// Estrutura preparada para futuro sistema de notificações por email

function getDbPath() {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'certidoes-db.json');
}

function lerDB() {
    try {
        const dbPath = getDbPath();
        if (fs.existsSync(dbPath)) {
            const data = fs.readFileSync(dbPath, 'utf-8');
            const db = JSON.parse(data);

            // Migração: garantir que config_email existe (DBs criados antes dessa feature)
            if (!db.config_email) {
                db.config_email = {
                    remetente: 'controladoriahfsaneamento@gmail.com',
                    senha_app: 'yvbi yypr udsx uibj',
                    destinatarios: ['luanoliveirabritonunes@gmail.com'],
                    dias_alerta: 15,
                    ativo: true,
                    verificar_ao_abrir: true
                };
                // Remover campo antigo se existir
                if (db.config_notificacao) {
                    delete db.config_notificacao;
                }
                // Salvar migração
                const dbPathSave = getDbPath();
                fs.writeFileSync(dbPathSave, JSON.stringify(db, null, 2), 'utf-8');
                console.log('[DB] Migração: config_email criado com sucesso.');
            }

            return db;
        }
    } catch (e) {
        console.error('[DB] Erro ao ler banco:', e.message);
    }
    return {
        registros: [],
        config_email: {
            remetente: 'controladoriahfsaneamento@gmail.com',
            senha_app: 'yvbi yypr udsx uibj',
            destinatarios: ['luanoliveirabritonunes@gmail.com'],
            dias_alerta: 15,
            ativo: true,
            verificar_ao_abrir: true
        }
    };
}

function salvarDB(db) {
    try {
        const dbPath = getDbPath();
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
    } catch (e) {
        console.error('[DB] Erro ao salvar banco:', e.message);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, '..', '..', 'icon.png'),
        title: 'Hidro Forte - Emissão de Certidões'
    });

    mainWindow.maximize();
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    // Remover menu padrão
    mainWindow.setMenuBarVisibility(false);

    // Verificar vencimentos ao abrir
    mainWindow.webContents.once('did-finish-load', () => {
        // Configurar auto-update
        configurarAutoUpdate(mainWindow);
        // Inicializar Firebase e sincronizar
        inicializarFirebaseESincronizar();
        // Verificar vencimentos
        verificarVencimentosAoIniciar();
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Função para formatar data no padrão DD MM AAAA
function formatarData() {
    const hoje = new Date();
    const dia = String(hoje.getDate()).padStart(2, '0');
    const mes = String(hoje.getMonth() + 1).padStart(2, '0');
    const ano = hoje.getFullYear();
    return `${dia} ${mes} ${ano}`;
}

// Função para formatar CNPJ
function formatarCNPJ(cnpj) {
    const numeros = cnpj.replace(/\D/g, '');
    return numeros.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

// Função para gerar nome do arquivo
function gerarNomeArquivo(tipo, cnpj, validade) {
    const data = formatarData();
    const cnpjLimpo = cnpj.replace(/\D/g, '');
    if (validade) {
        // Converte DD/MM/AAAA para DD MM AAAA
        const validadeFormatada = validade.replace(/\//g, ' ');
        return `${tipo} - ${cnpjLimpo} (EMITIDA ${data}) (VALIDADE ${validadeFormatada}).pdf`;
    }
    return `${tipo} - ${cnpjLimpo} (EMITIDA ${data}).pdf`;
}

// ============ PASTA DE CERTIDÕES ============
// Retorna o caminho base da pasta "certidões" ao lado do executável/projeto
function getCertidoesBasePath() {
    // Em produção (empacotado): ao lado do .exe
    // Em desenvolvimento: raiz do projeto (2 níveis acima de src/main/)
    const basePath = app.isPackaged
        ? path.dirname(process.execPath)
        : path.join(__dirname, '..', '..');
    return path.join(basePath, 'certidões');
}

// Remove caracteres não permitidos em nomes de pastas/arquivos no Windows
// Troca / por - para manter CNPJ legível (XX.XXX.XXX-XXXX-XX)
function sanitizarNomePasta(nome) {
    // Caracteres proibidos no Windows: \ / : * ? " < > |
    return nome
        .replace(/\//g, '-')
        .replace(/[\\:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Cache de nomes de empresa para evitar múltiplas chamadas à API na mesma sessão
const empresaCacheMain = {};

// Busca o nome da empresa via API e retorna o nome da pasta formatado
// Ex: "FACEBOOK SERVICOS ONLINE DO BRASIL LTDA. - 13.347.016/0001-17"
async function obterNomePastaEmpresa(cnpj) {
    const cnpjLimpo = cnpj.replace(/\D/g, '');
    const cnpjFormatado = formatarCNPJ(cnpjLimpo);

    // Verificar cache
    if (empresaCacheMain[cnpjLimpo]) {
        const nome = empresaCacheMain[cnpjLimpo];
        return sanitizarNomePasta(`${nome} - ${cnpjFormatado}`);
    }

    try {
        const response = await axios.get(`https://api.opencnpj.org/${cnpjLimpo}`, {
            timeout: 10000,
            headers: { 'Accept': 'application/json' }
        });

        const razao = response.data.razao_social || '';
        const fantasia = response.data.nome_fantasia || '';
        const nome = razao || fantasia || cnpjLimpo;

        empresaCacheMain[cnpjLimpo] = nome;

        return sanitizarNomePasta(`${nome} - ${cnpjFormatado}`);
    } catch (e) {
        console.error(`[EMPRESA] Erro ao buscar ${cnpjLimpo}:`, e.message);
        // Fallback: só CNPJ
        return sanitizarNomePasta(`${cnpjLimpo} - ${cnpjFormatado}`);
    }
}

// Garante que a pasta da empresa existe e retorna o caminho completo
async function garantirPastaEmpresa(cnpj) {
    const base = getCertidoesBasePath();
    const nomePasta = await obterNomePastaEmpresa(cnpj);
    const pastaEmpresa = path.join(base, nomePasta);

    if (!fs.existsSync(pastaEmpresa)) {
        fs.mkdirSync(pastaEmpresa, { recursive: true });
        console.log(`[PASTA] Criada: ${pastaEmpresa}`);
    }

    return pastaEmpresa;
}

// Função auxiliar para emitir uma certidão (usado por handlers individuais e emitir-todas)
// tipoNome = nome para exibição/nome de arquivo (ex: "CERTIDÃO FEDERAL")
async function emitirCertidaoInterno(tipoNome, moduloPath, cnpj, event) {
    const modulo = require(moduloPath);
    const resultado = await modulo.obterPDF(cnpj);

    const validade = resultado.validade || '';
    if (validade) console.log(`[${tipoNome}] Validade: ${validade}`);

    const pastaEmpresa = await garantirPastaEmpresa(cnpj);
    const nomeArquivo = gerarNomeArquivo(tipoNome, cnpj, validade);
    const caminhoCompleto = path.join(pastaEmpresa, nomeArquivo);

    fs.writeFileSync(caminhoCompleto, resultado.pdf);
    console.log(`[SALVO] ${caminhoCompleto}`);

    // Mapear nome exibição → chave do tipo (para upload consistente com o DB)
    const MAPA_TIPO_CHAVE = {
        'CERTIDÃO FEDERAL': 'federal',
        'CERTIDÃO ESTADUAL': 'estadual',
        'CERTIDÃO FGTS': 'fgts',
        'CERTIDÃO TRABALHISTA': 'trabalhista',
        'CERTIDÃO MUNICIPAL PALMAS': 'palmas'
    };
    const tipoChave = MAPA_TIPO_CHAVE[tipoNome] || tipoNome.toLowerCase();

    // Upload do PDF para Firestore (assíncrono, não bloqueia)
    firebaseService.uploadPDF(cnpj, tipoChave, caminhoCompleto).catch(err => {
        console.error(`[STORAGE] Erro no upload após emissão: ${err.message}`);
    });

    return {
        sucesso: true,
        arquivo: caminhoCompleto,
        nome: nomeArquivo,
        validade,
        pastaEmpresa
    };
}

// ============ HANDLERS INDIVIDUAIS ============

ipcMain.handle('emitir-federal', async (event, cnpj) => {
    try {
        return await emitirCertidaoInterno('CERTIDÃO FEDERAL', '../scrapers/federal', cnpj, event);
    } catch (error) {
        return { sucesso: false, mensagem: error.message };
    }
});

ipcMain.handle('emitir-estadual', async (event, cnpj) => {
    try {
        return await emitirCertidaoInterno('CERTIDÃO ESTADUAL', '../scrapers/estadual', cnpj, event);
    } catch (error) {
        return { sucesso: false, mensagem: error.message };
    }
});

ipcMain.handle('emitir-fgts', async (event, cnpj) => {
    try {
        return await emitirCertidaoInterno('CERTIDÃO FGTS', '../scrapers/fgts', cnpj, event);
    } catch (error) {
        return { sucesso: false, mensagem: error.message };
    }
});

ipcMain.handle('emitir-trabalhista', async (event, cnpj) => {
    try {
        return await emitirCertidaoInterno('CERTIDÃO TRABALHISTA', '../scrapers/trabalhista', cnpj, event);
    } catch (error) {
        return { sucesso: false, mensagem: error.message };
    }
});

ipcMain.handle('emitir-palmas', async (event, cnpj) => {
    try {
        return await emitirCertidaoInterno('CERTIDÃO MUNICIPAL PALMAS', '../scrapers/palmas', cnpj, event);
    } catch (error) {
        return { sucesso: false, mensagem: error.message };
    }
});

// ============ EMITIR TODAS ============
ipcMain.handle('emitir-todas', async (event, cnpj) => {
    const resultados = [];
    const tipos = [
        { nome: 'CERTIDÃO FEDERAL', modulo: '../scrapers/federal' },
        { nome: 'CERTIDÃO FGTS', modulo: '../scrapers/fgts' },
        { nome: 'CERTIDÃO TRABALHISTA', modulo: '../scrapers/trabalhista' },
        { nome: 'CERTIDÃO MUNICIPAL PALMAS', modulo: '../scrapers/palmas' },
        { nome: 'CERTIDÃO ESTADUAL', modulo: '../scrapers/estadual' }
    ];

    // Garantir pasta da empresa antes de começar
    let pastaEmpresa;
    try {
        pastaEmpresa = await garantirPastaEmpresa(cnpj);
    } catch (e) {
        return { sucesso: false, mensagem: `Erro ao criar pasta: ${e.message}` };
    }

    for (const tipo of tipos) {
        try {
            event.sender.send('progresso', `Emitindo ${tipo.nome}...`);
            const resultado = await emitirCertidaoInterno(tipo.nome, tipo.modulo, cnpj, event);
            resultados.push({
                tipo: tipo.nome,
                sucesso: true,
                arquivo: resultado.nome,
                validade: resultado.validade || ''
            });
        } catch (error) {
            resultados.push({ tipo: tipo.nome, sucesso: false, erro: error.message });
        }
    }

    return { sucesso: true, resultados, pasta: pastaEmpresa };
});

// Abrir pasta no explorador
ipcMain.handle('abrir-pasta', async (event, pasta) => {
    shell.openPath(pasta);
});

// ============ HANDLER: BUSCAR EMPRESA (API opencnpj) ============
ipcMain.handle('buscar-empresa', async (event, cnpj) => {
    try {
        const cnpjLimpo = cnpj.replace(/\D/g, '');
        const response = await axios.get(`https://api.opencnpj.org/${cnpjLimpo}`, {
            timeout: 10000,
            headers: { 'Accept': 'application/json' }
        });

        const data = response.data;
        return {
            sucesso: true,
            razao_social: data.razao_social || '',
            nome_fantasia: data.nome_fantasia || '',
            cnpj: cnpjLimpo
        };
    } catch (e) {
        console.error('[EMPRESA] Erro ao buscar:', e.message);
        return {
            sucesso: false,
            mensagem: e.response?.status === 404
                ? 'CNPJ não encontrado'
                : `Erro ao buscar empresa: ${e.message}`
        };
    }
});

// ============ HANDLER: REGISTRAR CERTIDÃO ============
// Salva ou atualiza o registro de uma certidão emitida no banco local.
// Se já existe um registro para o mesmo CNPJ + tipo, atualiza (mantém só o mais recente).
// Dispara e-mail de notificação de nova certidão.
ipcMain.handle('registrar-certidao', async (event, dados) => {
    try {
        const db = lerDB();

        // Verificar se já existe registro para mesmo CNPJ + tipo
        const idx = db.registros.findIndex(
            r => r.cnpj === dados.cnpj && r.tipo === dados.tipo
        );

        const registro = {
            cnpj: dados.cnpj,
            tipo: dados.tipo,
            validade: dados.validade || '',
            razao_social: dados.razao_social || '',
            nome_fantasia: dados.nome_fantasia || '',
            data_emissao: dados.data_emissao || new Date().toLocaleDateString('pt-BR'),
            arquivo: dados.arquivo || '',
            pasta_empresa: dados.pasta_empresa || '',
            atualizado_em: new Date().toISOString(),
            notificacao_enviada: false,
            email_notificacao: dados.email_notificacao || ''
        };

        if (idx >= 0) {
            db.registros[idx] = registro;
            console.log(`[DB] Atualizado: ${dados.tipo} - ${dados.cnpj}`);
        } else {
            db.registros.push(registro);
            console.log(`[DB] Novo registro: ${dados.tipo} - ${dados.cnpj}`);
        }

        salvarDB(db);

        // Sincronizar com Firebase (assíncrono, não bloqueia)
        firebaseService.registrarCertidao(registro).catch(err => {
            console.error(`[FIREBASE] Erro ao sincronizar: ${err.message}`);
        });

        // Disparar e-mail de nova certidão (assíncrono, não bloqueia)
        const config = db.config_email;
        if (config && config.ativo) {
            emailService.enviarEmailNovaCertidao(config, registro)
                .then(res => {
                    console.log(`[EMAIL] Nova certidão notificada: ${registro.tipo} - ${registro.cnpj}`);
                })
                .catch(err => {
                    console.error(`[EMAIL] Erro ao notificar nova certidão: ${err.message}`);
                });
        }

        return { sucesso: true };
    } catch (e) {
        console.error('[DB] Erro ao registrar:', e.message);
        return { sucesso: false, mensagem: e.message };
    }
});

// ============ HANDLERS: AUTENTICAÇÃO E USUÁRIOS ============
ipcMain.handle('login', async (event, { usuario, senha }) => {
    try {
        // Inicializar Firebase se necessário
        firebaseService.inicializar();
        return await firebaseService.autenticarUsuario(usuario, senha);
    } catch (e) {
        return { sucesso: false, mensagem: 'Erro ao autenticar. Tente novamente.' };
    }
});

ipcMain.handle('cadastrar-usuario', async (event, { usuario, senha, nivel, criadoPor }) => {
    try {
        return await firebaseService.cadastrarUsuario(usuario, senha, nivel, criadoPor);
    } catch (e) {
        return { sucesso: false, mensagem: e.message };
    }
});

ipcMain.handle('listar-usuarios', async () => {
    try {
        return await firebaseService.listarUsuarios();
    } catch (e) {
        return [];
    }
});

ipcMain.handle('deletar-usuario', async (event, usuario) => {
    try {
        return await firebaseService.deletarUsuario(usuario);
    } catch (e) {
        return { sucesso: false, mensagem: e.message };
    }
});

// ============ HANDLER: LISTAR REGISTROS ============
ipcMain.handle('listar-registros', async () => {
    try {
        const db = lerDB();
        return db.registros;
    } catch (e) {
        console.error('[DB] Erro ao listar:', e.message);
        return [];
    }
});

// ============ HANDLER: ABRIR PASTA DA EMPRESA ============
ipcMain.handle('abrir-pasta-empresa', async (event, cnpj) => {
    try {
        const pastaEmpresa = await garantirPastaEmpresa(cnpj);
        shell.openPath(pastaEmpresa);
        return { sucesso: true };
    } catch (e) {
        return { sucesso: false, mensagem: e.message };
    }
});

// ============ HANDLER: ABRIR PASTA CERTIDÕES (raiz) ============
ipcMain.handle('abrir-pasta-certidoes', async () => {
    try {
        const base = getCertidoesBasePath();
        if (!fs.existsSync(base)) {
            fs.mkdirSync(base, { recursive: true });
        }
        shell.openPath(base);
        return { sucesso: true };
    } catch (e) {
        return { sucesso: false, mensagem: e.message };
    }
});

// ============ HANDLER: VISUALIZAR PDF ============
// 1. Se o arquivo existe localmente → abre direto
// 2. Se não → baixa do Firebase Storage → salva na pasta da empresa → abre
ipcMain.handle('visualizar-pdf', async (event, { cnpj, tipo }) => {
    try {
        const db = lerDB();
        const registro = db.registros.find(r => r.cnpj === cnpj && r.tipo === tipo);

        // Tentar abrir arquivo local
        if (registro && registro.arquivo && fs.existsSync(registro.arquivo)) {
            shell.openPath(registro.arquivo);
            return { sucesso: true, origem: 'local' };
        }

        // Não existe localmente → baixar do Firebase Storage
        console.log(`[VISUALIZAR] PDF local não encontrado. Tentando baixar da nuvem: ${cnpj}/${tipo}`);

        const pastaEmpresa = await garantirPastaEmpresa(cnpj);

        // Gerar nome do arquivo (tipo mapeado para nome legível)
        const nomesArquivo = {
            'federal': 'CERTIDÃO FEDERAL',
            'estadual': 'CERTIDÃO ESTADUAL',
            'fgts': 'CERTIDÃO FGTS',
            'trabalhista': 'CERTIDÃO TRABALHISTA',
            'palmas': 'CERTIDÃO MUNICIPAL PALMAS'
        };
        const nomeTipo = nomesArquivo[tipo] || tipo.toUpperCase();
        const nomeArquivo = gerarNomeArquivo(nomeTipo, cnpj, registro?.validade || '');
        const caminhoDestino = path.join(pastaEmpresa, nomeArquivo);

        const resultado = await firebaseService.downloadPDF(cnpj, tipo, caminhoDestino);

        if (resultado.sucesso) {
            // Atualizar o caminho do arquivo no banco local
            if (registro) {
                registro.arquivo = caminhoDestino;
                registro.pasta_empresa = pastaEmpresa;
                salvarDB(db);
            }

            shell.openPath(caminhoDestino);
            return { sucesso: true, origem: 'nuvem' };
        } else {
            return { sucesso: false, mensagem: resultado.mensagem || 'PDF não disponível na nuvem' };
        }
    } catch (e) {
        console.error('[VISUALIZAR] Erro:', e.message);
        return { sucesso: false, mensagem: e.message };
    }
});

// ============ HANDLER: DELETAR CERTIDÃO ============
// Remove o registro do banco local e opcionalmente o arquivo PDF do disco
ipcMain.handle('deletar-certidao', async (event, { cnpj, tipo, deletarArquivo }) => {
    try {
        const db = lerDB();
        const idx = db.registros.findIndex(
            r => r.cnpj === cnpj && r.tipo === tipo
        );

        if (idx < 0) {
            return { sucesso: false, mensagem: 'Registro não encontrado' };
        }

        const registro = db.registros[idx];

        // Deletar arquivo do disco se solicitado
        if (deletarArquivo && registro.arquivo) {
            try {
                if (fs.existsSync(registro.arquivo)) {
                    fs.unlinkSync(registro.arquivo);
                    console.log(`[DELETE] Arquivo removido: ${registro.arquivo}`);
                }
            } catch (e) {
                console.error(`[DELETE] Erro ao remover arquivo: ${e.message}`);
            }
        }

        // Remover do banco
        db.registros.splice(idx, 1);
        salvarDB(db);
        console.log(`[DB] Registro removido: ${tipo} - ${cnpj}`);

        // Remover do Firebase (assíncrono)
        firebaseService.deletarCertidao(cnpj, tipo).catch(err => {
            console.error(`[FIREBASE] Erro ao deletar: ${err.message}`);
        });

        // Remover PDF do Storage (assíncrono)
        firebaseService.deletarPDF(cnpj, tipo).catch(err => {
            console.error(`[STORAGE] Erro ao deletar PDF: ${err.message}`);
        });

        return { sucesso: true };
    } catch (e) {
        console.error('[DB] Erro ao deletar:', e.message);
        return { sucesso: false, mensagem: e.message };
    }
});

// ============ HANDLER: CARREGAR CONFIG E-MAIL ============
ipcMain.handle('carregar-config-email', async () => {
    try {
        const db = lerDB();
        return { sucesso: true, config: db.config_email || emailService.CONFIG_PADRAO };
    } catch (e) {
        return { sucesso: false, mensagem: e.message };
    }
});

// ============ HANDLER: SALVAR CONFIG E-MAIL ============
ipcMain.handle('salvar-config-email', async (event, config) => {
    try {
        const db = lerDB();
        db.config_email = config;
        salvarDB(db);
        console.log('[EMAIL] Config salva.');

        // Sincronizar com Firebase (assíncrono)
        firebaseService.salvarConfigEmail(config).catch(err => {
            console.error(`[FIREBASE] Erro ao salvar config email: ${err.message}`);
        });

        return { sucesso: true };
    } catch (e) {
        return { sucesso: false, mensagem: e.message };
    }
});

// ============ HANDLER: ENVIAR E-MAIL DE TESTE ============
ipcMain.handle('enviar-email-teste', async () => {
    try {
        const db = lerDB();
        const config = db.config_email || emailService.CONFIG_PADRAO;
        const resultado = await emailService.enviarEmailTeste(config);
        console.log('[EMAIL] Teste enviado:', resultado.messageId);
        return resultado;
    } catch (e) {
        console.error('[EMAIL] Erro no teste:', e.message);
        return { sucesso: false, mensagem: e.message };
    }
});

// ============ HANDLER: VERIFICAR VENCIMENTOS ============
// Botão manual: sempre verifica e envia (não respeita trava diária)
ipcMain.handle('verificar-vencimentos', async () => {
    try {
        const db = lerDB();
        const config = db.config_email || emailService.CONFIG_PADRAO;

        if (!config.ativo) {
            return { sucesso: true, enviado: false, mensagem: 'Notificações desativadas.' };
        }

        const resultado = await emailService.verificarVencimentosENotificar(config, db.registros);

        // Salvar data da última verificação para controle anti-duplicação
        if (resultado.enviado) {
            db.ultima_verificacao_vencimentos = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            salvarDB(db);
            // Marcar no Firestore também
            firebaseService.marcarVerificacaoHoje().catch(e => console.error('[FIREBASE] Erro ao marcar verificação manual:', e.message));
        }

        console.log('[EMAIL] Verificação:', resultado.mensagem);
        return resultado;
    } catch (e) {
        console.error('[EMAIL] Erro na verificação:', e.message);
        return { sucesso: false, mensagem: e.message };
    }
});

// ============ VERIFICAR VENCIMENTOS AO INICIAR ============
// Verificação automática com controle anti-duplicação via Firestore:
// Checa no Firestore se já foi enviado hoje (por qualquer PC).
// Se não, envia e marca. Se sim, ignora.
// Fallback: JSON local caso Firestore esteja offline.
function verificarVencimentosAoIniciar() {
    setTimeout(async () => {
        try {
            const db = lerDB();
            const config = db.config_email;
            if (!config || !config.ativo || !config.verificar_ao_abrir) return;
            if (!db.registros || db.registros.length === 0) return;

            // Controle anti-duplicação via Firestore (prioridade)
            const jaVerificouFirestore = await firebaseService.jaVerificouHoje();
            if (jaVerificouFirestore) {
                console.log('[EMAIL] Verificação de vencimentos já realizada hoje (Firestore). Ignorando.');
                return;
            }

            // Fallback: controle via JSON local
            const hoje = new Date().toISOString().split('T')[0];
            if (db.ultima_verificacao_vencimentos === hoje) {
                console.log('[EMAIL] Verificação de vencimentos já realizada hoje (local). Ignorando.');
                return;
            }

            console.log('[EMAIL] Verificando vencimentos ao iniciar...');
            const resultado = await emailService.verificarVencimentosENotificar(config, db.registros);

            if (resultado.enviado) {
                // Marcar como feito no Firestore (trava para TODOS os PCs)
                await firebaseService.marcarVerificacaoHoje();

                // Marcar também no JSON local
                const dbAtual = lerDB();
                dbAtual.ultima_verificacao_vencimentos = hoje;
                salvarDB(dbAtual);

                console.log(`[EMAIL] Alerta enviado: ${resultado.totalAlertas} certidão(ões)`);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('notificacao-enviada', resultado);
                }
            } else {
                console.log('[EMAIL] Nenhum alerta necessário.');
            }
        } catch (e) {
            console.error('[EMAIL] Erro na verificação automática:', e.message);
        }
    }, 8000); // Aguarda 8s (dá tempo pro Firebase inicializar)
}

// ============ INICIALIZAÇÃO FIREBASE + SINCRONIZAÇÃO ============
async function inicializarFirebaseESincronizar() {
    try {
        const ok = firebaseService.inicializar();
        if (!ok) {
            console.log('[FIREBASE] Não foi possível inicializar. Funcionando apenas local.');
            return;
        }

        // Garantir que existe um admin padrão
        await firebaseService.garantirAdminPadrao();

        const db = lerDB();

        // Sincronizar registros: nuvem ↔ local
        const registrosMesclados = await firebaseService.sincronizarNuvemParaLocal(db.registros);

        // Sempre atualizar o DB local com o resultado da mesclagem
        // (inclui deleções feitas por outros PCs)
        db.registros = registrosMesclados;
        salvarDB(db);
        console.log(`[FIREBASE] Banco local atualizado: ${registrosMesclados.length} registros.`);

        // Enviar registros locais (já mesclados) para nuvem
        await firebaseService.sincronizarLocalParaNuvem(db.registros);

        // Upload de PDFs locais que ainda não estão na nuvem (background)
        for (const r of db.registros) {
            if (r.arquivo && fs.existsSync(r.arquivo)) {
                firebaseService.pdfExisteNaNuvem(r.cnpj, r.tipo).then(existe => {
                    if (!existe) {
                        firebaseService.uploadPDF(r.cnpj, r.tipo, r.arquivo).catch(e =>
                            console.error(`[STORAGE] Erro upload sync: ${e.message}`)
                        );
                    }
                }).catch(() => { });
            }
        }

        // Sincronizar config de email
        const configNuvem = await firebaseService.carregarConfigEmail();
        if (configNuvem && !db.config_email) {
            db.config_email = configNuvem;
            salvarDB(db);
            console.log('[FIREBASE] Config e-mail restaurada da nuvem.');
        } else if (db.config_email && !configNuvem) {
            await firebaseService.salvarConfigEmail(db.config_email);
            console.log('[FIREBASE] Config e-mail enviada para nuvem.');
        }

        console.log('[FIREBASE] Sincronização concluída.');

        // Notificar renderer para atualizar o relatório com os dados sincronizados
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('firebase-sync-concluida');
        }
    } catch (e) {
        console.error('[FIREBASE] Erro na sincronização inicial:', e.message);
    }
}
