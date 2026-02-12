const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { getChromePath } = require('./chrome');

/**
 * CNDT - Certidão Negativa de Débitos Trabalhistas
 * Tribunal Superior do Trabalho
 * 
 * USO BÁSICO:
 * const { obterPDF } = require('./cnd-trabalhista');
 * const { pdf, dados } = await obterPDF('01419973000122');
 */

// ==== CONFIGURAÇÃO ====
const CAPMONSTER_API_KEY = process.env.CAPMONSTER_API_KEY;
const BASE_URL = 'https://cndt-certidao.tst.jus.br';

class CNDTrabalhista {
    constructor(cnpj = '01419973000122') {
        this.cnpj = cnpj.replace(/\D/g, '');
        this.browser = null;
        this.page = null;
        this.pdfBuffer = null;
        this.downloadPath = path.join(os.tmpdir(), `cndt_download_${Date.now()}`);
    }

    formatCNPJ(cnpj) {
        const numbers = cnpj.replace(/\D/g, '');
        return numbers.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    }

    /**
     * Resolver captcha de imagem via CapMonster
     */
    async solveCaptcha(imageBase64) {
        console.log('\n[CAPTCHA] Iniciando resolução via CapMonster...');

        try {
            // Criar tarefa no CapMonster
            const createResponse = await axios.post('https://api.capmonster.cloud/createTask', {
                clientKey: CAPMONSTER_API_KEY,
                task: {
                    type: 'ImageToTextTask',
                    body: imageBase64,
                    CapMonsterModule: 'universal',
                    recognizingThreshold: 60,
                    Case: true, // Case sensitive
                    numeric: 0  // Pode ter letras e números
                }
            });

            if (createResponse.data.errorId !== 0) {
                throw new Error(`Erro ao criar tarefa: ${createResponse.data.errorDescription}`);
            }

            const taskId = createResponse.data.taskId;
            console.log(`  - Task ID: ${taskId}`);

            // Aguardar resultado
            let attempts = 0;
            const maxAttempts = 30;

            while (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 2000));

                const resultResponse = await axios.post('https://api.capmonster.cloud/getTaskResult', {
                    clientKey: CAPMONSTER_API_KEY,
                    taskId: taskId
                });

                if (resultResponse.data.status === 'ready') {
                    const text = resultResponse.data.solution.text;
                    console.log(`  - Captcha resolvido: "${text}"`);
                    return text;
                } else if (resultResponse.data.errorId !== 0) {
                    throw new Error(`Erro: ${resultResponse.data.errorDescription}`);
                }

                attempts++;
                console.log(`  - Aguardando... (${attempts}/${maxAttempts})`);
            }

            throw new Error('Timeout ao resolver captcha');
        } catch (error) {
            console.error('  - Erro ao resolver captcha:', error.message);
            throw error;
        }
    }

    async iniciar() {
        console.log('\n[BROWSER] Iniciando navegador...');

        const chromePath = getChromePath();
        this.browser = await puppeteer.launch({
            headless: 'new',
            ...(chromePath ? { executablePath: chromePath } : {}),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security'
            ]
        });

        this.page = await this.browser.newPage();

        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36');

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

        console.log('  - Navegador iniciado');
        console.log(`  - Download path: ${this.downloadPath}`);
    }

    async acessarPagina() {
        console.log('\n[ETAPA 1] Acessando página...');

        await this.page.goto(`${BASE_URL}/gerarCertidao.faces`, {
            waitUntil: 'networkidle0',
            timeout: 60000
        });

        // Aguardar o formulário carregar (usando seletor sem escape)
        await this.page.waitForFunction(() => {
            return document.getElementById('gerarCertidaoForm:cpfCnpj') !== null;
        }, { timeout: 30000 });

        // Aguardar o captcha carregar (a função loadCaptcha é chamada no onload)
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log('  - Página carregada');
    }

    async obterCaptcha() {
        console.log('\n[ETAPA 2] Obtendo captcha...');

        // O captcha é carregado via API e colocado na imagem
        // Vamos pegar diretamente da API
        const captchaData = await this.page.evaluate(async () => {
            try {
                const response = await fetch('/api');
                const data = await response.json();

                // Converter array de bytes para base64
                const imagem = btoa(String.fromCharCode.apply(null, new Uint8Array(data.imagem)));

                return {
                    tokenDesafio: data.tokenDesafio,
                    imagemBase64: imagem
                };
            } catch (e) {
                return { error: e.message };
            }
        });

        if (captchaData.error) {
            throw new Error(`Erro ao obter captcha: ${captchaData.error}`);
        }

        console.log(`  - Token obtido: ${captchaData.tokenDesafio.substring(0, 20)}...`);

        return captchaData;
    }

    async preencherFormulario(captchaData, captchaResposta) {
        console.log('\n[ETAPA 3] Preenchendo formulário...');

        const cnpjFormatado = this.formatCNPJ(this.cnpj);
        console.log(`  - CNPJ: ${cnpjFormatado}`);

        // Preencher CNPJ via evaluate (evita problemas com escape do seletor)
        await this.page.evaluate((cnpj) => {
            const campo = document.getElementById('gerarCertidaoForm:cpfCnpj');
            if (campo) {
                campo.value = '';
                campo.focus();
            }
        }, cnpjFormatado);

        // Digitar CNPJ caractere por caractere para ativar a máscara
        await this.page.evaluate(() => {
            document.getElementById('gerarCertidaoForm:cpfCnpj').focus();
        });
        await this.page.keyboard.type(cnpjFormatado, { delay: 30 });

        // Definir o token do captcha
        await this.page.evaluate((token) => {
            document.getElementById('tokenDesafio').value = token;
        }, captchaData.tokenDesafio);

        // Preencher resposta do captcha
        await this.page.evaluate(() => {
            document.getElementById('idCampoResposta').focus();
        });
        await this.page.keyboard.type(captchaResposta, { delay: 30 });

        console.log(`  - Resposta captcha: ${captchaResposta}`);
        console.log('  - Formulário preenchido');
    }

    async aguardarDownload(timeout = 30000) {
        console.log('  - Aguardando download do PDF...');

        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            await new Promise(resolve => setTimeout(resolve, 500));

            // Verificar se há arquivos na pasta de download
            if (fs.existsSync(this.downloadPath)) {
                const files = fs.readdirSync(this.downloadPath);

                // Procurar por PDF que não seja .crdownload (download em andamento)
                const pdfFiles = files.filter(f => f.endsWith('.pdf') && !f.endsWith('.crdownload'));

                if (pdfFiles.length > 0) {
                    const pdfPath = path.join(this.downloadPath, pdfFiles[0]);
                    console.log(`  - Arquivo encontrado: ${pdfFiles[0]}`);

                    // Ler o arquivo
                    const pdfBuffer = fs.readFileSync(pdfPath);

                    // Verificar se é PDF válido
                    if (pdfBuffer.length > 1000 && pdfBuffer.slice(0, 5).toString().startsWith('%PDF')) {
                        console.log(`  - PDF válido: ${pdfBuffer.length} bytes`);

                        // Limpar pasta temporária
                        fs.unlinkSync(pdfPath);

                        return pdfBuffer;
                    }
                }
            }
        }

        return null;
    }

    async emitirCertidao() {
        console.log('\n[ETAPA 4] Emitindo certidão...');

        // Clicar no botão Emitir via evaluate
        await this.page.evaluate(() => {
            document.getElementById('gerarCertidaoForm:btnEmitirCertidao').click();
        });

        console.log('  - Botão clicado, aguardando resposta...');

        // Aguardar um pouco para a página processar
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Verificar se há mensagem de erro
        const errorMessage = await this.page.evaluate(() => {
            const mensagens = document.getElementById('mensagens');
            if (mensagens && mensagens.textContent.trim()) {
                return mensagens.textContent.trim();
            }

            // Verificar erros em outros lugares
            const erros = document.querySelectorAll('.erroMensagem, .msgErro, [class*="error"], .ui-messages-error');
            for (const erro of erros) {
                if (erro.textContent.trim()) {
                    return erro.textContent.trim();
                }
            }

            return null;
        });

        if (errorMessage) {
            console.log(`  - Mensagem: ${errorMessage}`);
            // Se o erro indica captcha inválido, retornar erro específico
            if (errorMessage.toLowerCase().includes('captcha') ||
                errorMessage.toLowerCase().includes('caracteres') ||
                errorMessage.toLowerCase().includes('validação') ||
                errorMessage.toLowerCase().includes('código') ||
                errorMessage.toLowerCase().includes('desafio')) {
                return { success: false, error: errorMessage, retryable: true };
            }
        }

        // Verificar se a página mudou para tela de sucesso
        const textosCertidao = await this.page.evaluate(() => {
            const body = document.body.innerText;
            return {
                temSucesso: body.includes('EMITIDA com sucesso') || body.includes('emitida com sucesso'),
                temCertidao: body.includes('CERTIDÃO') || body.includes('Certidão'),
                temNadaConsta: body.includes('NADA CONSTA') || body.includes('nada consta')
            };
        });

        if (textosCertidao.temSucesso) {
            console.log('  - Certidão emitida com sucesso!');

            // Aguardar o download do PDF
            const pdfBuffer = await this.aguardarDownload(15000);

            if (pdfBuffer) {
                this.pdfBuffer = pdfBuffer;
                console.log('  - PDF capturado do download!');
                return { success: true };
            }

            // Se não conseguiu pegar do download, tentar outras abordagens
            console.log('  - PDF não encontrado no download, tentando outras abordagens...');

            // Verificar se há link para o PDF na página
            const pdfLink = await this.page.evaluate(() => {
                const links = document.querySelectorAll('a[href*=".pdf"], a[href*="certidao"], a[href*="download"]');
                for (const link of links) {
                    if (link.href) return link.href;
                }
                return null;
            });

            if (pdfLink) {
                console.log(`  - Link PDF encontrado: ${pdfLink}`);

                // Navegar para o link e capturar
                const newTab = await this.browser.newPage();

                // Configurar download na nova aba também
                const client = await newTab.target().createCDPSession();
                await client.send('Page.setDownloadBehavior', {
                    behavior: 'allow',
                    downloadPath: this.downloadPath
                });

                await newTab.goto(pdfLink, { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => { });

                // Aguardar download
                const pdfFromLink = await this.aguardarDownload(10000);

                await newTab.close().catch(() => { });

                if (pdfFromLink) {
                    this.pdfBuffer = pdfFromLink;
                    return { success: true };
                }
            }

            // Última tentativa: gerar PDF da página
            console.log('  - Gerando PDF da página atual...');
            return { success: true, needsCapture: true };
        }

        return { success: false, error: errorMessage || 'Não foi possível obter a certidão' };
    }

    async capturarPDFDaPagina() {
        console.log('\n[ETAPA 5] Capturando PDF da página...');

        // Tentar capturar o PDF se ainda não temos
        if (!this.pdfBuffer) {
            this.pdfBuffer = await this.page.pdf({
                format: 'A4',
                printBackground: true,
                margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
            });
            console.log(`  - PDF gerado: ${this.pdfBuffer.length} bytes`);
        }

        return this.pdfBuffer;
    }

    async extrairValidade(pdfBuffer) {
        console.log('\n[VALIDADE] Extraindo validade do PDF via Puppeteer...');
        try {
            const dataUrl = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
            const pdfPage = await this.browser.newPage();
            await pdfPage.goto(dataUrl, { waitUntil: 'networkidle0', timeout: 15000 }).catch(() => { });
            // Chrome renderiza PDFs, tentar pegar texto via plugin
            // Alternativa: usar pdf.js embutido no Chrome
            await new Promise(r => setTimeout(r, 2000));

            // Extrair texto do viewer de PDF do Chrome
            const texto = await pdfPage.evaluate(() => {
                // Tentar pegar do embed/plugin do Chrome
                const embed = document.querySelector('embed');
                if (embed && embed.contentDocument) {
                    return embed.contentDocument.body.innerText;
                }
                return document.body.innerText || '';
            }).catch(() => '');

            await pdfPage.close().catch(() => { });

            if (texto) {
                const match = texto.match(/Validade[:\s]*(\d{2}\/\d{2}\/\d{4})/i);
                if (match) {
                    console.log(`  - Validade encontrada: ${match[1]}`);
                    return match[1];
                }
            }

            // Fallback: converter PDF para HTML e buscar
            console.log('  - Tentando via setContent...');
            const htmlPage = await this.browser.newPage();
            await htmlPage.setContent(`
                <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"><\/script>
                <script>
                    async function extractText() {
                        const data = Uint8Array.from(atob('${pdfBuffer.toString('base64')}'), c => c.charCodeAt(0));
                        const pdf = await pdfjsLib.getDocument({data}).promise;
                        let text = '';
                        for (let i = 1; i <= pdf.numPages; i++) {
                            const page = await pdf.getPage(i);
                            const content = await page.getTextContent();
                            text += content.items.map(item => item.str).join(' ');
                        }
                        document.body.setAttribute('data-text', text);
                    }
                    extractText();
                <\/script>
            `, { waitUntil: 'networkidle0', timeout: 15000 }).catch(() => { });

            await new Promise(r => setTimeout(r, 3000));
            const pdfText = await htmlPage.evaluate(() => document.body.getAttribute('data-text') || '').catch(() => '');
            await htmlPage.close().catch(() => { });

            if (pdfText) {
                const match = pdfText.match(/Validade[:\s]*(\d{2}\/\d{2}\/\d{4})/i);
                if (match) {
                    console.log(`  - Validade encontrada (pdf.js): ${match[1]}`);
                    return match[1];
                }
            }

            console.log('  - Validade não encontrada');
        } catch (e) {
            console.log(`  - Erro ao extrair validade: ${e.message}`);
        }
        return '';
    }

    async finalizar() {
        if (this.browser) {
            await this.browser.close();
            console.log('\n[BROWSER] Navegador fechado');
        }

        // Limpar pasta temporária de downloads
        try {
            if (fs.existsSync(this.downloadPath)) {
                const files = fs.readdirSync(this.downloadPath);
                for (const file of files) {
                    fs.unlinkSync(path.join(this.downloadPath, file));
                }
                fs.rmdirSync(this.downloadPath);
            }
        } catch (e) {
            // Ignorar erros de limpeza
        }
    }

    async executar() {
        const maxTentativas = 5;
        let tentativa = 0;

        try {
            console.log('='.repeat(60));
            console.log('CNDT - CERTIDÃO NEGATIVA DE DÉBITOS TRABALHISTAS');
            console.log(`CNPJ: ${this.cnpj}`);
            console.log('='.repeat(60));

            await this.iniciar();
            await this.acessarPagina();

            while (tentativa < maxTentativas) {
                tentativa++;
                console.log(`\n>>> Tentativa ${tentativa}/${maxTentativas}`);

                // Obter dados do captcha
                const captchaData = await this.obterCaptcha();

                // Resolver captcha via CapMonster
                const captchaResposta = await this.solveCaptcha(captchaData.imagemBase64);

                // Preencher formulário
                await this.preencherFormulario(captchaData, captchaResposta);

                // Emitir certidão
                const resultado = await this.emitirCertidao();

                if (resultado.success) {
                    if (resultado.needsCapture || !this.pdfBuffer) {
                        await this.capturarPDFDaPagina();
                    }

                    // Extrair validade do PDF enquanto browser está aberto
                    let validade = '';
                    try {
                        validade = await this.extrairValidade(this.pdfBuffer);
                    } catch (e) {
                        console.log(`  - Falha ao extrair validade: ${e.message}`);
                    }

                    console.log('\n\u2713 CNDT obtida com sucesso!');
                    return {
                        success: true,
                        pdf: this.pdfBuffer,
                        validade,
                        dados: {
                            cnpj: this.cnpj,
                            situacao: 'NEGATIVA',
                            tipo: 'CNDT'
                        }
                    };
                }

                // Se erro não é de captcha, não adianta tentar de novo
                if (resultado.error && !resultado.error.toLowerCase().includes('validação') &&
                    !resultado.error.toLowerCase().includes('captcha') &&
                    !resultado.error.toLowerCase().includes('código')) {
                    console.log(`\n✗ Erro: ${resultado.error}`);
                    return { success: false, error: resultado.error };
                }

                // Captcha incorreto, tentar novamente
                if (tentativa < maxTentativas) {
                    console.log('\n⚠️ Captcha incorreto, recarregando...');
                    await this.page.reload({ waitUntil: 'networkidle0' });
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            console.log('\n✗ Não foi possível obter a CNDT após várias tentativas');
            return { success: false, error: 'Captcha incorreto após múltiplas tentativas' };

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
    const cndt = new CNDTrabalhista(cnpj);
    const resultado = await cndt.executar();

    if (resultado.success) {
        return {
            pdf: resultado.pdf,
            dados: resultado.dados,
            validade: resultado.validade || ''
        };
    } else {
        throw new Error(resultado.error || 'Erro ao obter CNDT');
    }
}

/**
 * Função para consultar e salvar
 */
async function consultarCND(cnpj, salvarArquivo = true) {
    const cndt = new CNDTrabalhista(cnpj);
    const resultado = await cndt.executar();

    if (resultado.success && salvarArquivo) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
        const filename = `CNDT_${cnpj}_${timestamp}.pdf`;
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
            console.log('🔍 Consultando CNDT...');
            console.log(`   CNPJ: ${CNPJ_TESTE}\n`);

            const resultado = await consultarCND(CNPJ_TESTE, true);

            if (resultado.success) {
                console.log('\n✅ CNDT obtida com sucesso!');
                if (resultado.dados) {
                    console.log(`   Situação: ${resultado.dados.situacao}`);
                }
            } else {
                console.log('\n❌ Erro:', resultado.error);
            }
        } catch (error) {
            console.error('❌ Erro:', error.message);
            process.exit(1);
        }
    })();
}

// Exportar para uso em outros arquivos
module.exports = {
    consultarCND,
    obterPDF,
    CNDTrabalhista
};
