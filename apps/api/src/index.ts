export interface Env {
  APP_ENV?: "development" | "staging" | "production";
  ALLOWED_ORIGIN?: string;
  SUPABASE_URL?: string;
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
  if (!configured(env)) throw new Error("SUPABASE_NOT_CONFIGURED");
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) return null;

  const result = await fetch(supabaseUrl(env, "/auth/v1/user"), {
    method: "GET",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
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
        if (!city?.active || !city.food_enabled) return response({ error: { code: "RESTAURANT_UNAVAILABLE", request_id: requestId } }, 404, requestId, origin, env);

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
