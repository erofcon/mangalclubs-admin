import { NextRequest } from "next/server";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ path: string[] }> | { path: string[] };
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const FORWARDED_HEADERS = new Set(["accept", "authorization", "content-type"]);

function apiBaseUrl() {
  const value = (process.env.MANGALCLUBS_API_URL || process.env.API_BASE_URL)?.trim();
  if (!value) {
    throw new Error("Set MANGALCLUBS_API_URL to https://api.mangalclubs.ru");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MANGALCLUBS_API_URL must be an absolute URL, for example https://api.mangalclubs.ru");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MANGALCLUBS_API_URL must start with http:// or https://");
  }

  return url.toString().replace(/\/+$/, "");
}

function proxyHeaders(requestHeaders: Headers) {
  const headers = new Headers();

  for (const [name, value] of requestHeaders) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || !FORWARDED_HEADERS.has(lowerName)) continue;
    headers.set(name, value);
  }

  return headers;
}

async function proxy(request: NextRequest, context: RouteContext) {
  try {
    const params = await Promise.resolve(context.params);
    const path = params.path.join("/");
    const sourceUrl = new URL(request.url);
    const targetUrl = `${apiBaseUrl()}/${path}${sourceUrl.search}`;

    const headers = proxyHeaders(request.headers);

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      cache: "no-store",
    });

    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("transfer-encoding");

    return new Response(await response.arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "API proxy request failed";
    const isConfigError = message.includes("MANGALCLUBS_API_URL");
    const status = isConfigError ? 500 : 502;

    return Response.json(
      {
        message,
        detail:
          isConfigError
            ? "Set MANGALCLUBS_API_URL=https://api.mangalclubs.ru in the Next.js deployment environment."
            : "Check that the backend API is running and reachable from the Next.js server.",
      },
      { status },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const PUT = proxy;
