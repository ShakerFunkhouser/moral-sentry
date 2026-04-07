import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// In-memory set of active SSE subscriber controllers.
// Shared across GET/POST within the same Next.js server process (demo-safe).
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

const encoder = new TextEncoder();

function broadcast(data: unknown) {
  const chunk = encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  for (const ctrl of subscribers) {
    try {
      ctrl.enqueue(chunk);
    } catch {
      subscribers.delete(ctrl);
    }
  }
}

/**
 * GET /api/events
 * Returns a text/event-stream SSE connection.
 * The dashboard LiveFeed component connects here to receive real-time hook decisions.
 */
export function GET() {
  let ctrl: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      subscribers.add(ctrl);
      // Send a keep-alive comment so the client knows the stream is live
      ctrl.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() {
      subscribers.delete(ctrl);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * POST /api/events/ingest
 * Receives a hook decision payload from the moral-sentry plugin and broadcasts
 * it to all connected SSE subscribers.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    broadcast(body);
    return NextResponse.json({ ok: true, subscribers: subscribers.size });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
