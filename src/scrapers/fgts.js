const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const puppeteer = require('puppeteer');
const { getChromePath } = require('./chrome');

/**
 * CND FGTS - Certificado de Regularidade do FGTS (Caixa Econômica Federal)
 * 
 * USO BÁSICO:
 * const { consultarCND } = require('./cnd-fgts');
 * const resultado = await consultarCND('01419973000122');
 * // Gera JSON + PDF automaticamente
 * 
 * USO SEM SALVAR ARQUIVOS:
 * const resultado = await consultarCND('01419973000122', false);
 * console.log(resultado.situacao); // "REGULAR" ou "IRREGULAR"
 * 
 * OBTER APENAS PDF (sem salvar):
 * const { obterPDF } = require('./cnd-fgts');
 * const { pdf, dados } = await obterPDF('01419973000122');
 * // pdf é um Buffer que você pode processar
 */

class CNDFGTS {
  constructor() {
    this.baseURL = 'https://consulta-crf.caixa.gov.br';
    this.cookies = {};
    this.viewState = '';
  }

  /**
   * Inicializa sessão e obtém ViewState
   */
  async inicializar() {
    const response = await axios.get(`${this.baseURL}/consultacrf/pages/consultaEmpregador.jsf`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Connection': 'keep-alive'
      }
    });

    // Extrair cookies
    if (response.headers['set-cookie']) {
      response.headers['set-cookie'].forEach(cookie => {
        const [cookiePair] = cookie.split(';');
        const [name, value] = cookiePair.split('=');
        this.cookies[name] = value;
      });
    }

    // Extrair ViewState do JSF
    const $ = cheerio.load(response.data);
    this.viewState = $('input[name="javax.faces.ViewState"]').val() || '';
  }

  /**
   * Detecta tipo de inscrição (CNPJ ou CEI)
   */
  detectarTipo(inscricao) {
    const limpo = inscricao.replace(/\D/g, '');
    // CNPJ tem 14 dígitos, CEI tem 12
    return limpo.length === 14 ? '1' : '2';
  }

  /**
   * Consulta CND FGTS
   */
  async consultar(cnpj, uf = '') {
    const inscricao = cnpj.replace(/\D/g, '');
    const tipoInscricao = this.detectarTipo(inscricao);

    // Montar payload JSF/AJAX
    const formData = new URLSearchParams({
      'AJAXREQUEST': '_viewRoot',
      'mainForm:tipoEstabelecimento': tipoInscricao,
      'mainForm:txtInscricao1': inscricao,
      'mainForm:uf': uf,
      'mainForm': 'mainForm',
      'autoScroll': '',
      'javax.faces.ViewState': this.viewState,
      'mainForm:btnConsultar': 'mainForm:btnConsultar'
    });

    const response = await axios.post(
      `${this.baseURL}/consultacrf/pages/consultaEmpregador.jsf`,
      formData.toString(),
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Origin': this.baseURL,
          'Referer': `${this.baseURL}/consultacrf/pages/consultaEmpregador.jsf`,
          'Cookie': Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '),
          'X-Requested-With': 'XMLHttpRequest'
        }
      }
    );

    return this.extrairDados(response.data);
  }

  /**
   * Extrai dados do XML/HTML retornado
   */
  extrairDados(html) {
    const $ = cheerio.load(html, { xmlMode: false });
    
    const resultado = {
      cnpj: '',
      razaoSocial: '',
      situacao: '',
      regular: false,
      mensagem: '',
      dataConsulta: '',
      linkCertificadoId: ''
    };

    // Tentar extrair dados da resposta AJAX
    const texto = $.text();
    
    // Buscar padrões comuns na resposta
    if (texto.includes('Regular') || texto.includes('REGULAR')) {
      resultado.situacao = 'REGULAR';
      resultado.regular = true;
    } else if (texto.includes('Irregular') || texto.includes('IRREGULAR')) {
      resultado.situacao = 'IRREGULAR';
      resultado.regular = false;
    }

    // Extrair CNPJ
    const cnpjMatch = texto.match(/(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/);
    if (cnpjMatch) {
      resultado.cnpj = cnpjMatch[1];
    }

    // Extrair razão social
    const razaoMatch = texto.match(/Raz.o [Ss]ocial[:\s]*([^\n\r<]+)/i);
    if (razaoMatch) {
      resultado.razaoSocial = razaoMatch[1].trim();
    }

    // Extrair data da consulta
    const dataMatch = texto.match(/Resultado da consulta em\s+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/i);
    if (dataMatch) {
      resultado.dataConsulta = dataMatch[1].trim();
    }

    // Extrair ID do link do certificado (para clicar depois)
    const linkMatch = html.match(/id="(mainForm:j_id\d+)"[^>]*>[\s]*Certificado de Regularidade/i);
    if (linkMatch) {
      resultado.linkCertificadoId = linkMatch[1];
    }

    // Extrair novo ViewState se houver
    const viewStateMatch = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/i);
    if (viewStateMatch) {
      this.viewState = viewStateMatch[1];
    }

    resultado.htmlResposta = html;

    return resultado;
  }

  /**
   * Gera PDF do certificado (fluxo completo até impressao.jsf)
   */
  async gerarPDF(resultado) {
    if (!resultado.linkCertificadoId) {
      throw new Error('Link do certificado não encontrado na resposta');
    }

    // Converter de ISO-8859-1 para UTF-8
    const iconv = require('iconv-lite');

    // ETAPA 1: Clicar no link do certificado → vai para FgeCfSImprimirCrf.jsf
    const formData1 = new URLSearchParams({
      'AJAXREQUEST': '_viewRoot',
      'mainForm:codAtivo': '',
      'mainForm:listEmpFpas': 'true',
      'mainForm:hidCodPessoa': '0',
      'mainForm:hidCodigo': '0',
      'mainForm:hidDescricao': '',
      'mainForm': 'mainForm',
      'autoScroll': '',
      'mainForm:_link_hidden_': '',
      'mainForm:j_idcl': '',
      'javax.faces.ViewState': this.viewState,
      [resultado.linkCertificadoId]: resultado.linkCertificadoId
    });

    const response1 = await axios.post(
      `${this.baseURL}/consultacrf/pages/consultaRegularidade.jsf`,
      formData1.toString(),
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Origin': this.baseURL,
          'Referer': `${this.baseURL}/consultacrf/pages/consultaRegularidade.jsf`,
          'Cookie': Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '),
          'X-Requested-With': 'XMLHttpRequest'
        },
        responseType: 'arraybuffer'
      }
    );

    let html1 = iconv.decode(Buffer.from(response1.data), 'iso-8859-1');
    
    // Extrair novo ViewState
    const viewStateMatch1 = html1.match(/javax\.faces\.ViewState[^>]*value="([^"]+)"/i);
    if (viewStateMatch1) {
      this.viewState = viewStateMatch1[1];
    }

    if (process.env.DEBUG) {
      fs.writeFileSync('debug_etapa1.html', html1, 'utf8');
    }

    // ETAPA 2: Clicar em "Visualizar" → vai para impressao.jsf
    const formData2 = new URLSearchParams({
      'AJAXREQUEST': '_viewRoot',
      'mainForm': 'mainForm',
      'autoScroll': '',
      'javax.faces.ViewState': this.viewState,
      'mainForm:btnVisualizar': 'mainForm:btnVisualizar'
    });

    const response2 = await axios.post(
      `${this.baseURL}/consultacrf/pages/FgeCfSImprimirCrf.jsf`,
      formData2.toString(),
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Origin': this.baseURL,
          'Referer': `${this.baseURL}/consultacrf/pages/FgeCfSImprimirCrf.jsf`,
          'Cookie': Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '),
          'X-Requested-With': 'XMLHttpRequest'
        },
        responseType: 'arraybuffer'
      }
    );

    // Detectar encoding correto (pode ser UTF-8 ou ISO-8859-1)
    let htmlContent = Buffer.from(response2.data).toString('utf8');
    
    // Se tiver caracteres bugados típicos de UTF-8 lido como ISO, já está em UTF-8
    // Se tiver caracteres ISO-8859-1, converter
    if (htmlContent.includes('Ã£') || htmlContent.includes('Ã§')) {
      // Está em UTF-8 mas com problemas - tentar latin1
      htmlContent = iconv.decode(Buffer.from(response2.data), 'latin1');
    }

    if (process.env.DEBUG) {
      fs.writeFileSync('debug_etapa2.html', htmlContent, 'utf8');
    }

    // Verificar se temos a página de impressão (tem btImprimir, não btnVisualizar)
    if (!htmlContent.includes('impressao.jsf') && !htmlContent.includes('btImprimir')) {
      // Se não chegou na página de impressão, pode ser que voltou para o início
      throw new Error('Não chegou na página de impressão. Verifique debug_etapa2.html');
    }

    // Usar logo da Caixa local
    let logoBase64 = '';
    const path = require('path');
    
    // Tentar vários caminhos possíveis
    const possiveisCaminhos = [
      path.join(__dirname, 'caixa.gif'),
      path.join(__dirname, 'estaticos', 'img', 'caixa.gif'),
      path.join(__dirname, 'Correto_files', 'caixa.gif'),
      path.join(process.cwd(), 'caixa.gif'),
      path.join(process.cwd(), 'estaticos', 'img', 'caixa.gif')
    ];
    
    for (const logoPath of possiveisCaminhos) {
      if (fs.existsSync(logoPath)) {
        const logoData = fs.readFileSync(logoPath);
        logoBase64 = `data:image/gif;base64,${logoData.toString('base64')}`;
        break;
      }
    }

    // Remover scripts (causam erro no html-pdf-node)
    htmlContent = htmlContent.replace(/<script[\s\S]*?<\/script>/gi, '');
    
    // Substituir TODAS as referências ao caixa.gif pelo base64
    if (logoBase64) {
      htmlContent = htmlContent.replace(/src\s*=\s*["'][^"']*caixa\.gif["']/gi, `src="${logoBase64}"`);
    }
    
    // Remover spacer gifs
    htmlContent = htmlContent.replace(/<img[^>]*spacer\.gif[^>]*>/gi, '');
    
    // Remover links de CSS externos (causam erro "Invalid URL")
    htmlContent = htmlContent.replace(/<link[^>]*href="\/[^"]*"[^>]*>/gi, '');
    htmlContent = htmlContent.replace(/<link[^>]*href="\.\.\/[^"]*"[^>]*>/gi, '');

    // Converter HTML para PDF usando Puppeteer
    const chromePath = getChromePath();
    const browser = await puppeteer.launch({
      headless: 'new',
      ...(chromePath ? { executablePath: chromePath } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
      printBackground: true
    });
    
    await browser.close();
    
    // Extrair validade do certificado
    let validade = '';
    const validadeMatch = htmlContent.match(/Validade:[\s<\/strong>]*?(\d{2}\/\d{2}\/\d{4})\s*a\s*(\d{2}\/\d{2}\/\d{4})/i);
    if (validadeMatch) {
      validade = validadeMatch[2]; // data final da validade
      console.log(`  - Validade: ${validadeMatch[1]} a ${validadeMatch[2]}`);
    }

    // Retornar PDF, HTML e validade
    return { pdf: pdfBuffer, html: htmlContent, validade };
  }

  /**
   * Salva resultado em arquivo JSON
   */
  salvarJSON(resultado, nomeArquivo = null) {
    const arquivo = nomeArquivo || `CND_FGTS_${resultado.cnpj.replace(/\D/g, '')}_${Date.now()}.json`;
    
    // Remover htmlResposta do JSON para deixar mais limpo
    const dadosLimpos = { ...resultado };
    delete dadosLimpos.htmlResposta;
    
    fs.writeFileSync(arquivo, JSON.stringify(dadosLimpos, null, 2), 'utf8');
    return arquivo;
  }

  /**
   * Salva PDF em arquivo
   */
  salvarPDF(pdfBuffer, resultado, nomeArquivo = null) {
    const arquivo = nomeArquivo || `CND_FGTS_${resultado.cnpj.replace(/\D/g, '')}_${Date.now()}.pdf`;
    fs.writeFileSync(arquivo, pdfBuffer);
    return arquivo;
  }
}

/**
 * Função principal para uso direto
 */
async function consultarCND(cnpj, salvarArquivo = true) {
  const cnd = new CNDFGTS();
  await cnd.inicializar();
  const resultado = await cnd.consultar(cnpj);
  
  if (salvarArquivo) {
    // Tentar gerar PDF do certificado
    try {
      const { pdf: pdfBuffer } = await cnd.gerarPDF(resultado);
      
      // Salvar PDF
      cnd.salvarPDF(pdfBuffer, resultado);
      resultado.pdfGerado = true;
    } catch (error) {
      console.log('   ⚠️  PDF não disponível:', error.message);
      resultado.pdfGerado = false;
    }
  }
  
  return resultado;
}

/**
 * Função auxiliar para obter apenas o PDF (sem salvar)
 */
async function obterPDF(cnpj) {
  const cnd = new CNDFGTS();
  await cnd.inicializar();
  const resultado = await cnd.consultar(cnpj);
  const { pdf: pdfBuffer, html: htmlCertificado, validade } = await cnd.gerarPDF(resultado);
  
  return {
    pdf: pdfBuffer,
    html: htmlCertificado,
    dados: resultado,
    validade
  };
}

// ============================================================
// TESTE - Altere o CNPJ aqui para testar
// ============================================================
const CNPJ_TESTE = '01419973000122';

// Executar teste se for chamado diretamente
if (require.main === module) {
  (async () => {
    try {
      console.log('🔍 Consultando CND FGTS (Caixa)...');
      console.log(`   CNPJ: ${CNPJ_TESTE}\n`);
      
      const resultado = await consultarCND(CNPJ_TESTE);
      
      console.log('✅ Resultado:');
      console.log(`   CNPJ: ${resultado.cnpj || 'N/A'}`);
      console.log(`   Razão Social: ${resultado.razaoSocial || 'N/A'}`);
      console.log(`   Situação: ${resultado.situacao || 'N/A'}`);
      console.log(`   Regular: ${resultado.regular ? 'SIM' : 'NÃO'}`);
      if (resultado.dataConsulta) {
        console.log(`   Data da Consulta: ${resultado.dataConsulta}`);
      }
      
      if (resultado.pdfGerado) {
        console.log('\n✅ PDF salvo com sucesso!\n');
      } else {
        console.log('\n⚠️  PDF não disponível\n');
      }
      
    } catch (error) {
      console.error('❌ Erro:', error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
      }
      process.exit(1);
    }
  })();
}

// Exportar para uso em outros arquivos
module.exports = {
  consultarCND,
  obterPDF,
  CNDFGTS
};
