import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";

const loadConfigMock = vi.hoisted(() => vi.fn<() => OpenClawConfig>(() => ({})));
const writeConfigFileMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
    writeConfigFile: writeConfigFileMock,
  };
});

const { onboardTelegramPartyCommand } = await import("./onboard-telegram-party.js");

describe("onboardTelegramPartyCommand", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue({});
    writeConfigFileMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("writes a Telegram party config in non-interactive mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { id: 101, username: "AlphaBot", first_name: "Alpha" },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { id: 202, username: "BetaBot", first_name: "Beta" },
          }),
        }),
    );

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;
    const prompter = {
      progress: () => ({ update: vi.fn(), stop: vi.fn() }),
    } as never;

    await onboardTelegramPartyCommand(
      {
        tokens: "111:token_alpha,222:token_beta",
        groupId: "-1001234567890",
        mode: "least-recent",
        cooldownSeconds: 45,
        requireMention: false,
        nonInteractive: true,
      },
      runtime,
      prompter,
    );

    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const firstWriteCall = writeConfigFileMock.mock.calls.at(0);
    if (!firstWriteCall) {
      throw new Error("expected writeConfigFile to be called");
    }
    const [cfg] = firstWriteCall as unknown as [OpenClawConfig];
    expect(cfg.channels?.telegram?.accounts?.alphabot?.botToken).toBe("111:token_alpha");
    expect(cfg.channels?.telegram?.accounts?.betabot?.botToken).toBe("222:token_beta");
    expect(cfg.channels?.telegram?.groups?.["-1001234567890"]?.party?.participants).toEqual([
      { accountId: "alphabot" },
      { accountId: "betabot" },
    ]);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Added accounts: alphabot, betabot"),
    );
  });
});
