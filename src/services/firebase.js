const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Serviço Firebase para sincronização de certidões na nuvem.
 * 
 * Firestore collections:
 *   - certidoes/{cnpj}_{tipo}      → registros de certidões
 *   - pdf_storage/{cnpj}_{tipo}    → PDFs em base64 (max ~900KB cada)
 *   - config/email                 → configuração de e-mail
 *   - config/controle              → controle anti-duplicação de vencimentos
 */

let db = null;
let inicializado = false;

// ============ INICIALIZAÇÃO ============
function inicializar() {
    if (inicializado) return true;

    try {
        // Buscar credenciais: empacotado ou desenvolvimento
        let credPath = path.join(__dirname, '..', 'config', 'firebase-credentials.json');
        if (!fs.existsSync(credPath)) {
            // Em produção (asar), pode estar em resources
            const altPath = path.join(process.resourcesPath || '', 'app', 'src', 'config', 'firebase-credentials.json');
            if (fs.existsSync(altPath)) {
                credPath = altPath;
            } else {
                console.error('[FIREBASE] Arquivo de credenciais não encontrado.');
                return false;
            }
        }

        const serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf-8'));

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });

        db = admin.firestore();
        inicializado = true;
        console.log('[FIREBASE] Inicializado com sucesso.');
        return true;
    } catch (e) {
        console.error('[FIREBASE] Erro ao inicializar:', e.message);
        return false;
    }
}

function getDB() {
    if (!inicializado) inicializar();
    return db;
}

// ============ CHAVE DO DOCUMENTO ============
// Gera ID único para cada certidão: "cnpj_tipo"
function gerarDocId(cnpj, tipo) {
    return `${cnpj}_${tipo}`;
}

// ============ REGISTRAR / ATUALIZAR CERTIDÃO ============
async function registrarCertidao(registro) {
    try {
        const firestore = getDB();
        if (!firestore) return { sucesso: false, mensagem: 'Firebase não inicializado' };

        const docId = gerarDocId(registro.cnpj, registro.tipo);

        // Não salvar caminhos locais (são diferentes em cada PC)
        const dados = {
            cnpj: registro.cnpj || '',
            tipo: registro.tipo || '',
            validade: registro.validade || '',
            razao_social: registro.razao_social || '',
            nome_fantasia: registro.nome_fantasia || '',
            data_emissao: registro.data_emissao || '',
            atualizado_em: new Date().toISOString(),
            notificacao_enviada: registro.notificacao_enviada || false
        };

        await firestore.collection('certidoes').doc(docId).set(dados, { merge: true });
        console.log(`[FIREBASE] Certidão salva: ${docId}`);
        return { sucesso: true };
    } catch (e) {
        console.error('[FIREBASE] Erro ao registrar certidão:', e.message);
        return { sucesso: false, mensagem: e.message };
    }
}

// ============ DELETAR CERTIDÃO ============
async function deletarCertidao(cnpj, tipo) {
    try {
        const firestore = getDB();
        if (!firestore) return { sucesso: false, mensagem: 'Firebase não inicializado' };

        const docId = gerarDocId(cnpj, tipo);
        await firestore.collection('certidoes').doc(docId).delete();
        console.log(`[FIREBASE] Certidão removida: ${docId}`);
        return { sucesso: true };
    } catch (e) {
        console.error('[FIREBASE] Erro ao deletar certidão:', e.message);
        return { sucesso: false, mensagem: e.message };
    }
}

// ============ LISTAR TODAS AS CERTIDÕES ============
async function listarCertidoes() {
    try {
        const firestore = getDB();
        if (!firestore) return [];

        const snapshot = await firestore.collection('certidoes').get();
        const registros = [];
        snapshot.forEach(doc => {
            registros.push(doc.data());
        });

        console.log(`[FIREBASE] ${registros.length} certidões carregadas da nuvem.`);
        return registros;
    } catch (e) {
        console.error('[FIREBASE] Erro ao listar certidões:', e.message);
        return [];
    }
}

// ============ SINCRONIZAR LOCAL → NUVEM ============
// Envia todos os registros locais para a nuvem (na primeira vez)
async function sincronizarLocalParaNuvem(registrosLocais) {
    try {
        const firestore = getDB();
        if (!firestore) return { sucesso: false, mensagem: 'Firebase não inicializado' };

        let count = 0;
        const batch = firestore.batch();

        for (const r of registrosLocais) {
            const docId = gerarDocId(r.cnpj, r.tipo);
            const docRef = firestore.collection('certidoes').doc(docId);

            batch.set(docRef, {
                cnpj: r.cnpj || '',
                tipo: r.tipo || '',
                validade: r.validade || '',
                razao_social: r.razao_social || '',
                nome_fantasia: r.nome_fantasia || '',
                data_emissao: r.data_emissao || '',
                atualizado_em: r.atualizado_em || new Date().toISOString(),
                notificacao_enviada: r.notificacao_enviada || false
            }, { merge: true });
            count++;
        }

        await batch.commit();
        console.log(`[FIREBASE] Sincronização local→nuvem: ${count} registros enviados.`);
        return { sucesso: true, count };
    } catch (e) {
        console.error('[FIREBASE] Erro na sincronização:', e.message);
        return { sucesso: false, mensagem: e.message };
    }
}

// ============ SINCRONIZAR NUVEM → LOCAL ============
// Retorna registros da nuvem para mesclar com os locais.
// Critério: mantém o registro com atualizado_em mais recente.
// Se um registro existe localmente mas NÃO na nuvem (e a nuvem tem dados),
// isso significa que outro PC deletou — então remove do local também.
async function sincronizarNuvemParaLocal(registrosLocais) {
    try {
        const registrosNuvem = await listarCertidoes();
        if (registrosNuvem.length === 0 && registrosLocais.length === 0) return registrosLocais;

        const mapaLocal = {};
        for (const r of registrosLocais) {
            mapaLocal[`${r.cnpj}_${r.tipo}`] = r;
        }

        const mapaNuvem = {};
        for (const r of registrosNuvem) {
            mapaNuvem[`${r.cnpj}_${r.tipo}`] = r;
        }

        // Determinar se a nuvem está "ativa" (tem registros ou já teve)
        // Se a nuvem retorna dados, ela está online e confiável
        const nuvemOnline = registrosNuvem.length > 0 || registrosLocais.length === 0;

        const resultado = [];

        // 1. Processar registros que estão na nuvem
        for (const id of Object.keys(mapaNuvem)) {
            const local = mapaLocal[id];
            const nuvem = mapaNuvem[id];

            if (local && nuvem) {
                // Ambos existem: pegar o mais recente, mas manter campos locais (arquivo, pasta)
                const dataLocal = new Date(local.atualizado_em || 0).getTime();
                const dataNuvem = new Date(nuvem.atualizado_em || 0).getTime();

                if (dataNuvem > dataLocal) {
                    resultado.push({
                        ...nuvem,
                        arquivo: local.arquivo || '',
                        pasta_empresa: local.pasta_empresa || ''
                    });
                } else {
                    resultado.push(local);
                }
            } else {
                // Só na nuvem: adicionar sem arquivo/pasta (outro PC emitiu)
                resultado.push({
                    ...nuvem,
                    arquivo: '',
                    pasta_empresa: ''
                });
            }
        }

        // 2. Processar registros que só existem localmente
        for (const id of Object.keys(mapaLocal)) {
            if (!mapaNuvem[id]) {
                if (nuvemOnline) {
                    // A nuvem está online e esse registro NÃO está lá
                    // → foi deletado por outro PC → NÃO adicionar (deletar localmente)
                    console.log(`[FIREBASE] Registro ${id} deletado na nuvem por outro PC. Removendo localmente.`);
                } else {
                    // Nuvem vazia/offline → manter local para não perder dados
                    resultado.push(mapaLocal[id]);
                }
            }
        }

        console.log(`[FIREBASE] Sincronização: ${registrosLocais.length} local, ${registrosNuvem.length} nuvem → ${resultado.length} mesclados.`);
        return resultado;
    } catch (e) {
        console.error('[FIREBASE] Erro na sincronização nuvem→local:', e.message);
        return registrosLocais;
    }
}

// ============ SALVAR CONFIG E-MAIL NA NUVEM ============
async function salvarConfigEmail(config) {
    try {
        const firestore = getDB();
        if (!firestore) return { sucesso: false };

        await firestore.collection('config').doc('email').set(config);
        console.log('[FIREBASE] Config e-mail salva na nuvem.');
        return { sucesso: true };
    } catch (e) {
        console.error('[FIREBASE] Erro ao salvar config email:', e.message);
        return { sucesso: false, mensagem: e.message };
    }
}

// ============ CARREGAR CONFIG E-MAIL DA NUVEM ============
async function carregarConfigEmail() {
    try {
        const firestore = getDB();
        if (!firestore) return null;

        const doc = await firestore.collection('config').doc('email').get();
        if (doc.exists) {
            console.log('[FIREBASE] Config e-mail carregada da nuvem.');
            return doc.data();
        }
        return null;
    } catch (e) {
        console.error('[FIREBASE] Erro ao carregar config email:', e.message);
        return null;
    }
}

// ============ CONTROLE ANTI-DUPLICAÇÃO DE VENCIMENTOS ============
// Verifica se a verificação de vencimentos já foi feita hoje (por qualquer PC)
async function jaVerificouHoje() {
    try {
        const firestore = getDB();
        if (!firestore) return false;

        const doc = await firestore.collection('config').doc('controle').get();
        if (doc.exists) {
            const data = doc.data();
            const hoje = new Date().toISOString().split('T')[0];
            return data.ultima_verificacao_vencimentos === hoje;
        }
        return false;
    } catch (e) {
        console.error('[FIREBASE] Erro ao verificar controle:', e.message);
        return false; // Na dúvida, permite enviar
    }
}

// Marca que a verificação de vencimentos foi feita hoje
async function marcarVerificacaoHoje() {
    try {
        const firestore = getDB();
        if (!firestore) return;

        const hoje = new Date().toISOString().split('T')[0];
        await firestore.collection('config').doc('controle').set({
            ultima_verificacao_vencimentos: hoje,
            verificado_por: require('os').hostname(),
            verificado_em: new Date().toISOString()
        }, { merge: true });

        console.log('[FIREBASE] Verificação de vencimentos marcada como feita hoje.');
    } catch (e) {
        console.error('[FIREBASE] Erro ao marcar verificação:', e.message);
    }
}

// ============ PDF NA NUVEM (via Firestore) ============
// Armazena PDFs como base64 em documentos Firestore.
// Collection: pdf_storage/{cnpj}_{tipo}
// Limite Firestore: 1MB por documento. PDFs de certidão ~50-300KB = OK.

function gerarPdfDocId(cnpj, tipo) {
    return `${cnpj}_${tipo}`;
}

async function uploadPDF(cnpj, tipo, caminhoLocal) {
    try {
        const firestore = getDB();
        if (!firestore) {
            console.log('[STORAGE] Firestore não inicializado.');
            return { sucesso: false, mensagem: 'Firestore não inicializado' };
        }
        if (!caminhoLocal || !fs.existsSync(caminhoLocal)) {
            console.log(`[STORAGE] Arquivo não encontrado: ${caminhoLocal}`);
            return { sucesso: false, mensagem: 'Arquivo local não encontrado' };
        }

        const buffer = fs.readFileSync(caminhoLocal);
        const sizeKB = Math.round(buffer.length / 1024);

        // Firestore tem limite de ~1MB por documento. Se PDF > 900KB, ignorar.
        if (buffer.length > 900 * 1024) {
            console.log(`[STORAGE] PDF muito grande (${sizeKB}KB). Ignorando upload.`);
            return { sucesso: false, mensagem: `PDF muito grande: ${sizeKB}KB` };
        }

        const base64 = buffer.toString('base64');
        const docId = gerarPdfDocId(cnpj, tipo);

        await firestore.collection('pdf_storage').doc(docId).set({
            cnpj,
            tipo,
            pdf_base64: base64,
            tamanho_kb: sizeKB,
            atualizado_em: new Date().toISOString(),
            enviado_por: require('os').hostname()
        });

        console.log(`[STORAGE] Upload OK: ${docId} (${sizeKB}KB)`);
        return { sucesso: true, docId };
    } catch (e) {
        console.error(`[STORAGE] Erro no upload: ${e.message}`);
        return { sucesso: false, mensagem: e.message };
    }
}

async function downloadPDF(cnpj, tipo, caminhoDestino) {
    try {
        const firestore = getDB();
        if (!firestore) {
            return { sucesso: false, mensagem: 'Firestore não inicializado' };
        }

        const docId = gerarPdfDocId(cnpj, tipo);
        const doc = await firestore.collection('pdf_storage').doc(docId).get();

        if (!doc.exists || !doc.data().pdf_base64) {
            console.log(`[STORAGE] PDF não encontrado na nuvem: ${docId}`);
            return { sucesso: false, mensagem: 'PDF não encontrado na nuvem' };
        }

        // Garantir que a pasta destino existe
        const pastaDestino = path.dirname(caminhoDestino);
        if (!fs.existsSync(pastaDestino)) {
            fs.mkdirSync(pastaDestino, { recursive: true });
        }

        // Decodificar base64 e salvar
        const buffer = Buffer.from(doc.data().pdf_base64, 'base64');
        fs.writeFileSync(caminhoDestino, buffer);

        console.log(`[STORAGE] Download OK: ${docId} → ${caminhoDestino}`);
        return { sucesso: true, caminhoDestino };
    } catch (e) {
        console.error(`[STORAGE] Erro no download: ${e.message}`);
        return { sucesso: false, mensagem: e.message };
    }
}

async function deletarPDF(cnpj, tipo) {
    try {
        const firestore = getDB();
        if (!firestore) return { sucesso: false };

        const docId = gerarPdfDocId(cnpj, tipo);
        await firestore.collection('pdf_storage').doc(docId).delete();
        console.log(`[STORAGE] Deletado: ${docId}`);
        return { sucesso: true };
    } catch (e) {
        console.error(`[STORAGE] Erro ao deletar: ${e.message}`);
        return { sucesso: false, mensagem: e.message };
    }
}

async function pdfExisteNaNuvem(cnpj, tipo) {
    try {
        const firestore = getDB();
        if (!firestore) return false;
        const docId = gerarPdfDocId(cnpj, tipo);
        const doc = await firestore.collection('pdf_storage').doc(docId).get();
        return doc.exists && !!doc.data().pdf_base64;
    } catch (e) {
        return false;
    }
}

// ============ HASH DE SENHA ============
function hashSenha(senha) {
    return crypto.createHash('sha256').update(senha).digest('hex');
}

// ============ AUTENTICAÇÃO DE USUÁRIO ============
async function autenticarUsuario(usuario, senha) {
    try {
        const firestore = getDB();
        if (!firestore) return { sucesso: false, mensagem: 'Firebase não inicializado' };

        const doc = await firestore.collection('usuarios').doc(usuario.toLowerCase()).get();
        if (!doc.exists) {
            return { sucesso: false, mensagem: 'Usuário ou senha incorretos' };
        }

        const dados = doc.data();
        if (dados.senha_hash !== hashSenha(senha)) {
            return { sucesso: false, mensagem: 'Usuário ou senha incorretos' };
        }

        return {
            sucesso: true,
            usuario: dados.usuario,
            nivel: dados.nivel
        };
    } catch (e) {
        console.error('[FIREBASE] Erro na autenticação:', e.message);
        return { sucesso: false, mensagem: 'Erro ao conectar. Tente novamente.' };
    }
}

// ============ CADASTRAR USUÁRIO ============
async function cadastrarUsuario(usuario, senha, nivel, criadoPor) {
    try {
        const firestore = getDB();
        if (!firestore) return { sucesso: false, mensagem: 'Firebase não inicializado' };

        const docId = usuario.toLowerCase();
        const docExistente = await firestore.collection('usuarios').doc(docId).get();
        if (docExistente.exists) {
            return { sucesso: false, mensagem: 'Usuário já existe' };
        }

        await firestore.collection('usuarios').doc(docId).set({
            usuario: docId,
            senha_hash: hashSenha(senha),
            nivel: nivel,
            criado_em: new Date().toISOString(),
            criado_por: criadoPor || 'sistema'
        });

        console.log(`[FIREBASE] Usuário criado: ${docId} (${nivel})`);
        return { sucesso: true };
    } catch (e) {
        console.error('[FIREBASE] Erro ao cadastrar usuário:', e.message);
        return { sucesso: false, mensagem: e.message };
    }
}

// ============ LISTAR USUÁRIOS ============
async function listarUsuarios() {
    try {
        const firestore = getDB();
        if (!firestore) return [];

        const snapshot = await firestore.collection('usuarios').get();
        const usuarios = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            usuarios.push({
                usuario: d.usuario,
                nivel: d.nivel,
                criado_em: d.criado_em,
                criado_por: d.criado_por
            });
        });
        return usuarios;
    } catch (e) {
        console.error('[FIREBASE] Erro ao listar usuários:', e.message);
        return [];
    }
}

// ============ DELETAR USUÁRIO ============
async function deletarUsuario(usuario) {
    try {
        const firestore = getDB();
        if (!firestore) return { sucesso: false, mensagem: 'Firebase não inicializado' };

        const docId = usuario.toLowerCase();
        await firestore.collection('usuarios').doc(docId).delete();
        console.log(`[FIREBASE] Usuário removido: ${docId}`);
        return { sucesso: true };
    } catch (e) {
        console.error('[FIREBASE] Erro ao deletar usuário:', e.message);
        return { sucesso: false, mensagem: e.message };
    }
}

// ============ GARANTIR ADMIN PADRÃO ============
async function garantirAdminPadrao() {
    try {
        const firestore = getDB();
        if (!firestore) return;

        const doc = await firestore.collection('usuarios').doc('admin').get();
        if (!doc.exists) {
            await firestore.collection('usuarios').doc('admin').set({
                usuario: 'admin',
                senha_hash: hashSenha('admin'),
                nivel: 'administrador',
                criado_em: new Date().toISOString(),
                criado_por: 'sistema'
            });
            console.log('[FIREBASE] Usuário admin padrão criado (admin/admin).');
        }
    } catch (e) {
        console.error('[FIREBASE] Erro ao criar admin padrão:', e.message);
    }
}

module.exports = {
    inicializar,
    registrarCertidao,
    deletarCertidao,
    listarCertidoes,
    sincronizarLocalParaNuvem,
    sincronizarNuvemParaLocal,
    salvarConfigEmail,
    carregarConfigEmail,
    jaVerificouHoje,
    marcarVerificacaoHoje,
    uploadPDF,
    downloadPDF,
    deletarPDF,
    pdfExisteNaNuvem,
    autenticarUsuario,
    cadastrarUsuario,
    listarUsuarios,
    deletarUsuario,
    garantirAdminPadrao
};
