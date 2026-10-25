/**
 * harness-output.ts — split a harness's stdout into its answer and its
 * reasoning.
 *
 * Cline's headless mode prints its reasoning with the terminal's SGR *dim*
 * attribute and a `[thinking] ` label — `ESC[2m[thinking] … ESC[0m` — then the
 * answer unstyled. Nothing in that text says where the reasoning ends, so this
 * reads the styling the CLI itself chose: text written while dim is active is
 * reasoning, everything else is the answer. A CLI that stops painting (a
 * `NO_COLOR` terminal, a future release) makes every character an answer — the
 * reasoning stays inline, but no content is lost or misattributed.
 *
 * The splitter is streaming — an escape sequence or the `[thinking] ` label can
 * be cut in half by a chunk boundary, so the remainder is carried into the next
 * feed (and emitted by `flush` when the child closes).
 */

export interface SplitChunk {
  /** The assistant's answer. */
  text: string;
  /** The CLI's reasoning for this turn. */
  thinking: string;
}

export interface ThinkingSplitter {
  feed(chunk: string): SplitChunk;
  flush(): SplitChunk;
}

/** Cline's label at the start of the dim block. */
const LABEL = "[thinking] ";

/** `ESC [ params letter` — the only escape form a styled answer uses here. */
const CSI = /^\u001b\[([0-9;?]*)([@-~])/;

export function createThinkingSplitter(): ThinkingSplitter {
  let dim = false;
  /** An escape sequence whose tail has not arrived yet. */
  let carry = "";
  /** `[thinking] ` is being matched: "" = undecided, "done", or not a label. */
  let label: "pending" | "done" | "none" = "pending";
  let labelProbe = "";

  /** The answer has begun; leading whitespace (the blank line Cline leaves
   *  between its reasoning and the answer) is not part of it. */
  let textStarted = false;

  const emit = (out: SplitChunk, ch: string) => {
    if (dim) {
      out.thinking += ch;
      return;
    }
    if (!textStarted) {
      if (!ch.trim()) return;
      textStarted = true;
    }
    out.text += ch;
  };

  /** Hold back the leading label so it never reaches the thinking lane. */
  const stripLabel = (out: SplitChunk) => {
    if (label !== "pending" || !out.thinking) return;
    if (label === "done") return;
    labelProbe += out.thinking;
    out.thinking = "";
    if (labelProbe.startsWith(LABEL)) {
      label = "done";
      out.thinking = labelProbe.slice(LABEL.length);
      labelProbe = "";
    } else if (LABEL.startsWith(labelProbe)) {
      // Still a prefix of the label — wait for more.
    } else {
      label = "none";
      out.thinking = labelProbe;
      labelProbe = "";
    }
  };

  const drain = (s: string): SplitChunk => {
    const out: SplitChunk = { text: "", thinking: "" };
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch !== "\u001b") {
        emit(out, ch);
        i += 1;
        continue;
      }
      const match = CSI.exec(s.slice(i));
      if (!match) {
        // Either an incomplete sequence (its tail is in the next chunk) or a
        // form this parser does not style (OSC, a two-byte escape): carry the
        // first, drop the second.
        const rest = s.slice(i);
        if (/^\u001b(\[[0-9;?]*)?$/.test(rest)) {
          carry = rest;
          break;
        }
        i += 1; // a lone ESC; the rest is ordinary text
        continue;
      }
      i += match[0].length;
      if (match[2] !== "m") continue;
      const params = match[1].split(";").filter(Boolean);
      if (params.some((p) => p === "0" || p === "22")) dim = false;
      else if (params.includes("2")) dim = true;
    }
    stripLabel(out);
    return out;
  };

  return {
    feed(chunk) {
      const s = carry + String(chunk ?? "");
      carry = "";
      return drain(s);
    },
    flush() {
      const out: SplitChunk = { text: "", thinking: "" };
      if (carry) {
        // A dangling escape is styling, not content.
        carry = "";
      }
      if (label === "pending" && labelProbe) {
        out.thinking = labelProbe;
        label = "none";
        labelProbe = "";
      }
      return out;
    },
  };
}
