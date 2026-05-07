import {
  renderMarkdownLines,
  splitMarkdownLineToRows,
  wrapTextToRows,
} from "../markdown-renderer.js";
import { measureTextWidth } from "../text-width.js";
import { getMessageTypeColor } from "../theme.js";
import type { ChatDisplayRow, ChatMessage, ChatViewport } from "./types.js";
const DEFAULT_MESSAGE_WIDTH_PADDING = 4;
const MESSAGE_INNER_PADDING = 2;
const MIN_MESSAGE_WIDTH = 10;
const USER_PROMPT_PREFIX = "◉ ";
const USER_CONTINUATION_PREFIX = "  ";
const MESSAGE_ROW_CACHE_LIMIT = 500;

type MessageRowCacheEntry = {
  key: string;
  rows: ChatDisplayRow[];
};

const messageRowCache = new Map<string, MessageRowCacheEntry>();

function getRowWidth(termCols: number): number {
  return Math.max(
    MIN_MESSAGE_WIDTH,
    termCols - DEFAULT_MESSAGE_WIDTH_PADDING - MESSAGE_INNER_PADDING,
  );
}

function wrapUserMessageRows(text: string, width: number): string[] {
  const contentWidth = Math.max(1, width - measureTextWidth(USER_PROMPT_PREFIX));
  const wrapped = wrapTextToRows(text, contentWidth);
  return wrapped.map((line, index) => (
    index === 0
      ? `${USER_PROMPT_PREFIX}${line}`
      : `${USER_CONTINUATION_PREFIX}${line}`
  ));
}

function buildMessageRows(msg: ChatMessage, width: number): ChatDisplayRow[] {
  if (msg.role === "user") {
    const rows = wrapUserMessageRows(msg.text, width);
    return rows.map((text, index) => ({
      key: `${msg.id}:user:${index}`,
      kind: "user",
      text,
      backgroundColor: "#D9D9D9",
      color: "#1A1A1A",
      paddingX: 1,
    }));
  }

  const typeColor = getMessageTypeColor(msg.messageType);
  const rendered = renderMarkdownLines(msg.text);
  const rows: ChatDisplayRow[] = [];

  rendered.forEach((line, lineIndex) => {
    const wrappedLines = splitMarkdownLineToRows(line, width);
    wrappedLines.forEach((wrappedLine, rowIndex) => {
      rows.push({
        key: `${msg.id}:pulseed:${lineIndex}:${rowIndex}`,
        kind: "pulseed",
        text: wrappedLine.text,
        segments: wrappedLine.segments,
        color: typeColor,
        bold: wrappedLine.bold,
        dim: wrappedLine.dim,
        italic: wrappedLine.italic,
        marginLeft: 2,
      });
    });
  });

  if (rows.length === 0) {
    rows.push({
      key: `${msg.id}:pulseed:empty`,
      kind: "pulseed",
      text: "",
      color: typeColor,
      marginLeft: 2,
    });
  }

  return rows;
}

function getMessageCacheKey(msg: ChatMessage, width: number): string {
  return [
    msg.id,
    msg.role,
    msg.messageType ?? "",
    width,
    msg.text.length,
    msg.text,
  ].join("\u0000");
}

function getCachedMessageRows(msg: ChatMessage, width: number): ChatDisplayRow[] {
  const key = getMessageCacheKey(msg, width);
  const cached = messageRowCache.get(msg.id);
  if (cached?.key === key) {
    return cached.rows;
  }

  const rows = buildMessageRows(msg, width);
  messageRowCache.set(msg.id, { key, rows });
  if (messageRowCache.size > MESSAGE_ROW_CACHE_LIMIT) {
    const oldestKey = messageRowCache.keys().next().value;
    if (oldestKey) {
      messageRowCache.delete(oldestKey);
    }
  }
  return rows;
}

export function buildChatViewport(
  messages: ChatMessage[],
  termCols: number,
  availableRows: number,
  scrollOffsetRows: number,
): ChatViewport {
  const maxVisibleRows = Math.max(1, Math.floor(availableRows));
  const rowWidth = getRowWidth(termCols);
  const messageRows = messages.map((msg) => ({
    msg,
    rows: getCachedMessageRows(msg, rowWidth),
  }));

  const totalRows = messageRows.reduce(
    (total, entry) => total + entry.rows.length + 1,
    0,
  );
  const visibleEndIdx = Math.max(0, totalRows - scrollOffsetRows);
  const visibleStartIdx = Math.max(0, visibleEndIdx - maxVisibleRows);
  const visibleRows: ChatDisplayRow[] = [];
  let cursor = 0;

  for (const { msg, rows } of messageRows) {
    const messageStart = cursor;
    const messageEnd = messageStart + rows.length;

    if (messageEnd > visibleStartIdx && messageStart < visibleEndIdx) {
      const sliceStart = Math.max(0, visibleStartIdx - messageStart);
      const sliceEnd = Math.min(rows.length, visibleEndIdx - messageStart);
      visibleRows.push(...rows.slice(sliceStart, sliceEnd));
    }

    cursor = messageEnd;
    if (cursor >= visibleStartIdx && cursor < visibleEndIdx) {
      visibleRows.push({
        key: `${msg.id}:spacer`,
        kind: "spacer",
        text: "",
      });
    }
    cursor += 1;

    if (cursor >= visibleEndIdx) {
      break;
    }
  }

  return {
    rows: visibleRows,
    hiddenAboveRows: visibleStartIdx,
    hiddenBelowRows: totalRows - visibleEndIdx,
    totalRows,
    maxVisibleRows,
  };
}
