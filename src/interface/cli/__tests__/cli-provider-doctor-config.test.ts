import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { checkApiKey } from "../commands/doctor.js";
import { cmdProvider } from "../commands/config.js";

describe("provider config credential display and doctor readiness", () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const savedHome = process.env["PULSEED_HOME"];
  const savedOpenAiKey = process.env["OPENAI_API_KEY"];
  const savedAnthropicKey = process.env["ANTHROPIC_API_KEY"];

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-provider-doctor-");
    process.env["PULSEED_HOME"] = tmpDir;
    delete process.env["OPENAI_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (savedHome !== undefined) process.env["PULSEED_HOME"] = savedHome;
    else delete process.env["PULSEED_HOME"];
    if (savedOpenAiKey !== undefined) process.env["OPENAI_API_KEY"] = savedOpenAiKey;
    else delete process.env["OPENAI_API_KEY"];
    if (savedAnthropicKey !== undefined) process.env["ANTHROPIC_API_KEY"] = savedAnthropicKey;
    else delete process.env["ANTHROPIC_API_KEY"];
    cleanupTempDir(tmpDir);
  });

  it("masks provider config credentials and reports doctor API key readiness from the same config", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify({
        provider: "openai",
        model: "gpt-5.5",
        adapter: "openai_codex_cli",
        api_key: "sk-provider-secret",
      })
    );

    await expect(cmdProvider(["show"])).resolves.toBe(0);
    const providerOutput = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(providerOutput).toContain('"provider": "openai"');
    expect(providerOutput).toContain('"model": "gpt-5.5"');
    expect(providerOutput).toContain('"adapter": "openai_codex_cli"');
    expect(providerOutput).toContain('"api_key": "****"');
    expect(providerOutput).not.toContain("sk-provider-secret");

    const doctorResult = await checkApiKey(tmpDir);
    expect(doctorResult.status).toBe("pass");
    expect(doctorResult.detail).toContain("source-of-truth as `pulseed provider show`");
    expect(doctorResult.detail).toContain("pulseed provider show");
    expect(doctorResult.detail).toContain("codex auth login");
  });
});
