const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { RecaptchaV2Task } = require('node-capmonster');
const { getChromePath } = require('./chrome');

/**
 * CND Estadual - SEFAZ Tocantins
 * 
 * USO BÁSICO:
 * const { obterPDF } = require('./cnd-estadual');
 * const { pdf, dados } = await obterPDF('01419973000122');
 * // pdf é um Buffer que você pode processar
 */

// ==== CONFIGURAÇÃO ====
const FINALIDADE = 'LICITAÇÃO';      // Finalidade da certidão
const CAPMONSTER_API_KEY = process.env.CAPMONSTER_API_KEY;

// Site key do reCAPTCHA v2 da SEFAZ-TO
const RECAPTCHA_SITE_KEY = '6LdVbykTAAAAAHKqhQKW5pIB0ipX5PH2A8ewgg_e';
const BASE_URL = 'https://www.sefaz.to.gov.br/cnd/com.cnd.hecwbcnd01';

class CNDEstadual {
    constructor(cnpj = '01419973000122') {
        this.cnpj = cnpj.replace(/\D/g, '');
        this.browser = null;
        this.page = null;
        this.pdfBuffer = null;
    }

    formatCNPJ(cnpj) {
        const numbers = cnpj.replace(/\D/g, '');
        return numbers.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    }

    async solveCaptcha() {
        console.log('\n[CAPTCHA] Iniciando resolução via CapMonster...');
        console.log(`  - Site Key: ${RECAPTCHA_SITE_KEY}`);
        console.log(`  - URL: ${BASE_URL}`);

        const capmonster = new RecaptchaV2Task(CAPMONSTER_API_KEY);

        try {
            const taskId = await capmonster.createTask(BASE_URL, RECAPTCHA_SITE_KEY);
            console.log(`  - Task ID: ${taskId}`);

            const result = await capmonster.joinTaskResult(taskId, 180000);
            console.log('  - Captcha resolvido com sucesso!');
            return result.gRecaptchaResponse;
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

        console.log('  - Navegador iniciado');
    }

    async acessarPagina() {
        console.log('\n[ETAPA 1] Acessando página...');

        await this.page.goto(BASE_URL, { waitUntil: 'networkidle0', timeout: 60000 });

        // Aguardar o formulário carregar
        await this.page.waitForSelector('#vNUM_CNPJ', { timeout: 30000 });

        console.log('  - Página carregada');
    }

    async preencherFormulario() {
        console.log('\n[ETAPA 2] Preenchendo formulário...');

        const cnpjFormatado = this.formatCNPJ(this.cnpj);
        console.log(`  - CNPJ: ${this.cnpj}`);
        console.log(`  - CNPJ formatado: ${cnpjFormatado}`);
        console.log(`  - Finalidade: ${FINALIDADE}`);

        // Método 1: Preencher via JavaScript diretamente (mais confiável)
        const preenchido = await this.page.evaluate((cnpjFormatado, cnpjNumeros) => {
            const campo = document.getElementById('vNUM_CNPJ');
            if (!campo) return { success: false, error: 'Campo não encontrado' };

            // Limpar campo
            campo.value = '';

            // Tentar com CNPJ formatado primeiro
            campo.value = cnpjFormatado;
            campo.dispatchEvent(new Event('input', { bubbles: true }));
            campo.dispatchEvent(new Event('change', { bubbles: true }));
            campo.dispatchEvent(new Event('blur', { bubbles: true }));

            // Verificar se aceitou
            if (campo.value && campo.value.length >= 14) {
                return { success: true, value: campo.value, method: 'formatado' };
            }

            // Tentar com números apenas
            campo.value = cnpjNumeros;
            campo.dispatchEvent(new Event('input', { bubbles: true }));
            campo.dispatchEvent(new Event('change', { bubbles: true }));
            campo.dispatchEvent(new Event('blur', { bubbles: true }));

            if (campo.value && campo.value.length >= 14) {
                return { success: true, value: campo.value, method: 'numeros' };
            }

            return { success: false, value: campo.value, error: 'Valor não aceito' };
        }, cnpjFormatado, this.cnpj);

        console.log(`  - Resultado preenchimento: ${JSON.stringify(preenchido)}`);

        // Se não funcionou via JS, tentar digitação simulada
        if (!preenchido.success || !preenchido.value) {
            console.log('  - Tentando digitação simulada...');

            // Clicar no campo para focar
            await this.page.click('#vNUM_CNPJ');
            await new Promise(resolve => setTimeout(resolve, 300));

            // Limpar
            await this.page.keyboard.down('Control');
            await this.page.keyboard.press('a');
            await this.page.keyboard.up('Control');
            await this.page.keyboard.press('Backspace');
            await new Promise(resolve => setTimeout(resolve, 200));

            // Digitar CNPJ formatado caractere por caractere
            for (const char of cnpjFormatado) {
                await this.page.keyboard.press(char === '.' ? 'Period' : char === '/' ? 'Slash' : char === '-' ? 'Minus' : `Digit${char}`);
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            await new Promise(resolve => setTimeout(resolve, 500));

            // Verificar valor final
            const valorFinal = await this.page.evaluate(() => {
                const campo = document.getElementById('vNUM_CNPJ');
                return campo ? campo.value : '';
            });
            console.log(`  - Valor após digitação: "${valorFinal}"`);
        }

        // Selecionar finalidade
        await this.page.select('#vFINALIDADE1', FINALIDADE);
        await new Promise(resolve => setTimeout(resolve, 500));

        console.log('  - Formulário preenchido');
    }

    async resolverCaptcha() {
        console.log('\n[ETAPA 3] Resolvendo captcha...');

        const captchaResponse = await this.solveCaptcha();

        // Injetar resposta do captcha usando o mecanismo do GeneXus gpxReCAPTCHA
        await this.page.evaluate((response) => {
            // 1. Preencher o textarea do recaptcha
            const textarea = document.getElementById('g-recaptcha-response');
            if (textarea) {
                textarea.value = response;
                textarea.innerHTML = response;
            }

            // 2. IMPORTANTE: Atualizar o objeto recaptchaObjects do GeneXus
            // O gpxReCAPTCHA cria um callback que seta t.Response = n
            if (window.recaptchaObjects && window.recaptchaObjects.length > 0) {
                for (let i = 0; i < window.recaptchaObjects.length; i++) {
                    window.recaptchaObjects[i].Response = response;
                    console.log('Atualizado recaptchaObjects[' + i + '].Response');
                }
            }

            // 3. Atualizar GXState com a resposta
            const gxStateInput = document.querySelector('input[name="GXState"]');
            if (gxStateInput) {
                try {
                    const gxState = JSON.parse(gxStateInput.value);
                    gxState.GPXRECAPTCHA1_Response = response;
                    gxStateInput.value = JSON.stringify(gxState);
                    console.log('GXState atualizado');
                } catch (e) {
                    console.error('Erro ao atualizar GXState:', e);
                }
            }

            // 4. Marcar o usercontrol como válido
            const container = document.getElementById('GPXRECAPTCHA1Container');
            if (container) {
                container.setAttribute('data-gxvalid', '1');
            }

            // 5. Se o GeneXus tem objeto gx.O, atualizar a propriedade
            if (typeof gx !== 'undefined' && gx.O) {
                // O GeneXus armazena as variáveis com prefixo
                if (typeof gx.O.GPXRECAPTCHA1_Response !== 'undefined') {
                    gx.O.GPXRECAPTCHA1_Response = response;
                }
                // Também pode estar em formato diferente
                if (typeof gx.O.GPXRECAPTCHA1 !== 'undefined' && gx.O.GPXRECAPTCHA1.Response !== undefined) {
                    gx.O.GPXRECAPTCHA1.Response = response;
                }
            }

            return response;
        }, captchaResponse);

        // Aguardar um pouco para processamento
        await new Promise(resolve => setTimeout(resolve, 500));

        console.log('  - Captcha injetado');
    }

    async clicarConfirmar() {
        console.log('\n[ETAPA 4] Clicando em Confirmar...');

        // Aguardar que a requisição AJAX complete
        const responsePromise = this.page.waitForResponse(
            response => response.url().includes('hecwbcnd01') && response.status() === 200,
            { timeout: 60000 }
        );

        // Clicar no botão Confirmar
        await this.page.click('#BUTTON3');

        // Aguardar resposta AJAX
        console.log('  - Aguardando resposta AJAX...');
        try {
            await responsePromise;
            console.log('  - Resposta AJAX recebida');
        } catch (e) {
            console.log('  - Timeout na resposta AJAX, continuando...');
        }

        // Aguardar processamento da página
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Verificar se houve mudança na página
        const currentUrl = this.page.url();
        console.log(`  - URL atual: ${currentUrl}`);

        console.log('  - Confirmação enviada');
    }

    async verificarResultado() {
        console.log('\n[ETAPA 5] Verificando resultado...');

        // Verificar se está na página de impressão (tem botão "Imprimir CND")
        const temBotaoImprimir = await this.page.evaluate(() => {
            const btn = document.getElementById('BUTTON6');
            return btn && (btn.value === 'Imprimir CND' || btn.title === 'Imprimir CND');
        });

        if (temBotaoImprimir) {
            console.log('  - Botão "Imprimir CND" encontrado!');
            return { success: true, needsClick: true };
        }

        // Pegar HTML para análise
        const html = await this.page.content();

        // Verificar se há mensagem de erro
        const errorText = await this.page.evaluate(() => {
            const errorEl = document.querySelector('.gx_ev.ErrorViewerBullet, [data-gx-id="gxErrorViewer"]');
            return errorEl ? errorEl.textContent.trim() : '';
        });

        if (errorText) {
            console.log(`  - Mensagem: ${errorText}`);
        }

        // Verificar se tem certidão
        const hasCertidao = html.includes('CERTIDÃO') ||
            html.includes('Certidão') ||
            html.includes('Nada Consta') ||
            html.includes('NEGATIVA DE DÉBITOS');

        if (hasCertidao) {
            console.log('  - Certidão encontrada!');
            return { success: true, html };
        }

        // Verificar se o GXState tem número de CND
        const gxStateData = await this.page.evaluate(() => {
            const gxStateInput = document.querySelector('input[name="GXState"]');
            if (gxStateInput) {
                try {
                    return JSON.parse(gxStateInput.value);
                } catch (e) {
                    return null;
                }
            }
            return null;
        });

        if (gxStateData) {
            console.log(`  - vCNDNUM: ${gxStateData.vCNDNUM}`);
            console.log(`  - vDV: ${gxStateData.vDV}`);
            console.log(`  - vERROCOD: ${gxStateData.vERROCOD || 'vazio'}`);
            console.log(`  - vNOMRAZ: ${gxStateData.vNOMRAZ || 'vazio'}`);

            if (gxStateData.vCNDNUM && gxStateData.vCNDNUM !== '0') {
                console.log('  - CND gerada!');
                return { success: true, cndNum: gxStateData.vCNDNUM, dv: gxStateData.vDV, razaoSocial: gxStateData.vNOMRAZ };
            }
        }

        return { success: false };
    }

    async clicarImprimirCND() {
        console.log('\n[ETAPA 6] Clicando em Imprimir CND...');

        let pdfBuffer = null;

        // Monitorar respostas na página atual
        const responseHandler = async (response) => {
            const contentType = response.headers()['content-type'] || '';
            const url = response.url();

            if (contentType.includes('application/pdf')) {
                console.log(`  - PDF detectado: ${url}`);
                try {
                    const buffer = await response.buffer();
                    if (buffer.length > 1000) {
                        pdfBuffer = buffer;
                        console.log(`  - PDF capturado: ${buffer.length} bytes`);
                    }
                } catch (e) {
                    console.log(`  - Erro buffer: ${e.message}`);
                }
            }
        };

        this.page.on('response', responseHandler);

        // Monitorar nova aba/janela também
        const newPagePromise = new Promise(resolve => {
            const handler = async target => {
                if (target.type() === 'page') {
                    const newPage = await target.page();
                    console.log('  - Nova aba detectada!');

                    // Monitorar respostas na nova aba
                    newPage.on('response', async (response) => {
                        const contentType = response.headers()['content-type'] || '';
                        if (contentType.includes('application/pdf')) {
                            try {
                                const buffer = await response.buffer();
                                if (buffer.length > 1000) {
                                    pdfBuffer = buffer;
                                    console.log(`  - PDF capturado da nova aba: ${buffer.length} bytes`);
                                }
                            } catch (e) { }
                        }
                    });

                    resolve(newPage);
                }
            };
            this.browser.on('targetcreated', handler);
            setTimeout(() => {
                this.browser.off('targetcreated', handler);
                resolve(null);
            }, 15000);
        });

        // Clicar no botão
        console.log('  - Clicando no botão...');
        await this.page.click('#BUTTON6');

        // Aguardar processamento
        console.log('  - Aguardando resposta...');
        await new Promise(resolve => setTimeout(resolve, 8000));

        // Verificar se nova aba foi aberta
        const newPage = await Promise.race([
            newPagePromise,
            new Promise(resolve => setTimeout(() => resolve(null), 2000))
        ]);

        if (newPage) {
            console.log('  - Processando nova aba...');
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Verificar URL da nova aba
            const newUrl = newPage.url();
            console.log(`  - URL nova aba: ${newUrl}`);

            // Tentar capturar conteúdo da nova aba
            if (!pdfBuffer) {
                // Fazer fetch na nova aba
                const pdfData = await newPage.evaluate(async () => {
                    try {
                        const response = await fetch(window.location.href, { credentials: 'include' });
                        const blob = await response.blob();
                        const arrayBuffer = await blob.arrayBuffer();
                        return Array.from(new Uint8Array(arrayBuffer));
                    } catch (e) {
                        return null;
                    }
                });

                if (pdfData && pdfData.length > 1000) {
                    pdfBuffer = Buffer.from(pdfData);
                    console.log(`  - PDF via fetch: ${pdfBuffer.length} bytes`);
                }
            }

            await newPage.close().catch(() => { });
        }

        // Remover listener
        this.page.off('response', responseHandler);

        // Verificar se a página atual mudou para uma página de PDF
        const currentUrl = this.page.url();
        console.log(`  - URL atual: ${currentUrl}`);

        // Se não capturou o PDF, tentar via navegação direta
        if (!pdfBuffer && currentUrl.includes('arecrpcnd')) {
            console.log('  - Tentando fetch direto...');

            const pdfData = await this.page.evaluate(async () => {
                try {
                    const response = await fetch(window.location.href, { credentials: 'include' });
                    const contentType = response.headers.get('content-type');
                    console.log('Content-Type:', contentType);

                    const blob = await response.blob();
                    const arrayBuffer = await blob.arrayBuffer();
                    return Array.from(new Uint8Array(arrayBuffer));
                } catch (e) {
                    console.error('Erro fetch:', e);
                    return null;
                }
            });

            if (pdfData && pdfData.length > 1000) {
                pdfBuffer = Buffer.from(pdfData);
                console.log(`  - PDF via fetch direto: ${pdfBuffer.length} bytes`);
            }
        }

        // Se capturou PDF válido, retornar
        if (pdfBuffer && pdfBuffer.length > 1000) {
            // Verificar se começa com %PDF
            const header = pdfBuffer.slice(0, 5).toString();
            if (header.startsWith('%PDF')) {
                this.pdfBuffer = pdfBuffer;
                console.log(`  - PDF válido capturado! (${pdfBuffer.length} bytes)`);
                return { success: true, pdfBuffer: pdfBuffer };
            } else {
                console.log(`  - Conteúdo não é PDF válido. Header: ${header}`);
            }
        }

        // Fallback: gerar PDF da página
        console.log('  - Gerando PDF da página (fallback)...');
        pdfBuffer = await this.page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
        });
        this.pdfBuffer = pdfBuffer;

        return { success: true, pdfBuffer: pdfBuffer, fallback: true };
    }

    async capturarPDFDaPagina(page, filepath) {
        // Tentar encontrar um iframe ou embed com PDF
        const pdfUrl = await page.evaluate(() => {
            // Verificar iframe
            const iframe = document.querySelector('iframe[src*=".pdf"], iframe[src*="report"]');
            if (iframe) return iframe.src;

            // Verificar embed
            const embed = document.querySelector('embed[type="application/pdf"], embed[src*=".pdf"]');
            if (embed) return embed.src;

            // Verificar object
            const obj = document.querySelector('object[type="application/pdf"], object[data*=".pdf"]');
            if (obj) return obj.data;

            return null;
        });

        if (pdfUrl) {
            console.log(`  - URL do PDF encontrada: ${pdfUrl}`);

            // Fazer download direto do PDF
            const response = await page.goto(pdfUrl, { waitUntil: 'networkidle0' });
            const buffer = await response.buffer();

            fs.writeFileSync(filepath, buffer);
            return true;
        }

        return false;
    }

    async capturarPDF(targetPage = null) {
        console.log('\n[PDF] Gerando PDF da página...');

        const page = targetPage || this.page;

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
        const filename = `CND-Estadual-TO_${CNPJ_TESTE}_${timestamp}.pdf`;
        const filepath = path.join(__dirname, filename);

        // Gerar PDF da página
        await page.pdf({
            path: filepath,
            format: 'A4',
            printBackground: true,
            margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
        });

        const stats = fs.statSync(filepath);
        console.log(`  - PDF salvo: ${filename} (${stats.size} bytes)`);
        return filepath;
    }

    async finalizar() {
        if (this.browser) {
            await this.browser.close();
            console.log('\n[BROWSER] Navegador fechado');
        }
    }

    async executar() {
        try {
            console.log('='.repeat(60));
            console.log('CND ESTADUAL - SEFAZ-TO (Puppeteer)');
            console.log(`CNPJ: ${this.cnpj}`);
            console.log('='.repeat(60));

            await this.iniciar();
            await this.acessarPagina();
            await this.preencherFormulario();
            await this.resolverCaptcha();
            await this.clicarConfirmar();

            const resultado = await this.verificarResultado();

            if (resultado.success) {
                if (resultado.needsClick) {
                    // Precisa clicar no botão Imprimir CND
                    const impressao = await this.clicarImprimirCND();

                    if (impressao.success && impressao.pdfBuffer) {
                        console.log('\n✓ PDF obtido com sucesso!');
                        return {
                            success: true,
                            pdf: impressao.pdfBuffer,
                            dados: {
                                cnpj: this.cnpj,
                                situacao: 'NEGATIVA',
                                cndNum: resultado.cndNum,
                                razaoSocial: resultado.razaoSocial
                            }
                        };
                    }
                }

                // Fallback: gerar PDF da página atual
                console.log('  - Gerando PDF da página atual...');
                const pdfBuffer = await this.page.pdf({
                    format: 'A4',
                    printBackground: true,
                    margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
                });

                return {
                    success: true,
                    pdf: pdfBuffer,
                    dados: {
                        cnpj: this.cnpj,
                        situacao: 'NEGATIVA',
                        cndNum: resultado.cndNum,
                        razaoSocial: resultado.razaoSocial
                    }
                };
            } else {
                console.log('\n✗ Não foi possível obter a CND');
                return { success: false, error: 'Não foi possível obter a CND Estadual' };
            }

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
    const cnd = new CNDEstadual(cnpj);
    const resultado = await cnd.executar();

    if (resultado.success) {
        // Validade = data de emissão + 30 dias
        const hoje = new Date();
        hoje.setDate(hoje.getDate() + 30);
        const validade = `${String(hoje.getDate()).padStart(2, '0')}/${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`;
        console.log(`[ESTADUAL] Validade (emissão + 30 dias): ${validade}`);

        return {
            pdf: resultado.pdf,
            dados: resultado.dados,
            validade
        };
    } else {
        throw new Error(resultado.error || 'Erro ao obter CND Estadual');
    }
}

/**
 * Função para consultar e salvar
 */
async function consultarCND(cnpj, salvarArquivo = true) {
    const cnd = new CNDEstadual(cnpj);
    const resultado = await cnd.executar();

    if (resultado.success && salvarArquivo) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
        const filename = `CND-Estadual-TO_${cnpj}_${timestamp}.pdf`;
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
            console.log('🔍 Consultando CND Estadual...');
            console.log(`   CNPJ: ${CNPJ_TESTE}\n`);

            const resultado = await consultarCND(CNPJ_TESTE, true);

            if (resultado.success) {
                console.log('\n✅ CND obtida com sucesso!');
                if (resultado.dados) {
                    console.log(`   Situação: ${resultado.dados.situacao}`);
                    console.log(`   Razão Social: ${resultado.dados.razaoSocial || 'N/A'}`);
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
    CNDEstadual
};
