const nodemailer = require('nodemailer');

/**
 * Serviço de envio de e-mail para alertas de vencimento de certidões.
 * Usa Gmail SMTP com Senha de App.
 */

// ============ CONFIGURAÇÃO PADRÃO ============
const CONFIG_PADRAO = {
    remetente: 'controladoriahfsaneamento@gmail.com',
    senha_app: 'yvbi yypr udsx uibj',
    destinatarios: ['luanoliveirabritonunes@gmail.com'],
    dias_alerta: 15,
    ativo: true
};

// ============ CRIAR TRANSPORTER ============
function criarTransporter(config) {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: config.remetente || CONFIG_PADRAO.remetente,
            pass: config.senha_app || CONFIG_PADRAO.senha_app
        }
    });
}

// ============ ENVIAR E-MAIL DE TESTE ============
async function enviarEmailTeste(config) {
    const transporter = criarTransporter(config);
    const destinatarios = config.destinatarios || CONFIG_PADRAO.destinatarios;

    const html = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #1a1a2e; color: #fff; padding: 20px 28px; border-radius: 10px 10px 0 0;">
                <h2 style="margin: 0; font-size: 1.2em;">📋 Hidro Forte - Emissão de Certidões</h2>
                <p style="margin: 4px 0 0; font-size: 0.85em; color: #8892b0;">Sistema de Notificações</p>
            </div>
            <div style="background: #fff; padding: 28px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
                <h3 style="color: #16a34a; margin-top: 0;">✅ E-mail de teste enviado com sucesso!</h3>
                <p style="color: #6b7280; line-height: 1.6;">
                    Este é um e-mail de teste do sistema de notificações de certidões.<br>
                    Se você recebeu este e-mail, a configuração está correta.
                </p>
                <div style="background: #f0f2f5; padding: 14px 18px; border-radius: 8px; margin-top: 16px;">
                    <p style="margin: 0; font-size: 0.88em; color: #6b7280;">
                        <strong>Remetente:</strong> ${config.remetente || CONFIG_PADRAO.remetente}<br>
                        <strong>Destinatário(s):</strong> ${destinatarios.join(', ')}<br>
                        <strong>Dias de alerta:</strong> ${config.dias_alerta || CONFIG_PADRAO.dias_alerta} dias antes do vencimento<br>
                        <strong>Data do teste:</strong> ${new Date().toLocaleString('pt-BR')}
                    </p>
                </div>
            </div>
        </div>
    `;

    const info = await transporter.sendMail({
        from: `"Hidro Forte - Certidões" <${config.remetente || CONFIG_PADRAO.remetente}>`,
        to: destinatarios.join(', '),
        subject: '✅ Teste — Hidro Forte - Emissão de Certidões',
        html
    });

    return { sucesso: true, messageId: info.messageId };
}

// ============ ENVIAR E-MAIL DE NOVA CERTIDÃO ============
async function enviarEmailNovaCertidao(config, registro) {
    const transporter = criarTransporter(config);
    const destinatarios = config.destinatarios || CONFIG_PADRAO.destinatarios;

    const nomeEmpresa = registro.nome_fantasia || registro.razao_social || registro.cnpj;
    const cnpjFormatado = registro.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    const tipoNomes = {
        'federal': 'Certidão Federal (Receita Federal)',
        'estadual': 'Certidão Estadual (SEFAZ Tocantins)',
        'fgts': 'Certidão FGTS (Caixa Econômica)',
        'trabalhista': 'CNDT — Certidão Trabalhista (TST)',
        'palmas': 'Certidão Municipal (Prefeitura de Palmas)'
    };
    const tipoNome = tipoNomes[registro.tipo] || registro.tipo;

    // Calcular dias para vencer
    let diasInfo = '';
    let corValidade = '#16a34a';
    if (registro.validade) {
        const partes = registro.validade.split('/');
        if (partes.length === 3) {
            const dataValidade = new Date(parseInt(partes[2]), parseInt(partes[1]) - 1, parseInt(partes[0]));
            const hoje = new Date();
            hoje.setHours(0, 0, 0, 0);
            dataValidade.setHours(0, 0, 0, 0);
            const diffDias = Math.ceil((dataValidade - hoje) / (1000 * 60 * 60 * 24));
            if (diffDias <= 0) {
                diasInfo = `⚠️ Já vencida`;
                corValidade = '#ef4444';
            } else if (diffDias <= 15) {
                diasInfo = `⚠️ Vence em ${diffDias} dia(s)`;
                corValidade = '#d97706';
            } else {
                diasInfo = `✅ Válida por ${diffDias} dia(s)`;
                corValidade = '#16a34a';
            }
        }
    }

    const html = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #1a1a2e; color: #fff; padding: 20px 28px; border-radius: 10px 10px 0 0;">
                <h2 style="margin: 0; font-size: 1.2em;">📋 Hidro Forte - Emissão de Certidões</h2>
                <p style="margin: 4px 0 0; font-size: 0.85em; color: #8892b0;">Nova Certidão Emitida</p>
            </div>
            <div style="background: #fff; padding: 28px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
                <h3 style="color: #16a34a; margin-top: 0;">✅ Nova certidão emitida com sucesso!</h3>
                
                <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                    <tr>
                        <td style="padding: 10px 14px; background: #f9fafb; font-size: 0.82em; font-weight: 600; color: #6b7280; width: 160px; border-bottom: 1px solid #e5e7eb;">Empresa</td>
                        <td style="padding: 10px 14px; background: #fff; font-size: 0.92em; color: #1a1a2e; border-bottom: 1px solid #e5e7eb;"><strong>${nomeEmpresa}</strong></td>
                    </tr>
                    <tr>
                        <td style="padding: 10px 14px; background: #f9fafb; font-size: 0.82em; font-weight: 600; color: #6b7280; border-bottom: 1px solid #e5e7eb;">CNPJ</td>
                        <td style="padding: 10px 14px; background: #fff; font-size: 0.92em; color: #1a1a2e; border-bottom: 1px solid #e5e7eb;">${cnpjFormatado}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px 14px; background: #f9fafb; font-size: 0.82em; font-weight: 600; color: #6b7280; border-bottom: 1px solid #e5e7eb;">Tipo de Certidão</td>
                        <td style="padding: 10px 14px; background: #fff; font-size: 0.92em; color: #1a1a2e; border-bottom: 1px solid #e5e7eb;">${tipoNome}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px 14px; background: #f9fafb; font-size: 0.82em; font-weight: 600; color: #6b7280; border-bottom: 1px solid #e5e7eb;">Data de Emissão</td>
                        <td style="padding: 10px 14px; background: #fff; font-size: 0.92em; color: #1a1a2e; border-bottom: 1px solid #e5e7eb;">${registro.data_emissao || new Date().toLocaleDateString('pt-BR')}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px 14px; background: #f9fafb; font-size: 0.82em; font-weight: 600; color: #6b7280; border-bottom: 1px solid #e5e7eb;">Data de Validade</td>
                        <td style="padding: 10px 14px; background: #fff; font-size: 0.92em; color: #1a1a2e; border-bottom: 1px solid #e5e7eb;">
                            ${registro.validade || 'Não informada'}
                            ${diasInfo ? `<br><span style="font-size: 0.82em; color: ${corValidade}; font-weight: 600;">${diasInfo}</span>` : ''}
                        </td>
                    </tr>
                </table>

                <div style="background: #f0f2f5; padding: 14px 18px; border-radius: 8px; margin-top: 16px;">
                    <p style="margin: 0; font-size: 0.82em; color: #9ca3af;">
                        📅 Emitida em ${new Date().toLocaleString('pt-BR')}
                    </p>
                </div>
            </div>
        </div>
    `;

    const info = await transporter.sendMail({
        from: `"Hidro Forte - Certidões" <${config.remetente || CONFIG_PADRAO.remetente}>`,
        to: destinatarios.join(', '),
        subject: `📄 Nova certidão: ${tipoNomes[registro.tipo] ? registro.tipo.charAt(0).toUpperCase() + registro.tipo.slice(1) : registro.tipo} — ${nomeEmpresa}`,
        html
    });

    return { sucesso: true, messageId: info.messageId };
}

// ============ VERIFICAR VENCIMENTOS E NOTIFICAR ============
async function verificarVencimentosENotificar(config, registros) {
    const diasAlerta = config.dias_alerta || CONFIG_PADRAO.dias_alerta;
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    // Filtrar certidões que vencem em até X dias ou já venceram
    const alertas = [];
    for (const r of registros) {
        if (!r.validade) continue;

        const partes = r.validade.split('/');
        if (partes.length !== 3) continue;

        const dataValidade = new Date(parseInt(partes[2]), parseInt(partes[1]) - 1, parseInt(partes[0]));
        dataValidade.setHours(0, 0, 0, 0);

        const diffDias = Math.ceil((dataValidade - hoje) / (1000 * 60 * 60 * 24));

        if (diffDias <= diasAlerta) {
            alertas.push({
                ...r,
                dias_restantes: diffDias,
                status: diffDias <= 0 ? 'VENCIDA' : diffDias <= 5 ? 'URGENTE' : 'ALERTA'
            });
        }
    }

    if (alertas.length === 0) {
        return { sucesso: true, enviado: false, mensagem: 'Nenhuma certidão próxima do vencimento.' };
    }

    // Ordenar: vencidas primeiro, depois por dias restantes
    alertas.sort((a, b) => a.dias_restantes - b.dias_restantes);

    // Montar HTML do e-mail
    const linhasHTML = alertas.map(a => {
        const nomeEmpresa = a.nome_fantasia || a.razao_social || a.cnpj;
        const tipoNome = {
            'federal': 'Federal', 'estadual': 'Estadual', 'fgts': 'FGTS',
            'trabalhista': 'Trabalhista', 'palmas': 'Municipal Palmas'
        }[a.tipo] || a.tipo;

        let statusCor, statusTexto;
        if (a.status === 'VENCIDA') {
            statusCor = '#ef4444';
            statusTexto = a.dias_restantes === 0 ? 'Vence hoje!' : `Vencida há ${Math.abs(a.dias_restantes)} dia(s)`;
        } else if (a.status === 'URGENTE') {
            statusCor = '#f97316';
            statusTexto = `Vence em ${a.dias_restantes} dia(s)`;
        } else {
            statusCor = '#d97706';
            statusTexto = `Vence em ${a.dias_restantes} dia(s)`;
        }

        return `
            <tr>
                <td style="padding: 10px 12px; border-bottom: 1px solid #f3f4f6; font-size: 0.9em;">${nomeEmpresa}</td>
                <td style="padding: 10px 12px; border-bottom: 1px solid #f3f4f6; font-size: 0.9em;">${tipoNome}</td>
                <td style="padding: 10px 12px; border-bottom: 1px solid #f3f4f6; font-size: 0.9em;">${a.validade}</td>
                <td style="padding: 10px 12px; border-bottom: 1px solid #f3f4f6;">
                    <span style="background: ${statusCor}; color: #fff; padding: 3px 10px; border-radius: 12px; font-size: 0.78em; font-weight: 600;">
                        ${statusTexto}
                    </span>
                </td>
            </tr>
        `;
    }).join('');

    const totalVencidas = alertas.filter(a => a.dias_restantes <= 0).length;
    const totalAlerta = alertas.filter(a => a.dias_restantes > 0).length;

    const html = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 700px; margin: 0 auto;">
            <div style="background: #1a1a2e; color: #fff; padding: 20px 28px; border-radius: 10px 10px 0 0;">
                <h2 style="margin: 0; font-size: 1.2em;">📋 Hidro Forte - Emissão de Certidões</h2>
                <p style="margin: 4px 0 0; font-size: 0.85em; color: #8892b0;">Alerta de Vencimento</p>
            </div>
            <div style="background: #fff; padding: 28px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
                <h3 style="color: #d97706; margin-top: 0;">⚠️ ${alertas.length} certidão(ões) requerem atenção</h3>
                
                <div style="display: flex; gap: 12px; margin-bottom: 20px;">
                    ${totalVencidas > 0 ? `<div style="background: #fef2f2; border: 1px solid #fecaca; padding: 10px 16px; border-radius: 8px; flex: 1; text-align: center;">
                        <div style="font-size: 1.4em; font-weight: 700; color: #ef4444;">${totalVencidas}</div>
                        <div style="font-size: 0.78em; color: #ef4444; font-weight: 600;">VENCIDA(S)</div>
                    </div>` : ''}
                    ${totalAlerta > 0 ? `<div style="background: #fffbeb; border: 1px solid #fed7aa; padding: 10px 16px; border-radius: 8px; flex: 1; text-align: center;">
                        <div style="font-size: 1.4em; font-weight: 700; color: #d97706;">${totalAlerta}</div>
                        <div style="font-size: 0.78em; color: #d97706; font-weight: 600;">EM ALERTA</div>
                    </div>` : ''}
                </div>

                <table style="width: 100%; border-collapse: collapse; margin-top: 8px;">
                    <thead>
                        <tr style="background: #f9fafb;">
                            <th style="padding: 10px 12px; text-align: left; font-size: 0.78em; color: #6b7280; text-transform: uppercase; border-bottom: 2px solid #e5e7eb;">Empresa</th>
                            <th style="padding: 10px 12px; text-align: left; font-size: 0.78em; color: #6b7280; text-transform: uppercase; border-bottom: 2px solid #e5e7eb;">Certidão</th>
                            <th style="padding: 10px 12px; text-align: left; font-size: 0.78em; color: #6b7280; text-transform: uppercase; border-bottom: 2px solid #e5e7eb;">Vencimento</th>
                            <th style="padding: 10px 12px; text-align: left; font-size: 0.78em; color: #6b7280; text-transform: uppercase; border-bottom: 2px solid #e5e7eb;">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${linhasHTML}
                    </tbody>
                </table>

                <div style="background: #f0f2f5; padding: 14px 18px; border-radius: 8px; margin-top: 20px;">
                    <p style="margin: 0; font-size: 0.82em; color: #9ca3af;">
                        📅 Verificação realizada em ${new Date().toLocaleString('pt-BR')}<br>
                        Alerta configurado para <strong>${diasAlerta} dias</strong> antes do vencimento.
                    </p>
                </div>
            </div>
        </div>
    `;

    const transporter = criarTransporter(config);
    const destinatarios = config.destinatarios || CONFIG_PADRAO.destinatarios;

    const assunto = totalVencidas > 0
        ? `🔴 ${totalVencidas} certidão(ões) VENCIDA(S) + ${totalAlerta} em alerta`
        : `⚠️ ${totalAlerta} certidão(ões) próxima(s) do vencimento`;

    const info = await transporter.sendMail({
        from: `"Hidro Forte - Certidões" <${config.remetente || CONFIG_PADRAO.remetente}>`,
        to: destinatarios.join(', '),
        subject: assunto,
        html
    });

    return {
        sucesso: true,
        enviado: true,
        messageId: info.messageId,
        totalAlertas: alertas.length,
        totalVencidas,
        totalAlerta,
        mensagem: `E-mail enviado com ${alertas.length} alerta(s) de vencimento.`
    };
}

module.exports = {
    CONFIG_PADRAO,
    enviarEmailTeste,
    enviarEmailNovaCertidao,
    verificarVencimentosENotificar
};
