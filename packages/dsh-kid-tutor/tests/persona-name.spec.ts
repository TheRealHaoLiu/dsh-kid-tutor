import { describe, expect, it } from "vitest";
import { resolveKidName } from "../src/persona-name.ts";

describe("resolveKidName", () => {
  it("prefers KID_NAME from the environment", () => {
    expect(resolveKidName({ kidName: "Config Name" }, { KID_NAME: "Env Name" } as NodeJS.ProcessEnv)).toBe(
      "Env Name",
    );
  });

  it("falls back to config when the env var is unset", () => {
    expect(resolveKidName({ kidName: "Config Name" }, {} as NodeJS.ProcessEnv)).toBe("Config Name");
  });

  it("falls back to 'friend' when neither is set", () => {
    expect(resolveKidName({}, {} as NodeJS.ProcessEnv)).toBe("friend");
  });

  it("treats a blank KID_NAME as unset", () => {
    expect(resolveKidName({ kidName: "Config Name" }, { KID_NAME: "   " } as NodeJS.ProcessEnv)).toBe(
      "Config Name",
    );
  });
});
