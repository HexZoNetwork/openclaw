import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";

const writeConfigFileMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    writeConfigFile: writeConfigFileMock,
  };
});

const { createNativeCommandsHarness, createTelegramGroupCommandContext } =
  await import("./bot-native-commands.test-helpers.js");

describe("/addtoken Telegram native command", () => {
  beforeEach(() => {
    writeConfigFileMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("adds new Telegram bot accounts and appends them to the current group party", async () => {
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

    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          configWrites: true,
          groups: {
            "-100999": {
              requireMention: false,
              party: {
                participants: [{ accountId: "default" }],
              },
            },
          },
        },
      },
    };

    const harness = createNativeCommandsHarness({ cfg });
    const handler = harness.handlers.addtoken;
    expect(handler).toBeTypeOf("function");

    await handler({
      ...createTelegramGroupCommandContext(),
      match: "111:token_alpha,222:token_beta",
    });

    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const firstWriteCall = writeConfigFileMock.mock.calls.at(0);
    if (!firstWriteCall) {
      throw new Error("expected writeConfigFile to be called");
    }
    const [persisted] = firstWriteCall as unknown as [OpenClawConfig];
    expect(persisted.channels?.telegram?.accounts?.alphabot?.botToken).toBe("111:token_alpha");
    expect(persisted.channels?.telegram?.accounts?.betabot?.botToken).toBe("222:token_beta");
    expect(
      persisted.channels?.telegram?.groups?.["-100999"]?.party?.participants?.map(
        (participant) => participant.accountId,
      ),
    ).toEqual(["default", "alphabot", "betabot"]);
    expect(harness.sendMessage).toHaveBeenCalledWith(
      -100999,
      expect.stringContaining("Added 2 Telegram bot tokens"),
      expect.any(Object),
    );
  });

  it("blocks /addtoken when Telegram config writes are disabled", async () => {
    const harness = createNativeCommandsHarness({
      cfg: {
        channels: {
          telegram: {
            configWrites: false,
          },
        },
      },
    });

    const handler = harness.handlers.addtoken;
    expect(handler).toBeTypeOf("function");

    await handler({
      ...createTelegramGroupCommandContext(),
      match: "111:token_alpha",
    });

    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalledWith(
      -100999,
      expect.stringContaining("Config writes are disabled"),
      expect.any(Object),
    );
  });
});
