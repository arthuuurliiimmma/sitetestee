const state = {
  stores: [],
  products: [],
  orders: [],
  selectedStoreId: "",
  selectedProductId: "",
  productSearch: "",
  productSourceFilter: "operational",
  selectedOrderId: "",
  orderSearch: "",
  orderStatusFilter: "all",
  currentView: "dashboard",
  shippingOptions: []
};

const dataList = document.querySelector("#dataList");
const dataStatus = document.querySelector("#dataStatus");
const dataSearch = document.querySelector("#dataSearch");
const refreshData = document.querySelector("#refreshData");
const clearData = document.querySelector("#clearData");
const storeSelect = document.querySelector("#storeSelect");
const productSelect = document.querySelector("#productSelect");
const storeForm = document.querySelector("#storeForm");
const productForm = document.querySelector("#productForm");
const ordersList = document.querySelector("#ordersList");
const checkoutLink = document.querySelector("#checkoutLink");
const adminStatus = document.querySelector("#adminStatus");
const syncShopifyButton = document.querySelector("#syncShopify");
const csvInput = document.querySelector("#csvInput");
const syncStatus = document.querySelector("#syncStatus");
const productCheckoutLink = document.querySelector("#productCheckoutLink");
const copyProductLink = document.querySelector("#copyProductLink");
const testShopifyToken = document.querySelector("#testShopifyToken");
const productSearch = document.querySelector("#productSearch");
const productSourceFilter = document.querySelector("#productSourceFilter");
const productList = document.querySelector("#productList");
const orderSearch = document.querySelector("#orderSearch");
const orderStatusFilter = document.querySelector("#orderStatusFilter");
const orderDetail = document.querySelector("#orderDetail");
const ordersStatus = document.querySelector("#ordersStatus");
const clearOrdersButton = document.querySelector("#clearOrders");
const testGateway = document.querySelector("#testGateway");
const installTheme = document.querySelector("#installTheme");
const shippingOptionsList = document.querySelector("#shippingOptionsList");
const addShippingOption = document.querySelector("#addShippingOption");
const saveShippingOptions = document.querySelector("#saveShippingOptions");
const adminLogin = document.querySelector("#adminLogin");
const adminShell = document.querySelector("#adminShell");
const loginForm = document.querySelector("#loginForm");
const loginError = document.querySelector("#loginError");
const logoutButton = document.querySelector("#logoutButton");
const adminPageTitle = document.querySelector("#adminPageTitle");
const adminPageSubtitle = document.querySelector("#adminPageSubtitle");
const adminViews = [...document.querySelectorAll("[data-admin-view]")];
const adminNavLinks = [...document.querySelectorAll("[data-admin-nav]")];

const viewCopy = {
  dashboard: {
    title: "Dashboard",
    subtitle: "Acompanhe vendas, pendências e operação do checkout."
  },
  store: {
    title: "Loja",
    subtitle: "Configure domínio, Shopify, gateway, webhooks e publicação."
  },
  shipping: {
    title: "Frete",
    subtitle: "Crie métodos personalizados com nome, valor e prazo."
  },
  product: {
    title: "Produtos",
    subtitle: "Sincronize a Shopify, revise produtos e copie links do checkout."
  },
  orders: {
    title: "Pedidos",
    subtitle: "Acompanhe pagamentos, entrega, gateway e criação na Shopify."
  },
  data: {
    title: "Dados",
    subtitle: ""
  }
};

function friendlyShopifyError(message, area = "Shopify") {
  const text = String(message || "Erro Shopify.");
  if (/shop is under review|access denied for .* field/i.test(text)) {
    if (area === "tema") {
      return "A Shopify bloqueou a API de temas porque a loja esta em analise. Suba o zip do tema manualmente em Loja virtual > Temas > Adicionar tema > Fazer upload.";
    }
    if (area === "produtos") {
      return "A Shopify bloqueou a API de produtos porque a loja esta em analise. Use Importar CSV nesta aba ate a revisao terminar.";
    }
    return "A Shopify bloqueou essa API porque a loja esta em analise. Use CSV/manual por enquanto.";
  }
  return text;
}

function setActiveView(view, pushHash = true) {
  const nextView = viewCopy[view] ? view : "dashboard";
  state.currentView = nextView;
  adminViews.forEach((section) => {
    section.classList.toggle("is-active", section.dataset.adminView === nextView);
  });
  adminNavLinks.forEach((link) => {
    link.classList.toggle("is-active", link.dataset.adminNav === nextView);
  });
  if (adminPageTitle) adminPageTitle.textContent = viewCopy[nextView].title;
  if (adminPageSubtitle) adminPageSubtitle.textContent = viewCopy[nextView].subtitle;
  if (pushHash && window.location.hash !== `#${nextView}`) {
    history.replaceState(null, "", `#${nextView}`);
  }
}

function apiUrl(path) {
  const cleanPath = String(path).replace(/^\//, "");
  return new URL(cleanPath, window.location.href).toString();
}

async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = {};
  }
  if (response.status === 401) {
    showLogin(data.error || "Login obrigatório.");
    throw new Error(data.error || "Login obrigatório.");
  }
  if (!response.ok) throw new Error(data.error || text || "Erro na API.");
  return data;
}

function showLogin(message = "") {
  adminLogin?.classList.remove("is-hidden");
  adminShell?.classList.add("is-locked");
  if (loginError) loginError.textContent = message;
}

function showPanel() {
  adminLogin?.classList.add("is-hidden");
  adminShell?.classList.remove("is-locked");
  if (loginError) loginError.textContent = "";
}

async function checkSession() {
  const response = await fetch(apiUrl("/api/admin/session"), {
    credentials: "same-origin",
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({}));
  if (data.authenticated) {
    showPanel();
    return true;
  }
  showLogin("");
  return false;
}

function setStatus(message, mode = "loading") {
  if (!adminStatus) return;
  adminStatus.textContent = message;
  adminStatus.classList.toggle("is-error", mode === "error");
  adminStatus.classList.toggle("is-hidden", mode === "hidden");
}

function setSyncStatus(message) {
  if (syncStatus) syncStatus.textContent = message || "";
}

function formatScopes(scopes = []) {
  if (!scopes.length) return "";
  return `Scopes: ${scopes.join(", ")}`;
}

function money(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function sourceLabel(product) {
  if (product.source === "shopify") return "Shopify";
  if (product.source === "csv") return "CSV backup";
  return "Manual";
}

function productPriority(product) {
  if (product.source === "shopify") return 0;
  if (product.variantId) return 1;
  if (product.source === "csv") return 3;
  return 2;
}

function storeProducts() {
  return state.products.filter((product) => product.storeId === state.selectedStoreId && product.active !== false);
}

function operationalProducts() {
  const bySlug = new Map();
  [...storeProducts()].sort((a, b) => productPriority(a) - productPriority(b)).forEach((product) => {
    const key = product.slug || product.id;
    if (!bySlug.has(key)) bySlug.set(key, product);
  });
  return [...bySlug.values()].sort((a, b) => normalizeText(a.name).localeCompare(normalizeText(b.name)));
}

function productsByCurrentFilter() {
  const source = state.productSourceFilter;
  let products = source === "operational" ? operationalProducts() : storeProducts();
  if (source === "shopify") products = products.filter((product) => product.source === "shopify");
  if (source === "csv") products = products.filter((product) => product.source === "csv");
  products = products.sort((a, b) => normalizeText(a.name).localeCompare(normalizeText(b.name)));

  const query = normalizeText(state.productSearch).trim();
  if (!query) return products;
  return products.filter((product) => {
    return [
      product.name,
      product.slug,
      product.sku,
      product.variantId,
      product.shopifyProductId
    ].some((value) => normalizeText(value).includes(query));
  });
}

function statusLabel(status) {
  return {
    pending: "Pendente",
    paid: "Pago",
    cancelled: "Cancelado"
  }[status] || "Pendente";
}

function paymentLabel(method) {
  return {
    pix: "Pix",
    card: "Cartao"
  }[method] || method || "Nao informado";
}

function gatewayLabel(provider) {
  return {
    blackcat: "BlackCat",
    paradise: "ParadisePag",
    manual: "Manual"
  }[provider] || provider || "Nao informado";
}

function defaultShippingOptions() {
  return [
    { name: "Sedex", days: "Em até 17 dias úteis", price: 47.31 },
    { name: "Total Express", days: "Em até 19 dias úteis", price: 12.14 },
    { name: "J&T", days: "Em até 20 dias úteis", price: 12.21 },
    { name: "PAC", days: "Em até 21 dias úteis", price: 25.73 }
  ];
}

function normalizedShippingOptions(options) {
  const source = Array.isArray(options) && options.length ? options : defaultShippingOptions();
  const normalized = source.map((option) => ({
    name: String(option.name || "").trim(),
    days: String(option.days || "").trim(),
    price: Number(option.price || 0)
  })).filter((option) => option.name && option.days && option.price >= 0);
  return normalized.length ? normalized : defaultShippingOptions();
}

function renderShippingOptions() {
  if (!shippingOptionsList) return;
  shippingOptionsList.innerHTML = normalizedShippingOptions(state.shippingOptions).map((option, index) => `
    <article class="admin-shipping-row" data-shipping-row="${index}">
      <label>
        Nome
        <input data-shipping-field="name" value="${escapeHtml(option.name)}" placeholder="Total Express" />
      </label>
      <label>
        Prazo
        <input data-shipping-field="days" value="${escapeHtml(option.days)}" placeholder="Em até 19 dias úteis" />
      </label>
      <label>
        Valor
        <input data-shipping-field="price" value="${Number(option.price || 0).toFixed(2)}" inputmode="decimal" placeholder="12,14" />
      </label>
      <button class="admin-refresh" data-shipping-remove="${index}" type="button">Remover</button>
    </article>
  `).join("");
}

function collectShippingOptions() {
  const rows = [...shippingOptionsList.querySelectorAll("[data-shipping-row]")];
  return rows.map((row) => {
    const name = row.querySelector('[data-shipping-field="name"]')?.value || "";
    const days = row.querySelector('[data-shipping-field="days"]')?.value || "";
    const price = row.querySelector('[data-shipping-field="price"]')?.value || "";
    return {
      name: name.trim(),
      days: days.trim(),
      price: Number(String(price).replace(",", ".")) || 0
    };
  }).filter((option) => option.name && option.days);
}

function customerName(order) {
  return [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(" ") || "Cliente";
}

function orderProductName(order) {
  if (Array.isArray(order.items) && order.items.length) {
    const first = order.items[0]?.name || order.items[0]?.title || "Produto";
    return order.items.length > 1 ? `${first} + ${order.items.length - 1} itens` : first;
  }
  return order.catalogProduct?.name || "Produto";
}

function addressLine(address = {}) {
  const firstLine = [address.address, address.number].filter(Boolean).join(", ");
  const secondLine = [address.district, address.city, address.state].filter(Boolean).join(" - ");
  return [firstLine, address.complement, secondLine, address.cep].filter(Boolean).join(" | ");
}

function storeOrders() {
  return state.orders.filter((order) => !state.selectedStoreId || order.storeId === state.selectedStoreId);
}

function filteredOrders() {
  let orders = storeOrders();
  if (state.orderStatusFilter !== "all") {
    orders = orders.filter((order) => (order.status || "pending") === state.orderStatusFilter);
  }
  const query = normalizeText(state.orderSearch).trim();
  if (query) {
    orders = orders.filter((order) => {
      return [
        order.id,
        customerName(order),
        order.customer?.email,
        order.customer?.cpf,
        order.customer?.phone,
        orderProductName(order),
        order.shipping?.cep,
        order.shipping?.city,
        order.paymentMethod
      ].some((value) => normalizeText(value).includes(query));
    });
  }
  return orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function customerCopyText(order) {
  return [
    `Pedido: ${order.id}`,
    `Cliente: ${customerName(order)}`,
    `E-mail: ${order.customer?.email || ""}`,
    `CPF: ${order.customer?.cpf || ""}`,
    `Telefone: ${order.customer?.phone || ""}`,
    `Produto: ${orderProductName(order)}`,
    `Total: ${money(order.totals?.total)}`,
    `Pagamento: ${paymentLabel(order.paymentMethod)}`,
    `Endereco: ${addressLine(order.shipping)}`
  ].join("\n");
}

function buildCheckoutUrl(product = selectedProduct()) {
  const store = selectedStore();
  const url = new URL("index.html", window.location.href);
  if (store?.slug) url.searchParams.set("store", store.slug);
  if (product?.slug) url.searchParams.set("product", product.slug);
  return url.toString();
}

function updateCheckoutLinks() {
  const url = buildCheckoutUrl();
  checkoutLink.href = url;
  checkoutLink.textContent = "Abrir checkout";
  if (productCheckoutLink) productCheckoutLink.value = url;
}

async function loadAll() {
  const [summary, stores, products, orders] = await Promise.all([
    api("/api/summary"),
    api("/api/stores"),
    api("/api/products"),
    api("/api/orders")
  ]);

  state.stores = stores;
  state.products = products;
  state.orders = orders;
  state.selectedStoreId = state.selectedStoreId || stores[0]?.id || "";
  state.selectedProductId = state.selectedProductId || operationalProducts()[0]?.id || products.find((product) => product.storeId === state.selectedStoreId)?.id || products[0]?.id || "";

  renderSummary(summary);
  renderStores();
  renderProducts();
  renderOrders();
  setStatus("", "hidden");
}

function renderSummary(summary) {
  const shopifyCount = storeProducts().filter((product) => product.source === "shopify").length;
  const visibleCount = operationalProducts().length || summary.products;
  document.querySelector("#paidTotal").textContent = money(summary.paidTotal);
  document.querySelector("#pendingTotal").textContent = money(summary.pendingTotal);
  document.querySelector("#storeCount").textContent = summary.stores;
  document.querySelector("#paidOrders").textContent = `${summary.paidOrders} pedidos`;
  document.querySelector("#pendingOrders").textContent = `${summary.pendingOrders} pedidos`;
  document.querySelector("#productCount").textContent = shopifyCount ? `${shopifyCount} Shopify` : `${visibleCount} produtos`;
  document.querySelector("#todayTotal").textContent = money(summary.todayTotal);
  document.querySelector("#todayOrders").textContent = `${summary.todayOrders} pedidos hoje`;
  document.querySelector("#orderCount").textContent = summary.orders;
  document.querySelector("#averagePaidTicket").textContent = `Ticket ${money(summary.averagePaidTicket)}`;
}

function renderStores() {
  storeSelect.innerHTML = state.stores.map((store) => `<option value="${store.id}">${store.name}</option>`).join("");
  storeSelect.value = state.selectedStoreId;
  const store = selectedStore();
  if (!store) return;

  fillForm(storeForm, store);
  storeForm.elements.shopifyAccessToken.value = "";
  storeForm.elements.shopifyAccessToken.placeholder = store.hasShopifyToken ? "Token salvo" : "Opcional / legado";
  storeForm.elements.shopifyClientSecret.value = "";
  storeForm.elements.shopifyClientSecret.placeholder = store.hasShopifyClientSecret ? "Client secret salvo" : "shpss_...";
  storeForm.elements.blackcatApiKey.value = "";
  storeForm.elements.blackcatApiKey.placeholder = store.hasBlackcatApiKey ? "Chave BlackCat salva" : "X-API-Key BlackCat";
  storeForm.elements.paradiseApiKey.value = "";
  storeForm.elements.paradiseApiKey.placeholder = store.hasParadiseApiKey ? "Chave ParadisePag salva" : "sk_...";
  state.shippingOptions = normalizedShippingOptions(store.shippingOptions);
  renderShippingOptions();
  document.querySelector("#dnsTarget").textContent = store.dnsTarget || "checkout.wpcheckout.com";
  document.querySelector("#blackcatWebhookUrl").textContent = new URL("api/webhooks/blackcat", window.location.href).toString();
  document.querySelector("#paradiseWebhookUrl").textContent = new URL("api/webhooks/paradise", window.location.href).toString();
  const theme = store.themeIntegration;
  const themeStatus = document.querySelector("#themeInstallStatus");
  if (themeStatus) {
    if (theme?.status === "installed") {
      themeStatus.textContent = `Instalado em ${theme.themeName || "tema principal"} usando ${theme.checkoutBaseUrl || "checkout"}.`;
    } else if (theme?.status === "error") {
      themeStatus.textContent = `Erro: ${theme.message || "Shopify recusou a instalação."}`;
    } else {
      themeStatus.textContent = "Ainda não instalado.";
    }
  }
  const syncText = store.lastShopifySyncAt ? `Ultima sincronizacao: ${new Date(store.lastShopifySyncAt).toLocaleString("pt-BR")}` : "";
  setSyncStatus([syncText, formatScopes(store.shopifyScopes)].filter(Boolean).join(" | "));
  updateCheckoutLinks();
}

function renderProducts() {
  const products = operationalProducts();
  productSelect.innerHTML = products.map((product) => `<option value="${product.id}">${product.name}</option>`).join("");
  if (!products.some((product) => product.id === state.selectedProductId)) {
    state.selectedProductId = products[0]?.id || "";
  }
  productSelect.value = state.selectedProductId;

  const product = selectedProduct() || {
    storeId: state.selectedStoreId,
    name: "CABELOS E UNHAS – WP",
    slug: "cabelos-e-unhas",
    price: 39.9,
    compareAt: 149.9,
    image: "./assets/product.png",
    variantId: ""
  };
  fillForm(productForm, product);
  updateCheckoutLinks();
  renderProductList();
}

function renderProductList() {
  const products = productsByCurrentFilter();
  if (!products.length) {
    productList.innerHTML = '<div class="admin-empty">Nenhum produto encontrado.</div>';
    return;
  }

  productList.innerHTML = products.map((product) => {
    const checkoutUrl = buildCheckoutUrl(product);
    const meta = [
      product.sku ? `SKU ${product.sku}` : "",
      product.variantId ? `Variant ${product.variantId}` : "Sem Variant ID"
    ].filter(Boolean).join(" | ");
    return `
      <article class="admin-product-row ${product.id === state.selectedProductId ? "is-active" : ""}" data-product-row="${escapeHtml(product.id)}">
        <img src="${escapeHtml(product.image || "./assets/product.png")}" alt="${escapeHtml(product.name)}" />
        <div>
          <strong title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</strong>
          <span title="${escapeHtml(meta)}">${escapeHtml(meta)}</span>
          <small class="admin-source-pill">${escapeHtml(sourceLabel(product))}</small>
        </div>
        <div class="admin-product-price">
          <strong>${money(product.price)}</strong>
          <small>${product.compareAt ? `De ${money(product.compareAt)}` : "Sem preco antigo"}</small>
        </div>
        <div class="admin-product-actions">
          <a class="admin-refresh" href="${escapeHtml(checkoutUrl)}" target="_blank" rel="noreferrer">Abrir</a>
          <button class="admin-refresh" data-copy-product="${escapeHtml(product.id)}" type="button">Copiar</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderOrders() {
  const orders = filteredOrders();
  const allStoreOrders = storeOrders();
  const pendingCount = allStoreOrders.filter((order) => (order.status || "pending") === "pending").length;
  const paidCount = allStoreOrders.filter((order) => order.status === "paid").length;
  const cancelledCount = allStoreOrders.filter((order) => order.status === "cancelled").length;
  ordersStatus.textContent = `${allStoreOrders.length} pedidos | ${pendingCount} pendentes | ${paidCount} pagos | ${cancelledCount} cancelados`;

  if (!orders.some((order) => order.id === state.selectedOrderId)) {
    state.selectedOrderId = orders[0]?.id || "";
  }

  if (!orders.length) {
    ordersList.innerHTML = '<div class="admin-empty">Nenhum pedido ainda.</div>';
    renderOrderDetail();
    return;
  }

  ordersList.innerHTML = orders.map((order) => {
    const status = order.status || "pending";
    const product = orderProductName(order);
    const shipping = addressLine(order.shipping);
    return `
      <article class="admin-order ${order.id === state.selectedOrderId ? "is-active" : ""}" data-order-row="${escapeHtml(order.id)}">
        <div>
          <strong>${escapeHtml(customerName(order))}</strong>
          <span>${escapeHtml(order.customer?.email || "")}</span>
          <small>${escapeHtml(order.customer?.phone || "")} ${order.customer?.cpf ? `| ${escapeHtml(order.customer.cpf)}` : ""}</small>
        </div>
        <div>
          <strong title="${escapeHtml(product)}">${escapeHtml(product)}</strong>
          <span>${escapeHtml(paymentLabel(order.paymentMethod))} ${order.coupon ? `| Cupom ${escapeHtml(order.coupon)}` : ""}</span>
          <small title="${escapeHtml(shipping)}">${escapeHtml(shipping || "Endereco nao informado")}</small>
        </div>
        <div class="admin-order__money">
          <strong>${money(order.totals?.total)}</strong>
          <span class="admin-status-pill is-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>
          <small>${new Date(order.createdAt).toLocaleString("pt-BR")}</small>
        </div>
        <div class="admin-order__actions">
          <select data-order-status="${escapeHtml(order.id)}">
            <option value="pending" ${status === "pending" ? "selected" : ""}>Pendente</option>
            <option value="paid" ${status === "paid" ? "selected" : ""}>Pago</option>
            <option value="cancelled" ${status === "cancelled" ? "selected" : ""}>Cancelado</option>
          </select>
          <button class="admin-refresh" data-order-open="${escapeHtml(order.id)}" type="button">Detalhes</button>
        </div>
      </article>
    `;
  }).join("");
  renderOrderDetail();
}

function renderOrderDetail() {
  const order = state.orders.find((item) => item.id === state.selectedOrderId);
  if (!order) {
    orderDetail.classList.add("is-hidden");
    orderDetail.innerHTML = "";
    return;
  }

  const status = order.status || "pending";
  const product = order.catalogProduct || {};
  orderDetail.classList.remove("is-hidden");
  orderDetail.innerHTML = `
    <div class="admin-order-detail__head">
      <div>
        <h3>${escapeHtml(customerName(order))}</h3>
        <p>${escapeHtml(order.id)} | ${new Date(order.createdAt).toLocaleString("pt-BR")}</p>
      </div>
      <div class="admin-detail-actions">
        <button class="admin-refresh" data-copy-order="${escapeHtml(order.id)}" type="button">Copiar cliente</button>
        <button class="admin-refresh" data-set-order-status="paid" type="button">Marcar pago</button>
        <button class="admin-refresh" data-set-order-status="cancelled" type="button">Cancelar</button>
        <button class="admin-refresh" data-shopify-sync="${escapeHtml(order.id)}" type="button">Enviar Shopify</button>
      </div>
    </div>
    <div class="admin-detail-grid">
      <div class="admin-detail-box">
        <strong>Cliente</strong>
        <span>${escapeHtml(order.customer?.email || "E-mail nao informado")}</span>
        <span>${escapeHtml(order.customer?.cpf || "CPF nao informado")}</span>
        <span>${escapeHtml(order.customer?.phone || "Telefone nao informado")}</span>
        <span>${escapeHtml(order.customer?.instagram || "Instagram nao informado")}</span>
      </div>
      <div class="admin-detail-box">
        <strong>Pedido</strong>
        <span>Status: ${escapeHtml(statusLabel(status))}</span>
        <span>Pagamento: ${escapeHtml(paymentLabel(order.paymentMethod))}${order.cardBrand ? ` / ${escapeHtml(order.cardBrand)}` : ""}</span>
        <span>Cupom: ${escapeHtml(order.coupon || "Sem cupom")}</span>
        <span>Total: ${money(order.totals?.total)}</span>
      </div>
      <div class="admin-detail-box">
        <strong>Gateway</strong>
        <span>${escapeHtml(gatewayLabel(order.gateway?.provider))}</span>
        <span>Status: ${escapeHtml(order.gateway?.status || "Nao informado")}</span>
        <span>Transacao: ${escapeHtml(order.gateway?.transactionId || "Nao informado")}</span>
        <span>${order.gateway?.invoiceUrl ? `<a href="${escapeHtml(order.gateway.invoiceUrl)}" target="_blank" rel="noreferrer">Abrir fatura</a>` : "Sem link de fatura"}</span>
      </div>
      <div class="admin-detail-box">
        <strong>Produto</strong>
        <span>${escapeHtml(orderProductName(order))}</span>
        <span>Gateway: ${escapeHtml(order.product?.name || "produtos digitais")}</span>
        <span>SKU: ${escapeHtml(product.sku || "Nao informado")}</span>
        <span>Variant ID: ${escapeHtml(product.variantId || order.product?.variantId || "Nao informado")}</span>
      </div>
      <div class="admin-detail-box">
        <strong>Entrega</strong>
        <span>${escapeHtml(addressLine(order.shipping) || "Endereco nao informado")}</span>
        <span>Recebedor: ${escapeHtml(order.shipping?.recipient || customerName(order))}</span>
        <span>Frete: ${escapeHtml(order.shipping?.option?.name || order.shipping?.selected || "Nao informado")} - ${money(order.totals?.shipping)}</span>
      </div>
      <div class="admin-detail-box">
        <strong>Valores</strong>
        <span>Subtotal: ${money(order.totals?.subtotal)}</span>
        <span>Desconto: ${money(order.totals?.discount)}</span>
        <span>Frete: ${money(order.totals?.shipping)}</span>
        <span>Total: ${money(order.totals?.total)}</span>
      </div>
      <div class="admin-detail-box">
        <strong>Shopify</strong>
        <span>${order.shopifyOrder?.adminUrl ? `<a href="${escapeHtml(order.shopifyOrder.adminUrl)}" target="_blank" rel="noreferrer">${escapeHtml(order.shopifyOrder.name || "Abrir pedido Shopify")}</a>` : "Pedido ainda nao criado na Shopify"}</span>
        <span>${order.shopifySync?.status ? `Sync: ${escapeHtml(order.shopifySync.status)}` : "Sync: aguardando pagamento"}</span>
        <span>${order.shopifySync?.message ? escapeHtml(order.shopifySync.message) : ""}</span>
        <span>${order.shopifyPermalink ? `<a href="${escapeHtml(order.shopifyPermalink)}" target="_blank" rel="noreferrer">Abrir permalink Shopify</a>` : "Sem permalink Shopify"}</span>
      </div>
    </div>
  `;
}

function selectedStore() {
  return state.stores.find((store) => store.id === state.selectedStoreId);
}

function selectedProduct() {
  return state.products.find((product) => product.id === state.selectedProductId);
}

function fillForm(form, data) {
  [...form.elements].forEach((field) => {
    if (!field.name || !(field.name in data)) return;
    field.value = data[field.name] ?? "";
  });
}

function formObject(form) {
  const object = Object.fromEntries(new FormData(form).entries());
  if ("price" in object) object.price = Number(String(object.price).replace(",", "."));
  if ("compareAt" in object) object.compareAt = Number(String(object.compareAt).replace(",", "."));
  if (form === storeForm && shippingOptionsList) object.shippingOptions = collectShippingOptions();
  return object;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

async function updateOrderStatus(orderId, status) {
  if (!orderId || !status) return;
  await api(`/api/orders/${orderId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
  state.selectedOrderId = orderId;
  await loadAll();
}

storeSelect.addEventListener("change", () => {
  state.selectedStoreId = storeSelect.value;
  state.selectedProductId = "";
  state.selectedOrderId = "";
  renderStores();
  renderProducts();
  renderOrders();
});

adminNavLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    setActiveView(link.dataset.adminNav);
  });
});

window.addEventListener("hashchange", () => {
  setActiveView(window.location.hash.replace("#", ""), false);
});

productSelect.addEventListener("change", () => {
  state.selectedProductId = productSelect.value;
  renderProducts();
});

productSearch.addEventListener("input", () => {
  state.productSearch = productSearch.value;
  renderProductList();
});

productSourceFilter.addEventListener("change", () => {
  state.productSourceFilter = productSourceFilter.value;
  renderProductList();
});

orderSearch.addEventListener("input", () => {
  state.orderSearch = orderSearch.value;
  renderOrders();
});

orderStatusFilter.addEventListener("change", () => {
  state.orderStatusFilter = orderStatusFilter.value;
  state.selectedOrderId = "";
  renderOrders();
});

storeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const store = await api("/api/stores", {
    method: "POST",
    body: JSON.stringify(formObject(storeForm))
  });
  state.selectedStoreId = store.id;
  await loadAll();
});

testShopifyToken.addEventListener("click", async () => {
  testShopifyToken.disabled = true;
  testShopifyToken.textContent = "Testando...";
  setSyncStatus("Salvando loja e testando token...");
  try {
    const store = await api("/api/stores", {
      method: "POST",
      body: JSON.stringify(formObject(storeForm))
    });
    state.selectedStoreId = store.id;
    const result = await api("/api/shopify/scopes/check", {
      method: "POST",
      body: JSON.stringify({ storeId: store.id })
    });
    await loadAll();
    setSyncStatus(`Token valido. ${formatScopes(result.scopes)}`);
  } catch (error) {
    setSyncStatus(`Erro no token: ${error.message}`);
  } finally {
    testShopifyToken.disabled = false;
    testShopifyToken.textContent = "Testar token";
  }
});

testGateway.addEventListener("click", async () => {
  testGateway.disabled = true;
  testGateway.textContent = "Testando...";
  setSyncStatus("Salvando loja e testando gateway...");
  try {
    const store = await api("/api/stores", {
      method: "POST",
      body: JSON.stringify(formObject(storeForm))
    });
    state.selectedStoreId = store.id;
    const result = await api("/api/gateway/check", {
      method: "POST",
      body: JSON.stringify({ storeId: store.id })
    });
    await loadAll();
    const gatewayLabel = result.activeGateway === "blackcat" ? "BlackCat" : result.activeGateway === "paradise" ? "ParadisePag" : "Manual";
    const seller = result.seller?.name ? ` | ${result.seller.name}` : "";
    setSyncStatus(result.configured ? `Gateway ${gatewayLabel} configurada.${seller}` : `Gateway ${gatewayLabel} sem chave salva.`);
  } catch (error) {
    setSyncStatus(`Erro na gateway: ${error.message}`);
  } finally {
    testGateway.disabled = false;
    testGateway.textContent = "Testar gateway";
  }
});

installTheme.addEventListener("click", async () => {
  installTheme.disabled = true;
  installTheme.textContent = "Instalando...";
  setSyncStatus("Salvando loja e instalando script no tema Shopify...");
  try {
    const store = await api("/api/stores", {
      method: "POST",
      body: JSON.stringify(formObject(storeForm))
    });
    state.selectedStoreId = store.id;
    const checkoutBaseUrl = store.checkoutDomain ? `https://${store.checkoutDomain}` : window.location.origin;
    const result = await api("/api/shopify/theme/install", {
      method: "POST",
      body: JSON.stringify({ storeId: store.id, checkoutBaseUrl })
    });
    await loadAll();
    setSyncStatus(`Tema instalado: ${result.themeName || "tema principal"} | ${result.checkoutBaseUrl || checkoutBaseUrl}`);
  } catch (error) {
    await loadAll().catch(() => {});
    setSyncStatus(`Erro no tema: ${friendlyShopifyError(error.message, "tema")}`);
  } finally {
    installTheme.disabled = false;
    installTheme.textContent = "Instalar tema";
  }
});

addShippingOption.addEventListener("click", () => {
  state.shippingOptions = collectShippingOptions();
  state.shippingOptions.push({ name: "Frete personalizado", days: "Em até 10 dias úteis", price: 0 });
  renderShippingOptions();
});

shippingOptionsList.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-shipping-remove]");
  if (!removeButton) return;
  state.shippingOptions = collectShippingOptions().filter((_, index) => index !== Number(removeButton.dataset.shippingRemove));
  if (!state.shippingOptions.length) state.shippingOptions = [{ name: "Frete personalizado", days: "Em até 10 dias úteis", price: 0 }];
  renderShippingOptions();
});

saveShippingOptions.addEventListener("click", async () => {
  saveShippingOptions.disabled = true;
  saveShippingOptions.textContent = "Salvando...";
  setSyncStatus("Salvando opções de frete...");
  try {
    const payload = formObject(storeForm);
    payload.shippingOptions = collectShippingOptions();
    const store = await api("/api/stores", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.selectedStoreId = store.id;
    await loadAll();
    setSyncStatus("Fretes salvos.");
  } catch (error) {
    setSyncStatus(`Erro ao salvar frete: ${error.message}`);
  } finally {
    saveShippingOptions.disabled = false;
    saveShippingOptions.textContent = "Salvar fretes";
  }
});

productForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = formObject(productForm);
  payload.storeId = state.selectedStoreId;
  const product = await api("/api/products", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  state.selectedProductId = product.id;
  await loadAll();
});

copyProductLink.addEventListener("click", async () => {
  const value = productCheckoutLink.value;
  if (!value) return;
  await copyText(value);
  copyProductLink.textContent = "Copiado";
  setTimeout(() => {
    copyProductLink.textContent = "Copiar";
  }, 1200);
});

productList.addEventListener("click", async (event) => {
  const copyButton = event.target.closest("[data-copy-product]");
  if (copyButton) {
    const product = state.products.find((item) => item.id === copyButton.dataset.copyProduct);
    if (!product) return;
    await copyText(buildCheckoutUrl(product));
    copyButton.textContent = "Copiado";
    setTimeout(() => {
      copyButton.textContent = "Copiar";
    }, 1200);
    return;
  }

  const row = event.target.closest("[data-product-row]");
  if (!row || event.target.closest("a")) return;
  state.selectedProductId = row.dataset.productRow;
  renderProducts();
});

ordersList.addEventListener("click", async (event) => {
  const statusSelect = event.target.closest("[data-order-status]");
  if (statusSelect) return;

  const openButton = event.target.closest("[data-order-open]");
  const row = event.target.closest("[data-order-row]");
  const orderId = openButton?.dataset.orderOpen || row?.dataset.orderRow || "";
  if (!orderId) return;
  state.selectedOrderId = orderId;
  renderOrders();
});

ordersList.addEventListener("change", async (event) => {
  const select = event.target.closest("[data-order-status]");
  if (!select) return;
  await updateOrderStatus(select.dataset.orderStatus, select.value);
});

orderDetail.addEventListener("click", async (event) => {
  const copyButton = event.target.closest("[data-copy-order]");
  if (copyButton) {
    const order = state.orders.find((item) => item.id === copyButton.dataset.copyOrder);
    if (!order) return;
    await copyText(customerCopyText(order));
    copyButton.textContent = "Copiado";
    setTimeout(() => {
      copyButton.textContent = "Copiar cliente";
    }, 1200);
    return;
  }

  const statusButton = event.target.closest("[data-set-order-status]");
  if (statusButton && state.selectedOrderId) {
    await updateOrderStatus(state.selectedOrderId, statusButton.dataset.setOrderStatus);
    return;
  }

  const shopifyButton = event.target.closest("[data-shopify-sync]");
  if (!shopifyButton) return;
  shopifyButton.disabled = true;
  shopifyButton.textContent = "Enviando...";
  try {
    await api(`/api/orders/${shopifyButton.dataset.shopifySync}/shopify-sync`, { method: "POST" });
    await loadAll();
  } catch (error) {
    ordersStatus.textContent = `Erro Shopify: ${error.message}`;
  }
});

syncShopifyButton.addEventListener("click", async () => {
  if (!state.selectedStoreId) return;
  syncShopifyButton.disabled = true;
  syncShopifyButton.textContent = "Sincronizando...";
  setSyncStatus("Buscando produtos na Shopify...");
  try {
    const result = await api("/api/shopify/products/sync", {
      method: "POST",
      body: JSON.stringify({ storeId: state.selectedStoreId })
    });
    state.selectedProductId = result.products?.[0]?.id || state.selectedProductId;
    await loadAll();
    setSyncStatus(`${result.imported} produtos/variantes sincronizados.`);
  } catch (error) {
    setSyncStatus(`Erro: ${friendlyShopifyError(error.message, "produtos")}`);
  } finally {
    syncShopifyButton.disabled = false;
    syncShopifyButton.textContent = "Sincronizar Shopify";
  }
});

csvInput.addEventListener("change", async () => {
  const file = csvInput.files?.[0];
  if (!file || !state.selectedStoreId) return;
  setSyncStatus("Importando CSV...");
  try {
    const csv = await file.text();
    const result = await api("/api/products/import-csv", {
      method: "POST",
      body: JSON.stringify({ storeId: state.selectedStoreId, csv })
    });
    state.selectedProductId = result.products?.[0]?.id || state.selectedProductId;
    await loadAll();
    setSyncStatus(`${result.imported} produtos/variantes importados do CSV.`);
  } catch (error) {
    setSyncStatus(`Erro: ${error.message}`);
  } finally {
    csvInput.value = "";
  }
});

document.querySelector("#refreshOrders").addEventListener("click", loadAll);

clearOrdersButton.addEventListener("click", async () => {
  const confirmed = window.confirm("Limpar todos os pedidos e dados de clientes salvos? Isso não apaga produtos, fretes, Shopify, domínio ou gateway.");
  if (!confirmed) return;

  clearOrdersButton.disabled = true;
  clearOrdersButton.textContent = "Limpando...";
  ordersStatus.textContent = "Limpando pedidos e dados de clientes...";
  try {
    const result = await api("/api/admin/clear-orders", { method: "POST" });
    state.selectedOrderId = "";
    state.orders = [];
    await loadAll();
    ordersStatus.textContent = `${result.removed || 0} pedidos removidos. Produtos e configurações foram mantidos.`;
  } catch (error) {
    ordersStatus.textContent = `Erro ao limpar: ${error.message}`;
  } finally {
    clearOrdersButton.disabled = false;
    clearOrdersButton.textContent = "Limpar dados";
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(loginForm).entries());
  loginError.textContent = "";
  try {
    await fetch(apiUrl("/api/admin/login"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Login inválido.");
      return data;
    });
    showPanel();
    await loadAll();
  } catch (error) {
    showLogin(error.message);
  }
});

logoutButton.addEventListener("click", async () => {
  await fetch(apiUrl("/api/admin/logout"), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" }
  }).catch(() => {});
  showLogin("");
});

setActiveView(window.location.hash.replace("#", "") || "dashboard", false);
checkSession().then((authenticated) => {
  if (!authenticated) {
    setStatus("", "hidden");
    return;
  }
  return loadAll();
}).catch((error) => {
  setStatus(`Erro ao carregar painel: ${error.message}`, "error");
  ordersList.innerHTML = `<div class="admin-empty">Erro ao carregar painel: ${error.message}</div>`;
});
