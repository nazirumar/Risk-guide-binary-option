/**
 * Storage abstraction (PROJECT_RULES.md Phase 5 spec: "S3-compatible or
 * Uploadthing; abstract storage layer").
 *
 * Phase 5 ships a `LocalStorageProvider` that writes screenshots to
 * `/home/z/my-project/upload/` (matches the Caddyfile's `/upload` route).
 * Production can swap in `S3StorageProvider` or `UploadthingStorageProvider`
 * by setting env vars — same `uploadFile(file)` interface.
 *
 * Returns a publicly-accessible URL that gets stored on the Trade row.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type StoredFile = {
  /** Public URL stored on the Trade row (e.g. "/upload/abc-123.png"). */
  url: string;
  /** Original file name for display. */
  originalName: string;
  /** MIME type. */
  contentType: string;
  /** Size in bytes. */
  size: number;
};

interface StorageProvider {
  uploadFile(file: File): Promise<StoredFile>;
}

// ─── Local file storage (dev / sandbox) ──────────────────────────────────────

class LocalStorageProvider implements StorageProvider {
  constructor(
    private readonly rootDir: string,
    private readonly publicPathPrefix: string,
  ) {}

  async uploadFile(file: File): Promise<StoredFile> {
    // Ensure the dir exists.
    await fs.mkdir(this.rootDir, { recursive: true });

    const ext = path.extname(file.name) || this.extFromType(file.type);
    const id = randomUUID();
    const filename = `${id}${ext}`;
    const fullPath = path.join(this.rootDir, filename);

    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(fullPath, buf);

    return {
      url: `${this.publicPathPrefix}/${filename}`,
      originalName: file.name,
      contentType: file.type || "application/octet-stream",
      size: file.size,
    };
  }

  private extFromType(type: string): string {
    switch (type) {
      case "image/png":
        return ".png";
      case "image/jpeg":
        return ".jpg";
      case "image/webp":
        return ".webp";
      case "image/gif":
        return ".gif";
      default:
        return ".bin";
    }
  }
}

// ─── Stub for S3 / Uploadthing — Phase 14 wires the real thing ───────────────

class StubCloudStorageProvider implements StorageProvider {
  constructor(
    private readonly providerName: string,
    private readonly bucketBaseUrl: string,
  ) {}

  async uploadFile(file: File): Promise<StoredFile> {
    // In production this would call the S3 / Uploadthing SDK. For the
    // sandbox, return a fake URL so the form can be exercised end-to-end
    // without a real cloud account.
    const id = randomUUID();
    const ext = path.extname(file.name) || ".png";
    return {
      url: `${this.bucketBaseUrl}/${id}${ext}`,
      originalName: file.name,
      contentType: file.type || "image/png",
      size: file.size,
    };
  }
}

// ─── Singleton factory ───────────────────────────────────────────────────────

let _provider: StorageProvider | null = null;

function getProvider(): StorageProvider {
  if (_provider) return _provider;
  const s3Bucket = process.env.S3_BUCKET;
  const uploadthingKey = process.env.UPLOADTHING_SECRET;
  if (s3Bucket) {
    _provider = new StubCloudStorageProvider("S3", `https://${s3Bucket}.s3.amazonaws.com`);
  } else if (uploadthingKey) {
    _provider = new StubCloudStorageProvider("Uploadthing", "https://uploadthing.com/f");
  } else {
    // Dev / sandbox default — local files served via /api/upload/* (Next.js
    // route handler that streams from local disk).
    _provider = new LocalStorageProvider("/home/z/my-project/upload", "/api/upload");
  }
  return _provider;
}

export async function uploadTradeScreenshot(file: File): Promise<StoredFile> {
  // Phase 5: only validate size + type. Phase 13 will add malware scanning.
  const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
  const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  if (file.size > MAX_BYTES) {
    throw new Error("Screenshot too large (max 5 MB).");
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new Error(`Unsupported screenshot type "${file.type}". Allowed: PNG, JPEG, WebP, GIF.`);
  }
  return getProvider().uploadFile(file);
}
