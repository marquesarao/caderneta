/* Caderneta — app (interface, armazenamento local em IndexedDB e sincronização com a planilha). */
(() => {
  const C = window.Core;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const DEFAULT_CATS = [
    ["moradia", "Moradia", 210], ["mercado", "Mercado", 150], ["alimentacao", "Alimentação fora", 25],
    ["transporte", "Transporte", 45], ["saude", "Saúde", 350], ["educacao", "Educação", 265],
    ["lazer", "Lazer", 300], ["contas", "Contas e serviços", 185], ["outros", "Outros", 90],
  ];
  const PAGS = [
    { id: "pix", nome: "Pix" }, { id: "debito", nome: "Débito" },
    { id: "credito", nome: "Crédito" }, { id: "dinheiro", nome: "Dinheiro" },
  ];
  const SCOPES = [{ id: "esta", nome: "Só esta" }, { id: "seguintes", nome: "Esta e seguintes" }, { id: "todas", nome: "Todas" }];
  const HUES = [210, 150, 25, 45, 350, 265, 300, 185, 90, 0, 120, 235, 60, 320];
  const TOP_N = 6, MAX_PARC = 24;
  const DATA_PADRAO = "2000-01-01T00:00:00.000Z"; // categorias padrão perdem para qualquer edição real

  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const fmt = (c) => brl.format((c || 0) / 100);
  const fmtNum = (c) => ((c || 0) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const hojeIso = () => C.isoDate(new Date());
  const ymLabel = (ym) => { const [y, m] = ym.split("-").map(Number); const t = new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" }); return t.charAt(0).toUpperCase() + t.slice(1); };
  const ymShort = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "short" }).replace(".", "") + "/" + String(y).slice(2); };
  const dayLabel = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" }); };
  const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const agoraIso = () => new Date().toISOString();

  // ================================================================ IndexedDB
  let idb;
  function abrirDb() {
    return new Promise((ok, erro) => {
      const req = indexedDB.open("caderneta", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("lanc", { keyPath: "id" });
        db.createObjectStore("cat", { keyPath: "id" });
        db.createObjectStore("meta", { keyPath: "k" });
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => erro(req.error);
    });
  }
  const tx = (store, modo, fn) => new Promise((ok, erro) => {
    const t = idb.transaction(store, modo);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => ok(r && r.result);
    t.onerror = () => erro(t.error);
  });
  const lerTudo = (store) => tx(store, "readonly", (s) => s.getAll());
  const gravar = (store, regs) => regs.length ? tx(store, "readwrite", (s) => { regs.forEach((r) => s.put(r)); }) : Promise.resolve();
  const metaGet = async (k) => { const r = await tx("meta", "readonly", (s) => s.get(k)); return r ? r.v : undefined; };
  const metaSet = (k, v) => tx("meta", "readwrite", (s) => s.put({ k, v }));
  const metaDel = (k) => tx("meta", "readwrite", (s) => s.delete(k));

  // ================================================================ estado
  const lanc = new Map();
  const cat = new Map();
  let cfg = null, cursor = 0;
  const sync = { rodando: false, deNovo: false, ultimo: null, erro: null };

  const state = {
    ym: C.ymOf(hojeIso()), filtro: null, filtroAutor: null, tab: "lancar",
    form: { centavos: 0, cat: null, pag: "pix", data: hojeIso(), desc: "", n: 1 },
    editId: null, scope: "esta",
    periodo: 1, sub: "dash", rel: null,
  };

  const lancsAtivos = () => [...lanc.values()].filter((l) => !l.excluido);
  const catsAtivas = () => [...cat.values()].filter((c) => !c.excluido).sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, "pt-BR"));
  const catById = (id) => cat.get(id) || { id, nome: "Sem categoria", hue: 200 };
  const pagNome = (id) => (PAGS.find((p) => p.id === id) || { nome: id || "" }).nome;
  const ehParcelada = (d) => !!(d && d.grupo && d.parcelas > 1);
  const tituloDe = (d) => (d.descricao || catById(d.categoria).nome) + (ehParcelada(d) ? ` (${d.parcela}/${d.parcelas})` : "");
  const pendentes = () => [...lanc.values()].filter((x) => x.pendente).length + [...cat.values()].filter((x) => x.pendente).length;

  async function salvarLanc(regs) { regs.forEach((r) => lanc.set(r.id, r)); await gravar("lanc", regs); agendarSync(); render(); }
  async function salvarCats(regs) { regs.forEach((r) => cat.set(r.id, r)); await gravar("cat", regs); agendarSync(); renderCatsPicker(); render(); }

  // ================================================================ sincronização
  let syncTimer = null;
  function agendarSync(ms = 1200) { clearTimeout(syncTimer); syncTimer = setTimeout(sincronizar, ms); renderSync(); }

  async function chamarScript(url, corpo, timeoutMs = 25000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // Sem Content-Type explícito o navegador manda text/plain: evita a pré-checagem CORS que o Apps Script não atende.
      const r = await fetch(url, { method: "POST", body: JSON.stringify(corpo), redirect: "follow", signal: ctrl.signal });
      if (!r.ok) throw new Error("http_" + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  async function sincronizar() {
    if (!cfg) return;
    if (sync.rodando) { sync.deNovo = true; return; }
    if (!navigator.onLine) { renderSync(); return; }
    sync.rodando = true; sync.erro = null; renderSync();
    try {
      const envL = [...lanc.values()].filter((x) => x.pendente).map((x) => ({ ...x }));
      const envC = [...cat.values()].filter((x) => x.pendente).map((x) => ({ ...x }));
      const res = await chamarScript(cfg.url, {
        chave: cfg.chave, desde: cursor,
        lancamentos: envL.map(C.paraServidor),
        categorias: envC.map((c) => { const o = { ...c }; delete o.pendente; return o; }),
      });
      if (!res || !res.ok) throw new Error(res && res.erro ? res.erro : "resposta_invalida");
      const vindosL = (res.lancamentos || []).map(C.doServidor);
      const vindosC = (res.categorias || []).map((c) => ({ ...c, excluido: c.excluido === true, pendente: false }));
      C.aplicarSync(lanc, envL, vindosL);
      C.aplicarSync(cat, envC, vindosC);
      const idsL = new Set([...envL, ...vindosL].map((x) => x.id));
      const idsC = new Set([...envC, ...vindosC].map((x) => x.id));
      await gravar("lanc", [...idsL].map((id) => lanc.get(id)));
      await gravar("cat", [...idsC].map((id) => cat.get(id)));
      cursor = res.agora; await metaSet("cursor", cursor);
      sync.ultimo = new Date();
      if (vindosC.length) renderCatsPicker();
      render();
    } catch (e) {
      const m = String(e && e.message || e);
      sync.erro = m === "chave_invalida" ? "Chave recusada pela planilha. Confira em Ajustes."
        : m.startsWith("ocupado") ? "Planilha ocupada, tentando de novo em instantes."
        : "Não foi possível sincronizar agora.";
      if (m.startsWith("ocupado")) agendarSync(5000);
    } finally {
      sync.rodando = false; renderSync();
      if (sync.deNovo) { sync.deNovo = false; agendarSync(300); }
    }
  }

  function renderSync() {
    const box = $("#sync"), txt = $("#syncTxt");
    const p = pendentes();
    let estado = "ok", msg;
    if (sync.rodando) { estado = "pendente"; msg = "Sincronizando…"; }
    else if (!navigator.onLine) { estado = p ? "pendente" : "ok"; msg = p ? `Offline · ${p} pendente${p > 1 ? "s" : ""}` : "Offline · tudo salvo no celular"; }
    else if (sync.erro) { estado = "erro"; msg = sync.erro; }
    else if (p) { estado = "pendente"; msg = `${p} pendente${p > 1 ? "s" : ""} de envio`; }
    else if (sync.ultimo) msg = "Sincronizado às " + sync.ultimo.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    else msg = "Aguardando sincronização";
    box.dataset.estado = estado; txt.textContent = msg;
    $("#btnSync").disabled = sync.rodando;
  }
  $("#btnSync").onclick = () => sincronizar();
  window.addEventListener("online", () => sincronizar());
  window.addEventListener("offline", renderSync);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sincronizar(); });
  setInterval(() => { if (document.visibilityState === "visible") sincronizar(); }, 180000);

  // ================================================================ util UI
  let toastTimer;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2800); }
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  function listaPorDia(box, lista) {
    const porDia = {};
    lista.slice().sort((a, b) => (b.data + (b.criadoEm || "")).localeCompare(a.data + (a.criadoEm || ""))).forEach((d) => { (porDia[d.data] ||= []).push(d); });
    Object.keys(porDia).sort().reverse().forEach((dia) => {
      const sec = el("div", "day"), head = el("div", "day-head");
      const r = el("span", "num", fmt(soma(porDia[dia]))); head.append(el("span", null, dayLabel(dia)), r);
      const rows = el("div", "rows");
      porDia[dia].forEach((d) => {
        const c = catById(d.categoria);
        const row = el("button", "row"); row.type = "button"; row.style.setProperty("--h", c.hue);
        const desc = el("span", "desc");
        const sm = el("small", null, (d.descricao ? `${c.nome} · ` : "") + pagNome(d.pagamento) + (d.autor ? " · " : ""));
        if (d.autor) sm.append(el("span", "autor", d.autor));
        if (d.pendente) sm.append(document.createTextNode(" · não enviado"));
        desc.append(el("strong", null, tituloDe(d)), sm);
        row.append(el("span", "dot"), desc, el("span", "val", fmt(d.valor)));
        row.onclick = () => startEdit(d); rows.append(row);
      });
      sec.append(head, rows); box.append(sec);
    });
  }
  function emptyBox(title, sub) { const e = el("div", "empty"); e.append(el("strong", null, title)); if (sub) e.append(el("span", null, sub)); return e; }

  // ================================================================ abas
  function setTab(tab) {
    state.tab = tab;
    ["lancar", "mes", "painel"].forEach((t) => { $("#tab-" + t).setAttribute("aria-selected", String(t === tab)); $("#view-" + t).hidden = t !== tab; });
    render();
  }
  $("#tab-lancar").onclick = () => setTab("lancar");
  $("#tab-mes").onclick = () => setTab("mes");
  $("#tab-painel").onclick = () => setTab("painel");

  // ================================================================ formulário
  const valorEl = $("#valor");
  valorEl.addEventListener("input", () => {
    const dig = valorEl.value.replace(/\D/g, "").replace(/^0+/, "").slice(0, 9);
    state.form.centavos = Number(dig || 0); valorEl.value = fmtNum(state.form.centavos);
    renderParc(); updateSaveBtn();
  });
  valorEl.addEventListener("focus", () => { setTimeout(() => valorEl.setSelectionRange(valorEl.value.length, valorEl.value.length), 0); });

  function topCats() {
    const hoje = hojeIso(); const d = new Date(); d.setDate(d.getDate() - 60); const ini = C.isoDate(d);
    const cont = {};
    lancsAtivos().forEach((x) => { if (x.data >= ini && x.data <= hoje) cont[x.categoria] = (cont[x.categoria] || 0) + 1; });
    const top = catsAtivas().map((c, i) => ({ c, i, n: cont[c.id] || 0 })).sort((a, b) => b.n - a.n || a.i - b.i).map((x) => x.c).slice(0, TOP_N);
    const sel = state.form.cat;
    if (sel && !top.some((c) => c.id === sel) && top.length) top[top.length - 1] = catById(sel);
    return top;
  }
  function renderCatsPicker() {
    const box = $("#cats"); box.replaceChildren();
    topCats().forEach((c) => {
      const b = el("button", "cat"); b.type = "button"; b.style.setProperty("--h", c.hue);
      b.setAttribute("aria-pressed", String(state.form.cat === c.id));
      b.append(el("span", "dot"), el("span", null, c.nome));
      b.onclick = () => { state.form.cat = c.id; renderCatsPicker(); updateSaveBtn(); };
      box.append(b);
    });
    $("#btnOutras").hidden = catsAtivas().length <= TOP_N;
  }
  function renderPags() {
    const box = $("#pags"); box.replaceChildren();
    PAGS.forEach((p) => {
      const b = el("button", null, p.nome); b.type = "button"; b.setAttribute("aria-pressed", String(state.form.pag === p.id));
      b.onclick = () => { state.form.pag = p.id; if (p.id !== "credito") state.form.n = 1; renderPags(); renderParc(); renderValorLbl(); };
      box.append(b);
    });
  }
  function renderValorLbl() {
    const ed = editando();
    $("#valorLbl").textContent = ehParcelada(ed) ? "Valor da parcela" : (!state.editId && state.form.pag === "credito" ? "Valor total" : "Valor");
  }
  function renderParc() {
    const show = state.form.pag === "credito" && !state.editId;
    $("#parcField").hidden = !show;
    if (!show) return;
    const n = state.form.n, t = state.form.centavos;
    $("#pN").textContent = n + "x"; $("#pMenos").disabled = n <= 1; $("#pMais").disabled = n >= MAX_PARC;
    if (n === 1) $("#pPrev").textContent = "à vista";
    else if (!t) $("#pPrev").textContent = "informe o valor total";
    else { const v = C.dividir(t, n); $("#pPrev").textContent = v[0] === v[1] ? `${n}x de ${fmt(v[1])}` : `1x de ${fmt(v[0])} + ${n - 1}x de ${fmt(v[1])}`; }
  }
  $("#pMenos").onclick = () => { state.form.n = Math.max(1, state.form.n - 1); renderParc(); };
  $("#pMais").onclick = () => { state.form.n = Math.min(MAX_PARC, state.form.n + 1); renderParc(); };

  function renderScope() {
    const box = $("#scope"); box.replaceChildren();
    SCOPES.forEach((s) => {
      const b = el("button", null, s.nome); b.type = "button"; b.setAttribute("aria-pressed", String(state.scope === s.id));
      b.onclick = () => { state.scope = s.id; renderScope(); disarmDelete(); };
      box.append(b);
    });
  }
  function renderDate() {
    const d = new Date(); d.setDate(d.getDate() - 1); const ontem = C.isoDate(d);
    $("#data").value = state.form.data;
    $("#dHoje").setAttribute("aria-pressed", String(state.form.data === hojeIso()));
    $("#dOntem").setAttribute("aria-pressed", String(state.form.data === ontem));
  }
  $("#dHoje").onclick = () => { state.form.data = hojeIso(); renderDate(); };
  $("#dOntem").onclick = () => { const d = new Date(); d.setDate(d.getDate() - 1); state.form.data = C.isoDate(d); renderDate(); };
  $("#data").addEventListener("change", (e) => { if (e.target.value) state.form.data = e.target.value; renderDate(); });
  $("#descricao").addEventListener("input", (e) => { state.form.desc = e.target.value; });

  const editando = () => (state.editId ? lanc.get(state.editId) : null);
  function updateSaveBtn() { $("#btnSalvar").disabled = !(state.form.centavos > 0 && state.form.cat); }
  function renderForm() {
    valorEl.value = fmtNum(state.form.centavos);
    $("#descricao").value = state.form.desc;
    const ed = editando(), parc = ehParcelada(ed);
    $("#editBanner").hidden = !state.editId;
    $("#editTxt").textContent = parc ? `Editando parcela ${ed.parcela} de ${ed.parcelas}` : "Editando lançamento";
    $("#scopeField").hidden = !parc;
    $("#btnExcluir").hidden = !state.editId;
    $("#btnSalvar").textContent = state.editId ? "Salvar alterações" : "Lançar";
    renderCatsPicker(); renderPags(); renderParc(); renderScope(); renderDate(); renderValorLbl();
    disarmDelete(); updateSaveBtn();
  }
  function resetForm(keepPag) {
    state.editId = null; state.scope = "esta";
    state.form = { centavos: 0, cat: null, pag: keepPag ? state.form.pag : "pix", data: hojeIso(), desc: "", n: 1 };
    renderForm();
  }
  $("#btnCancelEdit").onclick = () => { resetForm(); setTab("mes"); };

  // Todas as parcelas estão no celular, então o escopo é resolvido localmente.
  function alvos(ref) {
    if (!ehParcelada(ref) || state.scope === "esta") return [ref];
    const grupo = lancsAtivos().filter((d) => d.grupo === ref.grupo);
    return state.scope === "todas" ? grupo : grupo.filter((d) => d.parcela >= ref.parcela);
  }

  $("#btnSalvar").onclick = async () => {
    const f = state.form;
    if (!(f.centavos > 0 && f.cat)) return;
    const agora = agoraIso(), desc = (f.desc || "").trim();
    if (state.editId) {
      const ref = editando(); if (!ref) return;
      // Valor só se propaga quando foi alterado; senão cada parcela mantém o seu (a 1ª pode ter os centavos da sobra).
      const valorMudou = f.centavos !== ref.valor;
      const regs = alvos(ref).map((a) => {
        const r = { ...a, categoria: f.cat, pagamento: f.pag, descricao: desc, valor: valorMudou ? f.centavos : a.valor, alteradoEm: agora, pendente: true };
        if (a.id === ref.id) { r.data = f.data; r.mes = C.ymOf(f.data); }
        return r;
      });
      await salvarLanc(regs);
      toast(regs.length > 1 ? `${regs.length} parcelas atualizadas` : "Lançamento atualizado");
      resetForm(); setTab("mes");
    } else {
      const n = f.pag === "credito" ? f.n : 1;
      const regs = C.gerarLancamentos({ total: f.centavos, n, data: f.data, categoria: f.cat, pagamento: f.pag, descricao: desc, autor: cfg.autor, agora });
      await salvarLanc(regs);
      toast(n > 1 ? `Lançado: ${fmt(f.centavos)} em ${n}x em ${catById(f.cat).nome}` : `Lançado: ${fmt(f.centavos)} em ${catById(f.cat).nome}`);
      resetForm(true);
    }
  };

  let delTimer = null;
  function disarmDelete() { clearTimeout(delTimer); const b = $("#btnExcluir"); b.classList.remove("armed"); b.textContent = "Excluir"; }
  $("#btnExcluir").onclick = async () => {
    const b = $("#btnExcluir"), ref = editando(); if (!ref) return;
    const lista = alvos(ref);
    if (!b.classList.contains("armed")) {
      b.classList.add("armed");
      b.textContent = lista.length > 1 ? `Toque de novo para excluir ${lista.length} parcelas` : "Toque de novo para excluir";
      delTimer = setTimeout(disarmDelete, 3500); return;
    }
    disarmDelete();
    const agora = agoraIso();
    await salvarLanc(lista.map((a) => ({ ...a, excluido: true, alteradoEm: agora, pendente: true })));
    toast(lista.length > 1 ? `${lista.length} parcelas excluídas` : "Lançamento excluído");
    resetForm(); setTab("mes");
  };

  function startEdit(d) {
    state.editId = d.id; state.scope = "esta";
    state.form = { centavos: d.valor, cat: d.categoria, pag: d.pagamento || "pix", data: d.data, desc: d.descricao || "", n: 1 };
    setTab("lancar"); renderForm(); window.scrollTo({ top: 0 });
  }

  // ================================================================ seletor completo de categorias
  function openCatSheet() { $("#catSheet").hidden = false; $("#catSheetBg").hidden = false; $("#buscaCat").value = ""; renderCatList(); }
  function closeCatSheet() { $("#catSheet").hidden = true; $("#catSheetBg").hidden = true; }
  $("#btnOutras").onclick = openCatSheet; $("#btnFecharCat").onclick = closeCatSheet; $("#catSheetBg").onclick = closeCatSheet;
  $("#buscaCat").addEventListener("input", renderCatList);
  function escolherCat(id) { state.form.cat = id; closeCatSheet(); renderCatsPicker(); updateSaveBtn(); }
  function renderCatList() {
    const q = norm($("#buscaCat").value), box = $("#catList"); box.replaceChildren();
    catsAtivas().filter((c) => !q || norm(c.nome).includes(q)).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")).forEach((c) => {
      const b = el("button"); b.type = "button"; b.style.setProperty("--h", c.hue); b.setAttribute("aria-pressed", String(state.form.cat === c.id));
      b.append(el("span", "dot"), el("span", null, c.nome)); b.onclick = () => escolherCat(c.id); box.append(b);
    });
    const txt = $("#buscaCat").value.trim();
    if (txt && !catsAtivas().some((c) => norm(c.nome) === q)) {
      const b = el("button", "create", `+ Criar categoria "${txt}"`); b.type = "button";
      b.onclick = async () => { const c = await novaCategoria(txt); escolherCat(c.id); };
      box.append(b);
    }
    if (!box.children.length) { const e = el("button", null, "Nenhuma categoria"); e.type = "button"; e.disabled = true; box.append(e); }
  }

  // ================================================================ mês
  $$("[data-mshift]").forEach((b) => b.onclick = () => { state.ym = C.shiftYm(state.ym, Number(b.dataset.mshift)); state.filtro = null; render(); });
  const doMes = (ym) => lancsAtivos().filter((d) => d.mes === ym);
  const soma = (arr) => arr.reduce((s, d) => s + (d.valor || 0), 0);

  function chips(boxSel, itens, ativo, onPick, rotuloTodos) {
    const box = $(boxSel); box.replaceChildren();
    if (itens.length < 2) return;
    const all = el("button", "chip", rotuloTodos); all.setAttribute("aria-pressed", String(!ativo)); all.onclick = () => onPick(null); box.append(all);
    itens.forEach((it) => {
      const b = el("button", "chip"); if (it.hue != null) { b.style.setProperty("--h", it.hue); b.append(el("span", "dot")); }
      b.append(el("span", null, it.nome)); b.setAttribute("aria-pressed", String(ativo === it.id));
      b.onclick = () => onPick(ativo === it.id ? null : it.id); box.append(b);
    });
  }

  function renderMes() {
    $$(".mlabel").forEach((h) => h.textContent = ymLabel(state.ym));
    const todas = doMes(state.ym);
    const autores = [...new Set(todas.map((d) => d.autor).filter(Boolean))];
    if (state.filtroAutor && !autores.includes(state.filtroAutor)) state.filtroAutor = null;
    const porAutor = state.filtroAutor ? todas.filter((d) => d.autor === state.filtroAutor) : todas;
    const lista = state.filtro ? porAutor.filter((d) => d.categoria === state.filtro) : porAutor;
    $("#mesTotalLbl").textContent = state.filtro ? `Total em ${catById(state.filtro).nome}` : state.filtroAutor ? `Total de ${state.filtroAutor}` : "Total do mês";
    $("#mesTotal").textContent = fmt(soma(lista));

    chips("#filtroAutor", autores.map((a) => ({ id: a, nome: a })), state.filtroAutor, (v) => { state.filtroAutor = v; renderMes(); }, "Todos");
    chips("#filtros", [...new Set(porAutor.map((d) => d.categoria))].map(catById), state.filtro, (v) => { state.filtro = v; renderMes(); }, "Todas");

    const box = $("#lista"); box.replaceChildren();
    if (!lista.length) {
      const e = emptyBox("Nenhuma despesa neste mês", "Toque em Lançar para registrar a primeira.");
      const b = el("button", "btn primary", "Lançar despesa"); b.style.flex = "none"; b.onclick = () => setTab("lancar"); e.append(b); box.append(e); return;
    }
    listaPorDia(box, lista);
  }

  function cardsGrid(cls, itens) {
    const g = el("div", cls);
    itens.forEach(([rot, v]) => { const card = el("div", "pay"); card.append(el("small", null, rot), el("strong", null, fmt(v))); g.append(card); });
    return g;
  }
  // ================================================================ painel e relatório
  const PERIODOS = [{ id: 1, nome: "Mês" }, { id: 3, nome: "3 meses" }, { id: 6, nome: "6 meses" }, { id: 12, nome: "12 meses" }, { id: "ano", nome: "Ano" }];
  const MES_ABR = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const agrupa = (arr, chave) => arr.reduce((m, d) => { const k = chave(d); m[k] = (m[k] || 0) + d.valor; return m; }, {});
  const compacto = (c) => { const r = c / 100; return r >= 1000 ? (r / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mil" : String(Math.round(r)); };

  function mesesDoPeriodo() {
    if (state.periodo === "ano") { const [y, m] = state.ym.split("-").map(Number); return Array.from({ length: m }, (_, i) => `${y}-${C.pad(i + 1)}`); }
    return Array.from({ length: state.periodo }, (_, i) => C.shiftYm(state.ym, i - state.periodo + 1));
  }

  function segmentado(sel, itens, ativo, onPick) {
    const box = $(sel); box.replaceChildren();
    itens.forEach((it) => { const b = el("button", null, it.nome); b.type = "button"; b.setAttribute("aria-pressed", String(ativo === it.id)); b.onclick = () => onPick(it.id); box.append(b); });
  }

  function kpi(rotulo, valor, sub, cls) {
    const k = el("div", "kpi"); k.append(el("span", "lbl", rotulo), el("strong", cls || null, valor));
    if (sub) k.append(el("small", null, sub));
    return k;
  }

  // Barras verticais por mês (SVG desenhado à mão; funciona offline).
  function grafico(serie, destaque) {
    const ns = "http://www.w3.org/2000/svg", W = 340, H = 180, top = 22, bot = 22, side = 4;
    const max = Math.max(1, ...serie.map((s) => s[1]));
    const n = serie.length, slot = (W - side * 2) / n, bw = Math.min(34, slot * 0.62);
    const y = (v) => top + (H - top - bot) * (1 - v / max);
    const mk = (tag, at, txt) => { const e = document.createElementNS(ns, tag); Object.entries(at).forEach(([k, v]) => e.setAttribute(k, v)); if (txt != null) e.textContent = txt; return e; };
    const svg = mk("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Total por mês" });
    for (let g = 1; g <= 3; g++) svg.append(mk("line", { x1: side, x2: W - side, y1: y((max * g) / 3), y2: y((max * g) / 3), class: "grid" }));
    svg.append(mk("line", { x1: side, x2: W - side, y1: H - bot, y2: H - bot, class: "base" }));
    serie.forEach(([ym, v], i) => {
      const x = side + slot * i + (slot - bw) / 2, hi = ym === destaque;
      const h = Math.max(0, H - bot - y(v));
      svg.append(mk("rect", { x, y: H - bot - h, width: bw, height: h, rx: 4, class: hi ? "bar hi" : "bar" }));
      svg.append(mk("text", { x: x + bw / 2, y: H - 7, "text-anchor": "middle", class: hi ? "ax hi" : "ax" }, MES_ABR[Number(ym.slice(5)) - 1]));
      if (v > 0 && (n <= 6 || hi || v === max)) svg.append(mk("text", { x: x + bw / 2, y: H - bot - h - 6, "text-anchor": "middle", class: "vl" }, compacto(v)));
    });
    if (n > 1) {
      const media = serie.reduce((a, s) => a + s[1], 0) / n;
      if (media > 0) {
        svg.append(mk("line", { x1: side, x2: W - side, y1: y(media), y2: y(media), class: "avg" }));
        svg.append(mk("text", { x: side + 2, y: y(media) - 4, "text-anchor": "start", class: "ax" }, "média " + compacto(media)));
      }
    }
    return svg;
  }

  function barrasCategoria(itens, anterior) {
    const total = soma(itens), porCat = agrupa(itens, (d) => d.categoria);
    const ordem = Object.keys(porCat).sort((a, b) => porCat[b] - porCat[a]);
    const max = porCat[ordem[0]] || 1, bars = el("div", "bars");
    ordem.forEach((id) => {
      const c = catById(id), v = porCat[id];
      const it = el("div", "bar-item"); it.style.setProperty("--h", c.hue);
      const top = el("div", "bar-top"), nm = el("span", "name"); nm.append(el("span", "dot"), el("span", null, c.nome));
      top.append(nm, el("span", "v", fmt(v)));
      const tr = el("div", "track"), fl = el("div", "fill"); fl.style.width = Math.max(2, (v / max) * 100) + "%"; tr.append(fl);
      const sub = el("div", "bar-sub"); sub.append(el("span", null, `${Math.round((v / total) * 100)}% do total`));
      if (anterior) { const p = anterior[id] || 0; sub.append(el("span", "num", p ? `mês anterior ${fmt(p)}` : "sem gasto no mês anterior")); }
      it.append(top, tr, sub); bars.append(it);
    });
    return bars;
  }

  function renderPainel() {
    segmentado("#subSeg", [{ id: "dash", nome: "Painel" }, { id: "rel", nome: "Relatório" }], state.sub, (v) => { state.sub = v; renderPainel(); });
    $("#subDash").hidden = state.sub !== "dash"; $("#subRel").hidden = state.sub !== "rel";
    if (state.sub === "rel") return renderRelatorio();

    segmentado("#perSeg", PERIODOS, state.periodo, (v) => { state.periodo = v; renderPainel(); });
    const meses = mesesDoPeriodo(), set = new Set(meses);
    $("#painelLabel").textContent = meses.length === 1 ? ymLabel(state.ym) : `${ymShort(meses[0])} a ${ymShort(meses[meses.length - 1])}`;
    const todos = lancsAtivos(), itens = todos.filter((d) => set.has(d.mes)), total = soma(itens);

    const kp = $("#kpis"); kp.replaceChildren();
    if (meses.length === 1) {
      const prev = soma(todos.filter((d) => d.mes === C.shiftYm(state.ym, -1)));
      const pct = prev > 0 ? Math.round(((total - prev) / prev) * 100) : null;
      kp.append(kpi("Total do mês", fmt(total), pct == null ? "sem mês anterior para comparar" : `${pct > 0 ? "▲" : pct < 0 ? "▼" : "="} ${Math.abs(pct)}% vs. mês anterior`));
    } else kp.append(kpi("Total do período", fmt(total), `${itens.length} lançamento${itens.length === 1 ? "" : "s"}`));
    kp.append(kpi("Média por mês", fmt(Math.round(total / meses.length)), `${meses.length} ${meses.length > 1 ? "meses" : "mês"}`));
    const porCat = agrupa(itens, (d) => d.categoria), topo = Object.entries(porCat).sort((a, b) => b[1] - a[1])[0];
    kp.append(kpi("Maior categoria", topo ? catById(topo[0]).nome : "—", topo ? `${fmt(topo[1])} · ${Math.round((topo[1] / total) * 100)}%` : "", "txt-kpi"));
    const futuro = soma(todos.filter((d) => d.grupo && d.mes > state.ym));
    kp.append(kpi("Parcelas a vencer", fmt(futuro), `depois de ${ymShort(state.ym)}`));

    const mesesGraf = meses.length === 1 ? Array.from({ length: 6 }, (_, i) => C.shiftYm(state.ym, i - 5)) : meses;
    const g = $("#grafico"); g.replaceChildren(grafico(mesesGraf.map((ym) => [ym, soma(todos.filter((d) => d.mes === ym))]), state.ym));
    $("#graficoTit").textContent = meses.length === 1 ? "Últimos 6 meses" : "Evolução mensal";

    const corpo = $("#painelCorpo"); corpo.replaceChildren();
    if (!itens.length) { corpo.append(emptyBox("Sem lançamentos no período", "Escolha outro período ou lance uma despesa.")); }
    else {
      const anterior = meses.length === 1 ? agrupa(todos.filter((d) => d.mes === C.shiftYm(state.ym, -1)), (d) => d.categoria) : null;
      corpo.append(el("h3", "section-title", "Por categoria"), barrasCategoria(itens, anterior));
      const autores = [...new Set(itens.map((d) => d.autor).filter(Boolean))];
      if (autores.length > 1) corpo.append(el("h3", "section-title", "Por pessoa"), cardsGrid("pay-grid", autores.map((a) => [a, soma(itens.filter((d) => d.autor === a))])));
      corpo.append(el("h3", "section-title", "Por forma de pagamento"), cardsGrid("pay-grid", PAGS.map((p) => [p.nome, soma(itens.filter((d) => d.pagamento === p.id))])));
    }
    const comp = [1, 2, 3].map((k) => C.shiftYm(state.ym, k)).map((ym) => [ymShort(ym), soma(todos.filter((d) => d.grupo && d.mes === ym))]);
    if (comp.some(([, v]) => v > 0)) corpo.append(el("h3", "section-title", "Parcelas nos próximos meses"), cardsGrid("comp-grid", comp));
  }

  // ---------- relatório ----------
  function filtroPadrao() {
    const [y, m] = state.ym.split("-").map(Number);
    return { de: `${state.ym}-01`, ate: `${state.ym}-${C.pad(new Date(y, m, 0).getDate())}`, cat: "", autor: "", pag: "", q: "" };
  }
  function opcoes(sel, itens, valor, rotuloTodos) {
    const s = $(sel); s.replaceChildren();
    const o = el("option", null, rotuloTodos); o.value = ""; s.append(o);
    itens.forEach(([v, t]) => { const op = el("option", null, t); op.value = v; s.append(op); });
    s.value = itens.some(([v]) => v === valor) ? valor : "";
  }
  function filtrados() {
    const f = state.rel, q = norm(f.q || "");
    return lancsAtivos().filter((d) => d.data >= f.de && d.data <= f.ate
      && (!f.cat || d.categoria === f.cat) && (!f.autor || d.autor === f.autor) && (!f.pag || d.pagamento === f.pag)
      && (!q || norm(d.descricao || "").includes(q) || norm(catById(d.categoria).nome).includes(q)));
  }
  function renderRelatorio() {
    if (!state.rel) state.rel = filtroPadrao();
    const f = state.rel;
    $("#relDe").value = f.de; $("#relAte").value = f.ate;
    if (document.activeElement !== $("#relBusca")) $("#relBusca").value = f.q;
    opcoes("#relCat", catsAtivas().map((c) => [c.id, c.nome]), f.cat, "Todas");
    opcoes("#relAutor", [...new Set(lancsAtivos().map((d) => d.autor).filter(Boolean))].sort().map((a) => [a, a]), f.autor, "Todos");
    opcoes("#relPag", PAGS.map((p) => [p.id, p.nome]), f.pag, "Todos");
    const lista = filtrados();
    $("#relTotal").textContent = fmt(soma(lista));
    $("#relQtd").textContent = `${lista.length} lançamento${lista.length === 1 ? "" : "s"}`;
    const cats = $("#relCats"); cats.replaceChildren();
    const box = $("#relLista"); box.replaceChildren();
    $("#btnRelCsv").disabled = !lista.length;
    if (!lista.length) { box.append(emptyBox("Nada encontrado", "Ajuste as datas ou os filtros.")); return; }
    if (!f.cat) cats.append(el("h3", "section-title", "Por categoria"), barrasCategoria(lista));
    box.append(el("h3", "section-title", "Lançamentos"));
    listaPorDia(box, lista);
  }
  const atualizaRel = (campo) => (e) => { state.rel[campo] = e.target.value; renderRelatorio(); };
  $("#relDe").addEventListener("change", (e) => { if (e.target.value) { state.rel.de = e.target.value; if (state.rel.ate < state.rel.de) state.rel.ate = state.rel.de; } renderRelatorio(); });
  $("#relAte").addEventListener("change", (e) => { if (e.target.value) { state.rel.ate = e.target.value; if (state.rel.de > state.rel.ate) state.rel.de = state.rel.ate; } renderRelatorio(); });
  $("#relCat").addEventListener("change", atualizaRel("cat"));
  $("#relAutor").addEventListener("change", atualizaRel("autor"));
  $("#relPag").addEventListener("change", atualizaRel("pag"));
  let buscaTimer; $("#relBusca").addEventListener("input", (e) => { clearTimeout(buscaTimer); buscaTimer = setTimeout(() => { state.rel.q = e.target.value; renderRelatorio(); }, 250); });
  $("#btnRelLimpar").onclick = () => { state.rel = filtroPadrao(); renderRelatorio(); };
  $("#btnRelCsv").onclick = () => baixar(`relatorio-${state.rel.de}-a-${state.rel.ate}.csv`, csvDe(filtrados()), "text/csv");

  function render() {
    if (state.tab === "mes") renderMes(); else if (state.tab === "painel") renderPainel(); else renderCatsPicker();
    renderSync();
  }

  // ================================================================ ajustes
  function openSheet() { $("#sheet").hidden = false; $("#sheetBg").hidden = false; renderCatEdit(); $("#cfgResumo").textContent = cfg ? `Usuário: ${cfg.autor}` : ""; }
  function closeSheet() { $("#sheet").hidden = true; $("#sheetBg").hidden = true; }
  $("#btnAjustes").onclick = openSheet; $("#btnFechar").onclick = closeSheet; $("#sheetBg").onclick = closeSheet;

  function renderCatEdit() {
    const box = $("#catEdit"); box.replaceChildren();
    catsAtivas().forEach((c) => {
      const line = el("div", "cat-line"); line.style.setProperty("--h", c.hue);
      const inp = el("input", "txt"); inp.type = "text"; inp.value = c.nome; inp.maxLength = 24; inp.id = "catnome-" + c.id; inp.setAttribute("aria-label", "Nome da categoria");
      inp.addEventListener("change", () => { const n = inp.value.trim(); if (!n) { inp.value = c.nome; return; } salvarCats([{ ...c, nome: n, alteradoEm: agoraIso(), pendente: true }]); });
      const del = el("button", null, "Remover"); del.type = "button"; let t;
      del.onclick = () => {
        if (catsAtivas().length <= 1) return;
        if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = "Confirmar"; t = setTimeout(() => { del.classList.remove("armed"); del.textContent = "Remover"; }, 3000); return; }
        clearTimeout(t); salvarCats([{ ...c, excluido: true, alteradoEm: agoraIso(), pendente: true }]).then(renderCatEdit);
      };
      line.append(el("span", "dot"), inp, del); box.append(line);
    });
  }
  async function novaCategoria(nome) {
    let id = C.idCategoria("c-" + C.slug(nome)); while (cat.has(id)) id += "-2";
    const ativas = catsAtivas();
    const c = { id, nome, hue: HUES[ativas.length % HUES.length], ordem: (ativas.reduce((m, x) => Math.max(m, x.ordem), 0) + 1), alteradoEm: agoraIso(), excluido: false, pendente: true };
    await salvarCats([c]); if (!$("#sheet").hidden) renderCatEdit();
    return c;
  }
  $("#btnAddCat").onclick = () => { const n = $("#novaCat").value.trim(); if (!n) return; $("#novaCat").value = ""; novaCategoria(n); };

  function baixar(nome, conteudo, tipo) {
    const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
    const a = el("a"); a.href = url; a.download = nome; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function csvDe(lista) {
    const esc = (s) => { s = String(s ?? ""); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const linhas = ["data;categoria;pagamento;descricao;parcela;autor;valor"];
    lista.slice().sort((a, b) => a.data.localeCompare(b.data)).forEach((r) =>
      linhas.push([r.data, catById(r.categoria).nome, pagNome(r.pagamento), r.descricao, ehParcelada(r) ? `${r.parcela}/${r.parcelas}` : "", r.autor, fmtNum(r.valor)].map(esc).join(";")));
    return "\uFEFF" + linhas.join("\r\n");
  }
  $("#btnCsv").onclick = () => baixar(`despesas-${hojeIso()}.csv`, csvDe(lancsAtivos()), "text/csv");
  $("#btnJson").onclick = () => {
    const dados = { exportadoEm: agoraIso(), versao: 3, valorEm: "centavos",
      categorias: catsAtivas().map(({ pendente, ...c }) => c),
      despesas: lancsAtivos().map(({ pendente, ...l }) => l) };
    baixar(`despesas-${hojeIso()}.json`, JSON.stringify(dados, null, 2), "application/json");
  };
  $("#fileImport").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    let json;
    try { json = JSON.parse(await f.text()); } catch { toast("Arquivo inválido. Use o JSON exportado pela Caderneta."); return; }
    if (!json || !Array.isArray(json.despesas)) { toast("Esse JSON não tem lançamentos da Caderneta."); return; }
    const { categorias, lancamentos } = C.importarCaderneta(json, cfg.autor, agoraIso());
    const novasC = categorias.filter((c) => !cat.has(c.id));
    const novosL = lancamentos.filter((l) => !lanc.has(l.id));
    await salvarCats(novasC); await salvarLanc(novosL);
    toast(`Importados ${novosL.length} lançamentos e ${novasC.length} categorias`);
    closeSheet();
  });

  // ================================================================ configuração
  function mostrarSetup(editando) {
    $("#viewApp").hidden = true; $("#viewSetup").hidden = false; closeSheet();
    $("#btnCfgCancelar").hidden = !editando;
    $("#cfgUrl").value = cfg ? cfg.url : ""; $("#cfgChave").value = cfg ? cfg.chave : ""; $("#cfgAutor").value = cfg ? cfg.autor : "";
    $("#cfgErro").hidden = true;
  }
  function mostrarApp() { $("#viewSetup").hidden = true; $("#viewApp").hidden = false; renderForm(); render(); }
  $("#btnReconfig").onclick = () => mostrarSetup(true);
  $("#btnCfgCancelar").onclick = mostrarApp;
  $("#btnCfgSalvar").onclick = async () => {
    const url = $("#cfgUrl").value.trim(), chave = $("#cfgChave").value.trim(), autor = $("#cfgAutor").value.trim();
    const erro = (m) => { $("#cfgErro").textContent = m; $("#cfgErro").hidden = false; };
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) return erro("O endereço deve começar com https://script.google.com/macros/s/ e terminar em /exec.");
    if (chave.length < 16) return erro("Cole a chave completa gerada pelo setup.");
    if (!autor) return erro("Informe quem usa este celular.");
    const btn = $("#btnCfgSalvar"); btn.disabled = true; btn.textContent = "Testando…";
    try {
      // desde no futuro: valida a chave sem baixar dados.
      const res = await chamarScript(url, { chave, desde: 9e15 }, 20000);
      if (!res || !res.ok) return erro(res && res.erro === "chave_invalida" ? "A planilha recusou a chave. Confira se copiou inteira." : "A planilha respondeu com erro. Confira o endereço.");
      const trocouPlanilha = !cfg || cfg.url !== url;
      cfg = { url, chave, autor }; await metaSet("cfg", cfg);
      if (trocouPlanilha) { cursor = 0; await metaDel("cursor"); }
      mostrarApp(); sincronizar();
    } catch { erro("Não consegui falar com a planilha. Confira o endereço e a internet."); }
    finally { btn.disabled = false; btn.textContent = "Testar e salvar"; }
  };

  // ================================================================ início
  async function iniciar() {
    idb = await abrirDb();
    (await lerTudo("lanc")).forEach((r) => lanc.set(r.id, r));
    (await lerTudo("cat")).forEach((r) => cat.set(r.id, r));
    if (!cat.size) {
      const padrao = DEFAULT_CATS.map(([id, nome, hue], i) => ({ id, nome, hue, ordem: i, alteradoEm: DATA_PADRAO, excluido: false, pendente: true }));
      padrao.forEach((c) => cat.set(c.id, c)); await gravar("cat", padrao);
    }
    cfg = (await metaGet("cfg")) || null;
    cursor = (await metaGet("cursor")) || 0;
    if (!cfg) mostrarSetup(false); else { mostrarApp(); sincronizar(); }
  }
  iniciar().catch(() => { document.body.textContent = "Não foi possível abrir o armazenamento do celular. Feche e abra o app de novo."; });

  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
})();
