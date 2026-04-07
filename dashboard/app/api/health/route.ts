import { NextResponse } from "next/server";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3666";

export async function GET() {
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, { cache: "no-store" });
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ status: "unreachable", auth0Live: false, deepSeekLive: false }, { status: 503 });
  }
}
