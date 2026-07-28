/**
 * GET /api/profile?address=<hex address or ENS name>
 *
 * Server-side only, which is the point: the explorer API key stays in the
 * process environment and never reaches a browser.
 */

import { NextResponse } from "next/server";

import { EtherscanError } from "@/lib/etherscan";
import { InvalidAddressError, getProfile } from "@/lib/profile";

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address");
  if (!address) {
    return NextResponse.json(
      { error: "Pass ?address= with a hex address or ENS name." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await getProfile(address));
  } catch (error) {
    if (error instanceof InvalidAddressError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof EtherscanError) {
      // Upstream problem, not the caller's fault: 502 rather than 400 or 500.
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
