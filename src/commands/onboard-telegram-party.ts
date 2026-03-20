import {
  buildUniqueTelegramAccountId,
  fetchTelegramBotIdentity,
  listConfiguredTelegramTokenOwners,
  parseTelegramBotTokens,
  TELEGRAM_BOT_TOKEN_PATTERN,
} from "../../extensions/telegram/src/token-provisioning.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export type TelegramPartyOnboardOptions = {
  tokens?: string;
  groupId?: string;
  mode?: "round-robin" | "least-recent" | "random";
  cooldownSeconds?: number;
  requireMention?: boolean;
  nonInteractive?: boolean;
};

async function promptForValue(params: {
  provided?: string;
  nonInteractive?: boolean;
  prompter: WizardPrompter;
  message: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string> {
  if (typeof params.provided === "string" && params.provided.trim()) {
    return params.provided.trim();
  }
  if (params.nonInteractive) {
    throw new Error(`${params.message} is required in non-interactive mode.`);
  }
  return await params.prompter.text({
    message: params.message,
    placeholder: params.placeholder,
    validate: params.validate,
  });
}

function ensureTelegramPartyGroup(cfg: OpenClawConfig, groupId: string) {
  const telegram = ((cfg.channels ??= {}).telegram ??= {});
  telegram.groupPolicy ??= "open";
  const groups = (telegram.groups ??= {});
  const group = (groups[groupId] ??= {});
  group.requireMention ??= false;
  const party = (group.party ??= {});
  party.enabled ??= true;
  party.mode ??= "least-recent";
  party.cooldownSeconds ??= 45;
  party.participants ??= [];
  return { telegram, group, party };
}

export type ConfigureTelegramPartyResult = {
  cfg: OpenClawConfig;
  groupId: string;
  addedAccountIds: string[];
  duplicateAccountIds: string[];
  failedTokens: string[];
};

export async function configureTelegramPartyConfig(params: {
  cfg: OpenClawConfig;
  opts: TelegramPartyOnboardOptions;
  prompter: WizardPrompter;
}): Promise<ConfigureTelegramPartyResult> {
  const { cfg, opts, prompter } = params;
  const tokensInput = await promptForValue({
    provided: opts.tokens,
    nonInteractive: opts.nonInteractive,
    prompter,
    message: "Telegram bot tokens (comma-separated)",
    placeholder: "123:token_a,456:token_b",
    validate: (value) =>
      parseTelegramBotTokens(value).length > 0 ? undefined : "Enter at least one token.",
  });
  const groupId = await promptForValue({
    provided: opts.groupId,
    nonInteractive: opts.nonInteractive,
    prompter,
    message: "Telegram group ID",
    placeholder: "-1001234567890",
    validate: (value) =>
      /^-\d+$/.test(value.trim())
        ? undefined
        : "Telegram group IDs should look like -1001234567890.",
  });

  const parsedTokens = parseTelegramBotTokens(tokensInput);
  const invalidTokens = parsedTokens.filter((token) => !TELEGRAM_BOT_TOKEN_PATTERN.test(token));
  if (invalidTokens.length > 0) {
    throw new Error(`Invalid Telegram bot token format: ${invalidTokens.join(", ")}`);
  }

  let mode = opts.mode;
  if (!mode && !opts.nonInteractive) {
    mode = await prompter.select({
      message: "Party selection mode",
      options: [
        { value: "least-recent", label: "Least recent", hint: "Spread replies across bots" },
        { value: "round-robin", label: "Round robin", hint: "Strict rotation" },
        { value: "random", label: "Random", hint: "Unpredictable reply order" },
      ],
      initialValue: "least-recent",
    });
  }
  mode ??= "least-recent";

  let cooldownSeconds = opts.cooldownSeconds;
  if (cooldownSeconds == null && !opts.nonInteractive) {
    const input = await prompter.text({
      message: "Cooldown seconds",
      initialValue: "45",
      validate: (value) => {
        const parsed = Number.parseInt(value.trim(), 10);
        return Number.isFinite(parsed) && parsed >= 0 ? undefined : "Enter a non-negative integer.";
      },
    });
    cooldownSeconds = Number.parseInt(input.trim(), 10);
  }
  cooldownSeconds ??= 45;

  let requireMention = opts.requireMention;
  if (typeof requireMention !== "boolean" && !opts.nonInteractive) {
    requireMention = await prompter.confirm({
      message: "Require mention in the group?",
      initialValue: false,
    });
  }
  requireMention ??= false;

  const progress = prompter.progress("Provisioning Telegram party");
  const currentCfg = cfg;
  const nextCfg: OpenClawConfig = structuredClone(currentCfg);
  const { group, party, telegram } = ensureTelegramPartyGroup(nextCfg, groupId);
  group.requireMention = requireMention;
  party.mode = mode;
  party.cooldownSeconds = cooldownSeconds;
  const accounts = (telegram.accounts ??= {});
  const usedAccountIds = new Set<string>(
    Object.keys(accounts).map((existingAccountId) => normalizeAccountId(existingAccountId)),
  );
  const tokenOwners = listConfiguredTelegramTokenOwners(currentCfg);
  const existingParticipants = new Set(
    (party.participants ?? [])
      .map((participant) =>
        participant && typeof participant.accountId === "string"
          ? normalizeAccountId(participant.accountId)
          : "",
      )
      .filter(Boolean),
  );
  const addedAccountIds: string[] = [];
  const duplicateAccountIds: string[] = [];
  const failedTokens: string[] = [];

  for (const token of parsedTokens) {
    const owner = tokenOwners.get(token);
    if (owner) {
      duplicateAccountIds.push(owner);
      if (!existingParticipants.has(owner)) {
        party.participants?.push({ accountId: owner });
        existingParticipants.add(owner);
      }
      continue;
    }
    progress.update(`Checking ${token.slice(0, 8)}...`);
    try {
      const identity = await fetchTelegramBotIdentity(token);
      const candidate =
        identity.username?.toLowerCase() ??
        (typeof identity.id === "number" ? `bot-${identity.id}` : "telegram-bot");
      const accountId = buildUniqueTelegramAccountId({
        candidate,
        usedAccountIds,
      });
      accounts[accountId] = {
        ...accounts[accountId],
        enabled: true,
        botToken: token,
        ...(identity.firstName ? { name: identity.firstName } : {}),
      };
      party.participants?.push({ accountId });
      existingParticipants.add(accountId);
      tokenOwners.set(token, accountId);
      addedAccountIds.push(accountId);
    } catch (error) {
      failedTokens.push(`${token.slice(0, 8)}... (${String(error)})`);
    }
  }

  if (addedAccountIds.length === 0 && duplicateAccountIds.length === 0) {
    progress.stop("No Telegram bots were added");
    throw new Error(
      failedTokens.length > 0
        ? `Unable to add Telegram bots. ${failedTokens.join(" | ")}`
        : "Unable to add Telegram bots.",
    );
  }

  progress.stop("Telegram party config prepared");
  return {
    cfg: nextCfg,
    groupId,
    addedAccountIds,
    duplicateAccountIds,
    failedTokens,
  };
}

export async function onboardTelegramPartyCommand(
  opts: TelegramPartyOnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
  prompter: WizardPrompter = createClackPrompter(),
) {
  const result = await configureTelegramPartyConfig({
    cfg: loadConfig(),
    opts,
    prompter,
  });
  await writeConfigFile(result.cfg);
  runtime.log(
    [
      `Group ${result.groupId} ready for Telegram party mode.`,
      result.addedAccountIds.length > 0
        ? `Added accounts: ${result.addedAccountIds.join(", ")}`
        : "",
      result.duplicateAccountIds.length > 0
        ? `Already configured: ${result.duplicateAccountIds.join(", ")}`
        : "",
      result.failedTokens.length > 0 ? `Lookup failed: ${result.failedTokens.join(" | ")}` : "",
      'Next: run "pnpm openclaw gateway run"',
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
