import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { inspectTelegramAccount } from "./account-inspect.js";
import { listTelegramAccountIds } from "./accounts.js";

export const TELEGRAM_BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{10,}$/;

export type TelegramGetMeResult = {
  id?: number;
  username?: string;
  firstName?: string;
};

export function parseTelegramBotTokens(rawText: string): string[] {
  return rawText
    .split(/[\s,]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function buildUniqueTelegramAccountId(params: {
  candidate: string;
  usedAccountIds: Set<string>;
}): string {
  const base = normalizeAccountId(params.candidate) || "telegram-bot";
  if (!params.usedAccountIds.has(base)) {
    params.usedAccountIds.add(base);
    return base;
  }
  let suffix = 2;
  while (params.usedAccountIds.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  const next = `${base}-${suffix}`;
  params.usedAccountIds.add(next);
  return next;
}

export async function fetchTelegramBotIdentity(token: string): Promise<TelegramGetMeResult> {
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Telegram getMe returned HTTP ${response.status}`);
  }
  const parsed = payload as {
    ok?: boolean;
    description?: string;
    result?: { id?: unknown; username?: unknown; first_name?: unknown };
  };
  if (!response.ok || parsed.ok !== true || !parsed.result) {
    throw new Error(
      parsed.description?.trim() || `Telegram getMe returned HTTP ${response.status}`,
    );
  }
  return {
    id:
      typeof parsed.result.id === "number" && Number.isFinite(parsed.result.id)
        ? parsed.result.id
        : undefined,
    username:
      typeof parsed.result.username === "string" ? parsed.result.username.trim() : undefined,
    firstName:
      typeof parsed.result.first_name === "string" ? parsed.result.first_name.trim() : undefined,
  };
}

export function listConfiguredTelegramTokenOwners(cfg: OpenClawConfig): Map<string, string> {
  const owners = new Map<string, string>();
  for (const existingAccountId of listTelegramAccountIds(cfg)) {
    const account = inspectTelegramAccount({ cfg, accountId: existingAccountId });
    const token = account.token.trim();
    if (token && !owners.has(token)) {
      owners.set(token, account.accountId);
    }
  }
  return owners;
}
