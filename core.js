/* Caderneta — lógica pura (datas, valores, parcelas e regras de sincronização).
 * Sem acesso a DOM ou rede: testável no Node e usada pelo app.js no navegador. */
(function (root) {
  const pad = (n) => String(n).padStart(2, "0");
  const RE_ID = /^[A-Za-z0-9_-]{4,64}$/;

  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ymOf = (iso) => iso.slice(0, 7);
  const shiftYm = (ym, k) => {
    const [y, m] = ym.split("-").map(Number);
    const d = new Date(y, m - 1 + k, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  };
  // Soma k meses mantendo o dia; se o mês não tiver esse dia, usa o último (31/10 → 30/11).
  const addMonths = (iso, k) => {
    const [y, m, d] = iso.split("-").map(Number);
    const first = new Date(y, m - 1 + k, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return `${first.getFullYear()}-${pad(first.getMonth() + 1)}-${pad(Math.min(d, last))}`;
  };
  // Divide o total (centavos) em n parcelas; a sobra de centavos vai para a 1ª.
  const dividir = (total, n) => {
    const base = Math.floor(total / n);
    return Array.from({ length: n }, (_, i) => (i === 0 ? total - base * (n - 1) : base));
  };

  const slug = (s) =>
    String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "cat";
  // Id de categoria aceito pelo servidor (4–64 caracteres de [A-Za-z0-9_-]).
  const idCategoria = (base) => {
    if (RE_ID.test(base)) return base;
    let id = "c-" + slug(base);
    while (id.length < 4) id += "x";
    return id.slice(0, 64);
  };
  const novoId = () => {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  };

  // ---------- conversão local ↔ servidor ----------
  // Local: valor em centavos (inteiro). Servidor/planilha: valor em reais.
  const paraServidor = (r) => {
    const o = { ...r, valor: Math.round(r.valor) / 100 };
    delete o.pendente;
    return o;
  };
  const doServidor = (r) => ({
    ...r,
    valor: Math.round(Number(r.valor) * 100),
    excluido: r.excluido === true,
    grupo: r.grupo || null,
    parcela: r.parcela || null,
    parcelas: r.parcelas || null,
    pendente: false,
  });

  /**
   * Aplica o resultado de uma sincronização a uma coleção local.
   * @param local    Map id → registro local (é alterado e devolvido)
   * @param enviados registros que foram enviados nesta rodada (cópias do momento do envio)
   * @param vindos   registros devolvidos pelo servidor (já em formato local)
   * Regras:
   *  1. Enviado e não alterado localmente desde o envio → deixa de ser pendente.
   *  2. Vindo do servidor substitui o local, exceto se o local está pendente e é mais novo.
   */
  function aplicarSync(local, enviados, vindos) {
    enviados.forEach((e) => {
      const atual = local.get(e.id);
      if (atual && atual.pendente && atual.alteradoEm === e.alteradoEm) local.set(e.id, { ...atual, pendente: false });
    });
    vindos.forEach((v) => {
      const atual = local.get(v.id);
      if (atual && atual.pendente && atual.alteradoEm > v.alteradoEm) return;
      local.set(v.id, { ...v, pendente: false });
    });
    return local;
  }

  // Categoria: meta em centavos no celular, em reais na planilha (null = sem meta).
  const catParaServidor = (c) => {
    const o = { ...c, meta: c.meta > 0 ? Math.round(c.meta) / 100 : null };
    delete o.pendente;
    return o;
  };
  const catDoServidor = (c) => ({
    ...c,
    meta: Number(c.meta) > 0 ? Math.round(Number(c.meta) * 100) : null,
    excluido: c.excluido === true,
    pendente: false,
  });

  /** Situação de uma meta: ok (< 80%), alerta (80–100%), estouro (> 100%). */
  const situacaoMeta = (gasto, meta) => {
    if (!(meta > 0)) return null;
    const pct = gasto / meta;
    return { pct, estado: pct > 1 ? "estouro" : pct >= 0.8 ? "alerta" : "ok", resta: meta - gasto };
  };

  /** Gera os lançamentos de uma compra (parcelada ou não). Valor total em centavos. */
  function gerarLancamentos({ total, n, data, categoria, pagamento, descricao, autor, agora }) {
    const base = { categoria, pagamento, descricao, autor, criadoEm: agora, alteradoEm: agora, excluido: false, pendente: true };
    if (!(n > 1)) {
      return [{ id: novoId(), data, mes: ymOf(data), valor: total, grupo: null, parcela: null, parcelas: null, ...base }];
    }
    const grupo = "g-" + novoId();
    return dividir(total, n).map((valor, i) => {
      const d = addMonths(data, i);
      return { id: novoId(), data: d, mes: ymOf(d), valor, grupo, parcela: i + 1, parcelas: n, ...base };
    });
  }

  /** Converte o JSON exportado pela Caderneta (artefato) em registros locais. */
  function importarCaderneta(json, autor, agora) {
    const mapaCat = {};
    const categorias = (json.categorias || []).map((c, i) => {
      const id = idCategoria(c.id);
      mapaCat[c.id] = id;
      return { id, nome: String(c.nome || id).slice(0, 24), hue: Number(c.hue) || 0, ordem: i, alteradoEm: agora, excluido: false, pendente: true };
    });
    const grupos = {};
    const lancamentos = (json.despesas || [])
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.data) && Number(d.valor) > 0)
      .map((d) => {
        let grupo = null;
        if (d.grupo) grupo = grupos[d.grupo] || (grupos[d.grupo] = "g-" + novoId());
        return {
          id: RE_ID.test(d.id || "") ? d.id : novoId(),
          data: d.data, mes: ymOf(d.data), valor: Math.round(Number(d.valor)),
          categoria: mapaCat[d.categoria] || idCategoria(d.categoria || "outros"),
          pagamento: d.pagamento || "pix", descricao: d.descricao || "",
          grupo, parcela: d.grupo ? d.parcela : null, parcelas: d.grupo ? d.parcelas : null,
          autor, criadoEm: d.criadoEm || agora, alteradoEm: agora, excluido: false, pendente: true,
        };
      });
    return { categorias, lancamentos };
  }

  const api = { pad, RE_ID, isoDate, ymOf, shiftYm, addMonths, dividir, slug, idCategoria, novoId,
    paraServidor, doServidor, catParaServidor, catDoServidor, situacaoMeta, aplicarSync, gerarLancamentos, importarCaderneta };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Core = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
