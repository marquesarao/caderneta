/**
 * Caderneta — sincronização entre os celulares e esta planilha.
 * 1) Execute setup() uma vez (cria as abas e gera a chave da casa).
 * 2) Execute testarSync() para validar.
 * 3) Implantar > Nova implantação > App da Web (Executar como: Eu; Acesso: Qualquer pessoa).
 *
 * Contrato do POST (corpo JSON, enviado como text/plain):
 *   { chave, desde, lancamentos: [...], categorias: [...] }
 * Resposta:
 *   { ok, agora, gravados, lancamentos: [...alterados desde 'desde'], categorias: [...] }
 * Valores monetários trafegam em REAIS (ex.: 159.99).
 * Regra de conflito: por id, vence o maior 'alteradoEm' (ISO UTC).
 */

const ABA_LANC = 'Lançamentos';
const ABA_CAT = 'Categorias';

const COLS_LANC = ['id', 'data', 'mes', 'valor', 'categoria', 'pagamento', 'descricao', 'grupo',
  'parcela', 'parcelas', 'autor', 'criadoEm', 'alteradoEm', 'excluido', 'servidorEm'];
const FMT_LANC = ['@', '@', '@', '#,##0.00', '@', '@', '@', '@',
  '0', '0', '@', '@', '@', '0', '0'];

// colunas novas (meta, obs, reserva...) ficam sempre no fim para não deslocar as colunas que já existem na planilha.
const COLS_CAT = ['id', 'nome', 'hue', 'ordem', 'alteradoEm', 'excluido', 'servidorEm', 'meta', 'obs',
  'reserva', 'reservaDesde', 'saldoIni'];
const FMT_CAT = ['@', '@', '0', '0', '@', '0', '0', '#,##0.00', '@', '0', '@', '#,##0.00'];

const RE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const RE_ID = /^[A-Za-z0-9_-]{4,64}$/;

// ---------------------------------------------------------------- setup

function setup() {
  const ss = SpreadsheetApp.getActive();
  prepararAba_(ss, ABA_LANC, COLS_LANC);
  prepararAba_(ss, ABA_CAT, COLS_CAT);
  const props = PropertiesService.getScriptProperties();
  let chave = props.getProperty('CHAVE');
  if (!chave) {
    chave = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('CHAVE', chave);
  }
  Logger.log('Abas prontas (versão 4, com metas, observações e reservas).');
  Logger.log('CHAVE DA CASA (guarde, vai nos dois celulares): ' + chave);
}

function prepararAba_(ss, nome, cols) {
  const sh = ss.getSheetByName(nome) || ss.insertSheet(nome);
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  sh.setFrozenRows(1);
  const padrao = ss.getSheetByName('Página1') || ss.getSheetByName('Sheet1');
  if (padrao && ss.getSheets().length > 2 && padrao.getLastRow() === 0) ss.deleteSheet(padrao);
}

// ---------------------------------------------------------------- web app

function doGet() {
  return json_({ ok: true, app: 'caderneta', versao: 4 });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, erro: 'json_invalido' });
  }
  return json_(sincronizar_(body));
}

function sincronizar_(body) {
  const chave = PropertiesService.getScriptProperties().getProperty('CHAVE');
  if (!chave || !body || body.chave !== chave) return { ok: false, erro: 'chave_invalida' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, erro: 'ocupado_tente_de_novo' };
  try {
    const ss = SpreadsheetApp.getActive();
    const agora = proximoCarimbo_();
    const lancs = (Array.isArray(body.lancamentos) ? body.lancamentos : []).map(limparLanc_).filter(Boolean);
    const cats = (Array.isArray(body.categorias) ? body.categorias : []).map(limparCat_).filter(Boolean);

    const gravados = {
      lancamentos: gravar_(ss.getSheetByName(ABA_LANC), COLS_LANC, FMT_LANC, lancs, agora),
      categorias: gravar_(ss.getSheetByName(ABA_CAT), COLS_CAT, FMT_CAT, cats, agora),
    };
    SpreadsheetApp.flush();

    const desde = Number(body.desde) || 0;
    return {
      ok: true,
      agora: agora,
      gravados: gravados,
      lancamentos: ler_(ss.getSheetByName(ABA_LANC), COLS_LANC, desde),
      categorias: ler_(ss.getSheetByName(ABA_CAT), COLS_CAT, desde),
    };
  } finally {
    lock.releaseLock();
  }
}

// Carimbo do servidor estritamente crescente (evita perder alterações no mesmo milissegundo).
function proximoCarimbo_() {
  const props = PropertiesService.getScriptProperties();
  const ultimo = Number(props.getProperty('ULTIMO_CARIMBO')) || 0;
  const agora = Math.max(Date.now(), ultimo + 1);
  props.setProperty('ULTIMO_CARIMBO', String(agora));
  return agora;
}

// ---------------------------------------------------------------- gravação e leitura

function gravar_(sh, cols, formatos, regs, agora) {
  if (!regs.length) return 0;
  const ultima = sh.getLastRow();
  const iAlt = cols.indexOf('alteradoEm');
  const existentes = ultima > 1 ? sh.getRange(2, 1, ultima - 1, cols.length).getValues() : [];
  const pos = {};
  const alts = [];
  existentes.forEach(function (v, i) { pos[String(v[0])] = i; alts[i] = String(v[iAlt]); });

  let proxima = ultima + 1;
  let gravados = 0;
  regs.forEach(function (r) {
    let idx = pos[r.id];
    let linha;
    if (idx !== undefined) {
      if (r.alteradoEm <= alts[idx]) return; // a planilha já tem versão igual ou mais nova
      linha = idx + 2;
    } else {
      linha = proxima++;
      idx = linha - 2;
      pos[r.id] = idx;
    }
    alts[idx] = r.alteradoEm;
    r.servidorEm = agora;
    const valores = cols.map(function (c) { return r[c] === undefined || r[c] === null ? '' : r[c]; });
    const rg = sh.getRange(linha, 1, 1, cols.length);
    rg.setNumberFormats([formatos]);
    rg.setValues([valores]);
    gravados++;
  });
  return gravados;
}

function ler_(sh, cols, desde) {
  const ultima = sh.getLastRow();
  if (ultima < 2) return [];
  const iServ = cols.indexOf('servidorEm');
  return sh.getRange(2, 1, ultima - 1, cols.length).getValues()
    .filter(function (v) { return Number(v[iServ]) > desde; })
    .map(function (v) {
      const o = {};
      cols.forEach(function (c, i) { o[c] = v[i]; });
      o.excluido = Number(o.excluido) === 1;
      ['parcela', 'parcelas', 'hue', 'ordem', 'meta', 'saldoIni'].forEach(function (c) {
        if (c in o) o[c] = o[c] === '' ? null : Number(o[c]);
      });
      if ('valor' in o) o.valor = Number(o.valor);
      ['grupo', 'reservaDesde'].forEach(function (c) { if (c in o && o[c] === '') o[c] = null; });
      if ('reserva' in o) o.reserva = Number(o.reserva) === 1;
      return o;
    });
}

// ---------------------------------------------------------------- validação

function txt_(v, max) {
  let s = String(v === undefined || v === null ? '' : v).slice(0, max);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // impede que vire fórmula
  return s;
}

function iso_(v) {
  const s = String(v || '');
  return RE_ISO.test(s) ? s : new Date().toISOString();
}

function limparLanc_(r) {
  if (!r || typeof r.id !== 'string' || !RE_ID.test(r.id)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.data))) return null;
  const valor = Math.round(Number(r.valor) * 100) / 100;
  if (!isFinite(valor) || valor < 0) return null;
  const parcela = Number(r.parcela) | 0;
  const parcelas = Number(r.parcelas) | 0;
  return {
    id: r.id,
    data: r.data,
    mes: r.data.slice(0, 7),
    valor: valor,
    categoria: txt_(r.categoria, 40),
    pagamento: txt_(r.pagamento, 20),
    descricao: txt_(r.descricao, 120),
    grupo: r.grupo && RE_ID.test(String(r.grupo)) ? String(r.grupo) : '',
    parcela: parcela > 0 ? parcela : '',
    parcelas: parcelas > 1 ? parcelas : '',
    autor: txt_(r.autor, 30),
    criadoEm: iso_(r.criadoEm),
    alteradoEm: iso_(r.alteradoEm),
    excluido: r.excluido === true ? 1 : 0,
  };
}

function limparCat_(r) {
  if (!r || typeof r.id !== 'string' || !RE_ID.test(r.id)) return null;
  const nome = String(r.nome || '').trim();
  if (!nome) return null;
  const hue = Math.max(0, Math.min(359, Number(r.hue) | 0));
  const meta = Math.round(Number(r.meta) * 100) / 100;
  const saldoIni = Math.round(Number(r.saldoIni) * 100) / 100;
  return {
    id: r.id,
    nome: txt_(nome, 24),
    hue: hue,
    ordem: Number(r.ordem) | 0,
    alteradoEm: iso_(r.alteradoEm),
    excluido: r.excluido === true ? 1 : 0,
    meta: isFinite(meta) && meta > 0 ? meta : '',
    obs: txt_(String(r.obs || '').trim(), 200),
    reserva: r.reserva === true ? 1 : 0,
    reservaDesde: /^\d{4}-\d{2}$/.test(String(r.reservaDesde || '')) ? String(r.reservaDesde) : '',
    saldoIni: isFinite(saldoIni) && saldoIni > 0 ? saldoIni : '',
  };
}

// ---------------------------------------------------------------- utilitários

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Teste interno: grava um lançamento de teste (já marcado como excluído) e confere o retorno.
function testarSync() {
  const chave = PropertiesService.getScriptProperties().getProperty('CHAVE');
  const id = 'teste-' + Date.now();
  const agoraIso = new Date().toISOString();
  const r1 = sincronizar_({
    chave: chave, desde: 0,
    lancamentos: [{ id: id, data: '2026-10-31', valor: 12.5, categoria: 'mercado', pagamento: 'pix',
      descricao: 'teste de sincronização', autor: 'teste', criadoEm: agoraIso, alteradoEm: agoraIso, excluido: true }],
  });
  const achou = r1.ok && r1.lancamentos.some(function (l) { return l.id === id && l.valor === 12.5; });

  const r2 = sincronizar_({ chave: 'errada', desde: 0 });
  const recusou = r2.ok === false && r2.erro === 'chave_invalida';

  const r3 = sincronizar_({ chave: chave, desde: r1.agora });
  const incremental = r3.ok && !r3.lancamentos.some(function (l) { return l.id === id; });

  Logger.log('Gravou e devolveu: ' + achou);
  Logger.log('Recusou chave errada: ' + recusou);
  Logger.log('Sincronização incremental: ' + incremental);
  Logger.log(achou && recusou && incremental ? 'OK — tudo certo' : 'FALHOU — me mande este log');
}
