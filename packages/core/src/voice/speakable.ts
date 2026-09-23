/*
 * The text a voice reads: what a reader sees, without Markdown delimiters, link and image
 * addresses, code blocks or tables. Nothing is summarised — only what cannot be said is gone.
 */

const FENCED_BLOCK = /^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm;
const TABLE_ROW = /^[ \t]*\|.*$/gm;
const THEMATIC_BREAK = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm;
const IMAGE = /!\[[^\]]*\]\((?:<[^>]*>|[^)])*\)/g;
const LINK = /\[([^\]]+)\]\((?:<[^>]*>|[^)])*\)/g;
const REFERENCE_LINK = /\[([^\]]+)\]\[[^\]]*\]/g;
const LINK_DEFINITION = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*\S+.*$/gm;
const AUTOLINK = /<(?:https?|mailto):[^>\s]*>/g;
const BARE_URL = /\bhttps?:\/\/[^\s<>()]+/g;
const HTML_TAG = /<\/?[A-Za-z][^>]*>/g;
const LINE_MARKER = /^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?)/gm;

export function speakableText(markdown: string): string {
  return markdown
    .replace(FENCED_BLOCK, ' ')
    .replace(TABLE_ROW, ' ')
    .replace(THEMATIC_BREAK, ' ')
    .replace(LINK_DEFINITION, ' ')
    .replace(IMAGE, '')
    .replace(LINK, '$1')
    .replace(REFERENCE_LINK, '$1')
    .replace(AUTOLINK, '')
    .replace(BARE_URL, '')
    .replace(HTML_TAG, '')
    .replace(LINE_MARKER, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[^\p{L}\p{N}*])\*([^*\s][^*]*?)\*(?![\p{L}\p{N}*])/gu, '$1$2')
    .replace(/(^|[^\p{L}\p{N}_])_([^_\s][^_]*?)_(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,!?;:…])/g, '$1')
    .trim();
}
