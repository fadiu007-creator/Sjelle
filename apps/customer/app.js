const API = "https://saavqlbwffrwxingbnri.supabase.co/functions/v1/sjelle-api/api/v1";
const citySelect = document.querySelector("#city-select");
const cityStatus = document.querySelector("#city-status");
const results = document.querySelector("#restaurant-results");
const foodPanel = document.querySelector("#food-panel");
const ridePanel = document.querySelector("#ride-panel");
const tabs = [...document.querySelectorAll("[data-service]")];
const menuDialog = document.querySelector("#menu-dialog");
const menuTitle = document.querySelector("#menu-title");
const menuContent = document.querySelector("#menu-content");

document.querySelector("#year").textContent = String(new Date().getFullYear());

const state = { cities: [], selectedCity: "", service: "ride", activeRestaurant: null, cart: new Map(), authMode: "login", session: null, rideTrackingTimers: [] };

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function getJson(path) {
  const response = await fetch(`${API}${path}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.error?.code || "Kërkesa s’u krye.");
    error.status = response.status;
    throw error;
  }
  return body;
}

function showEmpty(title, description, icon = "⌁") {
  results.replaceChildren();
  const wrap = node("div", "empty-state");
  wrap.append(node("span", "empty-icon", icon));
  const copy = node("div");
  copy.append(node("b", "", title), node("p", "", description));
  wrap.append(copy);
  results.append(wrap);
}

function showError(message) {
  results.replaceChildren();
  const wrap = node("div", "error-state");
  wrap.append(node("span", "empty-icon", "!"));
  const copy = node("div");
  copy.append(node("b", "", "S’u lidhëm me shërbimin"), node("p", "", message));
  wrap.append(copy);
  results.append(wrap);
}

function cityLabel(city) {
  if (city.active && (city.rides_enabled || city.food_enabled)) return "Aktiv";
  return "Së shpejti";
}

function updateCityStatus() {
  const city = state.cities.find(item => item.slug === state.selectedCity);
  if (!city) {
    cityStatus.textContent = "Qytetet s’u ngarkuan. Provo prapë pak më vonë.";
    return;
  }
  const services = [];
  const rideComingArt = document.querySelector(".ride-message-art");
  const rideComingCopy = document.querySelector(".ride-message-copy");
  const rideQuoteBox = document.querySelector(".ride-quote-box");
  const rideActive = Boolean(city.active && city.rides_enabled);
  const quoteReady = Boolean(rideActive && city.routing_enabled && city.geocoding_enabled);
  if (rideQuoteBox) rideQuoteBox.hidden = !quoteReady;
  if (rideComingArt) rideComingArt.hidden = rideActive;
  if (rideComingCopy) {
    if (!rideComingCopy.dataset.defaultText) rideComingCopy.dataset.defaultText = rideComingCopy.textContent || "";
    rideComingCopy.textContent = rideActive && !quoteReady ? "Udhëtimet janë aktive në këtë qytet. Për momentin mund të rezervosh rrugët fikse të listuara më poshtë." : rideComingCopy.dataset.defaultText;
    rideComingCopy.hidden = rideActive && quoteReady;
  }
  if (city.rides_enabled) services.push("udhëtimet");
  if (city.food_enabled) services.push("ushqimi");
  cityStatus.textContent = city.active && services.length
    ? `Aktiv: ${services.join(" dhe ")}.`
    : "Shërbimet në këtë qytet ende nuk janë aktivizuar.";
}

function showLoading() {
  results.replaceChildren();
  const loading = node("div", "loading-card");
  loading.append(node("span", "spinner"), node("p", "", "Po kontrollojmë disponueshmërinë…"));
  results.append(loading);
}

function renderRestaurant(restaurant) {
  const card = node("article", "restaurant-card");
  const top = node("div", "restaurant-top");
  const initial = (restaurant.name || "R").trim().slice(0, 1).toUpperCase();
  top.append(node("span", "restaurant-avatar", initial));
  top.append(node("span", "restaurant-state", "I verifikuar"));
  card.append(top);
  card.append(node("h4", "", restaurant.name));
  card.append(node("p", "", restaurant.description || restaurant.address_text || "Menuja e restorantit."));
  const meta = node("div", "restaurant-meta");
  meta.append(node("span", "", `◷ ${restaurant.prep_time_minutes || 20} min përgatitje`));
  meta.append(node("span", "", "Dërgesë"));
  card.append(meta);
  const button = node("button", "menu-button", "Shiko menunë");
  button.type = "button";
  button.addEventListener("click", () => openMenu(restaurant));
  card.append(button);
  return card;
}

async function loadRestaurants() {
  if (state.service !== "food") return;
  if (!state.selectedCity) {
    showEmpty("Zgjidhe qytetin tënd", "Zgjedh një qytet për të kontrolluar restorantet.", "⌖");
    return;
  }
  showLoading();
  try {
    const result = await getJson(`/restaurants?city=${encodeURIComponent(state.selectedCity)}`);
    const city = state.cities.find(item => item.slug === state.selectedCity);
    if (!result.meta?.service_available || !city?.food_enabled) {
      showEmpty("Ushqimi po vjen së shpejti", "Dërgesat nuk janë aktivizuar ende në këtë qytet. Do ta shfaqim këtu kur të jenë gati.", "✳");
      return;
    }
    const restaurants = Array.isArray(result.data) ? result.data : [];
    if (!restaurants.length) {
      showEmpty("Po përgatisim listën", "Restorantet do të shfaqen pasi të jenë aprovuar dhe të kenë aktivizuar dërgesat.", "✳");
      return;
    }
    results.replaceChildren(...restaurants.map(renderRestaurant));
  } catch (error) {
    showError(error.status === 503
      ? "Shërbimi nuk është i disponueshëm për momentin. Provo përsëri pak më vonë."
      : "Nuk arritëm t'i marrim restorantet. Kontrollo lidhjen dhe provo përsëri.");
  }
}

async function openMenu(restaurant) {
  state.activeRestaurant = restaurant;
  state.cart = new Map();
  renderCart();
  menuTitle.textContent = restaurant.name;
  menuContent.replaceChildren(node("div", "loading-card", "Po ngarkojmë menunë…"));
  if (!menuDialog.open) menuDialog.showModal();
  try {
    const result = await getJson(`/restaurants/${encodeURIComponent(restaurant.slug)}/menu`);
    const data = result.data;
    menuContent.replaceChildren();
    const items = Array.isArray(data?.items) ? data.items : [];
    const categories = Array.isArray(data?.categories) ? data.categories : [];
    if (!items.length) {
      menuContent.append(node("p", "menu-empty", "Ky restorant ende nuk ka artikuj të publikuar në menu."));
      return;
    }
    for (const category of categories) {
      const categoryItems = items.filter(item => item.category_id === category.id);
      if (!categoryItems.length) continue;
      const section = node("section", "menu-category");
      section.append(node("h3", "", category.name));
      for (const item of categoryItems) section.append(menuItem(item));
      menuContent.append(section);
    }
    const uncategorized = items.filter(item => !item.category_id || !categories.some(category => category.id === item.category_id));
    if (uncategorized.length) {
      const section = node("section", "menu-category");
      section.append(node("h3", "", "Të tjera"));
      for (const item of uncategorized) section.append(menuItem(item));
      menuContent.append(section);
    }
  } catch {
    menuContent.replaceChildren(node("p", "menu-empty", "Menuja nuk mund të ngarkohet tani. Mbylle dritaren dhe provo përsëri."));
  }
}

function menuItem(item) {
  const row = node("article", "menu-item");
  const copy = node("div");
  copy.append(node("h4", "", item.name));
  if (item.description) copy.append(node("p", "", item.description));
  row.append(copy);
  const price = node("span", "menu-price", new Intl.NumberFormat("sq-XK", { style: "currency", currency: "EUR" }).format((Number(item.price_cents) || 0) / 100));
  row.append(price);
  const add = node("button", "secondary-button menu-add", "Shto");
  add.type = "button";
  add.addEventListener("click", () => {
    const current = state.cart.get(item.id) || { id: item.id, name: item.name, price_cents: Number(item.price_cents) || 0, quantity: 0 };
    current.quantity = Math.min(100, current.quantity + 1);
    state.cart.set(item.id, current);
    renderCart();
  });
  row.append(add);
  return row;
}

function chooseService(service) {
  state.service = service;
  for (const tab of tabs) {
    const active = tab.dataset.service === service;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  foodPanel.hidden = service !== "food";
  ridePanel.hidden = service !== "ride";
  if (service === "food") loadRestaurants();
  else { loadRideRoutes(); if (rideMap) rideMap.setView(mapCityCenter(), 12); setTimeout(() => { if (rideMap) rideMap.invalidateSize(); }, 100); }
}

tabs.forEach(tab => tab.addEventListener("click", () => chooseService(tab.dataset.service)));
citySelect.addEventListener("change", () => {
  state.selectedCity = citySelect.value;
  updateCityStatus();
  loadRestaurants();
  if (state.service === "ride") loadRideRoutes();
});
document.querySelector("#close-menu").addEventListener("click", () => menuDialog.close());
menuDialog.addEventListener("click", event => {
  if (event.target === menuDialog) menuDialog.close();
});

async function start() {
  try {
    const result = await getJson("/cities");
    state.cities = Array.isArray(result.data) ? result.data : [];
    citySelect.replaceChildren();
    for (const city of state.cities) {
      const option = node("option", "", `${city.name} · ${cityLabel(city)}`);
      option.value = city.slug;
      citySelect.append(option);
    }
    if (!state.cities.length) {
      citySelect.append(node("option", "", "Asnjë qytet i konfiguruar"));
      citySelect.disabled = true;
      cityStatus.textContent = "Qytetet nuk janë konfiguruar ende.";
      showEmpty("Po përgatisim nisjen", "Lista e qyteteve nuk është e disponueshme ende.", "⌖");
      return;
    }
    state.selectedCity = state.cities.some(city => city.slug === "prishtina") ? "prishtina" : state.cities[0].slug;
    citySelect.value = state.selectedCity;
    updateCityStatus();
    chooseService("ride");
  } catch {
    citySelect.replaceChildren(node("option", "", "Qytetet nuk u ngarkuan"));
    citySelect.disabled = true;
    cityStatus.textContent = "API nuk është lidhur ende. Kontrollo konfigurimin e Supabase API-së.";
    showError("Nuk ka lidhje me API-në e Sjelle. Kontrollo nëse Supabase API është në dispozicion.");
  }
}

start();


// Customer account, checkout and fixed-route booking. Tokens stay in tab-scoped storage.
const accountDialog = document.querySelector("#account-dialog");
const accountOpen = document.querySelector("#account-open");
const accountForm = document.querySelector("#auth-form");
const authMessage = document.querySelector("#auth-message");
const authNameWrap = document.querySelector("#auth-name-wrap");
const authSubmit = document.querySelector("#auth-submit");
const accountSignedIn = document.querySelector("#account-signed-in");
const accountSummary = document.querySelector("#account-summary");
const checkoutForm = document.querySelector("#checkout-form");
const checkoutMessage = document.querySelector("#checkout-message");
const checkoutSubmit = document.querySelector("#checkout-submit");
const cartLines = document.querySelector("#cart-lines");
const cartCount = document.querySelector("#cart-count");
const rideRoutes = document.querySelector("#ride-routes");

try {
  const saved = sessionStorage.getItem("sjelle.session");
  if (saved) state.session = JSON.parse(saved);
} catch { state.session = null; }

function showMessage(element, message, kind = "") {
  element.textContent = message;
  if (kind) element.dataset.kind = kind;
  else delete element.dataset.kind;
}

function persistSession(session) {
  state.session = session;
  try {
    if (session) sessionStorage.setItem("sjelle.session", JSON.stringify(session));
    else sessionStorage.removeItem("sjelle.session");
  } catch { /* private browsing can block storage; in-memory session still works */ }
  renderAccountState();
}

function renderAccountState() {
  const signedIn = Boolean(state.session?.access_token);
  accountOpen.textContent = signedIn ? "Llogaria" : "Kyçu / Regjistrohu";
  accountForm.hidden = signedIn;
  accountSignedIn.hidden = !signedIn;
  if (signedIn) accountSummary.textContent = "Je kyçur si " + (state.session.user?.email || "përdorues Sjelle") + ".";
}

async function apiRequest(path, options = {}, allowRefresh = true) {
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  if (state.session?.access_token) headers.set("authorization", "Bearer " + state.session.access_token);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(API + path, { ...options, headers, cache: "no-store" });
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (response.status === 401 && allowRefresh && state.session?.refresh_token) {
    const refreshed = await fetch(API + "/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ refresh_token: state.session.refresh_token }),
    });
    let refreshBody;
    try { refreshBody = await refreshed.json(); } catch { refreshBody = null; }
    if (refreshed.ok && refreshBody?.data?.access_token) {
      persistSession(refreshBody.data);
      return apiRequest(path, options, false);
    }
    persistSession(null);
  }
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.error?.code || "Kërkesa s’u krye.");
    error.code = body?.error?.code;
    error.status = response.status;
    throw error;
  }
  return body;
}

function openAccount(mode = "login") {
  state.authMode = mode;
  updateAuthMode();
  renderAccountState();
  if (!accountDialog.open) accountDialog.showModal();
}

function updateAuthMode() {
  const signup = state.authMode === "signup";
  authNameWrap.hidden = !signup;
  accountForm.elements.display_name.required = signup;
  accountForm.elements.password.autocomplete = signup ? "new-password" : "current-password";
  authSubmit.textContent = signup ? "Regjistrohu" : "Hyr";
  document.querySelectorAll("[data-auth-mode]").forEach(button => {
    button.classList.toggle("is-active", button.dataset.authMode === state.authMode);
  });
  document.querySelector("#account-title").textContent = signup ? "Regjistrohunë tënde" : "Mirë se erdhe";
  showMessage(authMessage, "");
}

accountOpen.addEventListener("click", () => openAccount("login"));
document.querySelector("#account-close").addEventListener("click", () => accountDialog.close());
accountDialog.addEventListener("click", event => { if (event.target === accountDialog) accountDialog.close(); });
document.querySelectorAll("[data-auth-mode]").forEach(button => button.addEventListener("click", () => {
  state.authMode = button.dataset.authMode;
  updateAuthMode();
}));
accountForm.addEventListener("submit", async event => {
  event.preventDefault();
  authSubmit.disabled = true;
  showMessage(authMessage, state.authMode === "signup" ? "Po krijojmë llogarinë…" : "Po të kyçim…");
  const form = new FormData(accountForm);
  const payload = {
    email: String(form.get("email") || "").trim(),
    password: String(form.get("password") || ""),
    display_name: String(form.get("display_name") || "").trim(),
    preferred_language: "sq",
  };
  try {
    const result = await apiRequest(state.authMode === "signup" ? "/auth/signup" : "/auth/login", {
      method: "POST", body: JSON.stringify(payload),
    }, false);
    const session = result.data;
    if (!session?.access_token) {
      showMessage(authMessage, "Llogaria u krijua. Kontrollo email-in për të konfirmuar adresën, pastaj hyr.", "success");
      state.authMode = "login";
      updateAuthMode();
      accountForm.elements.email.value = payload.email;
      return;
    }
    persistSession(session);
    accountDialog.close();
    showMessage(checkoutMessage, "Je kyçur. Mund të dërgosh porosinë.", "success");
  } catch (error) {
    showMessage(authMessage, error.message || "Nuk mundëm të kyçemi. Kontrollo të dhënat dhe provo përsëri.", "error");
  } finally {
    authSubmit.disabled = false;
  }
});

document.querySelector("#account-logout").addEventListener("click", async () => {
  const token = state.session?.access_token;
  try {
    if (token) await fetch(API + "/auth/logout", { method: "POST", headers: { authorization: "Bearer " + token } });
  } catch { /* local sign-out must still complete */ }
  persistSession(null);
  accountDialog.close();
});

function euro(cents) {
  return new Intl.NumberFormat("sq-XK", { style: "currency", currency: "EUR" }).format((Number(cents) || 0) / 100);
}

function renderCart() {
  const items = [...state.cart.values()];
  const count = items.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = items.reduce((sum, item) => sum + item.price_cents * item.quantity, 0);
  cartCount.textContent = count + (count === 1 ? " artikull" : " artikuj");
  checkoutSubmit.disabled = count === 0;
  if (!items.length) {
    cartLines.replaceChildren(node("p", "menu-empty", "Shto artikuj nga menuja."));
    return;
  }
  cartLines.replaceChildren();
  for (const item of items) {
    const line = node("div", "cart-line");
    const copy = node("div", "cart-line-copy");
    copy.append(node("b", "", item.name), node("span", "", item.quantity + " × " + euro(item.price_cents)));
    const controls = node("div", "cart-line-controls");
    const minus = node("button", "", "−");
    minus.type = "button";
    minus.setAttribute("aria-label", "Hiq një " + item.name);
    minus.addEventListener("click", () => {
      item.quantity -= 1;
      if (item.quantity <= 0) state.cart.delete(item.id);
      renderCart();
    });
    const plus = node("button", "", "+");
    plus.type = "button";
    plus.setAttribute("aria-label", "Shto një " + item.name);
    plus.addEventListener("click", () => { item.quantity = Math.min(100, item.quantity + 1); renderCart(); });
    controls.append(minus, node("span", "", String(item.quantity)), plus);
    line.append(copy, controls);
    cartLines.append(line);
  }
  const total = node("div", "cart-total");
  total.append(node("span", "", "Nëntotali i artikujve"), node("strong", "", euro(subtotal)));
  cartLines.append(total);
}

// Prefer a fresh high-accuracy GPS fix, then fall back to the network location provider if GPS is slow/unavailable.
function getCurrentDevicePosition() {
  return new Promise((resolve, reject) => {
    const attempt = (highAccuracy, timeout, allowFallback) => {
      navigator.geolocation.getCurrentPosition(
        resolve,
        error => {
          if (allowFallback && error?.code !== 1) {
            attempt(false, 15000, false);
            return;
          }
          reject(error);
        },
        { enableHighAccuracy: highAccuracy, timeout, maximumAge: 0 }
      );
    };
    attempt(true, 25000, true);
  });
}

const locateMeButton = document.querySelector("#locate-me");
locateMeButton.addEventListener("click", () => {
  if (!window.isSecureContext) {
    showMessage(checkoutMessage, "Vendndodhja kërkon lidhje të sigurt HTTPS. Hape Sjelle nga faqja zyrtare dhe provo përsëri.", "error");
    return;
  }
  if (!navigator.geolocation) {
    showMessage(checkoutMessage, "Ky shfletues nuk e mbështet gjetjen automatike të vendndodhjes. Provo Chrome ose lejo shërbimet e vendndodhjes në telefon.", "error");
    return;
  }
  locateMeButton.disabled = true;
  locateMeButton.textContent = "Po kërkojmë vendndodhjen…";
  showMessage(checkoutMessage, "Po kërkojmë GPS-in. Fillimisht provojmë saktësinë e lartë, pastaj një metodë alternative.");
  getCurrentDevicePosition().then(position => {
    checkoutForm.elements.lat.value = String(position.coords.latitude);
    checkoutForm.elements.lon.value = String(position.coords.longitude);
    locateMeButton.textContent = "Vendndodhja u gjet ✓";
    showMessage(checkoutMessage, "Vendndodhja u gjet. Shkruaj ose kërko adresën e saktë të dërgesës më sipër.", "success");
  }).catch(error => {
    locateMeButton.textContent = "Provo përsëri vendndodhjen";
    const messages = {
      1: "Qasja u refuzua. Lejo Location për Chrome në cilësimet e telefonit dhe provo përsëri.",
      2: "Telefoni nuk e gjeti vendndodhjen. Aktivizo Location/GPS dhe provo jashtë ose pranë dritares.",
      3: "Kërkimi zgjati shumë. Kontrollo GPS-in dhe lejet e Chrome, pastaj provo përsëri.",
    };
    showMessage(checkoutMessage, messages[error?.code] || "Nuk mundëm ta gjejmë vendndodhjen. Kontrollo lejet e shfletuesit dhe GPS-in e telefonit.", "error");
  }).finally(() => { locateMeButton.disabled = false; });
});

checkoutForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.activeRestaurant || !state.cart.size) return;
  if (!state.session?.access_token) {
    showMessage(checkoutMessage, "Hyr ose krijo llogari për të porositur.");
    openAccount("login");
    return;
  }
  checkoutSubmit.disabled = true;
  showMessage(checkoutMessage, "Po verifikojmë çmimet dhe po dërgojmë porosinë…");
  try {
    const form = new FormData(checkoutForm);
    const result = await apiRequest("/food-orders", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        restaurant_id: state.activeRestaurant.id,
        items: [...state.cart.values()].map(item => ({ id: item.id, quantity: item.quantity })),
        delivery_address_text: String(form.get("address") || "").trim(),
        delivery_lat: Number(form.get("lat")),
        delivery_lon: Number(form.get("lon")),
        delivery_instructions: String(form.get("instructions") || "").trim() || null,
      }),
    });
    state.cart.clear();
    renderCart();
    showMessage(checkoutMessage, "Porosia u dërgua për konfirmim nga restoranti. Statusi: " + (result.data?.status || "submitted") + ". Totali: " + euro(result.data?.total_cents) + ". Pagesa: me para në dorë.", "success");
  } catch (error) {
    const messages = {
      FOOD_PRICING_NOT_CONFIGURED: "Ky qytet nuk ka tarifa të konfiguruara ende. Porosia nuk u krijua.",
      CITY_UNAVAILABLE: "Dërgesat nuk janë aktive në këtë qytet.",
      RESTAURANT_UNAVAILABLE: "Restoranti nuk pranon porosi për momentin.",
      MENU_ITEM_UNAVAILABLE: "Një artikull nuk është më i disponueshëm. Rifresko menunë.",
      MINIMUM_ORDER_NOT_MET: "Nëntotali është nën minimumin e porosisë.",
    };
    showMessage(checkoutMessage, messages[error.code] || error.message || "Porosia dështoi. Nuk është marrë pagesë.", "error");
  } finally {
    checkoutSubmit.disabled = state.cart.size === 0;
  }
});

async function loadRideRoutes() {
  if (!state.selectedCity || !rideRoutes) return;
  rideRoutes.replaceChildren(node("p", "menu-empty", "Po kontrollojmë rrugët me çmime të konfiguruara…"));
  try {
    const result = await getJson("/ride-routes?city=" + encodeURIComponent(state.selectedCity));
    const routes = Array.isArray(result.data) ? result.data : [];
    if (!result.meta?.service_available || !routes.length) {
      rideRoutes.replaceChildren(node("p", "menu-empty", "Nuk ka ende rrugë me çmime të verifikuara në këtë qytet. Udhëtimet nuk mund të rezervohen derisa rrugët dhe çmimet të konfigurohen."));
      return;
    }
    rideRoutes.replaceChildren();
    for (const route of routes) {
      const card = node("article", "ride-route-card");
      const copy = node("div");
      copy.append(node("h4", "", route.origin_label + " → " + route.destination_label));
      copy.append(node("p", "", "Rruga e konfiguruar · " + route.vehicle_type));
      const price = node("div", "route-price");
      price.append(node("strong", "", euro(route.amount_cents)));
      const book = node("button", "", "Rezervo me para në dorë");
      book.type = "button";
      book.addEventListener("click", async () => {
        if (!state.session?.access_token) { openAccount("login"); return; }
        book.disabled = true;
        book.textContent = "Po rezervojmë…";
        try {
          const result = await apiRequest("/rides", {
            method: "POST",
            headers: { "x-route-id": route.id, "idempotency-key": crypto.randomUUID() },
          });
          book.textContent = "Kërkesa u dërgua · " + euro(result.data?.quoted_amount_cents);
        } catch (error) {
          book.disabled = false;
          book.textContent = "Provo përsëri";
          window.alert(error.code === "CITY_UNAVAILABLE" ? "Udhëtimet nuk janë aktive në këtë qytet." : "Nuk u krijua rezervimi. " + (error.message || ""));
        }
      });
      price.append(book);
      card.append(copy, price);
      rideRoutes.append(card);
    }
  } catch {
    rideRoutes.replaceChildren(node("p", "menu-empty", "Rrugët nuk mund të ngarkohen tani. Provo përsëri më vonë."));
  }
}

renderAccountState();
renderCart();


const myOrdersOpen = document.querySelector("#my-orders-open");
const myOrders = document.querySelector("#my-orders");
const orderStatusLabels = {
  submitted: "Në pritje të restorantit", accepted: "Pranuar", preparing: "Në përgatitje",
  ready_for_pickup: "Gati për marrje", courier_assigned: "Korrieri u caktua",
  picked_up: "Në dërgesë", delivered: "Dorëzuar", rejected: "Refuzuar",
  cancelled: "Anuluar", delivery_failed: "Dërgesa dështoi",
};

myOrdersOpen.addEventListener("click", loadMyOrders);

async function loadMyOrders() {
  if (!state.session?.access_token) return;
  myOrders.replaceChildren(node("p", "menu-empty", "Po ngarkojmë porositë…"));
  try {
    const result = await apiRequest("/food-orders");
    const orders = Array.isArray(result.data) ? result.data : [];
    if (!orders.length) {
      myOrders.replaceChildren(node("p", "menu-empty", "Nuk ke bërë porosi ende."));
      return;
    }
    myOrders.replaceChildren();
    for (const order of orders) {
      const card = node("article", "my-order-card");
      const heading = node("div", "my-order-heading");
      const restaurant = Array.isArray(order.restaurant) ? order.restaurant[0] : order.restaurant;
      heading.append(node("b", "", restaurant?.name || "Porosi Sjelle"));
      heading.append(node("span", "order-status", orderStatusLabels[order.status] || order.status));
      card.append(heading);
      card.append(node("p", "", "Totali: " + euro(order.total_cents) + " · Para në dorë"));
      const orderItems = Array.isArray(order.sjelle_food_order_items) ? order.sjelle_food_order_items : [];
      card.append(node("p", "order-items-summary", orderItems.map(item => item.quantity + "× " + item.item_name_snapshot).join(", ")));
      if (order.status === "submitted") {
        const cancel = node("button", "secondary-button", "Anulo porosinë");
        cancel.type = "button";
        cancel.addEventListener("click", async () => {
          cancel.disabled = true;
          try {
            await apiRequest("/food-orders/" + order.id + "/cancel", { method: "POST" });
            await loadMyOrders();
          } catch (error) {
            cancel.disabled = false;
            window.alert(error.code === "ORDER_NOT_CANCELLABLE" ? "Restoranti ka filluar ta përpunojë porosinë, ndaj nuk mund të anulohet këtu." : "Nuk u anulua porosia. " + (error.message || ""));
          }
        });
        card.append(cancel);
      }
      myOrders.append(card);
    }
  } catch {
    myOrders.replaceChildren(node("p", "menu-empty", "Porositë nuk mund të ngarkohen tani. Provo përsëri."));
  }
}

if (new URLSearchParams(window.location.search).get("account") === "login") openAccount("login");


const rideQuoteForm = document.querySelector("#ride-quote-form");
const rideQuoteMessage = document.querySelector("#ride-quote-message");
const rideQuoteResult = document.querySelector("#ride-quote-result");
const rideMapStatus=document.querySelector("#ride-map-status");let rideMap=null,rideMapMode="pickup",pickupMarker=null,destinationMarker=null,routeLine=null;
function mapCityCenter(){const centers={ferizaj:[42.3702,21.1553],prishtina:[42.6629,21.1655],prizren:[42.2139,20.7397],gjilan:[42.4635,21.4694],mitrovica:[42.8856,20.8661],peja:[42.6593,20.2883]};return centers[state.selectedCity]||[42.55,20.9];}
function initRideMap(){const el=document.querySelector("#ride-map");if(!el||!window.L||rideMap)return;rideMap=L.map(el,{zoomControl:true}).setView(mapCityCenter(),12);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"&copy; OpenStreetMap contributors"}).addTo(rideMap);rideMap.on("click",e=>setMapPoint(rideMapMode,e.latlng.lat,e.latlng.lng));setTimeout(()=>rideMap.invalidateSize(),120);}
function setRideMapMode(mode){rideMapMode=mode;document.querySelector("#map-pickup-mode")?.classList.toggle("is-selected",mode==="pickup");document.querySelector("#map-destination-mode")?.classList.toggle("is-selected",mode==="destination");if(rideMapStatus)rideMapStatus.textContent=mode==="pickup"?"Prek hartën për të zgjedhur pikën e nisjes.":"Prek hartën për të zgjedhur destinacionin.";}
function updateRideMapMarkers(){if(!rideMap||!window.L)return;const f=rideQuoteForm.elements;for(const which of ["pickup","destination"]){const lat=Number(f[which+"_lat"].value),lon=Number(f[which+"_lon"].value);let m=which==="pickup"?pickupMarker:destinationMarker;if(f[which+"_lat"].value&&f[which+"_lon"].value&&Number.isFinite(lat)&&Number.isFinite(lon)){if(!m)m=L.marker([lat,lon]).addTo(rideMap).bindPopup(which==="pickup"?"Nisja":"Destinacioni");else m.setLatLng([lat,lon]);}else if(m){rideMap.removeLayer(m);m=null;}if(which==="pickup")pickupMarker=m;else destinationMarker=m;}const pts=[];if(pickupMarker)pts.push(pickupMarker.getLatLng());if(destinationMarker)pts.push(destinationMarker.getLatLng());if(routeLine){rideMap.removeLayer(routeLine);routeLine=null;}if(pts.length===2)routeLine=L.polyline(pts,{color:"#71963c",weight:4,dashArray:"7 8"}).addTo(rideMap);if(pts.length===2)rideMap.fitBounds(L.latLngBounds(pts).pad(.22),{maxZoom:15});else if(pts.length===1)rideMap.setView(pts[0],15);}
function setMapPoint(which,lat,lon){if(lat<41.7||lat>43.4||lon<19.7||lon>22.0){if(rideMapStatus)rideMapStatus.textContent="Zgjedh një pikë brenda Kosovës.";return;}const f=rideQuoteForm.elements;const label=(which==="pickup"?"Nisja":"Destinacioni")+" në hartë ("+lat.toFixed(5)+", "+lon.toFixed(5)+")";f[which+"_query"].value=label;f[which+"_label"].value=label;f[which+"_lat"].value=String(lat);f[which+"_lon"].value=String(lon);document.querySelector("#"+which+"-suggestions").replaceChildren(node("p","menu-empty","Pika u zgjodh në hartë."));updateRideMapMarkers();if(rideMapStatus)rideMapStatus.textContent=(which==="pickup"?"Nisja":"Destinacioni")+" u zgjodh. "+(which==="pickup"?"Tani zgjidh destinacionin.":"Tani mund ta llogaritësh çmimin.");showMessage(rideQuoteMessage,label,"success");}
document.querySelector("#map-pickup-mode")?.addEventListener("click",()=>setRideMapMode("pickup"));document.querySelector("#map-destination-mode")?.addEventListener("click",()=>setRideMapMode("destination"));document.querySelector("#map-use-location")?.addEventListener("click",()=>{if(!navigator.geolocation){rideMapStatus.textContent="GPS nuk mbështetet. Zgjidh nisjen në hartë.";return;}rideMapStatus.textContent="Po kërkojmë GPS-in…";getCurrentDevicePosition().then(p=>{setRideMapMode("pickup");setMapPoint("pickup",p.coords.latitude,p.coords.longitude);rideMap?.setView([p.coords.latitude,p.coords.longitude],16);}).catch(e=>{const m={1:"Lejo Location për Sjelle në Chrome.",2:"Telefoni s’e gjeti GPS-in. Zgjidh pikën direkt në hartë.",3:"GPS-i zgjati shumë. Provo sërish ose prek hartën."};rideMapStatus.textContent=m[e?.code]||"GPS dështoi. Zgjidh pikën në hartë.";});});


function clearAddressSelection(which) {
  const form = rideQuoteForm;
  form.elements[which + "_label"].value = "";
  form.elements[which + "_lat"].value = "";
  form.elements[which + "_lon"].value = "";
  document.querySelector("#" + which + "-suggestions").replaceChildren();
  updateRideMapMarkers();
}

async function findRideAddress(which) {
  if (!state.session?.access_token) { openAccount("login"); return; }
  const query = String(rideQuoteForm.elements[which + "_query"].value || "").trim();
  const root = document.querySelector("#" + which + "-suggestions");
  if (query.length < 3) { showMessage(rideQuoteMessage, "Shkruaj të paktën 3 karaktere për adresën."); return; }
  if (!state.selectedCity) { showMessage(rideQuoteMessage, "Zgjidhe qytetin fillimisht.", "error"); return; }
  root.replaceChildren(node("p", "menu-empty", "Po e kërkojmë adresën…"));
  try {
    const result = await apiRequest("/geocode", { method: "POST", body: JSON.stringify({ city: state.selectedCity, query }) });
    const suggestions = Array.isArray(result.data) ? result.data : [];
    root.replaceChildren();
    if (!suggestions.length) { root.append(node("p", "menu-empty", "Nuk u gjet adresë në Kosovë. Provo një emër rruge ose pikë reference më të saktë.")); return; }
    for (const item of suggestions) {
      const choice = node("button", "", item.label);
      choice.type = "button";
      choice.addEventListener("click", () => {
        rideQuoteForm.elements[which + "_label"].value = item.label;
        rideQuoteForm.elements[which + "_lat"].value = String(item.lat);
        rideQuoteForm.elements[which + "_lon"].value = String(item.lon);
        rideQuoteForm.elements[which + "_query"].value = item.label;
        root.replaceChildren(node("p", "menu-empty", "E zgjodhe adresën."));
        updateRideMapMarkers();
        showMessage(rideQuoteMessage, "Adresa " + (which === "pickup" ? "e nisjes" : "e destinacionit") + " u zgjodh.", "success");
      });
      root.append(choice);
    }
  } catch (error) {
    const message = error.code === "GEOCODING_NOT_CONFIGURED"
      ? "Shërbimi i kërkimit të adresave nuk është konfiguruar ende."
      : "S’arritëm ta kërkojmë adresën. " + (error.message || "");
    root.replaceChildren(node("p", "menu-empty", message));
    showMessage(rideQuoteMessage, message, "error");
  }
}

document.querySelector("#find-pickup").addEventListener("click", () => findRideAddress("pickup"));
document.querySelector("#find-destination").addEventListener("click", () => findRideAddress("destination"));
for (const which of ["pickup","destination"]) {
  rideQuoteForm.elements[which + "_query"].addEventListener("input", () => clearAddressSelection(which));
}

const locatePickup = node("button", "secondary-button", "Përdor vendndodhjen time për nisjen");
locatePickup.type = "button";
locatePickup.addEventListener("click", () => {
  if (!window.isSecureContext) {
    showMessage(rideQuoteMessage, "Vendndodhja kërkon HTTPS. Hape Sjelle në Chrome dhe provo përsëri.", "error");
    return;
  }
  if (!navigator.geolocation) {
    showMessage(rideQuoteMessage, "Ky shfletues nuk e mbështet vendndodhjen. Provo Chrome ose kërko adresën manualisht.", "error");
    return;
  }
  locatePickup.disabled = true;
  locatePickup.textContent = "Po kërkojmë vendndodhjen…";
  showMessage(rideQuoteMessage, "Lejo Location për këtë faqe dhe sigurohu që GPS-i i telefonit është aktiv.");
  getCurrentDevicePosition().then(position => {
    rideQuoteForm.elements.pickup_query.value = "Vendndodhja ime";
    rideQuoteForm.elements.pickup_label.value = "Vendndodhja ime";
    rideQuoteForm.elements.pickup_lat.value = String(position.coords.latitude);
    rideQuoteForm.elements.pickup_lon.value = String(position.coords.longitude);
    document.querySelector("#pickup-suggestions").replaceChildren(node("p", "menu-empty", "Vendndodhja u plotësua. Kontrollo që je në qytetin e zgjedhur."));
    locatePickup.textContent = "Vendndodhja u gjet ✓";
    locatePickup.disabled = false;
    setMapPoint("pickup",position.coords.latitude,position.coords.longitude);
    showMessage(rideQuoteMessage, "Vendndodhja e nisjes u plotësua.", "success");
  }).catch(error => {
    locatePickup.disabled = false;
    locatePickup.textContent = "Provo përsëri vendndodhjen";
    const messages = {
      1: "Qasja u refuzua. Në Android: Settings → Apps → Chrome → Permissions → Location → Allow; pastaj aktivizo Location në telefon.",
      2: "Telefoni s’e gjeti vendndodhjen. Aktivizo GPS/Location dhe provo jashtë ose pranë dritares.",
      3: "Kërkimi zgjati shumë. Aktivizo Location dhe provo përsëri.",
    };
    showMessage(rideQuoteMessage, messages[error?.code] || "Vendndodhja dështoi. Kërko adresën me emër rruge ose pikë reference.", "error");
  });
});
rideQuoteForm.querySelector("#find-pickup").insertAdjacentElement("afterend", locatePickup);
initRideMap();
citySelect.addEventListener("change",()=>{if(rideMap)rideMap.setView(mapCityCenter(),12);});

rideQuoteForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.session?.access_token) { openAccount("login"); return; }
  const form = rideQuoteForm.elements;
  if (!form.pickup_label.value || !form.pickup_lat.value || !form.destination_label.value || !form.destination_lat.value) {
    showMessage(rideQuoteMessage, "Zgjedh një adresë të sugjeruar për nisjen dhe destinacionin para llogaritjes.", "error");
    return;
  }
  const submit = rideQuoteForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  rideQuoteResult.replaceChildren();
  showMessage(rideQuoteMessage, "Po llogarisim rrugën dhe çmimin në server…");
  try {
    const result = await apiRequest("/ride-quotes", {
      method: "POST",
      body: JSON.stringify({
        city: state.selectedCity,
        pickup_label: form.pickup_label.value,
        pickup_lat: Number(form.pickup_lat.value),
        pickup_lon: Number(form.pickup_lon.value),
        destination_label: form.destination_label.value,
        destination_lat: Number(form.destination_lat.value),
        destination_lon: Number(form.destination_lon.value),
        vehicle_type: form.vehicle_type.value,
      }),
    });
    const quote = result.data;
    const heading = node("h4", "", quote.pricing_kind === "fixed_route" ? "Çmim fiks i konfiguruar" : "Çmim i vlerësuar");
    rideQuoteResult.append(heading, node("strong", "", euro(quote.amount_cents)));
    rideQuoteResult.append(node("p", "", (quote.distance_m / 1000).toFixed(1) + " km · rreth " + Math.max(1, Math.round(quote.duration_s / 60)) + " min"));
    rideQuoteResult.append(node("p", "", "Pagesa: me para në dorë · Çmimi ruhet për 5 minuta. Versioni: " + quote.pricing_version));
    const book = node("button", "primary-button", "Konfirmo rezervimin");
    book.type = "button";
    book.addEventListener("click", async () => {
      book.disabled = true;
      book.textContent = "Po krijojmë rezervimin…";
      try {
        const booked = await apiRequest("/rides", {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ quote_id: quote.quote_id }),
        });
        rideQuoteResult.replaceChildren(node("h4", "", "Kërkesa për udhëtim u regjistrua"), node("p", "", "Statusi: " + (booked.data?.status || "searching") + ". Çmimi: " + euro(booked.data?.quoted_amount_cents) + "."));
        rideQuoteResult.append(node("p", "", booked.data?.driver_offer_sent ? "Oferta iu dërgua një shoferi të përshtatshëm; prit konfirmimin e tij." : "Rezervimi u ruajt, por nuk u gjet shofer i lirë për momentin."));
        showMessage(rideQuoteMessage, "Rezervimi u krijua në sistem.", "success");
      } catch (error) {
        book.disabled = false;
        book.textContent = "Provo përsëri";
        showMessage(rideQuoteMessage, "Rezervimi nuk u krijua: " + (error.message || ""), "error");
      }
    });
    rideQuoteResult.append(book);
    showMessage(rideQuoteMessage, "Çmimi u llogarit nga distanca dhe koha e rrugës në server.", "success");
  } catch (error) {
    const messages = {
      ROUTING_NOT_CONFIGURED: "Shërbimi i rrugëzimit nuk është konfiguruar. Çmimi nuk u hamendësua.",
      RIDE_PRICING_NOT_CONFIGURED: "Tarifat e udhëtimit nuk janë konfiguruar për këtë qytet.",
      CITY_UNAVAILABLE: "Udhëtimet nuk janë aktive në këtë qytet.",
      OUTSIDE_LAUNCH_AREA: "Nisja dhe destinacioni duhet të jenë brenda zonës fillestare në Kosovë.",
    };
    showMessage(rideQuoteMessage, messages[error.code] || error.message || "Nuk mundëm të llogarisim çmimin.", "error");
  } finally {
    submit.disabled = false;
  }
});


const myRidesOpen = document.querySelector("#my-rides-open");
const myRides = document.querySelector("#my-rides");
const rideStatusLabels = {
  searching:"Po kërkohet shofer",driver_assigned:"Shoferi u caktua",driver_arriving:"Shoferi po vjen",
  driver_arrived:"Shoferi arriti",in_progress:"Në udhëtim",completed:"Përfunduar",
  cancelled_by_customer:"Anuluar nga klienti",cancelled_by_driver:"Anuluar nga shoferi",
  cancelled_by_platform:"Anuluar nga Sjelle",no_driver_found:"Nuk u gjet shofer",
};
myRidesOpen.addEventListener("click",loadMyRides);
async function loadMyRides(){
  if(!state.session?.access_token)return;
  for(const timer of state.rideTrackingTimers)clearInterval(timer);state.rideTrackingTimers=[];
  myRides.replaceChildren(node("p","menu-empty","Po ngarkojmë udhëtimet…"));
  try{
    const result=await apiRequest("/rides");const rides=Array.isArray(result.data)?result.data:[];
    if(!rides.length){myRides.replaceChildren(node("p","menu-empty","Nuk ke rezervuar udhëtim ende."));return;}
    myRides.replaceChildren();
    for(const ride of rides){
      const c=node("article","my-order-card");
      c.append(node("div","my-order-heading",ride.pickup_label+" → "+ride.destination_label));
      c.append(node("span","order-status",rideStatusLabels[ride.status]||ride.status));
      c.append(node("p","","Çmimi: "+euro(ride.final_amount_cents??ride.quoted_amount_cents)+" · Para në dorë"));
      if(["driver_assigned","driver_arriving","driver_arrived","in_progress"].includes(ride.status)&&window.L){const mapEl=node("div","ride-tracking-map");mapEl.setAttribute("aria-label","Harta live e udhëtimit");c.append(mapEl);const map=L.map(mapEl,{zoomControl:false,attributionControl:false}).setView([Number(ride.pickup_lat)||42.37,Number(ride.pickup_lon)||21.15],13);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(map);if(typeof ride.pickup_lat==="number"&&typeof ride.pickup_lon==="number")L.marker([ride.pickup_lat,ride.pickup_lon]).addTo(map).bindPopup("Nisja");if(typeof ride.destination_lat==="number"&&typeof ride.destination_lon==="number")L.marker([ride.destination_lat,ride.destination_lon]).addTo(map).bindPopup("Destinacioni");const status=node("p","ride-tracking-status","Po lidhemi me vendndodhjen live…");c.append(status);let pin=null;setTimeout(()=>map.invalidateSize(),120);const refresh=async()=>{try{const r=await apiRequest("/rides/"+ride.id+"/driver-location");if(r.data?.available){const ll=[r.data.latitude,r.data.longitude];if(!pin)pin=L.circleMarker(ll,{radius:9,color:"#244c40",fillColor:"#d6f27a",fillOpacity:1,weight:3}).addTo(map).bindPopup("Shoferi live");else pin.setLatLng(ll);map.setView(ll,Math.max(14,map.getZoom()));status.textContent="Shoferi u përditësua "+new Date(r.data.recorded_at||Date.now()).toLocaleTimeString("sq-XK",{hour:"2-digit",minute:"2-digit"});}else status.textContent="Po presim vendndodhjen e shoferit…";}catch{status.textContent="Vendndodhja live s’është e disponueshme për momentin.";}};await refresh();state.rideTrackingTimers.push(setInterval(refresh,10000));}
      if(ride.status==="searching"){
        const cancel=node("button","secondary-button","Anulo kërkesën");cancel.type="button";
        cancel.addEventListener("click",async()=>{cancel.disabled=true;try{await apiRequest("/rides/"+ride.id+"/cancel",{method:"POST"});await loadMyRides();}catch(error){cancel.disabled=false;window.alert(error.code==="RIDE_NOT_CANCELLABLE"?"Shoferi mund ta ketë pranuar tashmë udhëtimin.":"Nuk u anulua udhëtimi: "+error.message);}});
        c.append(cancel);
      }
      myRides.append(c);
    }
  }catch(error){myRides.replaceChildren(node("p","menu-empty","Udhëtimet nuk mund të ngarkohen: "+error.message));}
}

setInterval(()=>{if(document.visibilityState==='visible'&&state.session?.access_token&&document.querySelector('#account-dialog')?.open){loadMyOrders();loadMyRides();}},20000);

// Support direct links to account creation/login from GitHub Pages project paths.
const requestedAccountMode = new URLSearchParams(window.location.search).get("account");
if (requestedAccountMode === "signup" || requestedAccountMode === "login") {
  openAccount(requestedAccountMode);
}


const supportOpen = document.querySelector("#support-open");
const supportForm = document.querySelector("#support-form");
const supportSubmit = document.querySelector("#support-submit");
const supportMessage = document.querySelector("#support-message");
const supportTickets = document.querySelector("#support-tickets");
const supportCategoryLabels = { ride:"Udhëtim", food_order:"Porosi ushqimi", payment:"Pagesa", safety:"Siguria", driver:"Shoferi", restaurant:"Restoranti", account:"Llogaria", other:"Tjetër" };
const supportStatusLabels = { open:"E hapur", in_progress:"Në verifikim", resolved:"E zgjidhur", closed:"E mbyllur" };

supportOpen.addEventListener("click", () => {
  if (!state.session?.access_token) { openAccount("login"); return; }
  supportForm.hidden = !supportForm.hidden;
  if (!supportForm.hidden) supportForm.elements.description.focus();
});
supportForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.session?.access_token) { openAccount("login"); return; }
  const category = String(supportForm.elements.category.value || "");
  const description = String(supportForm.elements.description.value || "").trim();
  if (description.length < 10 || description.length > 3000) {
    showMessage(supportMessage, "Përshkrimi duhet të ketë 10–3000 karaktere.", "error");
    return;
  }
  supportSubmit.disabled = true;
  showMessage(supportMessage, "Po dërgohet kërkesa…");
  try {
    await apiRequest("/support-tickets", { method: "POST", body: JSON.stringify({ category, description }) });
    supportForm.reset();
    supportForm.hidden = true;
    showMessage(supportMessage, "Kërkesa u dërgua. Mund ta shohësh më poshtë.", "success");
    await loadSupportTickets();
  } catch (error) {
    showMessage(supportMessage, error.message || "Kërkesa nuk u dërgua. Provo përsëri.", "error");
  } finally {
    supportSubmit.disabled = false;
  }
});
async function loadSupportTickets() {
  if (!state.session?.access_token) {
    supportTickets.replaceChildren();
    return;
  }
  supportTickets.replaceChildren(node("p", "menu-empty", "Po ngarkojmë kërkesat…"));
  try {
    const result = await apiRequest("/support-tickets");
    const tickets = Array.isArray(result.data) ? result.data : [];
    if (!tickets.length) {
      supportTickets.replaceChildren(node("p", "menu-empty", "Nuk ke kërkesa për ndihmë ende."));
      return;
    }
    supportTickets.replaceChildren();
    for (const ticket of tickets) {
      const card = node("article", "my-order-card support-ticket-card");
      card.append(node("div", "my-order-heading", supportCategoryLabels[ticket.category] || "Kërkesë për ndihmë"));
      card.append(node("span", "order-status", supportStatusLabels[ticket.status] || "E hapur"));
      card.append(node("p", "support-ticket-description", ticket.description || ""));
      const created = ticket.created_at ? new Date(ticket.created_at) : null;
      if (created && !Number.isNaN(created.getTime())) card.append(node("small", "support-ticket-date", created.toLocaleString("sq-XK")));
      supportTickets.append(card);
    }
  } catch (error) {
    supportTickets.replaceChildren(node("p", "menu-empty", "Kërkesat s’u ngarkuan: " + (error.message || "gabim i panjohur")));
  }
}

const originalRenderAccountState = renderAccountState;
renderAccountState = function() {
  originalRenderAccountState();
  if (state.session?.access_token && supportTickets) loadSupportTickets();
  else if (supportTickets) supportTickets.replaceChildren();
};

const deliveryAddressInput = document.querySelector('#checkout-form [name="address"]');
const deliveryAddressSuggestions = document.querySelector("#delivery-address-suggestions");
document.querySelector("#find-delivery-address").addEventListener("click",async()=>{
 if(!state.session?.access_token){openAccount("login");return;}
 const query=String(deliveryAddressInput.value||"").trim();
 if(query.length<3){showMessage(checkoutMessage,"Shkruaj të paktën 3 karaktere për adresën.");return;}
 deliveryAddressSuggestions.replaceChildren(node("p","menu-empty","Po e kërkojmë adresën…"));
 try{
  const result=await apiRequest("/geocode",{method:"POST",body:JSON.stringify({city:state.selectedCity,query})});
  deliveryAddressSuggestions.replaceChildren();
  const suggestions=Array.isArray(result.data)?result.data:[];
  if(!suggestions.length){deliveryAddressSuggestions.append(node("p","menu-empty","S’u gjet adresë në Kosovë. Provo me një adresë më të saktë."));return;}
  for(const item of suggestions){
   const choice=node("button","",item.label);choice.type="button";
   choice.addEventListener("click",()=>{
    deliveryAddressInput.value=item.label;
    checkoutForm.elements.lat.value=String(item.lat);
    checkoutForm.elements.lon.value=String(item.lon);
    deliveryAddressSuggestions.replaceChildren(node("p","menu-empty","E zgjodhe adresën."));
    showMessage(checkoutMessage,"Adresa dhe vendndodhja u plotësuan. Mund ta dërgosh porosinë.","success");
   });
   deliveryAddressSuggestions.append(choice);
  }
 }catch(error){showMessage(checkoutMessage,error.code==="GEOCODING_NOT_CONFIGURED"?"Kërkimi i adresave nuk është konfiguruar ende.":error.message||"S’arritëm ta kërkojmë adresën.","error");deliveryAddressSuggestions.replaceChildren();}
});
deliveryAddressInput.addEventListener("input",()=>{
 checkoutForm.elements.lat.value="";
 checkoutForm.elements.lon.value="";
 deliveryAddressSuggestions.replaceChildren();
});
