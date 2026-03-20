import type { ReplyToMode } from "openclaw/plugin-sdk/config-runtime";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  buildTelegramMessageContext,
  type BuildTelegramMessageContextParams,
  type TelegramMediaRef,
} from "./bot-message-context.js";
import type { TelegramMessageContextOptions } from "./bot-message-context.types.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import type { TelegramBotOptions } from "./bot.js";
import type { TelegramContext, TelegramStreamMode } from "./bot/types.js";
import { dispatchTelegramPartySyntheticMessage } from "./group-party-bus.js";

/** Dependencies injected once when creating the message processor. */
type TelegramMessageProcessorDeps = Omit<
  BuildTelegramMessageContextParams,
  "primaryCtx" | "allMedia" | "storeAllowFrom" | "options"
> & {
  telegramCfg: TelegramAccountConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramDeps: TelegramBotDeps;
  opts: Pick<TelegramBotOptions, "token">;
};

export const createTelegramMessageProcessor = (deps: TelegramMessageProcessorDeps) => {
  const {
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    loadFreshConfig,
    sendChatActionHandler,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    telegramDeps,
    opts,
  } = deps;

  const sleep = async (delayMs: number) => {
    if (delayMs <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  };

  return async (
    primaryCtx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: TelegramMessageContextOptions,
    replyMedia?: TelegramMediaRef[],
  ) => {
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      replyMedia,
      storeAllowFrom,
      options,
      bot,
      cfg,
      account,
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
      sendChatActionHandler,
      loadFreshConfig,
      upsertPairingRequest: telegramDeps.upsertChannelPairingRequest,
    });
    if (!context) {
      return;
    }
    try {
      // Show activity immediately so queue/model wait does not look like a dead bot.
      if (typeof context.sendTyping === "function") {
        await context.sendTyping().catch(() => undefined);
      }
      const dispatchResult = await dispatchTelegramMessage({
        context,
        bot,
        cfg,
        runtime,
        replyToMode,
        streamMode,
        textLimit,
        telegramCfg,
        telegramDeps,
        opts,
      });
      const maxAutoReplies = Math.max(0, context.partyConfig?.autoReplies ?? 1);
      const participantAccountIds =
        context.partyConfig?.participants
          .map((participant) => participant.accountId)
          .filter((participantId) => participantId !== account.accountId) ?? [];
      const autoChatterDepth = context.autoChatterDepth ?? 0;
      if (
        !context.isGroup ||
        maxAutoReplies === 0 ||
        autoChatterDepth >= maxAutoReplies ||
        participantAccountIds.length === 0 ||
        !dispatchResult.hasFinalResponse ||
        !dispatchResult.finalAnswerText?.trim()
      ) {
        return;
      }
      const autoReplyDelayMs = Math.max(0, context.partyConfig?.autoReplyDelayMs ?? 1200);
      await sleep(autoReplyDelayMs);
      const speakerLabel =
        primaryCtx.me?.first_name?.trim() || primaryCtx.me?.username?.trim() || account.accountId;
      await dispatchTelegramPartySyntheticMessage({
        participantAccountIds,
        message: {
          chatId: context.chatId,
          chatType: context.msg.chat.type === "supergroup" ? "supergroup" : "group",
          chatTitle:
            "title" in context.msg.chat && typeof context.msg.chat.title === "string"
              ? context.msg.chat.title
              : undefined,
          messageThreadId: context.resolvedThreadId,
          text: `${speakerLabel}: ${dispatchResult.finalAnswerText.trim()}`,
          speakerAccountId: account.accountId,
          speakerName: primaryCtx.me?.first_name,
          speakerUsername: primaryCtx.me?.username,
          autoChatterDepth: autoChatterDepth + 1,
        },
      });
    } catch (err) {
      runtime.error?.(danger(`telegram message processing failed: ${String(err)}`));
      logVerbose(`telegram party auto-chatter aborted: ${String(err)}`);
      try {
        await bot.api.sendMessage(
          context.chatId,
          "Something went wrong while processing your request. Please try again.",
          context.threadSpec?.id != null ? { message_thread_id: context.threadSpec.id } : undefined,
        );
      } catch {
        // Best-effort fallback; delivery may fail if the bot was blocked or the chat is invalid.
      }
    }
  };
};
