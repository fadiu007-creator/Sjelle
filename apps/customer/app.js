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

const state = { cities: [], selectedCity: "", service: "food" };

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
}

tabs.forEach(tab => tab.addEventListener("click", () => chooseService(tab.dataset.service)));
citySelect.addEventListener("change", () => {
  state.selectedCity = citySelect.value;
  updateCityStatus();
  loadRestaurants();
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
    state.selectedCity = state.cities[0].slug;
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
