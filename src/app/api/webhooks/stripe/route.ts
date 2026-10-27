import { NextResponse } from "next/server";
import { getBillingProvider } from "@/lib/billing/provider";
import { handleWebhookEventAction } from "@/server/actions/billing";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: Request) {
  const provider = getBillingProvider();
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature") ?? "";

  if (!provider.verifyWebhookSignature(rawBody, signature)) {
    return new NextResponse(JSON.stringify({ error: "Invalid signature." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const event = provider.parseWebhookEvent(rawBody);
  if (!event) {
    return new NextResponse(JSON.stringify({ error: "Unparseable event." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const res = await handleWebhookEventAction("STRIPE", event);
    return new NextResponse(JSON.stringify({ ok: true, message: res.message }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new NextResponse(
      JSON.stringify({ error: e instanceof Error ? e.message : "Webhook failed." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
