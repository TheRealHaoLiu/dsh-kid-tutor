import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { ParentAlertService, resolveAlertWebhookHeaders, resolveAlertWebhookUrl } from "../src/parent-alert.ts";
import type { Config } from "../src/parent-alert.ts";

describe("resolveAlertWebhookUrl", () => {
  it("prefers KID_ALERT_WEBHOOK_URL from the environment", () => {
    expect(
      resolveAlertWebhookUrl({ alertWebhookUrl: "https://config.example" }, {
        KID_ALERT_WEBHOOK_URL: "https://env.example",
      } as NodeJS.ProcessEnv),
    ).toBe("https://env.example");
  });

  it("falls back to config when unset", () => {
    expect(resolveAlertWebhookUrl({ alertWebhookUrl: "https://config.example" }, {} as NodeJS.ProcessEnv)).toBe(
      "https://config.example",
    );
  });

  it("falls back to empty (disabled) when neither is set", () => {
    expect(resolveAlertWebhookUrl({}, {} as NodeJS.ProcessEnv)).toBe("");
  });
});

describe("resolveAlertWebhookHeaders", () => {
  it("parses KID_ALERT_WEBHOOK_HEADERS as a JSON string map", () => {
    expect(
      resolveAlertWebhookHeaders({}, { KID_ALERT_WEBHOOK_HEADERS: '{"Title":"Kid Tutor Alert"}' } as NodeJS.ProcessEnv),
    ).toEqual({ Title: "Kid Tutor Alert" });
  });

  it("falls back to config when the env var is invalid JSON", () => {
    expect(
      resolveAlertWebhookHeaders({ alertHeaders: { Title: "Config" } }, {
        KID_ALERT_WEBHOOK_HEADERS: "not json",
      } as NodeJS.ProcessEnv),
    ).toEqual({ Title: "Config" });
  });

  it("falls back to config when the env var is a JSON non-string-map", () => {
    expect(
      resolveAlertWebhookHeaders({ alertHeaders: { Title: "Config" } }, {
        KID_ALERT_WEBHOOK_HEADERS: '{"Title": 5}',
      } as NodeJS.ProcessEnv),
    ).toEqual({ Title: "Config" });
  });

  it("defaults to an empty object", () => {
    expect(resolveAlertWebhookHeaders({}, {} as NodeJS.ProcessEnv)).toEqual({});
  });
});

describe("ParentAlertService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shouldAlert is false when no webhook is configured, regardless of severity", () => {
    const service = new ParentAlertService(
      new Context(),
      ParentAlertService.Config({ alertWebhookUrl: "" } as unknown as Config),
    );
    expect(service.shouldAlert(2)).toBe(false);
  });

  it("shouldAlert respects the configured severity threshold", () => {
    const service = new ParentAlertService(
      new Context(),
      ParentAlertService.Config({ alertWebhookUrl: "https://ntfy.example/topic", alertSeverity: 2 } as unknown as Config),
    );
    expect(service.shouldAlert(0)).toBe(false);
    expect(service.shouldAlert(1)).toBe(false);
    expect(service.shouldAlert(2)).toBe(true);
  });

  it("send() posts the expected plain-text payload and headers", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ParentAlertService(
      new Context(),
      ParentAlertService.Config({
        alertWebhookUrl: "https://ntfy.example/topic",
        alertHeaders: { Title: "Kid Tutor Alert", Priority: "high" },
      } as unknown as Config),
    );
    const result = await service.send({ category: "personal_info", severity: 2, excerpt: "what is your address" });
    expect(result).toEqual({ delivered: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ntfy.example/topic");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Title: "Kid Tutor Alert", Priority: "high" });
    expect(String(init.body)).toContain("category: personal_info");
    expect(String(init.body)).toContain("severity: 2");
    expect(String(init.body)).toContain("what is your address");
  });

  it("send() reports delivered:false without throwing on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    const service = new ParentAlertService(
      new Context(),
      ParentAlertService.Config({ alertWebhookUrl: "https://ntfy.example/topic" } as unknown as Config),
    );
    const result = await service.send({ category: "none", severity: 2, excerpt: "x" });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("500");
  });

  it("send() reports delivered:false without throwing on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const service = new ParentAlertService(
      new Context(),
      ParentAlertService.Config({ alertWebhookUrl: "https://ntfy.example/topic" } as unknown as Config),
    );
    const result = await service.send({ category: "none", severity: 2, excerpt: "x" });
    expect(result).toEqual({ delivered: false, error: "network down" });
  });

  it("send() with no webhook configured resolves delivered:false immediately", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = new ParentAlertService(new Context(), ParentAlertService.Config({} as unknown as Config));
    const result = await service.send({ category: "none", severity: 2, excerpt: "x" });
    expect(result).toEqual({ delivered: false, error: "no webhook configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
