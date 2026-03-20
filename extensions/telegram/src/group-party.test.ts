import { describe, expect, it } from "vitest";
import { resolveTelegramPartyDecision } from "./group-party.js";

const baseCfg = {
  agents: {
    list: [{ id: "main", default: true }, { id: "alpha" }, { id: "beta" }],
  },
  channels: { telegram: {} },
  messages: { groupChat: { mentionPatterns: [] } },
} as never;

const baseRoute = {
  agentId: "main",
  channel: "telegram",
  accountId: "alpha-bot",
  sessionKey: "agent:main:telegram:group:-1001",
  mainSessionKey: "agent:main:main",
  lastRoutePolicy: "session" as const,
  matchedBy: "default" as const,
};

describe("resolveTelegramPartyDecision", () => {
  it("selects one account and makes the others skip for the same message", () => {
    const common = {
      cfg: baseCfg,
      groupConfig: {
        party: {
          participants: [{ accountId: "alpha-bot" }, { accountId: "beta-bot" }],
          mode: "round-robin" as const,
          cooldownSeconds: 60,
        },
      },
      chatId: -1001,
      messageId: 77,
      messageText: "hello team",
      messageTimestampMs: 1_700_000_000_000,
      route: baseRoute,
    };

    const alpha = resolveTelegramPartyDecision({
      ...common,
      accountId: "alpha-bot",
    });
    const beta = resolveTelegramPartyDecision({
      ...common,
      accountId: "beta-bot",
      route: { ...baseRoute, accountId: "beta-bot" },
    });

    expect([alpha.kind, beta.kind].sort()).toEqual(["pass", "skip"]);
  });

  it("applies the participant agent override to the selected route", () => {
    const first = resolveTelegramPartyDecision({
      cfg: baseCfg,
      groupConfig: {
        party: {
          participants: [
            { accountId: "alpha-bot", agentId: "alpha", keywords: ["wizard"] },
            { accountId: "beta-bot", agentId: "beta" },
          ],
          mode: "least-recent",
        },
      },
      accountId: "alpha-bot",
      chatId: -1001,
      messageId: 78,
      messageText: "wizard, answer this one",
      messageTimestampMs: 1_700_000_060_000,
      messageThreadId: 9,
      route: baseRoute,
    });

    expect(first.kind).toBe("pass");
    if (first.kind !== "pass") {
      return;
    }
    expect(first.route.agentId).toBe("alpha");
    expect(first.route.sessionKey).toContain("agent:alpha:");
    expect(first.route.sessionKey).toContain("topic:9");
  });
});
