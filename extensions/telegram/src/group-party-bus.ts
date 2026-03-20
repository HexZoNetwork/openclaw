type TelegramPartySyntheticMessage = {
  chatId: number | string;
  chatType: "group" | "supergroup";
  chatTitle?: string;
  messageThreadId?: number;
  text: string;
  speakerAccountId: string;
  speakerName?: string;
  speakerUsername?: string;
  autoChatterDepth: number;
};

type TelegramPartySyntheticHandler = (message: TelegramPartySyntheticMessage) => Promise<void>;

const telegramPartyHandlers = new Map<string, TelegramPartySyntheticHandler>();
let nextSyntheticMessageId = 9_000_000_000;

export function allocateTelegramPartySyntheticMessageId(): number {
  nextSyntheticMessageId += 1;
  return nextSyntheticMessageId;
}

export function registerTelegramPartySyntheticHandler(
  accountId: string,
  handler: TelegramPartySyntheticHandler,
): () => void {
  telegramPartyHandlers.set(accountId, handler);
  return () => {
    if (telegramPartyHandlers.get(accountId) === handler) {
      telegramPartyHandlers.delete(accountId);
    }
  };
}

export async function dispatchTelegramPartySyntheticMessage(params: {
  participantAccountIds: string[];
  message: TelegramPartySyntheticMessage;
}): Promise<void> {
  const handlers = params.participantAccountIds
    .map((accountId) => telegramPartyHandlers.get(accountId))
    .filter((handler): handler is TelegramPartySyntheticHandler => Boolean(handler));
  if (handlers.length === 0) {
    return;
  }
  await Promise.allSettled(handlers.map(async (handler) => await handler(params.message)));
}
