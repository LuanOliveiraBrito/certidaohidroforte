const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getChromePath } = require('./chrome');

puppeteer.use(StealthPlugin());

/**
 * CND Federal - Receita Federal do Brasil
 * 
 * USO BÁSICO:
 * const { obterPDF } = require('./cnd-federal');
 * const { pdf, dados, validade } = await obterPDF('01419973000122');
 * // pdf é um Buffer que você pode salvar
 * 
 * USA: puppeteer-extra + stealth plugin para bypassar hCaptcha invisível
 */

const BASE_URL = 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj';

// Delay aleatório para simular comportamento humano
function humanDelay(min = 800, max = 2000) {
    const ms = Math.floor(Math.random() * (max - min)) + min;
    return new Promise(r => setTimeout(r, ms));
}

class CNDFederal {
    constructor(cnpj = '01419973000122') {
        this.cnpj = cnpj.replace(/\D/g, '');
        this.browser = null;
        this.page = null;
        this.pdfBuffer = null;
        this.downloadPath = path.join(os.tmpdir(), `cndf_download_${Date.now()}`);
    }

    async iniciar() {
        console.log('\n[BROWSER] Iniciando navegador com stealth...');
        
        const chromePath = getChromePath();
        this.browser = await puppeteer.launch({
            headless: false,  // OBRIGATÓRIO: headless é detectado pelo hCaptcha
            ...(chromePath ? { executablePath: chromePath } : {}),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--window-size=1280,800',
                '--window-position=-9999,-9999'
            ]
        });
        
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1280, height: 800 });
        
        // Criar pasta de download temporária
        if (!fs.existsSync(this.downloadPath)) {
            fs.mkdirSync(this.downloadPath, { recursive: true });
        }
        
        // Configurar CDP para interceptar downloads
        const client = await this.page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: this.downloadPath
        });
        
        console.log('  - Navegador iniciado (stealth ativo)');
        console.log(`  - Download path: ${this.downloadPath}`);
    }

    async acessarPagina() {
        console.log('\n[ETAPA 1] Acessando página da Receita Federal...');
        
        await this.page.goto(BASE_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        
        // Aguardar SPA renderizar o formulário
        await this.page.waitForSelector('input[name="niContribuinte"]', { timeout: 15000 });
        
        console.log('  - Página carregada');
        
        // Pausa humana ao carregar a página
        await humanDelay(1500, 3000);
        console.log('  - Pausa humana...');
        
        // Aceitar cookies se aparecer
        try {
            const buttons = await this.page.$$('button');
            for (const btn of buttons) {
                const text = await this.page.evaluate(el => el.textContent?.trim(), btn);
                if (text && text.includes('Aceitar')) {
                    await btn.click();
                    console.log('  - Cookies aceitos');
                    await humanDelay(500, 1200);
                    break;
                }
            }
        } catch(e) {}
    }

    // Simular movimento de mouse até um elemento
    async moverMouseAte(selector) {
        const el = typeof selector === 'string' ? await this.page.$(selector) : selector;
        if (!el) return;
        const box = await el.boundingBox();
        if (!box) return;
        // Mover para posição aleatória dentro do elemento
        const x = box.x + Math.random() * box.width;
        const y = box.y + Math.random() * box.height;
        await this.page.mouse.move(x, y, { steps: Math.floor(Math.random() * 10) + 5 });
    }

    async preencherEEmitir() {
        console.log('\n[ETAPA 2] Preenchendo CNPJ e emitindo...');
        console.log(`  - CNPJ: ${this.cnpj}`);
        
        // Simular: mover mouse até o campo
        const input = await this.page.$('input[name="niContribuinte"]');
        await this.moverMouseAte(input);
        await humanDelay(300, 800);
        
        // Clicar no campo
        await input.click();
        await humanDelay(400, 900);
        
        // Digitar CNPJ com velocidade humana (delay variável)
        for (const char of this.cnpj) {
            await this.page.keyboard.type(char, { delay: Math.floor(Math.random() * 80) + 50 });
        }
        console.log('  - CNPJ digitado');
        
        // Pausa após digitar (humano olha o que digitou)
        await humanDelay(1000, 2500);
        
        // Mover mouse até o botão Emitir
        const buttons = await this.page.$$('button');
        let btnEmitir = null;
        for (const btn of buttons) {
            const text = await this.page.evaluate(el => el.textContent?.trim(), btn);
            const type = await this.page.evaluate(el => el.type, btn);
            if (text === 'Emitir Certidão' && type === 'submit') {
                btnEmitir = btn;
                break;
            }
        }
        
        if (!btnEmitir) {
            btnEmitir = await this.page.$('button[type="submit"]');
        }
        
        if (!btnEmitir) {
            throw new Error('Botão "Emitir Certidão" não encontrado');
        }
        
        await this.moverMouseAte(btnEmitir);
        await humanDelay(300, 700);
        await btnEmitir.click();
        console.log('  - Botão "Emitir Certidão" clicado');
        console.log('  - hCaptcha invisível sendo resolvido pelo stealth...');
    }

    async aguardarNovaTela() {
        console.log('\n[ETAPA 3] Aguardando nova tela carregar...');
        
        // Esperar o botão "Emitir Nova Certidão" aparecer (até 40s)
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 1000));
            
            const btns = await this.page.$$('button');
            for (const btn of btns) {
                const text = await this.page.evaluate(e => e.textContent?.trim(), btn);
                if (text && text.includes('Emitir Nova Certid')) {
                    console.log(`  - Nova tela carregada (${i + 1}s)`);
                    return btn;
                }
            }
            
            // A cada 5s, logar estado da página para debug
            if (i % 5 === 0) {
                const pageText = await this.page.evaluate(() => document.body.innerText.substring(0, 800));
                const url = this.page.url();
                console.log(`  - [${i}s] URL: ${url}`);
                console.log(`  - [${i}s] Texto: ${pageText.substring(0, 200).replace(/\n/g, ' | ')}`);
                
                // Verificar se o hCaptcha falhou (challenge visível)
                const captchaState = await this.page.evaluate(() => {
                    const frames = document.querySelectorAll('iframe[title="hCaptcha challenge"]');
                    for (const f of frames) {
                        const parent = f.closest('div[style]');
                        if (parent && parent.style.display !== 'none' && parent.style.visibility !== 'hidden' && parent.style.opacity !== '0') {
                            return 'CHALLENGE_VISIBLE';
                        }
                    }
                    // Verificar textareas do hCaptcha
                    const resp = document.querySelector('textarea[name="h-captcha-response"]');
                    if (resp && resp.value) return 'RESPONSE_FILLED';
                    return 'NO_CHALLENGE';
                });
                console.log(`  - [${i}s] hCaptcha: ${captchaState}`);
                
                // Verificar erros
                if (pageText.toLowerCase().includes('cnpj inválido') || pageText.toLowerCase().includes('erro')) {
                    console.log('  - ERRO detectado na página!');
                    throw new Error(`Erro na página: ${pageText.substring(0, 300)}`);
                }
            }
        }
        
        throw new Error('Botão "Emitir Nova Certidão" não apareceu em 30s');
    }

    async emitirNovaCertidao(btnEmitirNova) {
        console.log('\n[ETAPA 4] Clicando em "Emitir Nova Certidão"...');
        
        // Pausa humana antes de clicar
        await humanDelay(1000, 2500);
        
        // Mover mouse até o botão
        await this.moverMouseAte(btnEmitirNova);
        await humanDelay(300, 600);
        
        // Interceptar novas abas e responses de PDF
        const newPagePromise = new Promise((resolve) => {
            this.browser.once('targetcreated', async (target) => {
                const p = await target.page();
                resolve(p);
            });
            // Timeout: se não abrir nova aba em 10s, resolve null
            setTimeout(() => resolve(null), 10000);
        });
        
        await btnEmitirNova.click();
        console.log('  - Botão clicado, aguardando PDF...');
        
        // Verificar se abriu nova aba com o PDF
        const newPage = await newPagePromise;
        if (newPage) {
            console.log('  - Nova aba detectada:', newPage.url());
            await new Promise(r => setTimeout(r, 3000)); // esperar carregar
            
            // Tentar pegar o PDF da nova aba
            try {
                const url = newPage.url();
                if (url.includes('blob:') || url.endsWith('.pdf') || url.includes('pdf')) {
                    // Capturar via CDP
                    const client = await newPage.target().createCDPSession();
                    const { data } = await client.send('Page.printToPDF', { printBackground: true });
                    this.pdfBuffer = Buffer.from(data, 'base64');
                    console.log(`  - PDF capturado da nova aba: ${this.pdfBuffer.length} bytes`);
                }
            } catch(e) {
                console.log(`  - Erro ao capturar da nova aba: ${e.message}`);
            }
        }
    }

    async aguardarDownload(timeout = 30000) {
        console.log('  - Aguardando download do PDF...');
        
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            await new Promise(resolve => setTimeout(resolve, 500));
            
            if (fs.existsSync(this.downloadPath)) {
                const files = fs.readdirSync(this.downloadPath);
                
                // Procurar por PDF que não seja .crdownload
                const pdfFiles = files.filter(f => f.endsWith('.pdf') && !f.endsWith('.crdownload'));
                
                if (pdfFiles.length > 0) {
                    const pdfPath = path.join(this.downloadPath, pdfFiles[0]);
                    console.log(`  - Arquivo encontrado: ${pdfFiles[0]}`);
                    
                    const pdfBuffer = fs.readFileSync(pdfPath);
                    
                    if (pdfBuffer.length > 1000 && pdfBuffer.slice(0, 5).toString().startsWith('%PDF')) {
                        console.log(`  - PDF válido: ${pdfBuffer.length} bytes`);
                        fs.unlinkSync(pdfPath);
                        return pdfBuffer;
                    }
                }
            }
        }
        
        return null;
    }

    /**
     * Extrai validade do PDF usando pdf.js via CDN em página separada
     * (mesmo método da cnd-trabalhista.js)
     */
    async extrairValidade(pdfBuffer) {
        if (!pdfBuffer || !this.browser) return '';

        console.log('\n[VALIDADE] Extraindo validade do PDF via pdf.js...');

        let pdfPage = null;
        try {
            const pdfBase64 = pdfBuffer.toString('base64');

            // Abrir página separada no browser (como faz a trabalhista)
            pdfPage = await this.browser.newPage();

            // Montar HTML que carrega pdf.js via CDN e extrai todo o texto
            await pdfPage.setContent(`
                <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"><\/script>
                <script>
                    async function extractText() {
                        try {
                            pdfjsLib.GlobalWorkerOptions.workerSrc =
                                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

                            const data = Uint8Array.from(atob('${pdfBase64}'), c => c.charCodeAt(0));
                            const pdf = await pdfjsLib.getDocument({ data }).promise;
                            let text = '';

                            for (let i = 1; i <= pdf.numPages; i++) {
                                const page = await pdf.getPage(i);
                                const content = await page.getTextContent();
                                text += content.items.map(item => item.str).join(' ') + '\\n';
                            }

                            document.body.setAttribute('data-text', text);
                            document.body.setAttribute('data-done', 'true');
                        } catch (e) {
                            document.body.setAttribute('data-error', e.message);
                            document.body.setAttribute('data-done', 'true');
                        }
                    }
                    extractText();
                <\/script>
            `, { waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {});

            // Aguardar extração terminar (máx 10s)
            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 500));
                const done = await pdfPage.evaluate(() => document.body.getAttribute('data-done'));
                if (done === 'true') break;
            }

            const error = await pdfPage.evaluate(() => document.body.getAttribute('data-error'));
            if (error) {
                console.log(`  - Erro pdf.js: ${error}`);
                return '';
            }

            const fullText = await pdfPage.evaluate(() => document.body.getAttribute('data-text') || '');

            if (!fullText) {
                console.log('  - Nenhum texto extraído do PDF');
                return '';
            }

            // Padrão 1: "válida até DD/MM/AAAA"
            const matchAteh = fullText.match(/[Vv][aá]lid[ao].*?até.*?(\d{2}\/\d{2}\/\d{4})/);
            if (matchAteh) {
                console.log(`  - Validade encontrada: ${matchAteh[1]}`);
                return matchAteh[1];
            }

            // Padrão 2: "Validade: DD/MM/AAAA"
            const matchValidade = fullText.match(/[Vv]alidade[:\s]+(\d{2}\/\d{2}\/\d{4})/);
            if (matchValidade) {
                console.log(`  - Validade encontrada: ${matchValidade[1]}`);
                return matchValidade[1];
            }

            // Padrão 3: "DD/MM/AAAA a DD/MM/AAAA" (pega a segunda data)
            const matchRange = fullText.match(/(\d{2}\/\d{2}\/\d{4})\s*a\s*(\d{2}\/\d{2}\/\d{4})/);
            if (matchRange) {
                console.log(`  - Validade encontrada: ${matchRange[2]}`);
                return matchRange[2];
            }

            // Padrão 4: "efeitos até DD/MM/AAAA"
            const matchEfeitos = fullText.match(/efeitos\s+at[ée]\s+(\d{2}\/\d{2}\/\d{4})/i);
            if (matchEfeitos) {
                console.log(`  - Validade encontrada: ${matchEfeitos[1]}`);
                return matchEfeitos[1];
            }

            // Padrão 5: genérico próximo a palavras-chave
            const matchGenerico = fullText.match(/(?:validade|v[aá]lid[ao]|at[eé]|vencimento|expira)[^0-9]{0,30}(\d{2}\/\d{2}\/\d{4})/i);
            if (matchGenerico) {
                console.log(`  - Validade encontrada: ${matchGenerico[1]}`);
                return matchGenerico[1];
            }

            console.log('  - Nenhum padrão de validade reconhecido no texto do PDF');
            return '';

        } catch (e) {
            console.log(`  - Erro ao extrair validade: ${e.message}`);
            return '';
        } finally {
            if (pdfPage) {
                await pdfPage.close().catch(() => {});
            }
        }
    }

    async finalizar() {
        if (this.browser) {
            await this.browser.close();
            console.log('\n[BROWSER] Navegador fechado');
        }
        
        // Limpar pasta temporária
        try {
            if (fs.existsSync(this.downloadPath)) {
                const files = fs.readdirSync(this.downloadPath);
                for (const file of files) {
                    fs.unlinkSync(path.join(this.downloadPath, file));
                }
                fs.rmdirSync(this.downloadPath);
            }
        } catch (e) {}
    }

    async executar() {
        try {
            console.log('='.repeat(60));
            console.log('CND FEDERAL - CERTIDÃO DE REGULARIDADE FISCAL');
            console.log(`CNPJ: ${this.cnpj}`);
            console.log('='.repeat(60));
            
            await this.iniciar();
            await this.acessarPagina();
            await this.preencherEEmitir();
            
            // Aguardar segunda tela
            const btnEmitirNova = await this.aguardarNovaTela();
            
            // Clicar "Emitir Nova Certidão"
            await this.emitirNovaCertidao(btnEmitirNova);
            
            // Se o PDF já foi capturado pela nova aba, pular download
            if (!this.pdfBuffer) {
                // Aguardar download do PDF (pode ser download direto)
                this.pdfBuffer = await this.aguardarDownload(15000);
            }
            
            if (!this.pdfBuffer) {
                console.log('  - Download/nova aba não funcionou, tentando outras abas...');
                
                // Verificar todas as abas abertas
                const pages = await this.browser.pages();
                console.log(`  - ${pages.length} abas abertas`);
                for (const p of pages) {
                    const url = p.url();
                    console.log(`  - Aba: ${url.substring(0, 100)}`);
                    if (url.includes('.pdf') || url.includes('blob:') || url.includes('certidao')) {
                        try {
                            await new Promise(r => setTimeout(r, 2000));
                            const client = await p.target().createCDPSession();
                            const { data } = await client.send('Page.printToPDF', { printBackground: true });
                            this.pdfBuffer = Buffer.from(data, 'base64');
                            console.log(`  - PDF capturado via printToPDF: ${this.pdfBuffer.length} bytes`);
                            break;
                        } catch(e) {
                            console.log(`  - Falha nessa aba: ${e.message}`);
                        }
                    }
                }
            }
            
            if (!this.pdfBuffer) {
                throw new Error('Não foi possível obter o PDF da certidão');
            }
            
            // Extrair validade
            let validade = '';
            try {
                validade = await this.extrairValidade(this.pdfBuffer);
            } catch (e) {
                console.log(`  - Falha ao extrair validade: ${e.message}`);
            }
            
            console.log('\n✓ CND Federal obtida com sucesso!');
            return {
                success: true,
                pdf: this.pdfBuffer,
                validade,
                dados: {
                    cnpj: this.cnpj,
                    tipo: 'CND Federal'
                }
            };
            
        } catch (error) {
            console.error('\n✗ Erro:', error.message);
            return { success: false, error: error.message };
        } finally {
            await this.finalizar();
        }
    }
}

/**
 * Função principal para obter PDF (sem salvar)
 */
async function obterPDF(cnpj) {
    const cnd = new CNDFederal(cnpj);
    const resultado = await cnd.executar();
    
    if (resultado.success) {
        return {
            pdf: resultado.pdf,
            dados: resultado.dados,
            validade: resultado.validade || ''
        };
    } else {
        throw new Error(resultado.error || 'Erro ao obter CND Federal');
    }
}

/**
 * Função para consultar e salvar
 */
async function consultarCND(cnpj, salvarArquivo = true) {
    const cnd = new CNDFederal(cnpj);
    const resultado = await cnd.executar();
    
    if (resultado.success && salvarArquivo) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
        const filename = `CND_Federal_${cnpj}_${timestamp}.pdf`;
        const filepath = path.join(__dirname, filename);
        
        fs.writeFileSync(filepath, resultado.pdf);
        console.log(`✅ PDF salvo: ${filepath}`);
        
        resultado.arquivo = filepath;
    }
    
    return resultado;
}

// Executar se chamado diretamente
if (require.main === module) {
    const CNPJ_TESTE = '01419973000122';
    
    (async () => {
        try {
            console.log('Consultando CND Federal...');
            console.log(`   CNPJ: ${CNPJ_TESTE}\n`);
            
            const resultado = await consultarCND(CNPJ_TESTE, true);
            
            if (resultado.success) {
                console.log('\n✅ CND Federal obtida com sucesso!');
                if (resultado.validade) console.log(`   Validade: ${resultado.validade}`);
            } else {
                console.log('\n❌ Erro:', resultado.error);
            }
        } catch (error) {
            console.error('❌ Erro:', error.message);
            process.exit(1);
        }
    })();
}

module.exports = {
    consultarCND,
    obterPDF,
    CNDFederal
};
