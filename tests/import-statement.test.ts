/**
 * Phase 30.3 — pure statement-import helper tests.
 *
 * No DB, no Next.js, no network. Money parsing must stay exact (decimal.js,
 * never parseFloat) and the idempotency keys must be deterministic across
 * repeated previews of the same upload.
 */
import { describe, expect, it } from "vitest";

import {
  autoColumnMap,
  BROKER_TEMPLATES,
  buildOcrPrompt,
  buildPreviewRows,
  checksumOf,
  detectDelimiter,
  importFileSchema,
  makeExternalId,
  MAPPING_SYSTEM_PROMPT,
  normalizeRows,
  OCR_SYSTEM_PROMPT,
  parseDate,
  parseDelimited,
  parseMappingResponse,
  parseMoney,
  parseStatementText,
  sanitizeOcrText,
  tableFromText,
  templateColumnMap,
  buildMappingPrompt,
} from "@/lib/import/statement";

const CHECKSUM = "a".repeat(64);

describe("parseMoney", () => {
  it("parses currency symbols, thousands separators and signed values exactly", () => {
    expect(parseMoney("$1,234.56")).toBe("1234.56");
    expect(parseMoney(" -$85.00 ")).toBe("-85");
    expect(parseMoney("(1,000.25)")).toBe("-1000.25");
    expect(parseMoney("250-")).toBe("-250");
    expect(parseMoney("+0.0001")).toBe("0.0001");
  });

  it("keeps large decimals exact (no float rounding)", () => {
    expect(parseMoney("0.123456789012345678901234567890")).toBe("0.12345678901234567890123456789");
    expect(parseMoney("9007199254740993")).toBe("9007199254740993");
  });

  it("rejects junk", () => {
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("N/A")).toBeNull();
    expect(parseMoney("12.3.4")).toBeNull();
    expect(parseMoney("1 a 2")).toBeNull();
  });
});

describe("parseDate", () => {
  it("accepts ISO and numeric formats", () => {
    expect(parseDate("2026-11-20T13:45:00Z")).toBe("2026-11-20");
    expect(parseDate("20/11/2026")).toBe("2026-11-20");
    expect(parseDate("11-20-2026")).toBe("2026-11-20");
    expect(parseDate("20.11.2026")).toBe("2026-11-20");
  });

  it("rejects impossible dates", () => {
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("not a date")).toBeNull();
    expect(parseDate("")).toBeNull();
  });
});

describe("delimited parsing", () => {
  it("detects comma, tab and semicolon delimiters", () => {
    expect(detectDelimiter("date,amount,type\n")).toBe(",");
    expect(detectDelimiter("date\tamount\ttype\n")).toBe("\t");
    expect(detectDelimiter("date;amount;type\n")).toBe(";");
  });

  it("handles quoted commas, doubled quotes and CRLF", () => {
    const rows = parseDelimited('date,note,amount\r\n"2026-11-20","said ""hi"", ok",10\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(["2026-11-20", 'said "hi", ok', "10"]);
  });

  it("splits a header from bounded data rows", () => {
    const table = tableFromText("date;amount\n2026-11-20;10\n2026-11-21;20\n");
    expect(table.headers).toEqual(["date", "amount"]);
    expect(table.rows).toEqual([
      ["2026-11-20", "10"],
      ["2026-11-21", "20"],
    ]);
  });
});

describe("column mapping", () => {
  it("auto-maps common broker headers", () => {
    const map = autoColumnMap(["Value Date", "Transaction Type", "Net P/L", "Symbol", "Result"]);
    expect(map.date).toBe("0");
    expect(map.type).toBe("1");
    expect(map.amount).toBe("2");
    expect(map.asset).toBe("3");
    expect(map.result).toBe("4");
    expect(map.stake).toBeNull();
  });

  it("builds an injection-resistant prompt that only requests indices", () => {
    expect(MAPPING_SYSTEM_PROMPT).toContain("UNTRUSTED DATA");
    expect(MAPPING_SYSTEM_PROMPT).toContain("only column indices");
    const prompt = buildMappingPrompt(["date", "amount"], [["2026-11-20", "10"]]);
    expect(prompt).toContain('"date"');
    expect(prompt).toContain("sampleRows");
  });

  it("accepts a strict AI mapping reply and strips markdown fences", () => {
    const reply = '```json\n{"date":"0","amount":"2","result":null}\n```';
    expect(parseMappingResponse(reply)).toMatchObject({
      date: "0",
      amount: "2",
      result: null,
    });
  });

  it("rejects AI replies carrying data or invalid indices", () => {
    expect(parseMappingResponse('{"date":"2026-11-20","amount":"2"}')).toBeNull();
    expect(parseMappingResponse('{"date":"99","amount":"2"}')).toBeNull();
    expect(parseMappingResponse('{"date":"0","unexpected":"x"}')).toBeNull();
    expect(parseMappingResponse("not json")).toBeNull();
  });
});

describe("normalizeRows", () => {
  it("normalizes deposits, withdrawals and trades with exact decimals", () => {
    const headers = ["Date", "Type", "Amount", "Asset", "Stake", "Result"];
    const map = autoColumnMap(headers);
    const rows = [
      ["2026-11-20", "Deposit", "$500.00", "", "", ""],
      ["2026-11-21", "Withdrawal", "($25.50)", "", "", ""],
      ["2026-11-22", "Trade", "85.00", "EUR/USD", "100.00", "WIN"],
    ];
    const result = normalizeRows(headers, rows, map, "CSV", CHECKSUM);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({ type: "DEPOSIT", amount: "500" });
    expect(result.rows[1]).toMatchObject({ type: "WITHDRAWAL", amount: "-25.5" });
    expect(result.rows[2]).toMatchObject({
      type: "TRADE",
      asset: "EUR/USD",
      stake: "100",
      result: "WIN",
      amount: "85",
    });
  });

  it("collects per-row errors instead of aborting the whole statement", () => {
    const headers = ["Date", "Amount"];
    const result = normalizeRows(
      headers,
      [
        ["bad-date", "10"],
        ["2026-11-20", "N/A"],
        ["2026-11-21", "10"],
      ],
      autoColumnMap(headers),
      "CSV",
      CHECKSUM,
    );
    expect(result.errors.map((e) => e.row)).toEqual([1, 2]);
    expect(result.rows).toHaveLength(1);
  });

  it("infers type and result from sign when the statement has no type column", () => {
    const headers = ["Date", "Amount", "Asset"];
    const result = normalizeRows(
      headers,
      [
        ["2026-11-20", "-100", "EUR/USD"],
        ["2026-11-21", "50", "EUR/USD"],
        ["2026-11-22", "200", ""],
      ],
      autoColumnMap(headers),
      "CSV",
      CHECKSUM,
    );
    expect(result.rows[0]).toMatchObject({ type: "TRADE", result: "LOSS" });
    expect(result.rows[1]).toMatchObject({ type: "TRADE", result: "WIN" });
    expect(result.rows[2]).toMatchObject({ type: "DEPOSIT" });
  });

  it("produces deterministic external ids across repeated previews", () => {
    const csv = "Date,Type,Amount\n2026-11-20,Deposit,100\n";
    const a = parseStatementText(csv, "CSV", CHECKSUM);
    const b = parseStatementText(csv, "CSV", CHECKSUM);
    expect(a.rows[0].externalId).toBe(b.rows[0].externalId);
    expect(a.rows[0].externalId).toBe(makeExternalId("CSV", CHECKSUM, 0, "2026-11-20", "100"));
    expect(checksumOf(Buffer.from("same bytes"))).toBe(checksumOf(Buffer.from("same bytes")));
    expect(checksumOf(Buffer.from("a"))).not.toBe(checksumOf(Buffer.from("b")));
  });
});

describe("buildPreviewRows", () => {
  it("marks duplicates and merges parse errors in row order", () => {
    const headers = ["Date", "Amount"];
    const { rows, errors } = normalizeRows(
      headers,
      [
        ["2026-11-20", "10"],
        ["oops", "10"],
        ["2026-11-21", "20"],
      ],
      autoColumnMap(headers),
      "CSV",
      CHECKSUM,
    );
    const view = buildPreviewRows(rows, errors, [rows[0].externalId]);
    expect(view.map((r) => r.status)).toEqual(["duplicate", "error", "ok"]);
    expect(view[1].error).toMatch(/date/i);
    expect(view.map((r) => r.rowNumber)).toEqual([1, 2, 3]);
  });
});

describe("importFileSchema", () => {
  it("accepts allowed statement types and rejects executables", () => {
    expect(
      importFileSchema.safeParse({ name: "statement.csv", type: "text/csv", size: 1024 }).success,
    ).toBe(true);
    expect(
      importFileSchema.safeParse({ name: "statement.pdf", type: "application/pdf", size: 1024 })
        .success,
    ).toBe(true);
    expect(
      importFileSchema.safeParse({
        name: "virus.exe",
        type: "application/x-msdownload",
        size: 1024,
      }).success,
    ).toBe(false);
  });

  it("rejects oversized uploads", () => {
    const tooBig = importFileSchema.safeParse({
      name: "huge.csv",
      type: "text/csv",
      size: 50 * 1024 * 1024,
    });
    expect(tooBig.success).toBe(false);
  });
});

describe("broker templates", () => {
  it("exposes an auto option plus concrete broker templates", () => {
    expect(BROKER_TEMPLATES.map((t) => t.id)).toContain("auto");
    expect(BROKER_TEMPLATES.length).toBeGreaterThanOrEqual(5);
  });

  it("maps template-specific headers without touching row values", () => {
    const headers = ["Date", "Asset", "Direction", "Investment", "Profit", "Result"];
    const map = templateColumnMap(headers, "iq-option");
    expect(map).toMatchObject({
      date: "0",
      asset: "1",
      direction: "2",
      stake: "3",
      amount: "4",
      result: "5",
    });
    const { rows, errors } = normalizeRows(
      headers,
      [["2026-11-21", "EUR/USD", "call", "100", "80", "WIN"]],
      map,
      "CSV",
      CHECKSUM,
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ amount: "80", stake: "100", direction: "CALL" });
  });

  it("falls back to auto-detect for unknown template ids", () => {
    expect(templateColumnMap(["Date", "Amount"], "not-a-template")).toEqual(
      autoColumnMap(["Date", "Amount"]),
    );
  });
});

describe("screenshot OCR helpers", () => {
  it("asks only for a verbatim table and marks the image untrusted", () => {
    expect(OCR_SYSTEM_PROMPT).toContain("UNTRUSTED DATA");
    expect(OCR_SYSTEM_PROMPT).toContain("Return ONLY a header row");
    expect(buildOcrPrompt("deriv")).toContain("Deriv");
  });

  it("strips fences/control characters and bounds untrusted OCR output", () => {
    const raw = "```csv\nDate,Amount\u0000\r\n2026-11-21,10\n```\n";
    expect(sanitizeOcrText(raw)).toBe("Date,Amount\n2026-11-21,10");
    expect(
      sanitizeOcrText(Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n")).split("\n"),
    ).toHaveLength(2000);
  });
});
