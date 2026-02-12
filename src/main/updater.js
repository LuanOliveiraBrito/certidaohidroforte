const { autoUpdater } = require('electron-updater');
const { app, ipcMain } = require('electron');

/**
 * Configura o auto-update do aplicativo.
 * Verifica atualizações ao iniciar e periodicamente.
 * Envia eventos para o renderer via IPC para exibir feedback ao usuário.
 * 
 * @param {BrowserWindow} mainWindow - Janela principal do Electron
 */
function configurarAutoUpdate(mainWindow) {
    // Em desenvolvimento, não verifica updates
    if (!app.isPackaged) {
        console.log('[UPDATER] Ambiente de desenvolvimento — auto-update desativado.');
        return;
    }

    // Configuração do autoUpdater
    autoUpdater.autoDownload = true;        // Baixa automaticamente
    autoUpdater.autoInstallOnAppQuit = true; // Instala ao fechar o app

    // Não mostrar diálogos nativos (usamos nossa própria UI)
    autoUpdater.autoRunAppAfterInstall = true;

    // Log geral
    autoUpdater.logger = {
        info: (msg) => console.log(`[UPDATER] ${msg}`),
        warn: (msg) => console.warn(`[UPDATER] ${msg}`),
        error: (msg) => console.error(`[UPDATER] ${msg}`)
    };

    // ============ EVENTOS ============

    autoUpdater.on('checking-for-update', () => {
        console.log('[UPDATER] Verificando atualizações...');
    });

    autoUpdater.on('update-available', (info) => {
        console.log(`[UPDATER] Nova versão disponível: ${info.version}`);
        enviarParaRenderer(mainWindow, 'update-disponivel', {
            versao: info.version,
            mensagem: `Nova versão ${info.version} encontrada! Baixando...`
        });
    });

    autoUpdater.on('update-not-available', (info) => {
        console.log(`[UPDATER] Nenhuma atualização disponível. Versão atual: ${info.version}`);
    });

    autoUpdater.on('download-progress', (progress) => {
        const percent = Math.round(progress.percent);
        console.log(`[UPDATER] Download: ${percent}%`);
        enviarParaRenderer(mainWindow, 'update-progresso', {
            percentual: percent,
            velocidade: formatarBytes(progress.bytesPerSecond),
            transferido: formatarBytes(progress.transferred),
            total: formatarBytes(progress.total)
        });
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log(`[UPDATER] Download concluído: v${info.version}. Pronto para instalar.`);
        enviarParaRenderer(mainWindow, 'update-pronto', {
            versao: info.version,
            mensagem: `Versão ${info.version} pronta! Reinicie para atualizar.`
        });
    });

    autoUpdater.on('error', (err) => {
        console.error(`[UPDATER] Erro: ${err.message}`);
        enviarParaRenderer(mainWindow, 'update-erro', {
            mensagem: err.message
        });
    });

    // ============ IPC: INSTALAR UPDATE ============
    ipcMain.on('instalar-update', () => {
        console.log('[UPDATER] Instalando atualização e reiniciando...');
        autoUpdater.quitAndInstall(false, true);
    });

    // ============ VERIFICAÇÃO INICIAL ============
    // Aguarda 5 segundos após iniciar para verificar
    setTimeout(() => {
        console.log('[UPDATER] Verificação inicial...');
        autoUpdater.checkForUpdates().catch(err => {
            console.error(`[UPDATER] Erro na verificação inicial: ${err.message}`);
        });
    }, 5000);

    // ============ VERIFICAÇÃO PERIÓDICA ============
    // Verifica a cada 4 horas
    const INTERVALO_4H = 4 * 60 * 60 * 1000;
    setInterval(() => {
        console.log('[UPDATER] Verificação periódica...');
        autoUpdater.checkForUpdates().catch(err => {
            console.error(`[UPDATER] Erro na verificação periódica: ${err.message}`);
        });
    }, INTERVALO_4H);
}

// ============ HELPERS ============

function enviarParaRenderer(mainWindow, canal, dados) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(canal, dados);
    }
}

function formatarBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const unidades = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + unidades[i];
}

module.exports = { configurarAutoUpdate };
