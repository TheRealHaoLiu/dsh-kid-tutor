import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { KidQuotaService, isWithinCutoff, localDateString } from "../src/quota.ts";

describe("localDateString", () => {
  it("formats in local time, zero-padded", () => {
    expect(localDateString(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(localDateString(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("isWithinCutoff", () => {
  it("handles a same-day window", () => {
    expect(isWithinCutoff(10, 9, 17)).toBe(true);
    expect(isWithinCutoff(8, 9, 17)).toBe(false);
    expect(isWithinCutoff(17, 9, 17)).toBe(false); // exclusive end
  });

  it("handles a window crossing midnight (default 21-7)", () => {
    expect(isWithinCutoff(22, 21, 7)).toBe(true);
    expect(isWithinCutoff(3, 21, 7)).toBe(true);
    expect(isWithinCutoff(6, 21, 7)).toBe(true);
    expect(isWithinCutoff(7, 21, 7)).toBe(false); // exclusive end
    expect(isWithinCutoff(20, 21, 7)).toBe(false);
    expect(isWithinCutoff(12, 21, 7)).toBe(false);
  });

  it("a zero-width window never cuts off", () => {
    expect(isWithinCutoff(3, 5, 5)).toBe(false);
  });
});

const dirsToClean: string[] = [];

function makeQuotaFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-kid-tutor-quota-"));
  dirsToClean.push(dir);
  return join(dir, "quota.json");
}

afterEach(() => {
  while (dirsToClean.length > 0) {
    const dir = dirsToClean.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("KidQuotaService", () => {
  it("charges and reports remaining, persisting to disk", () => {
    const file = makeQuotaFile();
    const ctx = new Context();
    const service = new KidQuotaService(ctx, KidQuotaService.Config({ turnsPerDay: 3, quotaFile: file }));
    expect(service.remaining()).toBe(3);
    service.charge();
    service.charge();
    expect(service.remaining()).toBe(1);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { used: number; date: string };
    expect(onDisk.used).toBe(2);
    expect(onDisk.date).toBe(localDateString(new Date()));
  });

  it("never reports negative remaining once over budget", () => {
    const file = makeQuotaFile();
    const ctx = new Context();
    const service = new KidQuotaService(ctx, KidQuotaService.Config({ turnsPerDay: 1, quotaFile: file }));
    service.charge();
    service.charge();
    service.charge();
    expect(service.remaining()).toBe(0);
  });

  it("loads prior usage from an existing file for today", () => {
    const file = makeQuotaFile();
    const ctx1 = new Context();
    const service1 = new KidQuotaService(ctx1, KidQuotaService.Config({ turnsPerDay: 10, quotaFile: file }));
    service1.charge();
    service1.charge();

    const ctx2 = new Context();
    const service2 = new KidQuotaService(ctx2, KidQuotaService.Config({ turnsPerDay: 10, quotaFile: file }));
    expect(service2.remaining()).toBe(8);
  });

  it("rolls over to a fresh budget on a new local day", () => {
    const file = makeQuotaFile();
    const ctx = new Context();
    const service = new KidQuotaService(ctx, KidQuotaService.Config({ turnsPerDay: 5, quotaFile: file }));
    service.charge();
    service.charge();
    expect(service.remaining()).toBe(3);

    // Simulate a stale on-disk day by writing yesterday's date directly, then
    // re-reading through a fresh instance (rollover happens on next access).
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const stale = { date: localDateString(yesterday), used: 5 };
    writeFileSync(file, JSON.stringify(stale), "utf8");

    const ctx2 = new Context();
    const service2 = new KidQuotaService(ctx2, KidQuotaService.Config({ turnsPerDay: 5, quotaFile: file }));
    expect(service2.remaining()).toBe(5);
  });

  it("treats an unreadable/corrupt quota file as a fresh empty day rather than throwing", () => {
    const file = makeQuotaFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{not json", "utf8");
    let service: KidQuotaService | undefined;
    expect(() => {
      service = new KidQuotaService(new Context(), KidQuotaService.Config({ turnsPerDay: 5, quotaFile: file }));
    }).not.toThrow();
    expect(service?.remaining()).toBe(5);
  });
});
