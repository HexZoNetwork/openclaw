import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config/config.js";

vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({
      agents: {
        list: [{ id: "main", default: true }, { id: "alpha" }, { id: "beta" }],
      },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [] } },
    })),
  };
});

const { buildTelegramMessageContextForTest } =
  await import("./bot-message-context.test-harness.js");

describe("buildTelegramMessageContext party routing", () => {
  it("lets only the selected Telegram account continue for a group message", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      agents: {
        list: [{ id: "main", default: true }, { id: "alpha" }, { id: "beta" }],
      },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [] } },
    } as never);

    const message = {
      message_id: 700,
      chat: {
        id: -1001234567890,
        type: "supergroup" as const,
        title: "Party Group",
      },
      date: 1700000000,
      text: "@bot hello party",
      from: { id: 42, first_name: "Alice" },
    };

    const alpha = await buildTelegramMessageContextForTest({
      message,
      accountId: "alpha-bot",
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: {
          requireMention: false,
          party: {
            participants: [{ accountId: "alpha-bot" }, { accountId: "beta-bot" }],
            mode: "round-robin",
          },
        },
      }),
    });
    const beta = await buildTelegramMessageContextForTest({
      message,
      accountId: "beta-bot",
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: {
          requireMention: false,
          party: {
            participants: [{ accountId: "alpha-bot" }, { accountId: "beta-bot" }],
            mode: "round-robin",
          },
        },
      }),
    });

    expect([alpha === null, beta === null].sort()).toEqual([false, true]);
  });

  it("applies the selected participant agent override to the session key", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      agents: {
        list: [{ id: "main", default: true }, { id: "alpha" }, { id: "beta" }],
      },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [] } },
    } as never);

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 701,
        chat: {
          id: -1001234567890,
          type: "supergroup" as const,
          title: "Party Group",
        },
        date: 1700000100,
        text: "wizard please answer",
        from: { id: 42, first_name: "Alice" },
      },
      accountId: "alpha-bot",
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: {
          requireMention: false,
          party: {
            participants: [
              { accountId: "alpha-bot", agentId: "alpha", keywords: ["wizard"] },
              { accountId: "beta-bot", agentId: "beta" },
            ],
            mode: "least-recent",
          },
        },
      }),
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SessionKey).toContain("agent:alpha:");
  });
});
