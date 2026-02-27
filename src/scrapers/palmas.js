const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const zlib = require('zlib');

/**
 * CND Palmas - Capturador de Certidão Negativa de Débitos
 * Prefeitura de Palmas - TO
 * 
 * USO BÁSICO:
 * const { consultarCND } = require('./cnd-palmas');
 * const resultado = await consultarCND('01419973000122', 'Licitação');
 * // Gera JSON + PDF automaticamente
 * 
 * USO SEM SALVAR ARQUIVOS:
 * const resultado = await consultarCND('01419973000122', 'Licitação', false);
 * console.log(resultado.situacao); // "NEGATIVA"
 * 
 * OBTER APENAS PDF (sem salvar):
 * const { obterPDF } = require('./cnd-palmas');
 * const { pdf, dados } = await obterPDF('01419973000122', 'Licitação');
 * // pdf é um Buffer que você pode processar
 */

class CNDPalmas {
  constructor() {
    this.baseURL = 'http://certidao.palmas.to.gov.br';
    this.cookies = {};
    this.csrfToken = '';
  }

  /**
   * Inicializa sessão e obtém CSRF token
   */
  async inicializar() {
    const response = await axios.get(`${this.baseURL}/cnd-pessoa/`, {
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

    // Extrair CSRF token
    const $ = cheerio.load(response.data);
    this.csrfToken = $('input[name="csrfmiddlewaretoken"]').val() || this.cookies.csrftoken;
  }

  /**
   * Consulta CND
   */
  async consultar(cnpj, finalidade = 'Licitação') {
    const formData = new URLSearchParams({
      csrfmiddlewaretoken: this.csrfToken,
      numero: cnpj.replace(/\D/g, ''),
      finalidade: finalidade,
      outra: '',
      btnAcao: 'Consultar'
    });

    const response = await axios.post(
      `${this.baseURL}/cnd-pessoa/`,
      formData.toString(),
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': this.baseURL,
          'Referer': `${this.baseURL}/cnd-pessoa/`,
          'Cookie': Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
        }
      }
    );

    return this.extrairDados(response.data);
  }

  /**
   * Extrai dados do HTML
   */
  extrairDados(html) {
    const $ = cheerio.load(html);
    
    const resultado = {
      cpfCnpj: '',
      contribuinte: '',
      situacao: '',
      inscricoes: [],
      temDebito: false,
      mensagem: '',
      ccp: '',
      finalidade: ''
    };

    // CPF/CNPJ
    const cpfCnpjLabel = $('label.label-tramite-item:contains("CPF/CNPJ:")');
    if (cpfCnpjLabel.length) {
      resultado.cpfCnpj = cpfCnpjLabel.next('strong').text().trim();
    }

    // Contribuinte
    const contribuinteLabel = $('label.label-tramite-item:contains("Contribuinte:")');
    if (contribuinteLabel.length) {
      resultado.contribuinte = contribuinteLabel.next('strong').text().trim();
    }

    // Mensagem e situação
    const mensagemDebito = $('.card-panel.blue.lighten-3 b').text().trim();
    resultado.mensagem = mensagemDebito;
    resultado.temDebito = !mensagemDebito.includes('NENHUM DÉBITO');
    resultado.situacao = resultado.temDebito ? 'COM DÉBITO' : 'NEGATIVA';

    // Inscrições
    $('input[name="inscricao"]').each((i, elem) => {
      resultado.inscricoes.push($(elem).val());
    });

    // Outros dados
    resultado.ccp = $('input[name="ccp"]').val();
    resultado.finalidade = $('input[name="finalidade"]').val();

    return resultado;
  }

  /**
   * Gera PDF da certidão
   */
  async gerarPDF(resultado) {
    const formData = new URLSearchParams({
      csrfmiddlewaretoken: this.csrfToken,
      situacao: resultado.situacao === 'NEGATIVA' ? 'None' : resultado.situacao,
      cgc: resultado.cpfCnpj,
      ccp: resultado.ccp || '',
      nome: resultado.contribuinte,
      finalidade: resultado.finalidade || 'Licitação',
      qtdeInscricao: resultado.inscricoes.length.toString(),
      btnAcao: 'imprimir'
    });

    // Adicionar inscrições
    resultado.inscricoes.forEach(inscricao => {
      formData.append('inscricao', inscricao);
    });

    const response = await axios.post(
      `${this.baseURL}/imprimir/`,
      formData.toString(),
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': this.baseURL,
          'Referer': `${this.baseURL}/cnd-pessoa/`,
          'Cookie': Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
        },
        responseType: 'arraybuffer'
      }
    );

    return response.data;
  }

  /**
   * Salva resultado em arquivo JSON
   */
  salvarJSON(resultado, nomeArquivo = null) {
    const arquivo = nomeArquivo || `CND_Palmas_${resultado.cpfCnpj.replace(/\D/g, '')}_${Date.now()}.json`;
    fs.writeFileSync(arquivo, JSON.stringify(resultado, null, 2), 'utf8');
    return arquivo;
  }

  /**
   * Salva PDF em arquivo
   */
  salvarPDF(pdfBuffer, resultado, nomeArquivo = null) {
    const arquivo = nomeArquivo || `CND_Palmas_${resultado.cpfCnpj.replace(/\D/g, '')}_${Date.now()}.pdf`;
    fs.writeFileSync(arquivo, pdfBuffer);
    return arquivo;
  }
}

/**
 * Função principal para uso direto
 */
async function consultarCND(cnpj, finalidade = 'Licitação', salvarArquivo = true) {
  const cnd = new CNDPalmas();
  await cnd.inicializar();
  const resultado = await cnd.consultar(cnpj, finalidade);
  
  if (salvarArquivo) {
    // Salvar JSON
    cnd.salvarJSON(resultado);
    
    // Gerar e salvar PDF
    try {
      const pdfBuffer = await cnd.gerarPDF(resultado);
      cnd.salvarPDF(pdfBuffer, resultado);
      resultado.pdfGerado = true;
    } catch (error) {
      console.log('   ⚠️  PDF não pôde ser gerado:', error.message);
      resultado.pdfGerado = false;
    }
  }
  
  return resultado;
}

// ============================================================
// TESTE - Altere o CNPJ aqui para testar
// ============================================================
const CNPJ_TESTE = '01419973000122';
const FINALIDADE_TESTE = 'Licitação';

// Executar teste se for chamado diretamente
if (require.main === module) {
  (async () => {
    try {
      console.log('🔍 Consultando CND Palmas...');
      console.log(`   CNPJ: ${CNPJ_TESTE}`);
      console.log(`   Finalidade: ${FINALIDADE_TESTE}\n`);
      
      const resultado = await consultarCND(CNPJ_TESTE, FINALIDADE_TESTE);
      
      console.log('✅ Resultado:');
      console.log(`   CPF/CNPJ: ${resultado.cpfCnpj}`);
      console.log(`   Contribuinte: ${resultado.contribuinte}`);
      console.log(`   Situação: ${resultado.situacao}`);
      console.log(`   Tem Débito: ${resultado.temDebito ? 'SIM' : 'NÃO'}`);
      console.log(`   Mensagem: ${resultado.mensagem}`);
      
      if (resultado.pdfGerado) {
        console.log('\n✅ Arquivos salvos: JSON + PDF\n');
      } else {
        console.log('\n✅ Arquivo JSON salvo (PDF não disponível)\n');
      }
      
    } catch (error) {
      console.error('❌ Erro:', error.message);
      process.exit(1);
    }
  })();
}

/**
 * Função auxiliar para obter apenas o PDF (sem salvar)
 */
/**
 * Decodifica dados em formato ASCII85 (Base85)
 */
function decodeASCII85(data) {
  let str = data.replace(/\s/g, '');
  if (str.startsWith('<~')) str = str.substring(2);
  if (str.endsWith('~>')) str = str.substring(0, str.length - 2);
  
  const result = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === 'z') {
      result.push(0, 0, 0, 0);
      i++;
      continue;
    }
    const block = [];
    for (let j = 0; j < 5 && i < str.length; j++, i++) {
      block.push(str.charCodeAt(i) - 33);
    }
    const padding = 5 - block.length;
    while (block.length < 5) block.push(84);
    let value = block[0] * 52200625 + block[1] * 614125 + block[2] * 7225 + block[3] * 85 + block[4];
    const bytes = [(value >> 24) & 0xFF, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF];
    for (let j = 0; j < 4 - padding; j++) result.push(bytes[j]);
  }
  return Buffer.from(result);
}

/**
 * Converte escapes octais do PDF (\343 = ã, \341 = á, etc) para caracteres
 */
function decodeOctalEscapes(str) {
  return str.replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Extrai a validade do PDF da certidão municipal
 * Descomprime streams ASCII85+FlateDecode e busca nos operadores Tj
 * Padrão: "Certidão válida até DD de Mês de AAAA"
 */
async function extrairValidadeDoPDF(pdfBuffer) {
  try {
    const meses = {
      'janeiro': '01', 'fevereiro': '02', 'março': '03', 'marco': '03',
      'abril': '04', 'maio': '05', 'junho': '06',
      'julho': '07', 'agosto': '08', 'setembro': '09',
      'outubro': '10', 'novembro': '11', 'dezembro': '12'
    };

    const buf = Buffer.from(pdfBuffer);
    const raw = buf.toString('latin1');
    const textos = [];

    // Encontrar todos os streams e decodificá-los
    let pos = 0;
    while (pos < buf.length) {
      let si = raw.indexOf('stream', pos);
      if (si < 0) break;
      // Pular "endstream"
      if (si >= 3 && raw.substring(si - 3, si) === 'end') { pos = si + 6; continue; }

      // Stream válido: "stream" deve ser seguido por \r\n ou \n
      const afterStream = raw[si + 6];
      if (afterStream !== '\r' && afterStream !== '\n') { pos = si + 6; continue; }

      // Verificar que ">>" aparece antes (indica fim do dict do stream object)
      const pre = raw.substring(Math.max(0, si - 20), si).trimEnd();
      if (!pre.endsWith('>>')) { pos = si + 6; continue; }

      // Pular \r\n ou \n após "stream"
      let dataStart = si + 6;
      if (raw[dataStart] === '\r') dataStart++;
      if (raw[dataStart] === '\n') dataStart++;

      const endStream = raw.indexOf('endstream', dataStart);
      if (endStream < 0) break;

      // Verificar tipo de filtro olhando o dict antes do stream
      const dictArea = raw.substring(Math.max(0, si - 300), si);
      const isImage = dictArea.includes('/Subtype /Image');
      
      if (!isImage) {
        const streamData = raw.substring(dataStart, endStream);
        const hasASCII85 = dictArea.includes('ASCII85Decode');
        const hasFlate = dictArea.includes('FlateDecode');

        try {
          let decoded;
          if (hasASCII85 && hasFlate) {
            // ASCII85 primeiro, depois FlateDecode
            const a85 = decodeASCII85(streamData);
            decoded = zlib.inflateSync(a85);
          } else if (hasFlate) {
            decoded = zlib.inflateSync(buf.slice(dataStart, endStream));
          } else if (hasASCII85) {
            decoded = decodeASCII85(streamData);
          } else {
            decoded = Buffer.from(streamData, 'latin1');
          }
          textos.push(decoded.toString('latin1'));
        } catch (e) {
          // Decodificação falhou, ignorar
        }
      }

      pos = endStream + 9;
    }

    const textoCompleto = textos.join(' ');

    // Extrair texto dos operadores Tj do PDF (entre parênteses)
    // e converter escapes octais para chars legíveis
    const textoParts = [];
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let m;
    while ((m = tjRegex.exec(textoCompleto)) !== null) {
      textoParts.push(decodeOctalEscapes(m[1]));
    }
    const textoLegivel = textoParts.join('');

    // Buscar padrão: "válida até 11 de Abril de 2026"
    const match = textoLegivel.match(/v[áa]lida\s+at[ée]\s+(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/i);
    if (match) {
      const dia = match[1].padStart(2, '0');
      const mesNome = match[2].toLowerCase();
      const ano = match[3];
      const mes = meses[mesNome];
      if (mes) {
        const validade = `${dia}/${mes}/${ano}`;
        console.log(`[PALMAS] Validade encontrada: ${validade}`);
        return validade;
      }
    }

    // Fallback: buscar no texto raw com escapes octais
    const matchRaw = textoCompleto.match(/lida\s*at\\351\s*(\d{1,2})\s*de\s*(\w+)\s*de\s*(\d{4})/i);
    if (matchRaw) {
      const dia = matchRaw[1].padStart(2, '0');
      const mesNome = matchRaw[2].toLowerCase();
      const ano = matchRaw[3];
      const mes = meses[mesNome];
      if (mes) {
        const validade = `${dia}/${mes}/${ano}`;
        console.log(`[PALMAS] Validade encontrada (raw): ${validade}`);
        return validade;
      }
    }

    console.log('[PALMAS] Validade não encontrada no PDF');
    return null;
  } catch (error) {
    console.log('[PALMAS] Erro ao extrair validade:', error.message);
    return null;
  }
}

async function obterPDF(cnpj, finalidade = 'Licitação') {
  const cnd = new CNDPalmas();
  await cnd.inicializar();
  const resultado = await cnd.consultar(cnpj, finalidade);
  const pdfBuffer = await cnd.gerarPDF(resultado);

  // Extrair validade do PDF
  const validade = await extrairValidadeDoPDF(pdfBuffer);

  return {
    pdf: pdfBuffer,
    dados: resultado,
    validade
  };
}

// Exportar para uso em outros arquivos
module.exports = {
  consultarCND,
  obterPDF,
  CNDPalmas
};
