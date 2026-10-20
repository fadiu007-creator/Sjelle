const API = "/api/v1";
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

const state = { cities: [], selectedCity: "", service: "food", activeRestaurant: null, cart: new Map(), authMode: "login", session: null };

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
    const error = new Error(body?.error?.message || body?.error?.code || "Kërkesa dështoi.");
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
  copy.append(node("b", "", "Nuk u lidhëm me shërbimin"), node("p", "", message));
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
    cityStatus.textContent = "Nuk u ngarkuan qytetet. Provo përsëri më vonë.";
    return;
  }
  const services = [];
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
    showEmpty("Zgjedh qytetin tënd", "Zgjedh një qytet për të kontrolluar restorantet.", "⌖");
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
  else loadRideRoutes();
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
    await loadRestaurants();
  } catch {
    citySelect.replaceChildren(node("option", "", "Qytetet nuk u ngarkuan"));
    citySelect.disabled = true;
    cityStatus.textContent = "API nuk është lidhur ende. Konfiguro lidhjen e backend-it në Cloudflare.";
    showError("Nuk ka lidhje me API-në e Sjelle. Kontrollo konfigurimin e Worker-it.");
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
  accountOpen.textContent = signedIn ? "Llogaria" : "Hyr / Regjistrohu";
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
    const error = new Error(body?.error?.message || body?.error?.code || "Kërkesa dështoi.");
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
  accountForm.elements.password.autocomplete = signup ? "new-password" : "current-password";
  authSubmit.textContent = signup ? "Krijo llogari" : "Hyr";
  document.querySelectorAll("[data-auth-mode]").forEach(button => {
    button.classList.toggle("is-active", button.dataset.authMode === state.authMode);
  });
  document.querySelector("#account-title").textContent = signup ? "Krijo llogarinë tënde" : "Mirë se erdhe";
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
    try {
      await apiRequest("/me", { method: "PUT", body: JSON.stringify({
        display_name: payload.display_name || session.user?.user_metadata?.display_name || (session.user?.email || "Klient").split("@")[0],
        phone: null, preferred_language: "sq",
      }) });
    } catch { /* session remains valid; profile can be completed later */ }
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

document.querySelector("#locate-me").addEventListener("click", () => {
  if (!navigator.geolocation) {
    showMessage(checkoutMessage, "Shfletuesi nuk e mbështet vendndodhjen. Shkruaji koordinatat manualisht.", "error");
    return;
  }
  showMessage(checkoutMessage, "Po kërkojmë vendndodhjen…");
  navigator.geolocation.getCurrentPosition(position => {
    checkoutForm.elements.lat.value = position.coords.latitude.toFixed(6);
    checkoutForm.elements.lon.value = position.coords.longitude.toFixed(6);
    showMessage(checkoutMessage, "Vendndodhja u plotësua. Kontrollo adresën para porosisë.", "success");
  }, () => showMessage(checkoutMessage, "Nuk mundëm të marrim vendndodhjen. Lejo qasjen ose plotëso koordinatat manualisht.", "error"), {
    enableHighAccuracy: true, timeout: 10000, maximumAge: 60000,
  });
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
