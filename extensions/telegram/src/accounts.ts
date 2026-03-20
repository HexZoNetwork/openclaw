import util from "node:util";
import {
  createAccountActionGate,
  DEFAULT_ACCOUNT_ID,
  listConfiguredAccountIds as listConfiguredAccountIdsFromSection,
  normalizeAccountId,
  normalizeOptionalAccountId,
  resolveAccountEntry,
  resolveAccountWithDefaultFallback,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { TelegramGroupConfig, TelegramTopicConfig } from "openclaw/plugin-sdk/config-runtime";
import { isTruthyEnvValue } from "openclaw/plugin-sdk/infra-runtime";
import {
  listBoundAccountIds,
  resolveDefaultAgentBoundAccountId,
} from "openclaw/plugin-sdk/routing";
import { formatSetExplicitDefaultInstruction } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramAccountConfig, TelegramActionConfig } from "../runtime-api.js";
import { resolveTelegramToken } from "./token.js";

let log: ReturnType<typeof createSubsystemLogger> | null = null;

function getLog() {
  if (!log) {
    log = createSubsystemLogger("telegram/accounts");
  }
  return log;
}

function formatDebugArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  return util.inspect(value, { colors: false, depth: null, compact: true, breakLength: Infinity });
}

const debugAccounts = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_TELEGRAM_ACCOUNTS)) {
    const parts = args.map((arg) => formatDebugArg(arg));
    getLog().warn(parts.join(" ").trim());
  }
};

export type ResolvedTelegramAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  config: TelegramAccountConfig;
};

function groupIncludesPartyParticipant(
  group: TelegramGroupConfig | undefined,
  accountId: string,
): boolean {
  if (
    group?.party?.participants?.some(
      (participant: { accountId: string }) => participant.accountId === accountId,
    )
  ) {
    return true;
  }
  return Object.values(group?.topics ?? {}).some((topic: TelegramTopicConfig | undefined) =>
    topic?.party?.participants?.some(
      (participant: { accountId: string }) => participant.accountId === accountId,
    ),
  );
}

function mergeTelegramTopicConfig(
  base: TelegramTopicConfig | undefined,
  override: TelegramTopicConfig | undefined,
): TelegramTopicConfig | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
  };
}

function mergeTelegramGroupConfig(
  base: TelegramGroupConfig,
  override: TelegramGroupConfig | undefined,
): TelegramGroupConfig {
  if (!override) {
    return base;
  }
  const topicIds = Array.from(
    new Set([...Object.keys(base.topics ?? {}), ...Object.keys(override.topics ?? {})]),
  );
  const mergedTopics =
    topicIds.length > 0
      ? Object.fromEntries(
          topicIds
            .map(
              (topicId) =>
                [
                  topicId,
                  mergeTelegramTopicConfig(base.topics?.[topicId], override.topics?.[topicId]),
                ] as const,
            )
            .filter((entry): entry is readonly [string, TelegramTopicConfig] => Boolean(entry[1])),
        )
      : undefined;
  return {
    ...base,
    ...override,
    ...(mergedTopics ? { topics: mergedTopics } : {}),
  };
}

function mergeTelegramGroupsForAccount(params: {
  accountId: string;
  channelGroups?: TelegramAccountConfig["groups"];
  accountGroups?: TelegramAccountConfig["groups"];
  isMultiAccount: boolean;
}): TelegramAccountConfig["groups"] | undefined {
  const { accountId, channelGroups, accountGroups, isMultiAccount } = params;
  if (!isMultiAccount) {
    return accountGroups ?? channelGroups;
  }

  const inheritedChannelGroups = Object.fromEntries(
    Object.entries(channelGroups ?? {}).filter(([, group]) =>
      groupIncludesPartyParticipant(group, accountId),
    ),
  );
  const hasInheritedChannelGroups = Object.keys(inheritedChannelGroups).length > 0;
  if (!accountGroups) {
    return hasInheritedChannelGroups ? inheritedChannelGroups : undefined;
  }

  const merged = { ...accountGroups };
  for (const [groupId, groupConfig] of Object.entries(inheritedChannelGroups)) {
    const existing = merged[groupId];
    merged[groupId] = existing ? mergeTelegramGroupConfig(groupConfig, existing) : groupConfig;
  }
  return merged;
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  return listConfiguredAccountIdsFromSection({
    accounts: cfg.channels?.telegram?.accounts,
    normalizeAccountId,
  });
}

export function listTelegramAccountIds(cfg: OpenClawConfig): string[] {
  const ids = Array.from(
    new Set([...listConfiguredAccountIds(cfg), ...listBoundAccountIds(cfg, "telegram")]),
  );
  debugAccounts("listTelegramAccountIds", ids);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

let emittedMissingDefaultWarn = false;

/** @internal Reset the once-per-process warning flag. Exported for tests only. */
export function resetMissingDefaultWarnFlag(): void {
  emittedMissingDefaultWarn = false;
}

export function resolveDefaultTelegramAccountId(cfg: OpenClawConfig): string {
  const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "telegram");
  if (boundDefault) {
    return boundDefault;
  }
  const preferred = normalizeOptionalAccountId(cfg.channels?.telegram?.defaultAccount);
  if (
    preferred &&
    listTelegramAccountIds(cfg).some((accountId) => normalizeAccountId(accountId) === preferred)
  ) {
    return preferred;
  }
  const ids = listTelegramAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  if (ids.length > 1 && !emittedMissingDefaultWarn) {
    emittedMissingDefaultWarn = true;
    getLog().warn(
      `channels.telegram: accounts.default is missing; falling back to "${ids[0]}". ` +
        `${formatSetExplicitDefaultInstruction("telegram")} to avoid routing surprises in multi-account setups.`,
    );
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig | undefined {
  const normalized = normalizeAccountId(accountId);
  return resolveAccountEntry(cfg.channels?.telegram?.accounts, normalized);
}

export function mergeTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig {
  const {
    accounts: _ignored,
    defaultAccount: _ignoredDefaultAccount,
    groups: channelGroups,
    ...base
  } = (cfg.channels?.telegram ?? {}) as TelegramAccountConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const account = resolveTelegramAccountConfig(cfg, accountId) ?? {};

  // In multi-account setups, channel-level `groups` must NOT be inherited by
  // accounts that don't have their own `groups` config.  A bot that is not a
  // member of a configured group will fail when handling group messages, and
  // this failure disrupts message delivery for *all* accounts.
  // Party routing is the exception: if a channel-level group/topic explicitly
  // lists this account as a participant, inherit just that group config so the
  // speaker-selection metadata stays visible to the participating bot.
  // Single-account setups keep backward compat: channel-level groups still
  // applies when the account has no override.
  // See: https://github.com/openclaw/openclaw/issues/30673
  const configuredAccountIds = Object.keys(cfg.channels?.telegram?.accounts ?? {});
  const isMultiAccount = configuredAccountIds.length > 1;
  const groups = mergeTelegramGroupsForAccount({
    accountId,
    channelGroups,
    accountGroups: account.groups,
    isMultiAccount,
  });

  return { ...base, ...account, groups };
}

export function createTelegramActionGate(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): (key: keyof TelegramActionConfig, defaultValue?: boolean) => boolean {
  const accountId = normalizeAccountId(params.accountId);
  return createAccountActionGate({
    baseActions: params.cfg.channels?.telegram?.actions,
    accountActions: resolveTelegramAccountConfig(params.cfg, accountId)?.actions,
  });
}

export type TelegramPollActionGateState = {
  sendMessageEnabled: boolean;
  pollEnabled: boolean;
  enabled: boolean;
};

export function resolveTelegramPollActionGateState(
  isActionEnabled: (key: keyof TelegramActionConfig, defaultValue?: boolean) => boolean,
): TelegramPollActionGateState {
  const sendMessageEnabled = isActionEnabled("sendMessage");
  const pollEnabled = isActionEnabled("poll");
  return {
    sendMessageEnabled,
    pollEnabled,
    enabled: sendMessageEnabled && pollEnabled,
  };
}

export function resolveTelegramAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTelegramAccount {
  const baseEnabled = params.cfg.channels?.telegram?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeTelegramAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const tokenResolution = resolveTelegramToken(params.cfg, { accountId });
    debugAccounts("resolve", {
      accountId,
      enabled,
      tokenSource: tokenResolution.source,
    });
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: tokenResolution.token,
      tokenSource: tokenResolution.source,
      config: merged,
    } satisfies ResolvedTelegramAccount;
  };

  // If accountId is omitted, prefer a configured account token over failing on
  // the implicit "default" account. This keeps env-based setups working while
  // making config-only tokens work for things like heartbeats.
  return resolveAccountWithDefaultFallback({
    accountId: params.accountId,
    normalizeAccountId,
    resolvePrimary: resolve,
    hasCredential: (account) => account.tokenSource !== "none",
    resolveDefaultAccountId: () => resolveDefaultTelegramAccountId(params.cfg),
  });
}

export function listEnabledTelegramAccounts(cfg: OpenClawConfig): ResolvedTelegramAccount[] {
  return listTelegramAccountIds(cfg)
    .map((accountId) => resolveTelegramAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
