export interface Env {
  APP_ENV?: "development" | "staging" | "production";
  ALLOWED_ORIGIN?: string;
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(self)",
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
    headers.set("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  }

  return new Response(JSON.stringify(body), { status, headers });
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
      return response({ ok: true }, 204, requestId, origin, env);
    }

    if (url.pathname === "/api/v1/health" && request.method === "GET") {
      return response({
        ok: true,
        service: "sjelle-api",
        environment: env.APP_ENV ?? "development",
        request_id: requestId,
      }, 200, requestId, origin, env);
    }

    return response({
      error: {
        code: "NOT_FOUND",
        message: "This endpoint is not implemented.",
        request_id: requestId,
      },
    }, 404, requestId, origin, env);
  },
} satisfies ExportedHandler<Env>;
