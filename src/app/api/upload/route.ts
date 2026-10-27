import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const UPLOAD_DIR = path.join(process.cwd(), "public", "upload");

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const ext = path.extname(file.name) || ".bin";
  const filename = `${randomUUID()}${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(path.join(UPLOAD_DIR, filename), buf);
  return NextResponse.json({ url: `/upload/${filename}` });
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
