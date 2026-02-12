const path = require('path');
const fs = require('fs');

/**
 * Retorna o caminho do executável do Chrome empacotado com o app.
 * - Em modo desenvolvimento: usa o Chrome do cache do puppeteer (~/.cache/puppeteer)
 * - Em modo empacotado (build): usa o Chrome em resources/chrome-win64/chrome.exe
 */
function getChromePath() {
    const isPackaged = process.mainModule && process.mainModule.filename.indexOf('app.asar') !== -1
        || (process.resourcesPath && !process.resourcesPath.includes('node_modules'));

    // Tentar caminho empacotado primeiro
    const packedPath = path.join(process.resourcesPath || '', 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(packedPath)) {
        console.log(`[CHROME] Usando Chrome empacotado: ${packedPath}`);
        return packedPath;
    }

    // Fallback: caminho do cache do puppeteer (desenvolvimento)
    const cachePaths = [
        path.join(process.env.USERPROFILE || '', '.cache', 'puppeteer', 'chrome', 'win64-121.0.6167.85', 'chrome-win64', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'puppeteer', 'chrome', 'win64-121.0.6167.85', 'chrome-win64', 'chrome.exe'),
    ];

    for (const p of cachePaths) {
        if (fs.existsSync(p)) {
            console.log(`[CHROME] Usando Chrome do cache: ${p}`);
            return p;
        }
    }

    // Último fallback: deixar o puppeteer resolver sozinho (funciona em dev)
    console.log('[CHROME] Nenhum Chrome encontrado manualmente, deixando puppeteer resolver...');
    return undefined;
}

module.exports = { getChromePath };
