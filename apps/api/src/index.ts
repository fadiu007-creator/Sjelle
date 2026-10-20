export interface Env {
  APP_ENV?: "development" | "staging" | "production";
  ALLOWED_ORIGIN?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ASSETS?: Fetcher;
}

type AuthUser = { id: string; email?: string };
type City = {
  slug: string;
  name: string;
  country_code: string;
  timezone: string;
  rides_enabled: boolean;
  food_enabled: boolean;
  active: boolean;
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(self)",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

function response(
  body: Record<string, unknown>,
  status: number,
  requestId: string,
  origin: string | null,
  env: Env,
): Response {
  const headers = new Headers(jsonHeaders);
  headers.set("x-request-id", requestId);

  if (origin && env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
    headers.set("access-control-allow-headers", "authorization, content-type, idempotency-key");
    headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  }

  return new Response(JSON.stringify(body), { status, headers });
}

function configured(env: Env): env is Env & { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string } {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseUrl(env: Env, path: string): string {
  return `${env.SUPABASE_URL!.replace(/\/+$/, "")}${path}`;
}

async function getAuthenticatedUser(request: Request, env: Env): Promise<AuthUser | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) return null;
  if (!configured(env) || !env.SUPABASE_PUBLISHABLE_KEY) throw new Error("SUPABASE_NOT_CONFIGURED");

  const result = await fetch(supabaseUrl(env, "/auth/v1/user"), {
    method: "GET",
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      authorization,
    },
  });
  if (!result.ok) return null;
  const user = await result.json() as Partial<AuthUser>;
  return typeof user.id === "string" ? { id: user.id, email: user.email } : null;
}

async function databaseRequest(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!configured(env)) throw new Error("SUPABASE_NOT_CONFIGURED");
  const headers = new Headers(init.headers);
  headers.set("apikey", env.SUPABASE_SERVICE_ROLE_KEY);
  headers.set("authorization", `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(supabaseUrl(env, `/rest/v1/${path}`), { ...init, headers });
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLanguage(value: unknown): value is "sq" | "en" | "sr" {
  return value === "sq" || value === "en" || value === "sr";
}


async function hasSjelleRole(env: Env, userId: string, role: string): Promise<boolean> {
  const result = await databaseRequest(env,
    "sjelle_user_roles?user_id=eq." + encodeURIComponent(userId) + "&role=eq." + encodeURIComponent(role) + "&select=role&limit=1");
  if (!result.ok) throw new Error("ROLE_CHECK_FAILED");
  const rows = await parseJson(result);
  return Array.isArray(rows) && rows.length > 0;
}

async function requireUser(request: Request, env: Env): Promise<AuthUser | null> {
  return getAuthenticatedUser(request, env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS") {
      if (origin && env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
        return response({ error: { code: "ORIGIN_NOT_ALLOWED", request_id: requestId } }, 403, requestId, null, env);
      }
      const headers = new Headers();
      headers.set("x-request-id", requestId);
      if (origin && env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) {
        headers.set("access-control-allow-origin", origin);
        headers.set("vary", "Origin");
        headers.set("access-control-allow-headers", "authorization, content-type, idempotency-key");
        headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      }
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === "/api/v1/health" && request.method === "GET") {
      return response({
        ok: true,
        service: "sjelle-api",
        environment: env.APP_ENV ?? "development",
        request_id: requestId,
      }, 200, requestId, origin, env);
    }

    if (url.pathname === "/api/v1/ready" && request.method === "GET") {
      if (!configured(env)) {
        return response({ ok: false, error: { code: "BACKEND_NOT_CONFIGURED", request_id: requestId } }, 503, requestId, origin, env);
      }
      try {
        const result = await databaseRequest(env, "sjelle_cities?select=id&limit=1");
        if (!result.ok) {
          return response({ ok: false, error: { code: "DATABASE_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
        }
        return response({ ok: true, service: "sjelle-api", database: "reachable", request_id: requestId }, 200, requestId, origin, env);
      } catch {
        return response({ ok: false, error: { code: "DATABASE_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
    }

    if (url.pathname === "/api/v1/cities" && request.method === "GET") {
      if (!configured(env)) {
        return response({ error: { code: "BACKEND_NOT_CONFIGURED", request_id: requestId } }, 503, requestId, origin, env);
      }
      try {
        const result = await databaseRequest(
          env,
          "sjelle_cities?select=slug,name,country_code,timezone,rides_enabled,food_enabled,active&order=name.asc",
        );
        if (!result.ok) {
          return response({ error: { code: "CITY_LIST_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
        }
        const cities = await parseJson(result) as City[];
        return response({ data: Array.isArray(cities) ? cities : [] }, 200, requestId, origin, env);
      } catch {
        return response({ error: { code: "CITY_LIST_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
    }

    if (url.pathname === "/api/v1/restaurants" && request.method === "GET") {
      const citySlug = (url.searchParams.get("city") ?? "").trim().toLowerCase();
      if (!/^[a-z0-9-]{2,60}$/.test(citySlug)) {
        return response({ error: { code: "CITY_REQUIRED", message: "Provide a valid city slug in ?city=.", request_id: requestId } }, 400, requestId, origin, env);
      }
      if (!configured(env)) {
        return response({ error: { code: "BACKEND_NOT_CONFIGURED", request_id: requestId } }, 503, requestId, origin, env);
      }
      try {
        const cityResponse = await databaseRequest(env, `sjelle_cities?slug=eq.${encodeURIComponent(citySlug)}&select=id,slug,active,food_enabled&limit=1`);
        if (!cityResponse.ok) return response({ error: { code: "RESTAURANT_LIST_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
        const cityRows = await parseJson(cityResponse) as Array<{ id: string; slug: string; active: boolean; food_enabled: boolean }>;
        const city = Array.isArray(cityRows) ? cityRows[0] : undefined;
        if (!city) return response({ error: { code: "CITY_NOT_FOUND", request_id: requestId } }, 404, requestId, origin, env);
        if (!city.active || !city.food_enabled) {
          return response({ data: [], meta: { city: city.slug, service_available: false } }, 200, requestId, origin, env);
        }
        const restaurantsResponse = await databaseRequest(
          env,
          `sjelle_restaurants?city_id=eq.${encodeURIComponent(city.id)}&approval_status=eq.approved&is_open=eq.true&delivery_enabled=eq.true&select=id,city_id,name,slug,description,address_text,latitude,longitude,image_path,is_open,delivery_enabled,prep_time_minutes&order=name.asc`,
        );
        if (!restaurantsResponse.ok) return response({ error: { code: "RESTAURANT_LIST_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
        const restaurants = await parseJson(restaurantsResponse);
        return response({ data: Array.isArray(restaurants) ? restaurants : [], meta: { city: city.slug, service_available: true } }, 200, requestId, origin, env);
      } catch {
        return response({ error: { code: "RESTAURANT_LIST_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
    }

    const menuMatch = url.pathname.match(/^\/api\/v1\/restaurants\/([^/]+)\/menu$/);
    if (menuMatch && request.method === "GET") {
      let restaurantSlug: string;
      try {
        restaurantSlug = decodeURIComponent(menuMatch[1]).trim().toLowerCase();
      } catch {
        return response({ error: { code: "INVALID_RESTAURANT_SLUG", request_id: requestId } }, 400, requestId, origin, env);
      }
      if (!/^[a-z0-9-]{2,80}$/.test(restaurantSlug)) {
        return response({ error: { code: "INVALID_RESTAURANT_SLUG", request_id: requestId } }, 400, requestId, origin, env);
      }
      if (!configured(env)) {
        return response({ error: { code: "BACKEND_NOT_CONFIGURED", request_id: requestId } }, 503, requestId, origin, env);
      }
      try {
        const restaurantResponse = await databaseRequest(
          env,
          `sjelle_restaurants?slug=eq.${encodeURIComponent(restaurantSlug)}&select=id,city_id,name,slug,description,address_text,latitude,longitude,image_path,approval_status,is_open,delivery_enabled,prep_time_minutes&limit=1`,
        );
        if (!restaurantResponse.ok) return response({ error: { code: "MENU_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
        const restaurantRows = await parseJson(restaurantResponse) as Array<{
          id: string; city_id: string; name: string; slug: string; description: string | null;
          address_text: string; latitude: number; longitude: number; image_path: string | null;
          approval_status: string; is_open: boolean; delivery_enabled: boolean; prep_time_minutes: number;
        }>;
        const restaurant = Array.isArray(restaurantRows) ? restaurantRows[0] : undefined;
        if (!restaurant || restaurant.approval_status !== "approved" || !restaurant.is_open || !restaurant.delivery_enabled) {
          return response({ error: { code: "RESTAURANT_UNAVAILABLE", request_id: requestId } }, 404, requestId, origin, env);
        }
        const cityResponse = await databaseRequest(env, `sjelle_cities?id=eq.${encodeURIComponent(restaurant.city_id)}&select=active,food_enabled&limit=1`);
        if (!cityResponse.ok) return response({ error: { code: "MENU_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
        const cityRows = await parseJson(cityResponse) as Array<{ active: boolean; food_enabled: boolean }>;
        const city = Array.isArray(cityRows) ? cityRows[0] : undefined;
        if (!city || !city.active || !city.food_enabled) return response({ error: { code: "RESTAURANT_UNAVAILABLE", request_id: requestId } }, 404, requestId, origin, env);

        const [categoriesResponse, itemsResponse] = await Promise.all([
          databaseRequest(env, `sjelle_menu_categories?restaurant_id=eq.${encodeURIComponent(restaurant.id)}&active=eq.true&select=id,name,sort_order&order=sort_order.asc`),
          databaseRequest(env, `sjelle_menu_items?restaurant_id=eq.${encodeURIComponent(restaurant.id)}&available=eq.true&select=id,category_id,name,description,image_path,price_cents&order=name.asc`),
        ]);
        if (!categoriesResponse.ok || !itemsResponse.ok) return response({ error: { code: "MENU_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
        const categories = await parseJson(categoriesResponse);
        const items = await parseJson(itemsResponse) as Array<{ id: string }>;
        return response({
          data: {
            restaurant: {
              id: restaurant.id, name: restaurant.name, slug: restaurant.slug,
              description: restaurant.description, address_text: restaurant.address_text,
              latitude: restaurant.latitude, longitude: restaurant.longitude,
              image_path: restaurant.image_path, prep_time_minutes: restaurant.prep_time_minutes,
            },
            categories: Array.isArray(categories) ? categories : [],
            items: Array.isArray(items) ? items : [],
          },
        }, 200, requestId, origin, env);
      } catch {
        return response({ error: { code: "MENU_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
    }



    if ((url.pathname === "/api/v1/auth/refresh" || url.pathname === "/api/v1/auth/logout") && request.method === "POST") {
      if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
        return response({ error: { code: "AUTH_NOT_CONFIGURED", request_id: requestId } }, 503, requestId, origin, env);
      }
      let authBody: unknown = {};
      if (url.pathname.endsWith("/refresh")) {
        try { authBody = await request.json(); } catch {
          return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env);
        }
        if (!isRecord(authBody) || typeof authBody.refresh_token !== "string" || authBody.refresh_token.length < 10 || authBody.refresh_token.length > 4096) {
          return response({ error: { code: "INVALID_REFRESH_TOKEN", request_id: requestId } }, 400, requestId, origin, env);
        }
      }
      const isRefresh = url.pathname.endsWith("/refresh");
      const authorization = request.headers.get("authorization");
      if (!isRefresh && (!authorization || !/^Bearer\s+\S+$/i.test(authorization))) {
        return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      }
      try {
        const authResponse = await fetch(supabaseUrl(env, isRefresh ? "/auth/v1/token?grant_type=refresh_token" : "/auth/v1/logout"), {
          method: "POST",
          headers: {
            apikey: env.SUPABASE_PUBLISHABLE_KEY,
            "content-type": "application/json",
            ...(authorization && !isRefresh ? { authorization } : {}),
          },
          ...(isRefresh ? { body: JSON.stringify({ refresh_token: (authBody as Record<string, unknown>).refresh_token }) } : {}),
        });
        if (!authResponse.ok) {
          return response({ error: { code: isRefresh ? "SESSION_REFRESH_FAILED" : "SIGN_OUT_FAILED", request_id: requestId } }, authResponse.status === 401 ? 401 : 503, requestId, origin, env);
        }
        if (!isRefresh) return response({ data: { signed_out: true } }, 200, requestId, origin, env);
        return response({ data: await parseJson(authResponse) }, 200, requestId, origin, env);
      } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
    }

    // Supabase Auth proxy: the publishable key is used only for Auth; the service-role key never leaves this Worker.
    if ((url.pathname === "/api/v1/auth/signup" && request.method === "POST")
      || (url.pathname === "/api/v1/auth/login" && request.method === "POST")) {
      if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
        return response({ error: { code: "AUTH_NOT_CONFIGURED", request_id: requestId } }, 503, requestId, origin, env);
      }
      let body: unknown;
      try { body = await request.json(); } catch {
        return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env);
      }
      if (!isRecord(body) || typeof body.email !== "string" || typeof body.password !== "string") {
        return response({ error: { code: "INVALID_CREDENTIALS", message: "Email and password are required.", request_id: requestId } }, 400, requestId, origin, env);
      }
      const email = body.email.trim().toLowerCase();
      const password = body.password;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 8 || password.length > 128 || (url.pathname.endsWith("/signup") && (typeof body.display_name !== "string" || !body.display_name.trim() || body.display_name.trim().length > 80))) {
        return response({ error: { code: "INVALID_CREDENTIALS", message: "Enter a valid email and a password between 8 and 128 characters.", request_id: requestId } }, 400, requestId, origin, env);
      }
      const signup = url.pathname.endsWith("/signup");
      const authPath = signup ? "/auth/v1/signup" : "/auth/v1/token?grant_type=password";
      const payload = signup
        ? { email, password, data: { display_name: typeof body.display_name === "string" ? body.display_name.trim().slice(0, 80) : "", preferred_language: isLanguage(body.preferred_language) ? body.preferred_language : "sq" } }
        : { email, password };
      try {
        const authResponse = await fetch(supabaseUrl(env, authPath), {
          method: "POST",
          headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const authBody = await parseJson(authResponse);
        if (!authResponse.ok) {
          const message = isRecord(authBody) && typeof authBody.msg === "string" ? authBody.msg
            : isRecord(authBody) && typeof authBody.message === "string" ? authBody.message : "Authentication failed.";
          return response({ error: { code: "AUTH_FAILED", message: message.slice(0, 220), request_id: requestId } }, authResponse.status >= 500 ? 503 : authResponse.status, requestId, origin, env);
        }
        return response({ data: authBody }, signup ? 201 : 200, requestId, origin, env);
      } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
    }

    if (url.pathname === "/api/v1/ride-routes" && request.method === "GET") {
      const citySlug = (url.searchParams.get("city") ?? "").trim().toLowerCase();
      if (!/^[a-z0-9-]{2,60}$/.test(citySlug)) {
        return response({ error: { code: "CITY_REQUIRED", request_id: requestId } }, 400, requestId, origin, env);
      }
      if (!configured(env)) return response({ error: { code: "BACKEND_NOT_CONFIGURED", request_id: requestId } }, 503, requestId, origin, env);
      try {
        const cityResponse = await databaseRequest(env, `sjelle_cities?slug=eq.${encodeURIComponent(citySlug)}&select=id,slug,active,rides_enabled&limit=1`);
        if (!cityResponse.ok) return response({ error: { code: "RIDE_ROUTES_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
        const cityRows = await parseJson(cityResponse) as Array<{ id: string; slug: string; active: boolean; rides_enabled: boolean }>;
        const city = cityRows[0];
        if (!city) return response({ error: { code: "CITY_NOT_FOUND", request_id: requestId } }, 404, requestId, origin, env);
        if (!city.active || !city.rides_enabled) return response({ data: [], meta: { city: city.slug, service_available: false } }, 200, requestId, origin, env);
        const routeResponse = await databaseRequest(env,
          `sjelle_fixed_route_prices?city_id=eq.${encodeURIComponent(city.id)}&active=eq.true&select=id,route_key,origin_label,destination_label,vehicle_type,amount_cents,currency,version,origin_lat,origin_lon,destination_lat,destination_lon,effective_from,effective_until&effective_from=lte.${encodeURIComponent(new Date().toISOString())}&order=origin_label.asc`);
        if (!routeResponse.ok) return response({ error: { code: "RIDE_ROUTES_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
        const routes = await parseJson(routeResponse);
        const now = Date.now();
        const valid = Array.isArray(routes) ? routes.filter((r) => isRecord(r)
          && typeof r.origin_lat === "number" && typeof r.origin_lon === "number"
          && typeof r.destination_lat === "number" && typeof r.destination_lon === "number"
          && (r.effective_until === null || typeof r.effective_until !== "string" || Date.parse(r.effective_until) > now)) : [];
        return response({ data: valid, meta: { city: city.slug, service_available: true } }, 200, requestId, origin, env);
      } catch {
        return response({ error: { code: "RIDE_ROUTES_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
    }

    if (url.pathname === "/api/v1/rides" && request.method === "POST") {
      let user: AuthUser | null;
      try { user = await getAuthenticatedUser(request, env); } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      const routeId = request.headers.get("x-route-id");
      const idempotencyKey = request.headers.get("idempotency-key");
      if (!routeId || !/^[0-9a-f-]{36}$/i.test(routeId) || !idempotencyKey || idempotencyKey.length < 12 || idempotencyKey.length > 128) {
        return response({ error: { code: "INVALID_RIDE_REQUEST", message: "Provide x-route-id and a unique Idempotency-Key.", request_id: requestId } }, 400, requestId, origin, env);
      }
      try {
        const result = await databaseRequest(env, "rpc/sjelle_book_fixed_route_ride", {
          method: "POST", body: JSON.stringify({ p_customer_id: user.id, p_route_id: routeId, p_idempotency_key: idempotencyKey }),
        });
        const payload = await parseJson(result);
        if (!result.ok) {
          const code = isRecord(payload) && typeof payload.message === "string" ? payload.message : "RIDE_BOOKING_FAILED";
          const status = ["CITY_UNAVAILABLE","ROUTE_NOT_AVAILABLE","CITY_PRICING_NOT_CONFIGURED"].includes(code) ? 409
            : ["INVALID_RIDE_REQUEST"].includes(code) ? 400 : 503;
          return response({ error: { code, request_id: requestId } }, status, requestId, origin, env);
        }
        return response({ data: payload }, 201, requestId, origin, env);
      } catch {
        return response({ error: { code: "RIDE_BOOKING_FAILED", request_id: requestId } }, 503, requestId, origin, env);
      }
    }

    if (url.pathname === "/api/v1/food-orders" && request.method === "POST") {
      let user: AuthUser | null;
      try { user = await getAuthenticatedUser(request, env); } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      const idempotencyKey = request.headers.get("idempotency-key");
      if (!idempotencyKey || idempotencyKey.length < 12 || idempotencyKey.length > 128) {
        return response({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", request_id: requestId } }, 400, requestId, origin, env);
      }
      let body: unknown;
      try { body = await request.json(); } catch {
        return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env);
      }
      if (!isRecord(body) || typeof body.restaurant_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.restaurant_id)
        || typeof body.delivery_address_text !== "string" || typeof body.delivery_lat !== "number" || typeof body.delivery_lon !== "number"
        || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50
        || body.items.some(item => !isRecord(item) || typeof item.id !== "string" || !/^[0-9a-f-]{36}$/i.test(item.id) || !Number.isInteger(item.quantity) || Number(item.quantity) < 1 || Number(item.quantity) > 100)) {
        return response({ error: { code: "INVALID_ORDER", message: "Provide a restaurant, delivery address, valid coordinates, and 1–50 item/quantity pairs.", request_id: requestId } }, 400, requestId, origin, env);
      }
      if (body.delivery_address_text.trim().length < 4 || body.delivery_address_text.length > 500
        || body.delivery_lat < -90 || body.delivery_lat > 90 || body.delivery_lon < -180 || body.delivery_lon > 180
        || (body.delivery_instructions !== undefined && body.delivery_instructions !== null && (typeof body.delivery_instructions !== "string" || body.delivery_instructions.length > 500))) {
        return response({ error: { code: "INVALID_DELIVERY_ADDRESS", request_id: requestId } }, 400, requestId, origin, env);
      }
      try {
        const result = await databaseRequest(env, "rpc/sjelle_create_food_order", {
          method: "POST",
          body: JSON.stringify({
            p_customer_id: user.id, p_restaurant_id: body.restaurant_id, p_idempotency_key: idempotencyKey,
            p_delivery_address_text: body.delivery_address_text.trim(), p_delivery_lat: body.delivery_lat,
            p_delivery_lon: body.delivery_lon, p_delivery_instructions: typeof body.delivery_instructions === "string" ? body.delivery_instructions.trim() : null,
            p_items: body.items,
          }),
        });
        const payload = await parseJson(result);
        if (!result.ok) {
          const code = isRecord(payload) && typeof payload.message === "string" ? payload.message : "ORDER_CREATE_FAILED";
          const status = ["CITY_UNAVAILABLE","RESTAURANT_UNAVAILABLE","MENU_ITEM_UNAVAILABLE","FOOD_PRICING_NOT_CONFIGURED","MINIMUM_ORDER_NOT_MET"].includes(code) ? 409
            : ["INVALID_ORDER","INVALID_IDEMPOTENCY_KEY","INVALID_DELIVERY_ADDRESS","INVALID_DELIVERY_COORDINATES","INVALID_ORDER_ITEMS","ORDER_TOTAL_TOO_LARGE"].includes(code) ? 400 : 503;
          return response({ error: { code, request_id: requestId } }, status, requestId, origin, env);
        }
        return response({ data: payload }, 201, requestId, origin, env);
      } catch {
        return response({ error: { code: "ORDER_CREATE_FAILED", request_id: requestId } }, 503, requestId, origin, env);
      }
    }

    if (url.pathname === "/api/v1/food-orders" && request.method === "GET") {
      let user: AuthUser | null;
      try { user = await getAuthenticatedUser(request, env); } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try {
        const result = await databaseRequest(env,
          `sjelle_food_orders?customer_id=eq.${encodeURIComponent(user.id)}&select=id,restaurant_id,restaurant:sjelle_restaurants(name),status,payment_method,sjelle_cash_status,item_subtotal_cents,delivery_fee_cents,service_fee_cents,total_cents,currency,delivery_address_text,created_at,updated_at,sjelle_food_order_items(id,item_name_snapshot,unit_price_cents,quantity,line_total_cents)&order=created_at.desc&limit=50`);
        if (!result.ok) return response({ error: { code: "ORDERS_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const rows = await parseJson(result);
        return response({ data: Array.isArray(rows) ? rows : [] }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "ORDERS_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    const orderMatch = url.pathname.match(/^\/api\/v1\/food-orders\/([0-9a-f-]{36})(?:\/(cancel|status))?$/i);
    if (orderMatch && request.method === "GET") {
      let user: AuthUser | null;
      try { user = await getAuthenticatedUser(request, env); } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try {
        const result = await databaseRequest(env,
          `sjelle_food_orders?id=eq.${encodeURIComponent(orderMatch[1])}&customer_id=eq.${encodeURIComponent(user.id)}&select=id,restaurant_id,restaurant:sjelle_restaurants(name),status,payment_method,sjelle_cash_status,item_subtotal_cents,delivery_fee_cents,service_fee_cents,total_cents,currency,delivery_address_text,created_at,updated_at,sjelle_food_order_items(id,item_name_snapshot,unit_price_cents,quantity,line_total_cents)&limit=1`);
        if (!result.ok) return response({ error: { code: "ORDER_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const rows = await parseJson(result) as unknown[];
        if (!Array.isArray(rows) || !rows.length) return response({ error: { code: "ORDER_NOT_FOUND", request_id: requestId } }, 404, requestId, origin, env);
        return response({ data: rows[0] as Record<string, unknown> }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "ORDER_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    const cancelMatch = url.pathname.match(/^\/api\/v1\/food-orders\/([0-9a-f-]{36})\/cancel$/i);
    if (cancelMatch && request.method === "POST") {
      let user: AuthUser | null;
      try { user = await getAuthenticatedUser(request, env); } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try {
        const result = await databaseRequest(env, "rpc/sjelle_cancel_food_order", { method: "POST", body: JSON.stringify({ p_customer_id: user.id, p_order_id: cancelMatch[1] }) });
        const payload = await parseJson(result);
        if (!result.ok) {
          const code = isRecord(payload) && typeof payload.message === "string" ? payload.message : "ORDER_CANCEL_FAILED";
          const status = code === "ORDER_NOT_FOUND" ? 404 : code === "ORDER_NOT_CANCELLABLE" ? 409 : 503;
          return response({ error: { code, request_id: requestId } }, status, requestId, origin, env);
        }
        return response({ data: payload }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "ORDER_CANCEL_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    const merchantStatusMatch = url.pathname.match(/^\/api\/v1\/merchant\/orders\/([0-9a-f-]{36})\/status$/i);
    if (merchantStatusMatch && request.method === "PATCH") {
      let user: AuthUser | null;
      try { user = await getAuthenticatedUser(request, env); } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env); }
      if (!isRecord(body) || !["accepted","preparing","ready_for_pickup","rejected"].includes(String(body.status))) {
        return response({ error: { code: "INVALID_ORDER_TRANSITION", request_id: requestId } }, 400, requestId, origin, env);
      }
      try {
        const result = await databaseRequest(env, "rpc/sjelle_update_food_order_status", { method: "POST", body: JSON.stringify({ p_actor_id: user.id, p_order_id: merchantStatusMatch[1], p_next_status: body.status }) });
        const payload = await parseJson(result);
        if (!result.ok) {
          const code = isRecord(payload) && typeof payload.message === "string" ? payload.message : "ORDER_STATUS_UPDATE_FAILED";
          const status = code === "FORBIDDEN" ? 403 : code === "ORDER_NOT_FOUND" ? 404 : code === "INVALID_ORDER_TRANSITION" ? 409 : 503;
          return response({ error: { code, request_id: requestId } }, status, requestId, origin, env);
        }
        return response({ data: payload }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "ORDER_STATUS_UPDATE_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    if (url.pathname === "/api/v1/rides" && request.method === "GET") {
      let user: AuthUser | null;
      try { user = await getAuthenticatedUser(request, env); } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try {
        const result = await databaseRequest(env,
          `sjelle_rides?customer_id=eq.${encodeURIComponent(user.id)}&select=id,vehicle_type,pickup_label,destination_label,status,pricing_kind,pricing_version,quoted_amount_cents,final_amount_cents,payment_method,sjelle_cash_status,requested_at&order=requested_at.desc&limit=50`);
        if (!result.ok) return response({ error: { code: "RIDES_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const rows = await parseJson(result);
        return response({ data: Array.isArray(rows) ? rows : [] }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "RIDES_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }


    if (url.pathname === "/api/v1/driver/apply" && request.method === "POST") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env); }
      if (!isRecord(body) || typeof body.city !== "string" || !["ride","delivery"].includes(String(body.mode))) {
        return response({ error: { code: "INVALID_DRIVER_APPLICATION", request_id: requestId } }, 400, requestId, origin, env);
      }
      try {
        const cityResponse = await databaseRequest(env, "sjelle_cities?slug=eq." + encodeURIComponent(body.city.trim().toLowerCase()) + "&select=id,slug&limit=1");
        if (!cityResponse.ok) return response({ error: { code: "CITY_LOOKUP_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const cities = await parseJson(cityResponse) as Array<{ id: string; slug: string }>;
        if (!cities.length) return response({ error: { code: "CITY_NOT_FOUND", request_id: requestId } }, 404, requestId, origin, env);
        const profileResponse = await databaseRequest(env, "sjelle_driver_profiles?on_conflict=user_id", {
          method: "POST", headers: { prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify({ user_id: user.id, city_id: cities[0].id, selected_mode: body.mode, online: false }),
        });
        if (!profileResponse.ok) return response({ error: { code: "DRIVER_APPLICATION_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const roleResponse = await databaseRequest(env, "sjelle_user_roles?on_conflict=user_id,role", {
          method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=minimal" },
          body: JSON.stringify({ user_id: user.id, role: "driver" }),
        });
        if (!roleResponse.ok) return response({ error: { code: "DRIVER_ROLE_SETUP_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        return response({ data: { application_status: "pending", city: cities[0].slug, mode: body.mode, online: false } }, 201, requestId, origin, env);
      } catch { return response({ error: { code: "DRIVER_APPLICATION_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    if (url.pathname === "/api/v1/driver/me" && request.method === "GET") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try {
        const [profileResponse, vehicleResponse, documentResponse] = await Promise.all([
          databaseRequest(env, "sjelle_driver_profiles?user_id=eq." + encodeURIComponent(user.id) + "&select=user_id,review_status,online,selected_mode,city_id,approved_at,created_at,updated_at&limit=1"),
          databaseRequest(env, "sjelle_vehicles?driver_id=eq." + encodeURIComponent(user.id) + "&select=id,vehicle_type,make,model,color,registration_number,capacity,review_status,document_expires_at,verified_at,created_at&order=created_at.desc"),
          databaseRequest(env, "sjelle_driver_documents?driver_id=eq." + encodeURIComponent(user.id) + "&select=id,document_type,document_number_last4,expires_at,review_status,reviewed_at,rejection_reason,created_at&order=created_at.desc"),
        ]);
        if (!profileResponse.ok || !vehicleResponse.ok || !documentResponse.ok) return response({ error: { code: "DRIVER_PROFILE_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const [profiles, vehicles, documents] = await Promise.all([parseJson(profileResponse), parseJson(vehicleResponse), parseJson(documentResponse)]);
        return response({ data: { profile: Array.isArray(profiles) ? profiles[0] || null : null, vehicles: Array.isArray(vehicles) ? vehicles : [], documents: Array.isArray(documents) ? documents : [] } }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "DRIVER_PROFILE_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    if (url.pathname === "/api/v1/driver/vehicles" && request.method === "POST") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env); }
      if (!isRecord(body) || !["standard","comfort","van","motorcycle","bicycle"].includes(String(body.vehicle_type))
        || typeof body.registration_number !== "string" || body.registration_number.trim().length < 2 || body.registration_number.trim().length > 24
        || (body.capacity !== undefined && (!Number.isInteger(body.capacity) || Number(body.capacity) < 1 || Number(body.capacity) > 20))) {
        return response({ error: { code: "INVALID_VEHICLE", request_id: requestId } }, 400, requestId, origin, env);
      }
      try {
        const driver = await databaseRequest(env, "sjelle_driver_profiles?user_id=eq." + encodeURIComponent(user.id) + "&select=user_id&limit=1");
        const driverRows = await parseJson(driver) as unknown[];
        if (!driver.ok) return response({ error: { code: "DRIVER_PROFILE_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        if (!Array.isArray(driverRows) || !driverRows.length) return response({ error: { code: "DRIVER_APPLICATION_REQUIRED", request_id: requestId } }, 409, requestId, origin, env);
        const result = await databaseRequest(env, "sjelle_vehicles", {
          method: "POST", headers: { prefer: "return=representation" },
          body: JSON.stringify({
            driver_id: user.id, vehicle_type: body.vehicle_type, registration_number: body.registration_number.trim().toUpperCase(),
            make: typeof body.make === "string" ? body.make.trim().slice(0,60) || null : null,
            model: typeof body.model === "string" ? body.model.trim().slice(0,60) || null : null,
            color: typeof body.color === "string" ? body.color.trim().slice(0,40) || null : null,
            capacity: body.capacity === undefined ? 4 : body.capacity,
            review_status: "pending",
          }),
        });
        const payload = await parseJson(result);
        if (!result.ok) return response({ error: { code: "VEHICLE_SAVE_FAILED", request_id: requestId } }, result.status === 409 ? 409 : 503, requestId, origin, env);
        return response({ data: Array.isArray(payload) ? payload[0] : payload }, 201, requestId, origin, env);
      } catch { return response({ error: { code: "VEHICLE_SAVE_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    if (url.pathname === "/api/v1/driver/documents" && request.method === "POST") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      if (!configured(env)) return response({ error: { code: "BACKEND_NOT_CONFIGURED", request_id: requestId } }, 503, requestId, origin, env);
      let form: FormData;
      try { form = await request.formData(); } catch { return response({ error: { code: "INVALID_DOCUMENT_UPLOAD", request_id: requestId } }, 400, requestId, origin, env); }
      const file = form.get("file");
      const documentType = form.get("document_type");
      const last4 = form.get("document_number_last4");
      const expiresAt = form.get("expires_at");
      if (!(file instanceof File) || !["identity","driving_licence","vehicle_registration","insurance","other_required"].includes(String(documentType))
        || file.size < 1 || file.size > 10 * 1024 * 1024
        || !["application/pdf","image/jpeg","image/png"].includes(file.type)) {
        return response({ error: { code: "INVALID_DOCUMENT_UPLOAD", message: "Upload a PDF, JPG or PNG document up to 10 MB.", request_id: requestId } }, 400, requestId, origin, env);
      }
      if (last4 !== null && (typeof last4 !== "string" || (last4.trim() && !/^[0-9A-Za-z]{4}$/.test(last4.trim())))) {
        return response({ error: { code: "INVALID_DOCUMENT_NUMBER", request_id: requestId } }, 400, requestId, origin, env);
      }
      if (expiresAt !== null && (typeof expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt))) {
        return response({ error: { code: "INVALID_DOCUMENT_EXPIRY", request_id: requestId } }, 400, requestId, origin, env);
      }
      const driverCheck = await databaseRequest(env, "sjelle_driver_profiles?user_id=eq." + encodeURIComponent(user.id) + "&select=user_id&limit=1");
      const driverRows = await parseJson(driverCheck) as unknown[];
      if (!driverCheck.ok) return response({ error: { code: "DRIVER_PROFILE_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
      if (!Array.isArray(driverRows) || !driverRows.length) return response({ error: { code: "DRIVER_APPLICATION_REQUIRED", request_id: requestId } }, 409, requestId, origin, env);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const isPdf = file.type === "application/pdf" && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
        const isJpeg = file.type === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        const isPng = file.type === "image/png" && bytes.slice(0,8).join(",") === "137,80,78,71,13,10,26,10";
        if (!isPdf && !isJpeg && !isPng) return response({ error: { code: "DOCUMENT_CONTENT_MISMATCH", request_id: requestId } }, 400, requestId, origin, env);
        const extension = isPdf ? "pdf" : isJpeg ? "jpg" : "png";
        const storagePath = user.id + "/" + crypto.randomUUID() + "." + extension;
        const upload = await fetch(supabaseUrl(env, "/storage/v1/object/sjelle-driver-documents/" + storagePath), {
          method: "POST",
          headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY!, authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY!, "content-type": file.type, "x-upsert": "false" },
          body: bytes,
        });
        if (!upload.ok) return response({ error: { code: "DOCUMENT_STORAGE_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const insert = await databaseRequest(env, "sjelle_driver_documents", {
          method: "POST", headers: { prefer: "return=representation" },
          body: JSON.stringify({
            driver_id: user.id, document_type: documentType, storage_path: storagePath,
            document_number_last4: typeof last4 === "string" && last4.trim() ? last4.trim() : null,
            expires_at: typeof expiresAt === "string" && expiresAt ? expiresAt : null,
            review_status: "pending",
          }),
        });
        const inserted = await parseJson(insert);
        if (!insert.ok) {
          await fetch(supabaseUrl(env, "/storage/v1/object/sjelle-driver-documents/" + storagePath), {
            method: "DELETE", headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY!, authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY! },
          });
          return response({ error: { code: "DOCUMENT_METADATA_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        }
        const row = Array.isArray(inserted) ? inserted[0] : null;
        return response({ data: row && isRecord(row) ? { id: row.id, document_type: row.document_type, review_status: row.review_status, expires_at: row.expires_at } : null }, 201, requestId, origin, env);
      } catch { return response({ error: { code: "DOCUMENT_UPLOAD_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    if (url.pathname === "/api/v1/driver/availability" && request.method === "PATCH") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env); }
      if (!isRecord(body) || typeof body.online !== "boolean" || (body.mode !== undefined && !["ride","delivery"].includes(String(body.mode)))) {
        return response({ error: { code: "INVALID_AVAILABILITY", request_id: requestId } }, 400, requestId, origin, env);
      }
      try {
        const profileResponse = await databaseRequest(env, "sjelle_driver_profiles?user_id=eq." + encodeURIComponent(user.id) + "&select=user_id,review_status,city_id,selected_mode&limit=1");
        const profiles = await parseJson(profileResponse) as Array<{ user_id: string; review_status: string; city_id: string; selected_mode: string | null }>;
        const profile = profiles[0];
        if (!profileResponse.ok) return response({ error: { code: "DRIVER_PROFILE_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        if (!profile) return response({ error: { code: "DRIVER_APPLICATION_REQUIRED", request_id: requestId } }, 409, requestId, origin, env);
        const mode = body.mode === undefined ? profile.selected_mode : String(body.mode);
        if (body.online && profile.review_status !== "approved") return response({ error: { code: "DRIVER_NOT_APPROVED", request_id: requestId } }, 409, requestId, origin, env);
        if (body.online) {
          const [docsResponse, vehicleResponse, cityResponse] = await Promise.all([
            databaseRequest(env, "sjelle_driver_documents?driver_id=eq." + encodeURIComponent(user.id) + "&review_status=eq.approved&select=document_type,expires_at"),
            databaseRequest(env, "sjelle_vehicles?driver_id=eq." + encodeURIComponent(user.id) + "&review_status=eq.approved&select=id&limit=1"),
            databaseRequest(env, "sjelle_cities?id=eq." + encodeURIComponent(profile.city_id) + "&select=active,rides_enabled,food_enabled&limit=1"),
          ]);
          const docs = await parseJson(docsResponse) as Array<{ document_type: string; expires_at: string | null }>;
          const vehicles = await parseJson(vehicleResponse) as unknown[];
          const cities = await parseJson(cityResponse) as Array<{ active: boolean; rides_enabled: boolean; food_enabled: boolean }>;
          const required = ["identity","driving_licence","vehicle_registration","insurance"];
          if (!docsResponse.ok || !vehicleResponse.ok || !cityResponse.ok) return response({ error: { code: "DRIVER_READINESS_CHECK_FAILED", request_id: requestId } }, 503, requestId, origin, env);
          if (!required.every(type => docs.some(doc => doc.document_type === type && (!doc.expires_at || doc.expires_at >= new Date().toISOString().slice(0,10)))) || !vehicles.length) {
            return response({ error: { code: "DRIVER_DOCUMENTS_NOT_APPROVED", message: "Identity, driving licence, vehicle registration and insurance must be approved, with at least one approved vehicle.", request_id: requestId } }, 409, requestId, origin, env);
          }
          const city = cities[0];
          if (!city || !city.active || (mode === "ride" && !city.rides_enabled) || (mode === "delivery" && !city.food_enabled)) {
            return response({ error: { code: "CITY_SERVICE_UNAVAILABLE", request_id: requestId } }, 409, requestId, origin, env);
          }
        }
        const update = await databaseRequest(env, "sjelle_driver_profiles?user_id=eq." + encodeURIComponent(user.id), {
          method: "PATCH", headers: { prefer: "return=representation" },
          body: JSON.stringify({ online: body.online, selected_mode: mode, updated_at: new Date().toISOString() }),
        });
        const payload = await parseJson(update);
        if (!update.ok) return response({ error: { code: "AVAILABILITY_UPDATE_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        return response({ data: Array.isArray(payload) ? payload[0] : payload }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "AVAILABILITY_UPDATE_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    if (url.pathname === "/api/v1/driver/location" && request.method === "POST") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env); }
      if (!isRecord(body) || typeof body.latitude !== "number" || typeof body.longitude !== "number"
        || body.latitude < -90 || body.latitude > 90 || body.longitude < -180 || body.longitude > 180
        || (body.accuracy_m !== undefined && (typeof body.accuracy_m !== "number" || body.accuracy_m < 0 || body.accuracy_m > 10000))) {
        return response({ error: { code: "INVALID_LOCATION", request_id: requestId } }, 400, requestId, origin, env);
      }
      try {
        const driver = await databaseRequest(env, "sjelle_driver_profiles?user_id=eq." + encodeURIComponent(user.id) + "&select=online,review_status&limit=1");
        const profiles = await parseJson(driver) as Array<{ online: boolean; review_status: string }>;
        if (!driver.ok) return response({ error: { code: "DRIVER_PROFILE_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        if (!profiles[0] || !profiles[0].online || profiles[0].review_status !== "approved") return response({ error: { code: "DRIVER_NOT_ONLINE", request_id: requestId } }, 409, requestId, origin, env);
        const result = await databaseRequest(env, "sjelle_driver_locations?on_conflict=driver_id", {
          method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ driver_id: user.id, latitude: body.latitude, longitude: body.longitude,
            accuracy_m: body.accuracy_m ?? null, heading_degrees: body.heading_degrees ?? null, recorded_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
        });
        if (!result.ok) return response({ error: { code: "LOCATION_UPDATE_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        return response({ data: { recorded: true } }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "LOCATION_UPDATE_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    const driverReviewMatch = url.pathname.match(/^\/api\/v1\/admin\/drivers\/([0-9a-f-]{36})\/review$/i);
    if (driverReviewMatch && request.method === "PATCH") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch {
        return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try { if (!await hasSjelleRole(env, user.id, "admin")) return response({ error: { code: "FORBIDDEN", request_id: requestId } }, 403, requestId, origin, env); }
      catch { return response({ error: { code: "ROLE_CHECK_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env); }
      if (!isRecord(body) || !["approved","rejected","suspended"].includes(String(body.review_status))) return response({ error: { code: "INVALID_REVIEW_STATUS", request_id: requestId } }, 400, requestId, origin, env);
      try {
        if (body.review_status === "approved") {
          const [docsResponse, vehicleResponse] = await Promise.all([
            databaseRequest(env, "sjelle_driver_documents?driver_id=eq." + encodeURIComponent(driverReviewMatch[1]) + "&review_status=eq.approved&select=document_type"),
            databaseRequest(env, "sjelle_vehicles?driver_id=eq." + encodeURIComponent(driverReviewMatch[1]) + "&review_status=eq.approved&select=id&limit=1"),
          ]);
          const docs = await parseJson(docsResponse) as Array<{ document_type: string }>;
          const vehicles = await parseJson(vehicleResponse) as unknown[];
          if (!docsResponse.ok || !vehicleResponse.ok) return response({ error: { code: "DRIVER_READINESS_CHECK_FAILED", request_id: requestId } }, 503, requestId, origin, env);
          if (!["identity","driving_licence","vehicle_registration","insurance"].every(type => docs.some(doc => doc.document_type === type && (!doc.expires_at || doc.expires_at >= new Date().toISOString().slice(0,10)))) || !vehicles.length) {
            return response({ error: { code: "DRIVER_DOCUMENTS_NOT_APPROVED", request_id: requestId } }, 409, requestId, origin, env);
          }
        }
        const result = await databaseRequest(env, "sjelle_driver_profiles?user_id=eq." + encodeURIComponent(driverReviewMatch[1]), {
          method: "PATCH", headers: { prefer: "return=representation" },
          body: JSON.stringify({ review_status: body.review_status, approved_at: body.review_status === "approved" ? new Date().toISOString() : null,
            approved_by: body.review_status === "approved" ? user.id : null, online: false, updated_at: new Date().toISOString() }),
        });
        const payload = await parseJson(result);
        if (!result.ok) return response({ error: { code: "DRIVER_REVIEW_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        if (!Array.isArray(payload) || !payload.length) return response({ error: { code: "DRIVER_NOT_FOUND", request_id: requestId } }, 404, requestId, origin, env);
        await databaseRequest(env, "sjelle_audit_logs", { method: "POST", body: JSON.stringify({ actor_id: user.id, action: "driver.reviewed", target_type: "driver", target_id: driverReviewMatch[1], metadata: { review_status: body.review_status } }) });
        return response({ data: { user_id: driverReviewMatch[1], review_status: body.review_status, online: false } }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "DRIVER_REVIEW_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    const documentReviewMatch = url.pathname.match(/^\/api\/v1\/admin\/driver-documents\/([0-9a-f-]{36})\/review$/i);
    if (documentReviewMatch && request.method === "PATCH") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try { if (!await hasSjelleRole(env, user.id, "admin")) return response({ error: { code: "FORBIDDEN", request_id: requestId } }, 403, requestId, origin, env); }
      catch { return response({ error: { code: "ROLE_CHECK_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env); }
      if (!isRecord(body) || !["approved","rejected"].includes(String(body.review_status)) || (body.rejection_reason !== undefined && typeof body.rejection_reason !== "string")) {
        return response({ error: { code: "INVALID_REVIEW_STATUS", request_id: requestId } }, 400, requestId, origin, env);
      }
      try {
        const result = await databaseRequest(env, "sjelle_driver_documents?id=eq." + encodeURIComponent(documentReviewMatch[1]), {
          method: "PATCH", headers: { prefer: "return=representation" },
          body: JSON.stringify({ review_status: body.review_status, reviewed_at: new Date().toISOString(), reviewed_by: user.id,
            rejection_reason: body.review_status === "rejected" ? String(body.rejection_reason || "Document rejected").slice(0,300) : null }),
        });
        const payload = await parseJson(result);
        if (!result.ok) return response({ error: { code: "DOCUMENT_REVIEW_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        if (!Array.isArray(payload) || !payload.length) return response({ error: { code: "DOCUMENT_NOT_FOUND", request_id: requestId } }, 404, requestId, origin, env);
        await databaseRequest(env, "sjelle_audit_logs", { method: "POST", body: JSON.stringify({ actor_id: user.id, action: "driver_document.reviewed", target_type: "driver_document", target_id: documentReviewMatch[1], metadata: { review_status: body.review_status } }) });
        return response({ data: { id: payload[0].id, document_type: payload[0].document_type, review_status: payload[0].review_status } }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "DOCUMENT_REVIEW_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    const vehicleReviewMatch = url.pathname.match(/^\/api\/v1\/admin\/vehicles\/([0-9a-f-]{36})\/review$/i);
    if (vehicleReviewMatch && request.method === "PATCH") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try { if (!await hasSjelleRole(env, user.id, "admin")) return response({ error: { code: "FORBIDDEN", request_id: requestId } }, 403, requestId, origin, env); }
      catch { return response({ error: { code: "ROLE_CHECK_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env); }
      if (!isRecord(body) || !["approved","rejected"].includes(String(body.review_status)) || (body.document_expires_at !== undefined && body.document_expires_at !== null && (typeof body.document_expires_at !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.document_expires_at)))) {
        return response({ error: { code: "INVALID_REVIEW_STATUS", request_id: requestId } }, 400, requestId, origin, env);
      }
      try {
        const result = await databaseRequest(env, "sjelle_vehicles?id=eq." + encodeURIComponent(vehicleReviewMatch[1]), {
          method: "PATCH", headers: { prefer: "return=representation" },
          body: JSON.stringify({ review_status: body.review_status, verified_at: body.review_status === "approved" ? new Date().toISOString() : null,
            verified_by: body.review_status === "approved" ? user.id : null, document_expires_at: body.document_expires_at ?? null }),
        });
        const payload = await parseJson(result);
        if (!result.ok) return response({ error: { code: "VEHICLE_REVIEW_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        if (!Array.isArray(payload) || !payload.length) return response({ error: { code: "VEHICLE_NOT_FOUND", request_id: requestId } }, 404, requestId, origin, env);
        await databaseRequest(env, "sjelle_audit_logs", { method: "POST", body: JSON.stringify({ actor_id: user.id, action: "vehicle.reviewed", target_type: "vehicle", target_id: vehicleReviewMatch[1], metadata: { review_status: body.review_status } }) });
        return response({ data: { id: payload[0].id, review_status: payload[0].review_status } }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "VEHICLE_REVIEW_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }


    if (url.pathname === "/api/v1/driver/offers" && request.method === "GET") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try {
        const result = await databaseRequest(env, "sjelle_driver_offers?driver_id=eq." + encodeURIComponent(user.id) + "&status=eq.offered&expires_at=gt." + encodeURIComponent(new Date().toISOString()) + "&select=id,job_kind,ride_id,delivery_job_id,expires_at,created_at&order=created_at.desc&limit=20");
        if (!result.ok) return response({ error: { code: "DRIVER_OFFERS_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const offers = await parseJson(result) as Array<Record<string, unknown>>;
        const data = await Promise.all((Array.isArray(offers) ? offers : []).map(async offer => {
          if (offer.job_kind === "ride" && typeof offer.ride_id === "string") {
            const rideResponse = await databaseRequest(env, "sjelle_rides?id=eq." + encodeURIComponent(offer.ride_id) + "&select=id,pickup_label,destination_label,quoted_amount_cents,status,vehicle_type&limit=1");
            const rides = await parseJson(rideResponse) as unknown[];
            return { ...offer, job: Array.isArray(rides) ? rides[0] || null : null };
          }
          if (offer.job_kind === "delivery" && typeof offer.delivery_job_id === "string") {
            const jobResponse = await databaseRequest(env, "sjelle_delivery_jobs?id=eq." + encodeURIComponent(offer.delivery_job_id) + "&select=id,status,order_id,pickup_lat,pickup_lon&limit=1");
            const jobs = await parseJson(jobResponse) as Array<{ id: string; status: string; order_id: string; pickup_lat: number; pickup_lon: number }>;
            const job = jobs[0];
            if (!job) return { ...offer, job: null };
            const orderResponse = await databaseRequest(env, "sjelle_food_orders?id=eq." + encodeURIComponent(job.order_id) + "&select=id,restaurant_id,status,total_cents,prep_time_minutes&limit=1");
            const orders = await parseJson(orderResponse) as Array<{ id: string; restaurant_id: string; status: string; total_cents: number; prep_time_minutes: number | null }>;
            const order = orders[0];
            if (!order) return { ...offer, job: { id: job.id, status: job.status, pickup_lat: job.pickup_lat, pickup_lon: job.pickup_lon } };
            const restaurantResponse = await databaseRequest(env, "sjelle_restaurants?id=eq." + encodeURIComponent(order.restaurant_id) + "&select=name,address_text&limit=1");
            const restaurants = await parseJson(restaurantResponse) as unknown[];
            return { ...offer, job: { id: job.id, status: job.status, pickup_lat: job.pickup_lat, pickup_lon: job.pickup_lon, order_status: order.status, total_cents: order.total_cents, prep_time_minutes: order.prep_time_minutes, restaurant: Array.isArray(restaurants) ? restaurants[0] || null : null } };
          }
          return { ...offer, job: null };
        }));
        return response({ data }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "DRIVER_OFFERS_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    const driverOfferResponseMatch = url.pathname.match(/^\/api\/v1\/driver\/offers\/([0-9a-f-]{36})\/respond$/i);
    if (driverOfferResponseMatch && request.method === "POST") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env); }
      if (!isRecord(body) || !["accept","reject"].includes(String(body.response))) return response({ error: { code: "INVALID_OFFER_RESPONSE", request_id: requestId } }, 400, requestId, origin, env);
      try {
        const result = await databaseRequest(env, "rpc/sjelle_respond_driver_offer", {
          method: "POST", body: JSON.stringify({ p_driver_id: user.id, p_offer_id: driverOfferResponseMatch[1], p_response: body.response }),
        });
        const payload = await parseJson(result);
        if (!result.ok) {
          const code = isRecord(payload) && typeof payload.message === "string" ? payload.message : "OFFER_RESPONSE_FAILED";
          const status = code === "OFFER_NOT_FOUND" ? 404 : ["OFFER_EXPIRED","DRIVER_NOT_AVAILABLE","JOB_NOT_AVAILABLE"].includes(code) ? 409 : 503;
          return response({ error: { code, request_id: requestId } }, status, requestId, origin, env);
        }
        return response({ data: payload }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "OFFER_RESPONSE_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    const driverJobMatch = url.pathname.match(/^\/api\/v1\/driver\/jobs\/(ride|delivery)\/([0-9a-f-]{36})\/status$/i);
    if (driverJobMatch && request.method === "POST") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env); }
      const allowed = driverJobMatch[1] === "ride"
        ? ["driver_arriving","driver_arrived","in_progress","completed"]
        : ["arriving","arrived","picked_up","delivered"];
      if (!isRecord(body) || !allowed.includes(String(body.status)) || (body.cash_collected !== undefined && typeof body.cash_collected !== "boolean")) {
        return response({ error: { code: "INVALID_JOB_TRANSITION", request_id: requestId } }, 400, requestId, origin, env);
      }
      try {
        const result = await databaseRequest(env, "rpc/sjelle_driver_update_job", {
          method: "POST", body: JSON.stringify({ p_driver_id: user.id, p_job_kind: driverJobMatch[1], p_job_id: driverJobMatch[2], p_next_status: body.status, p_cash_collected: body.cash_collected === true }),
        });
        const payload = await parseJson(result);
        if (!result.ok) {
          const code = isRecord(payload) && typeof payload.message === "string" ? payload.message : "JOB_UPDATE_FAILED";
          const status = code === "JOB_NOT_FOUND" ? 404 : ["DRIVER_NOT_APPROVED","ORDER_NOT_READY_FOR_PICKUP","INVALID_JOB_TRANSITION"].includes(code) ? 409 : 503;
          return response({ error: { code, request_id: requestId } }, status, requestId, origin, env);
        }
        return response({ data: payload }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "JOB_UPDATE_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    const adminDispatchMatch = url.pathname.match(/^\/api\/v1\/admin\/dispatch\/(ride|delivery)\/([0-9a-f-]{36})$/i);
    if (adminDispatchMatch && request.method === "POST") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try { if (!await hasSjelleRole(env, user.id, "admin")) return response({ error: { code: "FORBIDDEN", request_id: requestId } }, 403, requestId, origin, env); }
      catch { return response({ error: { code: "ROLE_CHECK_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
      try {
        const result = await databaseRequest(env, "rpc/sjelle_offer_next_driver", {
          method: "POST", body: JSON.stringify({ p_job_kind: adminDispatchMatch[1], p_job_id: adminDispatchMatch[2] }),
        });
        const payload = await parseJson(result);
        if (!result.ok) return response({ error: { code: "DISPATCH_RETRY_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        return response({ data: payload }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "DISPATCH_RETRY_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }


    if (url.pathname === "/api/v1/admin/cities" && request.method === "GET") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try { if (!await hasSjelleRole(env, user.id, "admin")) return response({ error: { code: "FORBIDDEN", request_id: requestId } }, 403, requestId, origin, env); }
      catch { return response({ error: { code: "ROLE_CHECK_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
      try {
        const [citiesResponse, pricingResponse] = await Promise.all([
          databaseRequest(env, "sjelle_cities?select=id,slug,name,active,rides_enabled,food_enabled&order=name.asc"),
          databaseRequest(env, "sjelle_city_pricing?select=city_id,version,food_delivery_fee_cents,food_service_fee_cents,food_minimum_subtotal_cents,ride_base_fare_cents,ride_minimum_fare_cents,ride_per_km_cents,ride_per_minute_cents,active,updated_at"),
        ]);
        if (!citiesResponse.ok || !pricingResponse.ok) return response({ error: { code: "ADMIN_CITY_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const [cities, pricing] = await Promise.all([parseJson(citiesResponse), parseJson(pricingResponse)]);
        return response({ data: Array.isArray(cities) ? cities.map(city => ({
          ...city, pricing: Array.isArray(pricing) ? pricing.find(p => p.city_id === city.id) || null : null,
        })) : [] }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "ADMIN_CITY_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    const adminPricingMatch = url.pathname.match(/^\/api\/v1\/admin\/cities\/([a-z0-9-]{2,60})\/pricing$/i);
    if (adminPricingMatch && request.method === "PUT") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try { if (!await hasSjelleRole(env, user.id, "admin")) return response({ error: { code: "FORBIDDEN", request_id: requestId } }, 403, requestId, origin, env); }
      catch { return response({ error: { code: "ROLE_CHECK_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env); }
      const integerFields = ["food_delivery_fee_cents","food_service_fee_cents","food_minimum_subtotal_cents","ride_base_fare_cents","ride_minimum_fare_cents","ride_per_km_cents","ride_per_minute_cents"];
      if (!isRecord(body) || typeof body.version !== "string" || !/^[a-zA-Z0-9._-]{1,40}$/.test(body.version)
        || integerFields.some(field => !Number.isSafeInteger(body[field]) || Number(body[field]) < 0)
        || (body.active !== undefined && typeof body.active !== "boolean")) {
        return response({ error: { code: "INVALID_CITY_PRICING", message: "Provide a version and non-negative integer fees/rates in euro cents.", request_id: requestId } }, 400, requestId, origin, env);
      }
      try {
        const cityResponse = await databaseRequest(env, "sjelle_cities?slug=eq." + encodeURIComponent(adminPricingMatch[1].toLowerCase()) + "&select=id&limit=1");
        const cities = await parseJson(cityResponse) as Array<{ id: string }>;
        if (!cityResponse.ok) return response({ error: { code: "CITY_LOOKUP_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        if (!cities.length) return response({ error: { code: "CITY_NOT_FOUND", request_id: requestId } }, 404, requestId, origin, env);
        const result = await databaseRequest(env, "sjelle_city_pricing?on_conflict=city_id", {
          method: "POST", headers: { prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify({
            city_id: cities[0].id, version: body.version,
            food_delivery_fee_cents: body.food_delivery_fee_cents, food_service_fee_cents: body.food_service_fee_cents,
            food_minimum_subtotal_cents: body.food_minimum_subtotal_cents, ride_base_fare_cents: body.ride_base_fare_cents,
            ride_minimum_fare_cents: body.ride_minimum_fare_cents, ride_per_km_cents: body.ride_per_km_cents,
            ride_per_minute_cents: body.ride_per_minute_cents, active: body.active === true, updated_at: new Date().toISOString(),
          }),
        });
        const payload = await parseJson(result);
        if (!result.ok) return response({ error: { code: "CITY_PRICING_SAVE_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        await databaseRequest(env, "sjelle_audit_logs", { method: "POST", body: JSON.stringify({ actor_id: user.id, action: "city.pricing.updated", target_type: "city", target_id: cities[0].id, metadata: { version: body.version, active: body.active === true } }) });
        return response({ data: Array.isArray(payload) ? payload[0] : payload }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "CITY_PRICING_SAVE_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }


    if (url.pathname === "/api/v1/admin/routes" && request.method === "GET") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try { if (!await hasSjelleRole(env, user.id, "admin")) return response({ error: { code: "FORBIDDEN", request_id: requestId } }, 403, requestId, origin, env); }
      catch { return response({ error: { code: "ROLE_CHECK_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
      const citySlug = (url.searchParams.get("city") || "").trim().toLowerCase();
      if (!/^[a-z0-9-]{2,60}$/.test(citySlug)) return response({ error: { code: "CITY_REQUIRED", request_id: requestId } }, 400, requestId, origin, env);
      try {
        const cityResponse = await databaseRequest(env, "sjelle_cities?slug=eq." + encodeURIComponent(citySlug) + "&select=id&limit=1");
        const cities = await parseJson(cityResponse) as Array<{ id: string }>;
        if (!cityResponse.ok) return response({ error: { code: "CITY_LOOKUP_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        if (!cities.length) return response({ error: { code: "CITY_NOT_FOUND", request_id: requestId } }, 404, requestId, origin, env);
        const result = await databaseRequest(env, "sjelle_fixed_route_prices?city_id=eq." + encodeURIComponent(cities[0].id) + "&select=id,route_key,origin_label,destination_label,vehicle_type,amount_cents,version,active,origin_lat,origin_lon,destination_lat,destination_lon,effective_from,effective_until&order=created_at.desc");
        if (!result.ok) return response({ error: { code: "ROUTES_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const rows = await parseJson(result);
        return response({ data: Array.isArray(rows) ? rows : [] }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "ROUTES_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    if (url.pathname === "/api/v1/admin/routes" && request.method === "POST") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try { if (!await hasSjelleRole(env, user.id, "admin")) return response({ error: { code: "FORBIDDEN", request_id: requestId } }, 403, requestId, origin, env); }
      catch { return response({ error: { code: "ROLE_CHECK_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env); }
      if (!isRecord(body) || typeof body.city !== "string" || typeof body.route_key !== "string" || !/^[a-z0-9-]{2,80}$/.test(body.route_key)
        || typeof body.origin_label !== "string" || body.origin_label.trim().length < 2 || body.origin_label.length > 160
        || typeof body.destination_label !== "string" || body.destination_label.trim().length < 2 || body.destination_label.length > 160
        || !["standard","comfort","van"].includes(String(body.vehicle_type)) || !Number.isSafeInteger(body.amount_cents) || Number(body.amount_cents) < 1
        || typeof body.version !== "string" || !/^[a-zA-Z0-9._-]{1,40}$/.test(body.version)
        || typeof body.origin_lat !== "number" || body.origin_lat < -90 || body.origin_lat > 90
        || typeof body.origin_lon !== "number" || body.origin_lon < -180 || body.origin_lon > 180
        || typeof body.destination_lat !== "number" || body.destination_lat < -90 || body.destination_lat > 90
        || typeof body.destination_lon !== "number" || body.destination_lon < -180 || body.destination_lon > 180) {
        return response({ error: { code: "INVALID_ROUTE", request_id: requestId } }, 400, requestId, origin, env);
      }
      try {
        const cityResponse = await databaseRequest(env, "sjelle_cities?slug=eq." + encodeURIComponent(body.city.trim().toLowerCase()) + "&select=id&limit=1");
        const cities = await parseJson(cityResponse) as Array<{ id: string }>;
        if (!cityResponse.ok) return response({ error: { code: "CITY_LOOKUP_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        if (!cities.length) return response({ error: { code: "CITY_NOT_FOUND", request_id: requestId } }, 404, requestId, origin, env);
        const result = await databaseRequest(env, "sjelle_fixed_route_prices", {
          method: "POST", headers: { prefer: "return=representation" },
          body: JSON.stringify({
            city_id: cities[0].id, route_key: body.route_key, origin_label: body.origin_label.trim(),
            destination_label: body.destination_label.trim(), vehicle_type: body.vehicle_type, amount_cents: body.amount_cents,
            currency: "EUR", version: body.version, active: false, created_by: user.id,
            origin_lat: body.origin_lat, origin_lon: body.origin_lon, destination_lat: body.destination_lat, destination_lon: body.destination_lon,
          }),
        });
        const payload = await parseJson(result);
        if (!result.ok) return response({ error: { code: "ROUTE_CREATE_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        await databaseRequest(env, "sjelle_audit_logs", { method: "POST", body: JSON.stringify({ actor_id: user.id, action: "ride_route.created", target_type: "fixed_route", target_id: Array.isArray(payload) ? payload[0]?.id : "", metadata: { route_key: body.route_key, amount_cents: body.amount_cents } }) });
        return response({ data: Array.isArray(payload) ? payload[0] : payload }, 201, requestId, origin, env);
      } catch { return response({ error: { code: "ROUTE_CREATE_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    const adminRouteMatch = url.pathname.match(/^\/api\/v1\/admin\/routes\/([0-9a-f-]{36})$/i);
    if (adminRouteMatch && request.method === "PATCH") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try { if (!await hasSjelleRole(env, user.id, "admin")) return response({ error: { code: "FORBIDDEN", request_id: requestId } }, 403, requestId, origin, env); }
      catch { return response({ error: { code: "ROLE_CHECK_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env); }
      if (!isRecord(body) || typeof body.active !== "boolean") return response({ error: { code: "INVALID_ROUTE_STATUS", request_id: requestId } }, 400, requestId, origin, env);
      try {
        if (body.active) {
          const routeResponse = await databaseRequest(env, "sjelle_fixed_route_prices?id=eq." + encodeURIComponent(adminRouteMatch[1]) + "&select=id,city_id,origin_lat,origin_lon,destination_lat,destination_lon,amount_cents&limit=1");
          const routes = await parseJson(routeResponse) as Array<{ id: string; city_id: string; origin_lat: number | null; origin_lon: number | null; destination_lat: number | null; destination_lon: number | null; amount_cents: number }>;
          if (!routeResponse.ok) return response({ error: { code: "ROUTE_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
          if (!routes.length) return response({ error: { code: "ROUTE_NOT_FOUND", request_id: requestId } }, 404, requestId, origin, env);
          const route = routes[0];
          if (route.origin_lat === null || route.origin_lon === null || route.destination_lat === null || route.destination_lon === null || route.amount_cents < 1) {
            return response({ error: { code: "ROUTE_COORDINATES_REQUIRED", request_id: requestId } }, 409, requestId, origin, env);
          }
          const pricing = await databaseRequest(env, "sjelle_city_pricing?city_id=eq." + encodeURIComponent(route.city_id) + "&active=eq.true&select=city_id&limit=1");
          const pricingRows = await parseJson(pricing) as unknown[];
          if (!pricing.ok || !pricingRows.length) return response({ error: { code: "CITY_PRICING_NOT_CONFIGURED", request_id: requestId } }, 409, requestId, origin, env);
        }
        const result = await databaseRequest(env, "sjelle_fixed_route_prices?id=eq." + encodeURIComponent(adminRouteMatch[1]), {
          method: "PATCH", headers: { prefer: "return=representation" }, body: JSON.stringify({ active: body.active }),
        });
        const payload = await parseJson(result);
        if (!result.ok) return response({ error: { code: "ROUTE_UPDATE_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        if (!Array.isArray(payload) || !payload.length) return response({ error: { code: "ROUTE_NOT_FOUND", request_id: requestId } }, 404, requestId, origin, env);
        await databaseRequest(env, "sjelle_audit_logs", { method: "POST", body: JSON.stringify({ actor_id: user.id, action: "ride_route.activation_changed", target_type: "fixed_route", target_id: adminRouteMatch[1], metadata: { active: body.active } }) });
        return response({ data: payload[0] }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "ROUTE_UPDATE_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    const adminCityServicesMatch = url.pathname.match(/^\/api\/v1\/admin\/cities\/([a-z0-9-]{2,60})\/services$/i);
    if (adminCityServicesMatch && request.method === "PATCH") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try { if (!await hasSjelleRole(env, user.id, "admin")) return response({ error: { code: "FORBIDDEN", request_id: requestId } }, 403, requestId, origin, env); }
      catch { return response({ error: { code: "ROLE_CHECK_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
      let body: unknown;
      try { body = await request.json(); } catch { return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env); }
      if (!isRecord(body) || typeof body.active !== "boolean" || typeof body.rides_enabled !== "boolean" || typeof body.food_enabled !== "boolean"
        || typeof body.confirm_ready !== "boolean" || typeof body.reason !== "string" || body.reason.trim().length < 8 || body.reason.length > 500
        || (body.active && !body.rides_enabled && !body.food_enabled)) {
        return response({ error: { code: "INVALID_CITY_ACTIVATION", message: "Provide explicit service flags, confirm_ready=true and an operational readiness reason.", request_id: requestId } }, 400, requestId, origin, env);
      }
      try {
        const cityResponse = await databaseRequest(env, "sjelle_cities?slug=eq." + encodeURIComponent(adminCityServicesMatch[1].toLowerCase()) + "&select=id&limit=1");
        const cities = await parseJson(cityResponse) as Array<{ id: string }>;
        if (!cityResponse.ok) return response({ error: { code: "CITY_LOOKUP_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        if (!cities.length) return response({ error: { code: "CITY_NOT_FOUND", request_id: requestId } }, 404, requestId, origin, env);
        const cityId = cities[0].id;
        if (body.active) {
          const pricingResponse = await databaseRequest(env, "sjelle_city_pricing?city_id=eq." + encodeURIComponent(cityId) + "&active=eq.true&select=city_id&limit=1");
          const pricing = await parseJson(pricingResponse) as unknown[];
          if (!pricingResponse.ok || !pricing.length) return response({ error: { code: "CITY_PRICING_NOT_CONFIGURED", request_id: requestId } }, 409, requestId, origin, env);
          if (body.food_enabled) {
            const restaurantResponse = await databaseRequest(env, "sjelle_restaurants?city_id=eq." + encodeURIComponent(cityId) + "&approval_status=eq.approved&is_open=eq.true&delivery_enabled=eq.true&select=id&limit=1");
            const restaurants = await parseJson(restaurantResponse) as unknown[];
            if (!restaurantResponse.ok || !restaurants.length) return response({ error: { code: "NO_READY_RESTAURANTS", request_id: requestId } }, 409, requestId, origin, env);
          }
          if (body.rides_enabled) {
            const [routeResponse, driverResponse] = await Promise.all([
              databaseRequest(env, "sjelle_fixed_route_prices?city_id=eq." + encodeURIComponent(cityId) + "&active=eq.true&origin_lat=not.is.null&origin_lon=not.is.null&destination_lat=not.is.null&destination_lon=not.is.null&select=id&limit=1"),
              databaseRequest(env, "sjelle_driver_profiles?city_id=eq." + encodeURIComponent(cityId) + "&review_status=eq.approved&select=user_id&limit=1"),
            ]);
            const [routes, drivers] = await Promise.all([parseJson(routeResponse), parseJson(driverResponse)]);
            if (!routeResponse.ok || !Array.isArray(routes) || !routes.length) return response({ error: { code: "NO_READY_RIDE_ROUTES", request_id: requestId } }, 409, requestId, origin, env);
            if (!driverResponse.ok || !Array.isArray(drivers) || !drivers.length) return response({ error: { code: "NO_APPROVED_DRIVERS", request_id: requestId } }, 409, requestId, origin, env);
          }
        }
        const result = await databaseRequest(env, "sjelle_cities?id=eq." + encodeURIComponent(cityId), {
          method: "PATCH", headers: { prefer: "return=representation" },
          body: JSON.stringify({ active: body.active, rides_enabled: body.active && body.rides_enabled, food_enabled: body.active && body.food_enabled }),
        });
        const payload = await parseJson(result);
        if (!result.ok) return response({ error: { code: "CITY_ACTIVATION_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        await databaseRequest(env, "sjelle_audit_logs", { method: "POST", body: JSON.stringify({ actor_id: user.id, action: "city.services.updated", target_type: "city", target_id: cityId, reason: body.reason.trim(), metadata: { active: body.active, rides_enabled: body.active && body.rides_enabled, food_enabled: body.active && body.food_enabled } }) });
        return response({ data: Array.isArray(payload) ? payload[0] : payload }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "CITY_ACTIVATION_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }


    if (url.pathname === "/api/v1/merchant/orders" && request.method === "GET") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try {
        const [ownedResponse, staffResponse] = await Promise.all([
          databaseRequest(env, "sjelle_restaurants?owner_id=eq." + encodeURIComponent(user.id) + "&select=id,name,slug,city_id,is_open,delivery_enabled&order=name.asc"),
          databaseRequest(env, "sjelle_restaurant_staff?user_id=eq." + encodeURIComponent(user.id) + "&can_manage_orders=eq.true&select=restaurant_id"),
        ]);
        if (!ownedResponse.ok || !staffResponse.ok) return response({ error: { code: "MERCHANT_ACCESS_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const owned = await parseJson(ownedResponse) as Array<Record<string, unknown>>;
        const staff = await parseJson(staffResponse) as Array<{ restaurant_id: string }>;
        const restaurants = [...(Array.isArray(owned) ? owned : [])];
        const ids = new Set(restaurants.map(r => String(r.id)));
        for (const item of Array.isArray(staff) ? staff : []) {
          if (!ids.has(item.restaurant_id)) {
            const lookup = await databaseRequest(env, "sjelle_restaurants?id=eq." + encodeURIComponent(item.restaurant_id) + "&select=id,name,slug,city_id,is_open,delivery_enabled&limit=1");
            const found = await parseJson(lookup) as Array<Record<string, unknown>>;
            if (Array.isArray(found) && found[0]) { restaurants.push(found[0]); ids.add(String(found[0].id)); }
          }
        }
        if (!restaurants.length) return response({ data: { restaurants: [], orders: [] } }, 200, requestId, origin, env);
        const inFilter = "in.(" + [...ids].join(",") + ")";
        const orderResponse = await databaseRequest(env, "sjelle_food_orders?restaurant_id=" + inFilter + "&select=id,restaurant_id,status,payment_method,sjelle_cash_status,item_subtotal_cents,delivery_fee_cents,service_fee_cents,total_cents,currency,delivery_address_text,delivery_instructions,created_at,prep_time_minutes,ready_at,accepted_at,updated_at,sjelle_food_order_items(id,item_name_snapshot,unit_price_cents,quantity,line_total_cents)&order=created_at.asc&limit=100");
        if (!orderResponse.ok) return response({ error: { code: "MERCHANT_ORDERS_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const orders = await parseJson(orderResponse) as Array<Record<string, unknown>>;
        return response({ data: { restaurants, orders: Array.isArray(orders) ? orders : [] } }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "MERCHANT_ORDERS_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    if (url.pathname === "/api/v1/driver/jobs" && request.method === "GET") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try {
        const [ridesResponse, jobsResponse] = await Promise.all([
          databaseRequest(env, "sjelle_rides?driver_id=eq." + encodeURIComponent(user.id) + "&status=in.(driver_assigned,driver_arriving,driver_arrived,in_progress)&select=id,vehicle_type,pickup_label,pickup_lat,pickup_lon,destination_label,destination_lat,destination_lon,status,quoted_amount_cents,payment_method,sjelle_cash_status,requested_at&order=requested_at.desc"),
          databaseRequest(env, "sjelle_delivery_jobs?driver_id=eq." + encodeURIComponent(user.id) + "&status=in.(assigned,arriving,arrived,in_progress)&select=id,order_id,status,pickup_lat,pickup_lon,delivery_lat,delivery_lon,assigned_at,picked_up_at"),
        ]);
        if (!ridesResponse.ok || !jobsResponse.ok) return response({ error: { code: "DRIVER_JOBS_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const [rides, jobs] = await Promise.all([parseJson(ridesResponse), parseJson(jobsResponse)]);
        const deliveries = await Promise.all((Array.isArray(jobs) ? jobs : []).map(async job => {
          if (!isRecord(job) || typeof job.order_id !== "string") return job;
          const orderResponse = await databaseRequest(env, "sjelle_food_orders?id=eq." + encodeURIComponent(job.order_id) + "&select=id,status,total_cents,delivery_address_text,delivery_instructions,sjelle_cash_status,restaurant_id,ready_at&limit=1");
          const orders = await parseJson(orderResponse) as Array<Record<string, unknown>>;
          const order = orders[0];
          if (!order) return { ...job, order: null };
          const restaurantResponse = await databaseRequest(env, "sjelle_restaurants?id=eq." + encodeURIComponent(String(order.restaurant_id)) + "&select=name,address_text,latitude,longitude&limit=1");
          const restaurants = await parseJson(restaurantResponse);
          return { ...job, order, restaurant: Array.isArray(restaurants) ? restaurants[0] || null : null };
        }));
        return response({ data: { rides: Array.isArray(rides) ? rides : [], deliveries } }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "DRIVER_JOBS_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    if (url.pathname === "/api/v1/admin/driver-documents" && request.method === "GET") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try { if (!await hasSjelleRole(env, user.id, "admin")) return response({ error: { code: "FORBIDDEN", request_id: requestId } }, 403, requestId, origin, env); }
      catch { return response({ error: { code: "ROLE_CHECK_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
      try {
        const [docsResponse, vehiclesResponse, driversResponse] = await Promise.all([
          databaseRequest(env, "sjelle_driver_documents?review_status=eq.pending&select=id,driver_id,document_type,document_number_last4,expires_at,review_status,created_at&order=created_at.asc&limit=100"),
          databaseRequest(env, "sjelle_vehicles?review_status=eq.pending&select=id,driver_id,vehicle_type,make,model,color,registration_number,document_expires_at,created_at&order=created_at.asc&limit=100"),
          databaseRequest(env, "sjelle_driver_profiles?review_status=eq.pending&select=user_id,city_id,selected_mode,created_at&order=created_at.asc&limit=100"),
        ]);
        if (!docsResponse.ok || !vehiclesResponse.ok || !driversResponse.ok) return response({ error: { code: "ADMIN_DRIVER_QUEUE_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const [documents, vehicles, drivers] = await Promise.all([parseJson(docsResponse), parseJson(vehiclesResponse), parseJson(driversResponse)]);
        return response({ data: { documents, vehicles, drivers } }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "ADMIN_DRIVER_QUEUE_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    const signedDocumentMatch = url.pathname.match(/^\/api\/v1\/admin\/driver-documents\/([0-9a-f-]{36})\/signed-url$/i);
    if (signedDocumentMatch && request.method === "POST") {
      let user: AuthUser | null;
      try { user = await requireUser(request, env); } catch { return response({ error: { code: "AUTH_PROVIDER_UNAVAILABLE", request_id: requestId } }, 503, requestId, origin, env); }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);
      try { if (!await hasSjelleRole(env, user.id, "admin")) return response({ error: { code: "FORBIDDEN", request_id: requestId } }, 403, requestId, origin, env); }
      catch { return response({ error: { code: "ROLE_CHECK_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
      if (!configured(env)) return response({ error: { code: "BACKEND_NOT_CONFIGURED", request_id: requestId } }, 503, requestId, origin, env);
      try {
        const docResponse = await databaseRequest(env, "sjelle_driver_documents?id=eq." + encodeURIComponent(signedDocumentMatch[1]) + "&select=storage_path&limit=1");
        const docs = await parseJson(docResponse) as Array<{ storage_path: string }>;
        if (!docResponse.ok) return response({ error: { code: "DOCUMENT_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        if (!docs.length) return response({ error: { code: "DOCUMENT_NOT_FOUND", request_id: requestId } }, 404, requestId, origin, env);
        const signed = await fetch(supabaseUrl(env, "/storage/v1/object/sign/sjelle-driver-documents/" + docs[0].storage_path), {
          method: "POST",
          headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY!, authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY!, "content-type": "application/json" },
          body: JSON.stringify({ expiresIn: 300 }),
        });
        const payload = await parseJson(signed);
        if (!signed.ok || !isRecord(payload) || typeof payload.signedURL !== "string") return response({ error: { code: "SIGNED_URL_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        const base = env.SUPABASE_URL!.replace(/\/+$/, "");
        const relative = payload.signedURL.startsWith("http") ? payload.signedURL : (payload.signedURL.startsWith("/storage/v1/") ? base + payload.signedURL : base + "/storage/v1" + (payload.signedURL.startsWith("/") ? payload.signedURL : "/" + payload.signedURL));
        await databaseRequest(env, "sjelle_audit_logs", { method: "POST", body: JSON.stringify({ actor_id: user.id, action: "driver_document.view_url_issued", target_type: "driver_document", target_id: signedDocumentMatch[1] }) });
        return response({ data: { url: base + relative, expires_in_seconds: 300 } }, 200, requestId, origin, env);
      } catch { return response({ error: { code: "SIGNED_URL_FAILED", request_id: requestId } }, 503, requestId, origin, env); }
    }

    if (url.pathname === "/api/v1/me" && (request.method === "GET" || request.method === "PUT")) {
      let user: AuthUser | null;
      try {
        user = await getAuthenticatedUser(request, env);
      } catch (error) {
        const code = error instanceof Error && error.message === "SUPABASE_NOT_CONFIGURED"
          ? "BACKEND_NOT_CONFIGURED" : "AUTH_PROVIDER_UNAVAILABLE";
        return response({ error: { code, request_id: requestId } }, 503, requestId, origin, env);
      }
      if (!user) return response({ error: { code: "UNAUTHENTICATED", request_id: requestId } }, 401, requestId, origin, env);

      if (request.method === "GET") {
        try {
          const result = await databaseRequest(env, `sjelle_profiles?id=eq.${encodeURIComponent(user.id)}&select=id,display_name,phone,preferred_language,created_at,updated_at&limit=1`);
          if (!result.ok) return response({ error: { code: "PROFILE_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
          const rows = await parseJson(result) as unknown[];
          if (!Array.isArray(rows) || rows.length === 0) {
            return response({ error: { code: "PROFILE_NOT_CREATED", request_id: requestId } }, 404, requestId, origin, env);
          }
          return response({ data: rows[0] as Record<string, unknown> }, 200, requestId, origin, env);
        } catch {
          return response({ error: { code: "PROFILE_READ_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        }
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return response({ error: { code: "INVALID_JSON", request_id: requestId } }, 400, requestId, origin, env);
      }
      if (!isRecord(body)) return response({ error: { code: "INVALID_PROFILE", request_id: requestId } }, 400, requestId, origin, env);

      const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
      const phone = body.phone === undefined || body.phone === null ? null : typeof body.phone === "string" ? body.phone.trim() : undefined;
      const language = body.preferred_language === undefined ? "sq" : body.preferred_language;
      if (!displayName || displayName.length > 80 || phone === undefined || (phone !== null && phone.length > 32) || !isLanguage(language)) {
        return response({
          error: {
            code: "INVALID_PROFILE",
            message: "display_name is required (1–80 characters); phone must be text up to 32 characters; preferred_language must be sq, en, or sr.",
            request_id: requestId,
          },
        }, 400, requestId, origin, env);
      }

      try {
        const profileResponse = await databaseRequest(
          env,
          "sjelle_profiles?on_conflict=id",
          {
            method: "POST",
            headers: { prefer: "resolution=merge-duplicates,return=representation" },
            body: JSON.stringify({ id: user.id, display_name: displayName, phone, preferred_language: language, updated_at: new Date().toISOString() }),
          },
        );
        if (!profileResponse.ok) {
          return response({ error: { code: "PROFILE_SAVE_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        }
        const rows = await parseJson(profileResponse) as unknown[];
        const roleResponse = await databaseRequest(
          env,
          "sjelle_user_roles?on_conflict=user_id,role",
          {
            method: "POST",
            headers: { prefer: "resolution=ignore-duplicates,return=minimal" },
            body: JSON.stringify({ user_id: user.id, role: "customer" }),
          },
        );
        if (!roleResponse.ok) {
          return response({ error: { code: "PROFILE_ROLE_SETUP_FAILED", request_id: requestId } }, 503, requestId, origin, env);
        }
        return response({ data: Array.isArray(rows) ? rows[0] : null }, 200, requestId, origin, env);
      } catch {
        return response({ error: { code: "PROFILE_SAVE_FAILED", request_id: requestId } }, 503, requestId, origin, env);
      }
    }

    if (!url.pathname.startsWith("/api/") && env.ASSETS) return env.ASSETS.fetch(request);

    return response({
      error: {
        code: "NOT_FOUND",
        message: "This endpoint is not implemented.",
        request_id: requestId,
      },
    }, 404, requestId, origin, env);
  },
} satisfies ExportedHandler<Env>;
