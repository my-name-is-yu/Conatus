// ─── Markdown Renderer ───
//
// Simple markdown-to-plain-text conversion for Ink's <Text> component.
// We intentionally avoid marked-terminal because its ANSI escape codes
// with embedded newlines conflict with Ink's layout engine, causing
// text overlap and incorrect line-height calculations.
//
// Instead, we do lightweight manual conversion that produces clean text
// which Ink can properly measure and render.

export interface MarkdownLine {
  text: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
}

/**
 * Convert markdown text to an array of MarkdownLine objects.
 * Each line represents a visual line in the output.
 * Ink will render each as a separate <Text> element inside a vertical <Box>.
 */
export function renderMarkdownLines(text: string): MarkdownLine[] {
  const lines = text.split('\n');
  const result: MarkdownLine[] = [];

  let inCodeBlock = false;

  for (const line of lines) {
    // Code block toggle
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      result.push({ text: '  ' + line, dim: true });
      continue;
    }

    const trimmed = line.trim();

    // Empty line -> blank separator
    if (trimmed === '') {
      result.push({ text: '' });
      continue;
    }

    // Headers -> bold text (strip # markers)
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      result.push({ text: headerMatch[2], bold: true });
      continue;
    }

    // Unordered list items -> bullet points
    const listMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (listMatch) {
      result.push({ text: '  \u2022 ' + stripInlineMarkdown(listMatch[1]) });
      continue;
    }

    // Ordered list items -> numbered
    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (orderedMatch) {
      result.push({ text: '  ' + orderedMatch[1] + '. ' + stripInlineMarkdown(orderedMatch[2]) });
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(trimmed)) {
      result.push({ text: '\u2500'.repeat(40), dim: true });
      continue;
    }

    // Normal text -> strip inline markdown
    result.push({ text: stripInlineMarkdown(trimmed) });
  }

  return result;
}

/**
 * Strip inline markdown formatting, returning plain text.
 * Handles: **bold**, *italic*, `code`, [links](url), ~~strikethrough~~
 */
function stripInlineMarkdown(text: string): string {
  return text
    // Bold + italic: ***text***
    .replace(/\*{3}(.+?)\*{3}/g, '$1')
    // Bold: **text** or __text__
    .replace(/\*{2}(.+?)\*{2}/g, '$1')
    .replace(/_{2}(.+?)_{2}/g, '$1')
    // Italic: *text* or _text_
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    // Strikethrough: ~~text~~
    .replace(/~~(.+?)~~/g, '$1')
    // Inline code: `code`
    .replace(/`(.+?)`/g, '$1')
    // Links: [text](url) -> text
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    // Images: ![alt](url) -> [alt]
    .replace(/!\[(.+?)\]\(.+?\)/g, '[$1]');
}

/**
 * Legacy single-string renderer for backward compatibility.
 * Joins lines with newline. Prefer renderMarkdownLines() for Ink rendering.
 */
export function renderMarkdown(text: string): string {
  return renderMarkdownLines(text)
    .map((l) => l.text)
    .join('\n');
}
