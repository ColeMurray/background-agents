/**
 * Split long agent text into Slack section blocks.
 *
 * Slack caps a section block's mrkdwn (see SECTION_TEXT_MAX_CHARS) and rejects
 * the whole message if any block exceeds it. Two surfaces need the same treatment — the
 * completion the Slack bot posts when a session finishes, and the messages an
 * agent posts itself through the notify route in the control plane — so the
 * policy lives here rather than in either one. Splitting keeps code fences
 * balanced across the seam, since a section that opens a fence without closing
 * it renders the rest of the message as monospace.
 */

/**
 * Slack's hard cap on a section block's mrkdwn text. Responses longer than this
 * are split across consecutive section blocks rather than truncated, so a long
 * answer arrives whole instead of stopping mid-sentence.
 */
export const SECTION_TEXT_MAX_CHARS = 3000;

/**
 * How many section blocks a response may occupy. Slack allows 50 blocks per
 * message; the rest of this builder contributes at most 4 (artifacts, tools,
 * footer, actions), so this leaves comfortable headroom. Beyond this the tail is
 * truncated and the View Session button is the way to read the whole thing.
 */
export const MAX_RESPONSE_SECTIONS = 20;

const CODE_FENCE = "```";

interface FenceState {
  readonly open: boolean;
  readonly info: string;
}

const CLOSED_FENCE: FenceState = { open: false, info: "" };

/**
 * Cap on the retained fence info string. An info string is a language token
 * (`ts`, `python`, `json`), so this is generous for real input — but it has to be
 * bounded: `reopenPrefix` re-emits it on every continuation section, so an
 * unbounded capture let a pathologically long fence-opener line push sections
 * past the cap by the length of its info string. Only the first whitespace-
 * delimited token is kept, since anything after it isn't a language.
 */
const FENCE_INFO_MAX_CHARS = 32;

function normalizeFenceInfo(raw: string): string {
  return raw.trim().split(/\s/, 1)[0].slice(0, FENCE_INFO_MAX_CHARS);
}

/** Fence state after `chunk` is appended to text that ended in `state`. */
function advanceFence(state: FenceState, chunk: string): FenceState {
  let next = state;
  for (const line of chunk.split("\n")) {
    let cursor = 0;
    while (cursor < line.length) {
      const fenceIndex = line.indexOf(CODE_FENCE, cursor);
      if (fenceIndex === -1) break;
      const startsLine = line.slice(0, fenceIndex).trim().length === 0;
      next = next.open
        ? CLOSED_FENCE
        : {
            open: true,
            info: startsLine ? normalizeFenceInfo(line.slice(fenceIndex + CODE_FENCE.length)) : "",
          };
      cursor = fenceIndex + CODE_FENCE.length;
    }
  }
  return next;
}

/** Reopens, at the top of a section, a fence carried over from the previous one. */
function reopenPrefix(state: FenceState): string {
  return state.open ? `${CODE_FENCE}${state.info}\n` : "";
}

/** Closes a fence still open at the end of a section. */
function closeSuffix(state: FenceState): string {
  return state.open ? `\n${CODE_FENCE}` : "";
}

function sliceAtCodePointBoundary(text: string, maxChars: number): string {
  let end = Math.min(maxChars, text.length);
  const lastCodeUnit = text.charCodeAt(end - 1);
  const nextCodeUnit = text.charCodeAt(end);
  // Back up when the cut falls between a UTF-16 high and low surrogate, so a
  // supplementary code point is never split across sections.
  if (
    lastCodeUnit >= 0xd800 &&
    lastCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  ) {
    end -= 1;
  }
  return text.slice(0, end);
}

class SlackSectionAccumulator {
  private readonly sections: string[] = [];
  private sectionStart = CLOSED_FENCE;
  private sectionEnd = CLOSED_FENCE;
  private body = "";
  private truncated = false;

  constructor(
    private readonly maxChars: number,
    private readonly maxSections: number
  ) {}

  appendSourceToken(sourceToken: string): boolean {
    if (!sourceToken) return true;
    if (sourceToken.startsWith("\n\n") || sourceToken.length <= this.maxChars) {
      return this.appendToken(sourceToken);
    }

    // Oversized paragraphs (long tables, big code blocks) fall back to line
    // tokens while retaining their line endings.
    for (const lineToken of sourceToken.split(/(\n)/)) {
      if (lineToken && !this.appendToken(lineToken)) return false;
    }
    return true;
  }

  finish(): string[] {
    if (!this.truncated) this.flush();
    if (!this.truncated) return this.sections;

    const lastIndex = this.sections.length - 1;
    this.sections[lastIndex] = withTruncationMarker(this.sections[lastIndex], this.maxChars);
    return this.sections;
  }

  private appendToken(token: string): boolean {
    if (this.tryAppend(token)) return true;

    this.flush();
    if (this.stopAtSectionLimit()) return false;
    if (this.tryAppend(token)) return true;

    return this.appendOversizedToken(token);
  }

  private tryAppend(token: string): boolean {
    const joined = this.body + token;
    const joinedEnd = advanceFence(this.sectionEnd, token);
    if (this.render(joined, joinedEnd).length > this.maxChars) return false;

    this.body = joined;
    this.sectionEnd = joinedEnd;
    return true;
  }

  private appendOversizedToken(token: string): boolean {
    let rest = token;
    while (rest.length > 0) {
      const taken = this.takeHardSlice(rest);
      rest = rest.slice(taken.length);
      if (rest.length === 0) continue;

      this.flush();
      if (this.stopAtSectionLimit()) return false;
    }
    return true;
  }

  private takeHardSlice(text: string): string {
    const start = this.sectionEnd;
    const prefix = reopenPrefix(start);
    let taken = sliceAtCodePointBoundary(text, Math.max(0, this.maxChars - prefix.length));
    if (!taken) {
      throw new RangeError("Section budget is too small to fit the next Unicode code point");
    }

    let end = advanceFence(start, taken);
    const suffix = closeSuffix(end);
    if (prefix.length + taken.length + suffix.length > this.maxChars) {
      taken = sliceAtCodePointBoundary(
        text,
        Math.max(0, this.maxChars - prefix.length - suffix.length)
      );
      if (!taken) {
        throw new RangeError("Section budget is too small to fit the next Unicode code point");
      }
      end = advanceFence(start, taken);
    }

    this.sectionStart = start;
    this.body = taken;
    this.sectionEnd = end;
    return taken;
  }

  private flush(): void {
    if (!this.body) return;
    this.sections.push(this.render(this.body, this.sectionEnd));
    // A fence left open carries into the next section, which reopens it.
    this.sectionStart = this.sectionEnd;
    this.body = "";
  }

  private stopAtSectionLimit(): boolean {
    if (this.sections.length < this.maxSections) return false;
    this.truncated = true;
    return true;
  }

  private render(content: string, end: FenceState): string {
    return `${reopenPrefix(this.sectionStart)}${content}${closeSuffix(end)}`;
  }
}

/**
 * Split agent prose into Slack section blocks, preferring paragraph boundaries.
 *
 * Long answers used to be cut at 2000 characters in a single block, which stopped
 * multi-part answers mid-sentence even though Slack accepts far more. Splitting
 * greedily on blank lines keeps headings with their prose; paragraphs that are
 * themselves oversized fall back to line boundaries, then to a hard slice.
 *
 * Fenced code blocks are closed at the end of a section and reopened at the start
 * of the next, so a split inside a fence doesn't leak monospace formatting across
 * the rest of the message.
 *
 * Both repairs cost characters, so every fit check measures the text Slack will
 * actually receive — reopen prefix plus body plus closing fence — and the
 * hard-slice path advances by exactly what it kept. Measuring the bare body
 * instead lets an in-fence section overflow by the 4 closing characters, and
 * Slack rejects the whole message rather than trimming the block.
 *
 * Returns [] for empty input so the caller can render its own placeholder.
 */
export function splitIntoSlackSections(
  text: string,
  maxChars: number = SECTION_TEXT_MAX_CHARS,
  maxSections: number = MAX_RESPONSE_SECTIONS
): string[] {
  if (!text.trim()) return [];
  if (text.length <= maxChars) return [text];

  const accumulator = new SlackSectionAccumulator(maxChars, maxSections);
  for (const sourceToken of text.split(/(\n{2,})/)) {
    if (!accumulator.appendSourceToken(sourceToken)) break;
  }
  return accumulator.finish();
}

/**
 * Append the truncation pointer to the final kept section, preserving both the
 * character cap and fence balance — slicing blindly can eat the closing fence and
 * leak monospace over the marker.
 */
function withTruncationMarker(section: string, maxChars: number): string {
  const marker = "\n\n_...truncated — open the session to read the rest_";
  if (section.length + marker.length <= maxChars) return section + marker;
  const closing = `\n${CODE_FENCE}`;
  // Reserve room for a closing fence unconditionally: the cut can land inside a
  // fence this section opened *and* closed, which no trailing-fence check sees.
  const content = section.endsWith(closing) ? section.slice(0, -closing.length) : section;
  const room = maxChars - marker.length - closing.length;
  const sliced = sliceAtCodePointBoundary(content, Math.max(0, room));
  const needsClose = (sliced.match(/```/g) ?? []).length % 2 !== 0;
  return `${sliced}${needsClose ? closing : ""}${marker}`;
}
