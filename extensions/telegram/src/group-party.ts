import type {
  OpenClawConfig,
  TelegramGroupConfig,
  TelegramPartyConfig,
  TelegramPartyParticipantConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-runtime";
import {
  buildAgentMainSessionKey,
  buildAgentSessionKey,
  deriveLastRoutePolicy,
  sanitizeAgentId,
  type ResolvedAgentRoute,
} from "openclaw/plugin-sdk/routing";
import { buildTelegramGroupPeerId } from "./bot/helpers.js";

type TelegramPartyDecisionRecord = {
  selectedAccountId: string;
  selectedAgentId?: string;
};

type TelegramPartyConversationState = {
  lastSelectedAccountId?: string;
  lastSelectedAt: number;
  participantLastSelectedAt: Record<string, number>;
};

const MAX_DECISION_CACHE_SIZE = 2000;
const MAX_CONVERSATION_STATE_SIZE = 1000;
const partyDecisionCache = new Map<string, TelegramPartyDecisionRecord>();
const partyConversationState = new Map<string, TelegramPartyConversationState>();

function trimCache<K, V>(map: Map<K, V>, maxSize: number) {
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    map.delete(oldestKey);
  }
}

function normalizeParticipant(
  participant: TelegramPartyParticipantConfig,
): TelegramPartyParticipantConfig | null {
  const accountId = participant.accountId?.trim();
  if (!accountId) {
    return null;
  }
  return {
    accountId,
    ...(typeof participant.agentId === "string" && participant.agentId.trim()
      ? { agentId: sanitizeAgentId(participant.agentId) }
      : {}),
    ...(Array.isArray(participant.keywords)
      ? {
          keywords: participant.keywords
            .map((keyword) => keyword.trim().toLowerCase())
            .filter(Boolean),
        }
      : {}),
    ...(typeof participant.weight === "number" && Number.isFinite(participant.weight)
      ? { weight: participant.weight }
      : {}),
  };
}

function normalizePartyConfig(
  party: TelegramPartyConfig | undefined,
): (TelegramPartyConfig & { participants: TelegramPartyParticipantConfig[] }) | null {
  if (!party || party.enabled === false) {
    return null;
  }
  const participants = Array.isArray(party.participants)
    ? party.participants
        .map(normalizeParticipant)
        .filter((participant): participant is TelegramPartyParticipantConfig =>
          Boolean(participant),
        )
    : [];
  if (participants.length === 0) {
    return null;
  }
  return {
    ...party,
    participants,
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function scoreParticipant(params: {
  participant: TelegramPartyParticipantConfig;
  state: TelegramPartyConversationState | undefined;
  normalizedText: string;
  seed: string;
  cooldownMs: number;
  now: number;
  mode: NonNullable<TelegramPartyConfig["mode"]>;
}) {
  const { participant, state, normalizedText, seed, cooldownMs, now, mode } = params;
  const lastSelectedAt = state?.participantLastSelectedAt[participant.accountId] ?? 0;
  const keywordHits =
    participant.keywords?.reduce(
      (count, keyword) => count + (normalizedText.includes(keyword) ? 1 : 0),
      0,
    ) ?? 0;
  const inCooldown = cooldownMs > 0 && lastSelectedAt > 0 && now - lastSelectedAt < cooldownMs;
  const lastSelectedBonus =
    state?.lastSelectedAccountId === participant.accountId && inCooldown ? -1_000_000 : 0;
  const recencyScore =
    mode === "least-recent"
      ? lastSelectedAt > 0
        ? Math.min(now - lastSelectedAt, 86_400_000)
        : 86_400_000
      : 0;
  const roundRobinScore =
    mode === "round-robin" && state?.lastSelectedAccountId === participant.accountId ? -50_000 : 0;
  const weightScore = Math.round((participant.weight ?? 1) * 1000);
  const keywordScore = keywordHits * 10_000;
  const randomScore = mode === "random" ? hashString(`${seed}:${participant.accountId}`) : 0;
  const tiebreaker = hashString(`${seed}:${participant.accountId}:tie`);
  return (
    lastSelectedBonus +
    recencyScore +
    roundRobinScore +
    weightScore +
    keywordScore +
    randomScore +
    tiebreaker / 1_000_000
  );
}

function getConversationState(key: string): TelegramPartyConversationState | undefined {
  const state = partyConversationState.get(key);
  if (!state) {
    return undefined;
  }
  partyConversationState.delete(key);
  partyConversationState.set(key, state);
  return state;
}

function setConversationState(key: string, state: TelegramPartyConversationState) {
  partyConversationState.set(key, state);
  trimCache(partyConversationState, MAX_CONVERSATION_STATE_SIZE);
}

function getOrCreateDecision(params: {
  messageKey: string;
  conversationKey: string;
  party: TelegramPartyConfig & { participants: TelegramPartyParticipantConfig[] };
  text?: string;
  timestampMs: number;
}): TelegramPartyDecisionRecord {
  const cached = partyDecisionCache.get(params.messageKey);
  if (cached) {
    return cached;
  }
  const now = params.timestampMs;
  const state = getConversationState(params.conversationKey);
  const normalizedText = params.text?.trim().toLowerCase() ?? "";
  const cooldownMs = Math.max(0, (params.party.cooldownSeconds ?? 45) * 1000);
  const mode = params.party.mode ?? "least-recent";
  const seed = params.messageKey;
  const selected =
    params.party.participants
      .map((participant) => ({
        participant,
        score: scoreParticipant({
          participant,
          state,
          normalizedText,
          seed,
          cooldownMs,
          now,
          mode,
        }),
      }))
      .sort((left, right) => right.score - left.score)[0]?.participant ??
    params.party.participants[0];

  const decision: TelegramPartyDecisionRecord = {
    selectedAccountId: selected.accountId,
    ...(selected.agentId ? { selectedAgentId: selected.agentId } : {}),
  };
  partyDecisionCache.set(params.messageKey, decision);
  trimCache(partyDecisionCache, MAX_DECISION_CACHE_SIZE);
  setConversationState(params.conversationKey, {
    lastSelectedAccountId: selected.accountId,
    lastSelectedAt: now,
    participantLastSelectedAt: {
      ...(state?.participantLastSelectedAt ?? {}),
      [selected.accountId]: now,
    },
  });
  return decision;
}

export function resolveTelegramPartyConfig(params: {
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
}) {
  return normalizePartyConfig(params.topicConfig?.party ?? params.groupConfig?.party);
}

export function resolveTelegramPartyDecision(params: {
  cfg: OpenClawConfig;
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
  route: ResolvedAgentRoute;
  accountId: string;
  chatId: string | number;
  messageId: number;
  messageText?: string;
  messageTimestampMs: number;
  messageThreadId?: number;
}):
  | { kind: "pass"; route: ResolvedAgentRoute }
  | { kind: "skip"; selectedAccountId: string }
  | { kind: "pass"; route: ResolvedAgentRoute; selectedAccountId: string } {
  const party = resolveTelegramPartyConfig({
    groupConfig: params.groupConfig,
    topicConfig: params.topicConfig,
  });
  if (!party) {
    return { kind: "pass", route: params.route };
  }
  const participants = new Set(party.participants.map((participant) => participant.accountId));
  if (!participants.has(params.accountId)) {
    return {
      kind: "skip",
      selectedAccountId: party.participants[0]?.accountId ?? "",
    };
  }
  const conversationKey = `telegram:${params.chatId}:topic:${params.messageThreadId ?? "main"}`;
  const messageKey = `${conversationKey}:message:${params.messageId}`;
  const decision = getOrCreateDecision({
    messageKey,
    conversationKey,
    party,
    text: params.messageText,
    timestampMs: params.messageTimestampMs,
  });
  if (decision.selectedAccountId !== params.accountId) {
    return {
      kind: "skip",
      selectedAccountId: decision.selectedAccountId,
    };
  }
  if (!decision.selectedAgentId || decision.selectedAgentId === params.route.agentId) {
    return {
      kind: "pass",
      route: params.route,
      selectedAccountId: decision.selectedAccountId,
    };
  }
  const sessionKey = buildAgentSessionKey({
    agentId: decision.selectedAgentId,
    channel: "telegram",
    accountId: params.route.accountId,
    peer: {
      kind: "group",
      id: buildTelegramGroupPeerId(params.chatId, params.messageThreadId),
    },
    dmScope: params.cfg.session?.dmScope,
    identityLinks: params.cfg.session?.identityLinks,
  }).toLowerCase();
  const mainSessionKey = buildAgentMainSessionKey({
    agentId: decision.selectedAgentId,
  }).toLowerCase();
  return {
    kind: "pass",
    selectedAccountId: decision.selectedAccountId,
    route: {
      ...params.route,
      agentId: decision.selectedAgentId,
      sessionKey,
      mainSessionKey,
      lastRoutePolicy: deriveLastRoutePolicy({ sessionKey, mainSessionKey }),
      matchedBy: "binding.channel",
    },
  };
}
