import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });
  const buf = Buffer.from(await file.arrayBuffer());
  const dataUrl = `data:${file.type || "application/octet-stream"};base64,${buf.toString("base64")}`;
  return NextResponse.json({ url: dataUrl });
}
