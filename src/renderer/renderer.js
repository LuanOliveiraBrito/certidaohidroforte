const { ipcRenderer } = require('electron');

// ============ SESSÃO DO USUÁRIO ============
let usuarioLogado = null; // { usuario, nivel }

// ============ NOMES DOS TIPOS ============
const NOMES_TIPO = {
    'federal': 'Certidão Federal',
    'estadual': 'Certidão Estadual',
    'fgts': 'Certidão FGTS',
    'trabalhista': 'Certidão Trabalhista',
    'palmas': 'Certidão Municipal Palmas'
};

// ============ LOGIN ============
function carregarCredenciaisSalvas() {
    try {
        const salvo = localStorage.getItem('credenciais_salvas');
        if (salvo) {
            const { usuario, senha } = JSON.parse(salvo);
            document.getElementById('loginUsuario').value = usuario || '';
            document.getElementById('loginSenha').value = senha || '';
            document.getElementById('loginLembrar').checked = true;
        }
    } catch (e) { }
}

async function realizarLogin() {
    const usuario = document.getElementById('loginUsuario').value.trim();
    const senha = document.getElementById('loginSenha').value;
    const lembrar = document.getElementById('loginLembrar').checked;
    const erroEl = document.getElementById('loginErro');
    const btnLogin = document.getElementById('btnLogin');

    if (!usuario || !senha) {
        erroEl.textContent = 'Preencha usuário e senha.';
        return;
    }

    erroEl.textContent = '';
    btnLogin.disabled = true;
    btnLogin.textContent = 'Entrando...';

    try {
        const resultado = await ipcRenderer.invoke('login', { usuario, senha });

        if (resultado.sucesso) {
            usuarioLogado = { usuario: resultado.usuario, nivel: resultado.nivel };

            // Salvar ou limpar credenciais
            if (lembrar) {
                localStorage.setItem('credenciais_salvas', JSON.stringify({ usuario, senha }));
            } else {
                localStorage.removeItem('credenciais_salvas');
            }

            mostrarApp();
        } else {
            erroEl.textContent = resultado.mensagem || 'Erro ao entrar.';
        }
    } catch (e) {
        erroEl.textContent = 'Erro de conexão. Tente novamente.';
    } finally {
        btnLogin.disabled = false;
        btnLogin.textContent = 'Entrar';
    }
}

function realizarLogout() {
    usuarioLogado = null;
    document.getElementById('loginOverlay').classList.remove('oculto');
    document.getElementById('appSidebar').style.display = 'none';
    document.getElementById('appMain').style.display = 'none';
    document.getElementById('loginSenha').value = '';
    document.getElementById('loginErro').textContent = '';
    // Manter usuário salvo se checkbox marcado, só limpar a senha do campo
    if (!document.getElementById('loginLembrar').checked) {
        document.getElementById('loginUsuario').value = '';
    }
}

function mostrarApp() {
    document.getElementById('loginOverlay').classList.add('oculto');
    document.getElementById('appSidebar').style.display = '';
    document.getElementById('appMain').style.display = '';

    // Exibir nome do usuário na sidebar
    document.getElementById('sidebarUserName').textContent = usuarioLogado.usuario;

    // Aplicar permissões baseadas no nível
    aplicarPermissoes();

    // Navegar para emitir
    navigateTo('emitir');
    atualizarRelatorio();
}

function aplicarPermissoes() {
    const isAdmin = usuarioLogado && usuarioLogado.nivel === 'administrador';

    // Nav: Notificações e Administração só para admin
    document.getElementById('navNotificacoes').style.display = isAdmin ? '' : 'none';
    document.getElementById('navAdmin').style.display = isAdmin ? '' : 'none';

    // Botões de deletar na tabela (controlado ao renderizar)
    // O controle é feito dentro do renderizarRelatorio
}

// Enter para fazer login
document.getElementById('loginSenha').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') realizarLogin();
});
document.getElementById('loginUsuario').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('loginSenha').focus();
});

// ============ NAVEGAÇÃO ============
function navigateTo(pageName) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const page = document.getElementById(`page-${pageName}`);
    if (page) page.classList.add('active');

    const navBtn = document.querySelector(`.nav-item[data-page="${pageName}"]`);
    if (navBtn) navBtn.classList.add('active');

    if (pageName === 'relatorio') atualizarRelatorio();
    if (pageName === 'notificacoes') carregarConfigEmail();
    if (pageName === 'admin') carregarUsuarios();
}

// ============ FORMATO CNPJ ============
document.getElementById('cnpj').addEventListener('input', function (e) {
    let v = e.target.value.replace(/\D/g, '');
    if (v.length > 14) v = v.slice(0, 14);
    if (v.length > 12) v = v.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})/, '$1.$2.$3/$4-$5');
    else if (v.length > 8) v = v.replace(/^(\d{2})(\d{3})(\d{3})(\d{0,4})/, '$1.$2.$3/$4');
    else if (v.length > 5) v = v.replace(/^(\d{2})(\d{3})(\d{0,3})/, '$1.$2.$3');
    else if (v.length > 2) v = v.replace(/^(\d{2})(\d{0,3})/, '$1.$2');
    e.target.value = v;

    if (v.replace(/\D/g, '').length === 14) {
        buscarEmpresa();
    }
});

// ============ BUSCAR EMPRESA ============
let empresaCache = {};

async function buscarEmpresa() {
    const cnpj = getCNPJ();
    if (cnpj.length !== 14) return;

    if (empresaCache[cnpj]) {
        exibirInfoEmpresa(empresaCache[cnpj]);
        return;
    }

    const info = document.getElementById('empresaInfo');
    info.textContent = 'Buscando empresa...';
    info.className = 'empresa-info';

    try {
        const resultado = await ipcRenderer.invoke('buscar-empresa', cnpj);
        if (resultado.sucesso) {
            empresaCache[cnpj] = resultado;
            exibirInfoEmpresa(resultado);
        } else {
            info.textContent = resultado.mensagem || 'Empresa não encontrada';
            info.className = 'empresa-info erro';
        }
    } catch (e) {
        info.textContent = 'Erro ao buscar empresa';
        info.className = 'empresa-info erro';
    }
}

function exibirInfoEmpresa(dados) {
    const info = document.getElementById('empresaInfo');
    info.textContent = `${dados.razao_social}${dados.nome_fantasia ? ' (' + dados.nome_fantasia + ')' : ''}`;
    info.className = 'empresa-info';
}

// ============ HELPERS ============
function getCNPJ() {
    return document.getElementById('cnpj').value.replace(/\D/g, '');
}

function validarCNPJ() {
    const cnpj = getCNPJ();
    if (cnpj.length !== 14) {
        addLog('Por favor, digite um CNPJ válido com 14 dígitos', 'erro');
        return false;
    }
    return true;
}

function addLog(mensagem, tipo = 'info') {
    const log = document.getElementById('log');
    const item = document.createElement('div');
    item.className = `log-item ${tipo}`;
    const hora = new Date().toLocaleTimeString('pt-BR');
    item.textContent = `[${hora}] ${mensagem}`;
    log.insertBefore(item, log.firstChild);
}

function setLoading(ativo, texto = 'Processando...') {
    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');
    if (ativo) { loading.classList.add('ativo'); loadingText.textContent = texto; }
    else { loading.classList.remove('ativo'); }
    document.querySelectorAll('.btn').forEach(b => b.disabled = ativo);
}

// ============ EMITIR CERTIDÃO INDIVIDUAL ============
async function emitirCertidao(tipo) {
    if (!validarCNPJ()) return;
    const cnpj = getCNPJ();

    addLog(`Iniciando emissão: ${NOMES_TIPO[tipo]}...`, 'info');
    setLoading(true, `Emitindo ${NOMES_TIPO[tipo]}...`);

    try {
        const resultado = await ipcRenderer.invoke(`emitir-${tipo}`, cnpj);
        if (resultado.sucesso) {
            addLog(`✅ ${resultado.nome} — Salvo!`, 'sucesso');
            await registrarCertidao(cnpj, tipo, resultado.validade, resultado.arquivo, resultado.pastaEmpresa);
        } else {
            addLog(`❌ ${NOMES_TIPO[tipo]}: ${resultado.mensagem}`, 'erro');
        }
    } catch (error) {
        addLog(`❌ Erro: ${error.message}`, 'erro');
    } finally {
        setLoading(false);
    }
}

// ============ EMITIR TODAS ============
async function emitirTodas() {
    if (!validarCNPJ()) return;
    const cnpj = getCNPJ();

    addLog('Iniciando emissão de todas as certidões...', 'info');
    setLoading(true, 'Emitindo todas as certidões...');

    try {
        const resultado = await ipcRenderer.invoke('emitir-todas', cnpj);
        if (resultado.sucesso) {
            for (const r of resultado.resultados) {
                if (r.sucesso) {
                    addLog(`✅ ${r.arquivo}`, 'sucesso');
                    const tipoKey = r.tipo.toLowerCase().includes('federal') ? 'federal' :
                        r.tipo.toLowerCase().includes('estadual') ? 'estadual' :
                            r.tipo.toLowerCase().includes('fgts') ? 'fgts' :
                                r.tipo.toLowerCase().includes('trabalhista') ? 'trabalhista' :
                                    r.tipo.toLowerCase().includes('palmas') || r.tipo.toLowerCase().includes('municipal') ? 'palmas' : '';
                    if (tipoKey) {
                        await registrarCertidao(cnpj, tipoKey, r.validade, '', resultado.pasta);
                    }
                } else {
                    addLog(`❌ ${r.tipo}: ${r.erro}`, 'erro');
                }
            }
            addLog(`📁 Salvo em: ${resultado.pasta}`, 'info');
        } else {
            addLog(`❌ ${resultado.mensagem}`, 'erro');
        }
    } catch (error) {
        addLog(`❌ Erro: ${error.message}`, 'erro');
    } finally {
        setLoading(false);
    }
}

// ============ REGISTRAR CERTIDÃO ============
async function registrarCertidao(cnpj, tipo, validade, arquivo, pastaEmpresa) {
    try {
        let empresa = empresaCache[cnpj];
        if (!empresa) {
            try {
                const res = await ipcRenderer.invoke('buscar-empresa', cnpj);
                if (res.sucesso) {
                    empresa = res;
                    empresaCache[cnpj] = res;
                }
            } catch (e) { /* segue sem nome */ }
        }

        await ipcRenderer.invoke('registrar-certidao', {
            cnpj,
            tipo,
            validade: validade || '',
            razao_social: empresa?.razao_social || '',
            nome_fantasia: empresa?.nome_fantasia || '',
            data_emissao: new Date().toLocaleDateString('pt-BR'),
            arquivo: arquivo || '',
            pasta_empresa: pastaEmpresa || '',
            notificacao_enviada: false,
            email_notificacao: ''
        });
    } catch (e) {
        console.error('Erro ao registrar certidão:', e);
    }
}

// ============ RELATÓRIO — ESTADO ============
let registrosCache = [];
let sortColuna = 'dias';
let sortAsc = true;
let graficoStatus = null;

// ============ RELATÓRIO — ORDENAÇÃO ============
function atualizarHeadersSort() {
    const colunas = ['empresa', 'tipo', 'status', 'vencimento', 'dias'];
    colunas.forEach(col => {
        const th = document.getElementById(`th-${col}`);
        if (!th) return;
        if (col === sortColuna) {
            th.classList.add('sort-active');
            th.querySelector('.sort-arrow').textContent = sortAsc ? '▲' : '▼';
        } else {
            th.classList.remove('sort-active');
            th.querySelector('.sort-arrow').textContent = '▲';
        }
    });
}

function ordenarRelatorio(coluna) {
    if (sortColuna === coluna) {
        sortAsc = !sortAsc;
    } else {
        sortColuna = coluna;
        sortAsc = true;
    }
    atualizarHeadersSort();
    renderizarRelatorio(registrosCache);
}

// ============ RELATÓRIO — ATUALIZAR ============
async function atualizarRelatorio() {
    try {
        const registros = await ipcRenderer.invoke('listar-registros');
        registrosCache = registros || [];
        atualizarHeadersSort();
        renderizarRelatorio(registrosCache);
    } catch (e) {
        console.error('Erro ao atualizar relatório:', e);
    }
}

function calcularDiasParaVencer(validadeStr) {
    if (!validadeStr) return null;
    const partes = validadeStr.split('/');
    if (partes.length !== 3) return null;
    const dataValidade = new Date(parseInt(partes[2]), parseInt(partes[1]) - 1, parseInt(partes[0]));
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    dataValidade.setHours(0, 0, 0, 0);
    return Math.ceil((dataValidade - hoje) / (1000 * 60 * 60 * 24));
}

// ============ RELATÓRIO — RENDERIZAR ============
function renderizarRelatorio(registros) {
    const tbody = document.getElementById('tabelaBody');
    const emptyState = document.getElementById('emptyState');
    const thead = document.getElementById('tabelaRelatorio').querySelector('thead');
    const searchTerm = document.getElementById('searchRelatorio').value.toLowerCase().trim();

    // Filtrar por pesquisa
    let filtrados = registros;
    if (searchTerm) {
        filtrados = registros.filter(r =>
            (r.razao_social || '').toLowerCase().includes(searchTerm) ||
            (r.nome_fantasia || '').toLowerCase().includes(searchTerm) ||
            (r.cnpj || '').includes(searchTerm)
        );
    }

    // Stats (sempre sobre TODOS os registros)
    let totalAtivas = 0, totalAlerta = 0, totalVencidas = 0;
    registros.forEach(r => {
        const dias = calcularDiasParaVencer(r.validade);
        if (dias === null || dias > 15) totalAtivas++;
        else if (dias > 0) totalAlerta++;
        else totalVencidas++;
    });

    document.getElementById('statTotal').textContent = registros.length;
    document.getElementById('statAtivas').textContent = totalAtivas;
    document.getElementById('statAlerta').textContent = totalAlerta;
    document.getElementById('statVencidas').textContent = totalVencidas;

    // Gráfico donut
    atualizarGrafico(totalAtivas, totalAlerta, totalVencidas);

    // Tabela vazia
    if (filtrados.length === 0) {
        tbody.innerHTML = '';
        emptyState.style.display = 'block';
        thead.style.display = 'none';
        return;
    }

    emptyState.style.display = 'none';
    thead.style.display = '';

    // Ordenar conforme coluna selecionada
    filtrados.sort((a, b) => {
        let cmp = 0;
        switch (sortColuna) {
            case 'empresa': {
                const nomeA = (a.nome_fantasia || a.razao_social || a.cnpj || '').toLowerCase();
                const nomeB = (b.nome_fantasia || b.razao_social || b.cnpj || '').toLowerCase();
                cmp = nomeA.localeCompare(nomeB, 'pt-BR');
                break;
            }
            case 'tipo': {
                const tipoA = (NOMES_TIPO[a.tipo] || a.tipo || '').toLowerCase();
                const tipoB = (NOMES_TIPO[b.tipo] || b.tipo || '').toLowerCase();
                cmp = tipoA.localeCompare(tipoB, 'pt-BR');
                break;
            }
            case 'status': {
                function statusOrdem(r) {
                    const d = calcularDiasParaVencer(r.validade);
                    if (d === null || d > 15) return 2;
                    if (d > 0) return 1;
                    return 0;
                }
                cmp = statusOrdem(a) - statusOrdem(b);
                break;
            }
            case 'vencimento': {
                function parseData(str) {
                    if (!str) return Infinity;
                    const p = str.split('/');
                    if (p.length !== 3) return Infinity;
                    return new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0])).getTime();
                }
                const dA = parseData(a.validade);
                const dB = parseData(b.validade);
                cmp = dA - dB;
                break;
            }
            case 'dias':
            default: {
                const diasA = calcularDiasParaVencer(a.validade);
                const diasB = calcularDiasParaVencer(b.validade);
                const vA = diasA === null ? 99999 : diasA;
                const vB = diasB === null ? 99999 : diasB;
                cmp = vA - vB;
                break;
            }
        }
        return sortAsc ? cmp : -cmp;
    });

    // Renderizar linhas
    tbody.innerHTML = filtrados.map(r => {
        const dias = calcularDiasParaVencer(r.validade);
        let statusBadge, diasClass, diasText;

        if (!r.validade) {
            statusBadge = '<span class="badge badge-ativo">ATIVO</span>';
            diasClass = 'positivo';
            diasText = '—';
        } else if (dias > 15) {
            statusBadge = '<span class="badge badge-ativo">ATIVO</span>';
            diasClass = 'positivo';
            diasText = `${dias} dias`;
        } else if (dias > 0) {
            statusBadge = '<span class="badge badge-alerta">ALERTA</span>';
            diasClass = 'alerta';
            diasText = `${dias} dias`;
        } else {
            statusBadge = '<span class="badge badge-vencido">VENCIDO</span>';
            diasClass = 'vencido';
            diasText = dias === 0 ? 'Vence hoje' : `Vencido há ${Math.abs(dias)} dias`;
        }

        const nomeEmpresa = r.nome_fantasia || r.razao_social || r.cnpj;
        const cnpjFormatado = r.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
        const isAdmin = usuarioLogado && usuarioLogado.nivel === 'administrador';
        const btnDeletar = isAdmin
            ? `<button class="btn btn-danger btn-sm btn-acao" onclick="abrirModalDeletar('${r.cnpj}', '${r.tipo}')" title="Excluir certidão">🗑️</button>`
            : '';

        return `<tr>
            <td><strong>${nomeEmpresa}</strong><br><span style="font-size:0.78em;color:#9ca3af;">${cnpjFormatado}</span></td>
            <td>${NOMES_TIPO[r.tipo] || r.tipo}</td>
            <td>${statusBadge}</td>
            <td>${r.validade || '—'}</td>
            <td><span class="dias-vencer ${diasClass}">${diasText}</span></td>
            <td style="white-space:nowrap;">
                <button class="btn btn-info btn-sm btn-acao" onclick="visualizarPDF('${r.cnpj}', '${r.tipo}')" title="Visualizar PDF">👁️</button>
                <button class="btn btn-primary btn-sm btn-acao" onclick="abrirPastaEmpresa('${r.cnpj}')" title="Abrir pasta">📂</button>
                ${btnDeletar}
            </td>
        </tr>`;
    }).join('');
}

function filtrarRelatorio() {
    renderizarRelatorio(registrosCache);
}

// ============ ABRIR PASTAS ============
async function abrirPastaEmpresa(cnpj) {
    await ipcRenderer.invoke('abrir-pasta-empresa', cnpj);
}

async function abrirPastaCertidoes() {
    await ipcRenderer.invoke('abrir-pasta-certidoes');
}

// ============ VISUALIZAR PDF ============
async function visualizarPDF(cnpj, tipo) {
    const tipoNome = NOMES_TIPO[tipo] || tipo;

    // Mostrar feedback visual: trocar botão por spinner
    const botoes = document.querySelectorAll(`button[onclick="visualizarPDF('${cnpj}', '${tipo}')"]`);
    botoes.forEach(btn => {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-pdf"></span>';
    });

    try {
        const resultado = await ipcRenderer.invoke('visualizar-pdf', { cnpj, tipo });

        if (resultado.sucesso) {
            if (resultado.origem === 'nuvem') {
                addLog(`☁️ PDF baixado da nuvem: ${tipoNome}`, 'sucesso');
            }
        } else {
            addLog(`❌ PDF não disponível: ${tipoNome} — ${resultado.mensagem || 'Não encontrado'}`, 'erro');
        }
    } catch (e) {
        addLog(`❌ Erro ao visualizar PDF: ${e.message}`, 'erro');
    } finally {
        // Restaurar botão
        botoes.forEach(btn => {
            btn.disabled = false;
            btn.innerHTML = '👁️';
        });
    }
}

// ============ GRÁFICO DE STATUS (DONUT) ============
function atualizarGrafico(ativas, alerta, vencidas) {
    const canvas = document.getElementById('graficoStatus');
    const container = canvas.parentElement;
    const total = ativas + alerta + vencidas;

    // Sem dados: mostra mensagem
    if (total === 0) {
        if (graficoStatus) {
            graficoStatus.destroy();
            graficoStatus = null;
        }
        container.innerHTML = '<div class="grafico-vazio">Sem dados</div>';
        return;
    }

    // Garantir que o canvas existe
    if (!container.querySelector('canvas')) {
        container.innerHTML = '<canvas id="graficoStatus"></canvas>';
    }
    const ctx = document.getElementById('graficoStatus').getContext('2d');

    const dados = [ativas, alerta, vencidas];
    const cores = ['#16a34a', '#d97706', '#ef4444'];
    const labels = ['Ativas', 'Alerta', 'Vencidas'];

    if (graficoStatus) {
        // Atualizar dados existentes
        graficoStatus.data.datasets[0].data = dados;
        graficoStatus.update();
        return;
    }

    // Criar gráfico
    graficoStatus = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: dados,
                backgroundColor: cores,
                borderColor: '#fff',
                borderWidth: 3,
                hoverBorderWidth: 0,
                hoverOffset: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            cutout: '65%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        padding: 14,
                        usePointStyle: true,
                        pointStyle: 'circle',
                        font: { size: 11, family: "'Segoe UI', sans-serif" },
                        color: '#6b7280'
                    }
                },
                tooltip: {
                    backgroundColor: '#1a1a2e',
                    titleFont: { size: 12 },
                    bodyFont: { size: 12 },
                    padding: 10,
                    cornerRadius: 8,
                    callbacks: {
                        label: function (context) {
                            const valor = context.parsed;
                            const pct = total > 0 ? Math.round((valor / total) * 100) : 0;
                            return ` ${context.label}: ${valor} (${pct}%)`;
                        }
                    }
                }
            },
            animation: {
                animateRotate: true,
                duration: 600
            }
        }
    });
}

// ============ DELETAR CERTIDÃO ============
let deletarPendente = { cnpj: '', tipo: '' };

function abrirModalDeletar(cnpj, tipo) {
    deletarPendente = { cnpj, tipo };
    const nomeEmpresa = registrosCache.find(r => r.cnpj === cnpj);
    const nome = nomeEmpresa?.nome_fantasia || nomeEmpresa?.razao_social || cnpj;
    const tipoNome = NOMES_TIPO[tipo] || tipo;
    document.getElementById('modalDeletarMsg').innerHTML =
        `Tem certeza que deseja excluir <strong>${tipoNome}</strong> de <strong>${nome}</strong>?`;
    document.getElementById('checkDeletarArquivo').checked = false;
    document.getElementById('modalDeletar').classList.add('ativo');
}

function fecharModalDeletar() {
    document.getElementById('modalDeletar').classList.remove('ativo');
    deletarPendente = { cnpj: '', tipo: '' };
}

async function confirmarDeletar() {
    const { cnpj, tipo } = deletarPendente;
    if (!cnpj || !tipo) return;

    const deletarArquivo = document.getElementById('checkDeletarArquivo').checked;
    fecharModalDeletar();

    try {
        const resultado = await ipcRenderer.invoke('deletar-certidao', {
            cnpj, tipo, deletarArquivo
        });
        if (resultado.sucesso) {
            await atualizarRelatorio();
        } else {
            console.error('Erro ao deletar:', resultado.mensagem);
        }
    } catch (e) {
        console.error('Erro ao deletar certidão:', e);
    }
}

// Fechar modal ao clicar fora
document.getElementById('modalDeletar').addEventListener('click', function (e) {
    if (e.target === this) fecharModalDeletar();
});

// ============ NOTIFICAÇÕES POR E-MAIL ============
async function carregarConfigEmail() {
    try {
        const res = await ipcRenderer.invoke('carregar-config-email');
        if (res.sucesso && res.config) {
            const c = res.config;
            document.getElementById('emailRemetente').value = c.remetente || '';
            document.getElementById('emailSenhaApp').value = c.senha_app || '';
            document.getElementById('emailDestinatarios').value = (c.destinatarios || []).join(', ');
            document.getElementById('diasAlerta').value = c.dias_alerta || 15;
            document.getElementById('notifAtivo').checked = c.ativo !== false;
            document.getElementById('notifAoAbrir').checked = c.verificar_ao_abrir !== false;
        }
    } catch (e) {
        console.error('Erro ao carregar config email:', e);
    }
}

function obterConfigEmailDoForm() {
    const destinatariosStr = document.getElementById('emailDestinatarios').value;
    const destinatarios = destinatariosStr.split(',').map(e => e.trim()).filter(e => e.length > 0);

    return {
        remetente: document.getElementById('emailRemetente').value.trim(),
        senha_app: document.getElementById('emailSenhaApp').value,
        destinatarios,
        dias_alerta: parseInt(document.getElementById('diasAlerta').value) || 15,
        ativo: document.getElementById('notifAtivo').checked,
        verificar_ao_abrir: document.getElementById('notifAoAbrir').checked
    };
}

function mostrarNotifStatus(mensagem, tipo = 'sucesso') {
    const bar = document.getElementById('notifStatusBar');
    const icon = document.getElementById('notifStatusIcon');
    const msg = document.getElementById('notifStatusMsg');

    bar.style.display = 'flex';
    bar.className = `notif-status-bar ${tipo}`;
    icon.textContent = tipo === 'sucesso' ? '✅' : tipo === 'erro' ? '❌' : 'ℹ️';
    msg.textContent = mensagem;

    // Auto-hide após 8s
    setTimeout(() => { bar.style.display = 'none'; }, 8000);
}

async function salvarConfigEmail() {
    const config = obterConfigEmailDoForm();

    if (!config.remetente) {
        mostrarNotifStatus('Informe o e-mail remetente.', 'erro');
        return;
    }
    if (!config.senha_app) {
        mostrarNotifStatus('Informe a senha de app.', 'erro');
        return;
    }
    if (config.destinatarios.length === 0) {
        mostrarNotifStatus('Informe pelo menos um e-mail destinatário.', 'erro');
        return;
    }

    try {
        const res = await ipcRenderer.invoke('salvar-config-email', config);
        if (res.sucesso) {
            mostrarNotifStatus('Configuração salva com sucesso!', 'sucesso');
        } else {
            mostrarNotifStatus(`Erro ao salvar: ${res.mensagem}`, 'erro');
        }
    } catch (e) {
        mostrarNotifStatus(`Erro: ${e.message}`, 'erro');
    }
}

async function enviarEmailTeste() {
    mostrarNotifStatus('Enviando e-mail de teste...', 'info');

    // Salvar config antes de testar
    const config = obterConfigEmailDoForm();
    await ipcRenderer.invoke('salvar-config-email', config);

    try {
        const res = await ipcRenderer.invoke('enviar-email-teste');
        if (res.sucesso) {
            mostrarNotifStatus('E-mail de teste enviado com sucesso! Verifique sua caixa de entrada.', 'sucesso');
        } else {
            mostrarNotifStatus(`Erro ao enviar: ${res.mensagem}`, 'erro');
        }
    } catch (e) {
        mostrarNotifStatus(`Erro: ${e.message}`, 'erro');
    }
}

async function verificarVencimentosAgora() {
    mostrarNotifStatus('Verificando vencimentos...', 'info');

    // Salvar config antes
    const config = obterConfigEmailDoForm();
    await ipcRenderer.invoke('salvar-config-email', config);

    try {
        const res = await ipcRenderer.invoke('verificar-vencimentos');
        const hist = document.getElementById('ultimaVerificacao');

        if (res.sucesso) {
            if (res.enviado) {
                mostrarNotifStatus(res.mensagem, 'sucesso');
                hist.innerHTML = `
                    <div class="notif-resultado">
                        <div class="notif-resultado-header sucesso">📧 E-mail de alerta enviado!</div>
                        <div class="notif-resultado-body">
                            <p><strong>${res.totalAlertas}</strong> certidão(ões) em alerta</p>
                            ${res.totalVencidas > 0 ? `<p style="color: #ef4444;">🔴 ${res.totalVencidas} vencida(s)</p>` : ''}
                            ${res.totalAlerta > 0 ? `<p style="color: #d97706;">⚠️ ${res.totalAlerta} próxima(s) do vencimento</p>` : ''}
                            <p class="notif-timestamp">Verificado em ${new Date().toLocaleString('pt-BR')}</p>
                        </div>
                    </div>
                `;
            } else {
                mostrarNotifStatus(res.mensagem, 'info');
                hist.innerHTML = `
                    <div class="notif-resultado">
                        <div class="notif-resultado-header info">✅ ${res.mensagem}</div>
                        <p class="notif-timestamp">Verificado em ${new Date().toLocaleString('pt-BR')}</p>
                    </div>
                `;
            }
        } else {
            mostrarNotifStatus(`Erro: ${res.mensagem}`, 'erro');
        }
    } catch (e) {
        mostrarNotifStatus(`Erro: ${e.message}`, 'erro');
    }
}

// Listener para notificação automática ao abrir
ipcRenderer.on('notificacao-enviada', (event, resultado) => {
    console.log('[NOTIF] Alerta automático enviado:', resultado.mensagem);
});

// ============ FIREBASE SYNC CONCLUÍDA ============
ipcRenderer.on('firebase-sync-concluida', () => {
    console.log('[SYNC] Firebase sincronizado. Atualizando relatório...');
    atualizarRelatorio();
});

// ============ PROGRESSO ============
ipcRenderer.on('progresso', (event, mensagem) => {
    document.getElementById('loadingText').textContent = mensagem;
    addLog(mensagem, 'info');
});

// ============ ADMINISTRAÇÃO DE USUÁRIOS ============
async function carregarUsuarios() {
    try {
        const usuarios = await ipcRenderer.invoke('listar-usuarios');
        const tbody = document.getElementById('tabelaUsuariosBody');
        const emptyState = document.getElementById('emptyUsuarios');
        const thead = document.getElementById('tabelaUsuarios').querySelector('thead');

        if (!usuarios || usuarios.length === 0) {
            tbody.innerHTML = '';
            emptyState.style.display = 'block';
            thead.style.display = 'none';
            return;
        }

        emptyState.style.display = 'none';
        thead.style.display = '';

        tbody.innerHTML = usuarios.map(u => {
            const nivelBadge = u.nivel === 'administrador'
                ? '<span class="badge-admin administrador">Administrador</span>'
                : '<span class="badge-admin funcionario">Funcionário</span>';
            const dataFormatada = u.criado_em ? new Date(u.criado_em).toLocaleDateString('pt-BR') : '—';
            // Não permitir deletar a si mesmo
            const btnDeletar = u.usuario === usuarioLogado.usuario
                ? '<span style="font-size:0.78em;color:#9ca3af;">Você</span>'
                : `<button class="btn btn-danger btn-sm btn-acao" onclick="deletarUsuario('${u.usuario}')" title="Excluir acesso">🗑️</button>`;

            return `<tr>
                <td><strong>${u.usuario}</strong></td>
                <td>${nivelBadge}</td>
                <td>${dataFormatada}</td>
                <td>${btnDeletar}</td>
            </tr>`;
        }).join('');
    } catch (e) {
        console.error('Erro ao carregar usuários:', e);
    }
}

async function cadastrarUsuario() {
    const usuario = document.getElementById('adminNovoUsuario').value.trim();
    const senha = document.getElementById('adminNovaSenha').value;
    const nivel = document.getElementById('adminNovoNivel').value;
    const statusEl = document.getElementById('adminStatus');

    if (!usuario || !senha) {
        statusEl.textContent = 'Preencha usuário e senha.';
        statusEl.className = 'admin-status erro';
        return;
    }

    if (senha.length < 4) {
        statusEl.textContent = 'A senha deve ter pelo menos 4 caracteres.';
        statusEl.className = 'admin-status erro';
        return;
    }

    try {
        const resultado = await ipcRenderer.invoke('cadastrar-usuario', {
            usuario, senha, nivel, criadoPor: usuarioLogado.usuario
        });

        if (resultado.sucesso) {
            statusEl.textContent = `✅ Usuário "${usuario}" cadastrado com sucesso!`;
            statusEl.className = 'admin-status sucesso';
            document.getElementById('adminNovoUsuario').value = '';
            document.getElementById('adminNovaSenha').value = '';
            document.getElementById('adminNovoNivel').value = 'funcionario';
            carregarUsuarios();
        } else {
            statusEl.textContent = resultado.mensagem || 'Erro ao cadastrar.';
            statusEl.className = 'admin-status erro';
        }
    } catch (e) {
        statusEl.textContent = 'Erro de conexão.';
        statusEl.className = 'admin-status erro';
    }
}

async function deletarUsuario(usuario) {
    if (!confirm(`Tem certeza que deseja excluir o acesso de "${usuario}"?`)) return;

    try {
        const resultado = await ipcRenderer.invoke('deletar-usuario', usuario);
        if (resultado.sucesso) {
            carregarUsuarios();
        } else {
            alert(resultado.mensagem || 'Erro ao excluir.');
        }
    } catch (e) {
        alert('Erro ao excluir usuário.');
    }
}

// ============ INIT ============
carregarCredenciaisSalvas();

// ============ AUTO-UPDATE (IPC do main → renderer) ============

ipcRenderer.on('update-disponivel', (event, dados) => {
    const toast = document.getElementById('updateToast');
    document.getElementById('updateIcon').textContent = '⬇️';
    document.getElementById('updateTitle').textContent = `Nova versão ${dados.versao}`;
    document.getElementById('updateMsg').textContent = 'Baixando atualização...';
    document.getElementById('updateProgress').classList.remove('oculto');
    document.getElementById('btnUpdateRestart').classList.add('oculto');
    toast.classList.remove('oculto');
});

ipcRenderer.on('update-progresso', (event, dados) => {
    const bar = document.getElementById('updateProgressBar');
    bar.style.width = `${dados.percentual}%`;
    document.getElementById('updateMsg').textContent = `${dados.percentual}% — ${dados.velocidade}/s`;
});

ipcRenderer.on('update-pronto', (event, dados) => {
    document.getElementById('updateIcon').textContent = '✅';
    document.getElementById('updateTitle').textContent = `Versão ${dados.versao} pronta!`;
    document.getElementById('updateMsg').textContent = 'Reinicie para aplicar a atualização.';
    document.getElementById('updateProgress').classList.add('oculto');
    document.getElementById('btnUpdateRestart').classList.remove('oculto');
});

ipcRenderer.on('update-erro', (event, dados) => {
    // Apenas loga, não mostra pro usuário (pode ser erro de rede momentâneo)
    console.log('[UPDATER] Erro no update:', dados.mensagem);
});

function instalarUpdate() {
    ipcRenderer.send('instalar-update');
}

function fecharUpdateToast() {
    document.getElementById('updateToast').classList.add('oculto');
}
