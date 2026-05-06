export const USER_INPUT_SCHEMA_VERSION = "user-input-v1" as const;

export type UserInputItem =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string; name?: string; metadata?: Record<string, unknown> }
  | { kind: "local_image"; path: string; name?: string; metadata?: Record<string, unknown> }
  | { kind: "mention"; target: string; label?: string; metadata?: Record<string, unknown> }
  | { kind: "skill"; name: string; path?: string; metadata?: Record<string, unknown> }
  | { kind: "plugin"; name: string; id?: string; metadata?: Record<string, unknown> }
  | { kind: "tool"; name: string; id?: string; metadata?: Record<string, unknown> }
  | { kind: "attachment"; id: string; name?: string; mimeType?: string; path?: string; url?: string; metadata?: Record<string, unknown> };

export interface UserInput {
  schema_version: typeof USER_INPUT_SCHEMA_VERSION;
  items: UserInputItem[];
  rawText?: string;
  metadata?: Record<string, unknown>;
}

function cloneItem(item: UserInputItem): UserInputItem {
  return {
    ...item,
    ...("metadata" in item && item.metadata ? { metadata: { ...item.metadata } } : {}),
  } as UserInputItem;
}

export function createTextUserInput(text: string, metadata?: Record<string, unknown>): UserInput {
  return {
    schema_version: USER_INPUT_SCHEMA_VERSION,
    items: [{ kind: "text", text }],
    rawText: text,
    ...(metadata ? { metadata: { ...metadata } } : {}),
  };
}

export function cloneUserInput(input: UserInput): UserInput {
  return {
    schema_version: USER_INPUT_SCHEMA_VERSION,
    items: input.items.map(cloneItem),
    ...(input.rawText !== undefined ? { rawText: input.rawText } : {}),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  };
}

export function normalizeUserInput(input: UserInput | undefined, fallbackText: string): UserInput {
  if (!input) {
    return createTextUserInput(fallbackText);
  }
  return {
    schema_version: USER_INPUT_SCHEMA_VERSION,
    items: input.items.length > 0 ? input.items.map(cloneItem) : [{ kind: "text", text: fallbackText }],
    rawText: input.rawText ?? fallbackText,
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  };
}

export function replaceUserInputText(input: UserInput, text: string): UserInput {
  const normalized = normalizeUserInput(input, text);
  return {
    ...normalized,
    rawText: text,
    items: normalized.items.map((item) => item.kind === "text" ? { ...item, text } : cloneItem(item)),
  };
}

export function getUserInputText(input: UserInput): string {
  const textItems = input.items
    .filter((item): item is Extract<UserInputItem, { kind: "text" }> => item.kind === "text")
    .map((item) => item.text);
  if (textItems.length > 0) {
    return textItems.join("\n");
  }
  return input.rawText ?? "";
}
