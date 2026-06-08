import { NextRequest } from "next/server";

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

function apiBaseUrl() {
  const value = process.env.MANGALCLUBS_API_URL || process.env.API_BASE_URL;
  if (!value) {
    throw new Error("Set MANGALCLUBS_API_URL in .env.local");
  }
  return value.replace(/\/+$/, "");
}

async function proxy(request: NextRequest, context: RouteContext) {
  try {
    const params = await Promise.resolve(context.params);
    const path = params.path.join("/");
    const sourceUrl = new URL(request.url);
    const targetUrl = `${apiBaseUrl()}/${path}${sourceUrl.search}`;

    const headers = new Headers(request.headers);
    for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);

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
    const status = message.includes("MANGALCLUBS_API_URL") ? 500 : 502;

    return Response.json(
      {
        message,
        detail:
          status === 500
            ? "Create .env.local and set MANGALCLUBS_API_URL=http://localhost:8000"
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
