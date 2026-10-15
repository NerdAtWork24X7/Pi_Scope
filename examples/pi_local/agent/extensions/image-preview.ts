/**
 * Image Preview Extension
 *
 * Two responsibilities:
 * 1. On prompt submit ("input" hook), detect image file paths in the text
 *    (bare paths like `/tmp/pi-clipboard-<uuid>.png` from Ctrl+V, or
 *    `@`-prefixed like `@shot.png`), attach them as ImageContent, and replace
 *    each token with a stable `[Image #N: <basename>]` label.
 * 2. On transcript render (markdown transformer for user messages), replace
 *    those labels' surroundings with an inline kitty/iterm2 image preview
 *    via the pi-tui `Image` component, falling back to a plain text line on
 *    terminals without image support.
 */

import type { ImageContent } from "@mariozechner/pi-ai";
import {
  detectSupportedImageMimeTypeFromFile,
  formatDimensionNote,
  resizeImage,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { getCapabilities, Image } from "@mariozechner/pi-tui";
import { basename, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";

// Cap per-prompt attachments and the preview cache (evict oldest on overflow).
const MAX_IMAGES_PER_PROMPT = 10;
const MAX_CACHE_ENTRIES = 32;
const MAX_DIMENSION = 2000;

type CacheEntry = {
  path: string;
  mimeType: string;
  base64: string;
  width: number;
  height: number;
  // Stable Kitty graphics id (1..0xffffffff) reused across repaints. The TUI
  // parses `i=` back out of rendered lines to delete stale placements, so a
  // random per-render id would leak kitty image memory on every repaint.
  imageId?: number;
};

// Module-scoped so labels stay resolvable across prompts for the life of the
// session process. Keyed by the exact label string; bounded to 32 entries.
const imageCache = new Map<string, CacheEntry>();

// Session-global label counter. Per-prompt numbering (restarting at #1) would
// let two different files share a label when they share a basename, so the
// cache would resolve a stale preview. A monotonic counter keeps labels unique
// for the session; the 32-entry LRU bounds memory regardless.
let labelCounter = 0;

// Match a single whitespace-delimited token that may be an image path:
// - `@`-prefixed (`@shot.png`)
// - bare path (absolute like /tmp/pi-clipboard-*.png or relative like shot.png)
// Wrapped in an optional quote/backtick pair (stripped below). Non-greedy
// content up to the matching closing quote, or up to whitespace when bare.
const TOKEN_RE = /(["'`])?(@?\/?[^\s"'`]+)\1/g;

function makeLabel(n: number, path: string): string {
  return `[Image #${n}: ${basename(path)}]`;
}

// Deterministic 32-bit id derived from the label so re-renders of the same
// preview reuse one Kitty graphics id. FNV-1a keeps it stable across processes
// and cheap; mapped to [1, 0xffffffff] since 0 is not a valid kitty id.
function stableImageId(label: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 0xfffffffe + 1;
}

// Strip decorative wrappers the parser tolerates: surrounding quotes and a
// single trailing `@` (e.g. `"shot.png"@`).
function cleanCandidate(raw: string): string {
  let s = raw;
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")) ||
      (s.startsWith("`") && s.endsWith("`")))
  ) {
    s = s.slice(1, -1);
  }
  if (s.endsWith("@")) s = s.slice(0, -1);
  return s;
}

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, _ctx) => {
    // Only the interactive path carries user-typed text worth scanning;
    // rpc/extension sources would loop on their own emitted prompts.
    if (event.source !== "interactive") return { action: "continue" };

    try {
      const text = event.text;
      const attached: ImageContent[] = [];
      const dimensionNotes: string[] = [];
      const seen = new Set<string>(); // resolved absolute paths, dedupe
      const replacements = new Map<string, string>(); // token -> label

      for (const match of text.matchAll(TOKEN_RE)) {
        if (attached.length >= MAX_IMAGES_PER_PROMPT) break;
        const token = match[0];
        const candidate = cleanCandidate(match[2] ?? token);
        if (!candidate) continue;
        const abs = resolve(process.cwd(), candidate);
        let exists: boolean;
        try {
          exists = statSync(abs).isFile();
        } catch {
          exists = false;
        }
        if (!exists || seen.has(abs)) continue;

        // detectSupportedImageMimeTypeFromFile returns null for non-image
        // content (e.g. a .png file that isn't actually a PNG) — skip those.
        const mimeType = await detectSupportedImageMimeTypeFromFile(abs);
        if (!mimeType) continue;

        const bytes = new Uint8Array(readFileSync(abs));
        const resized = await resizeImage(bytes, mimeType, {
          maxWidth: MAX_DIMENSION,
          maxHeight: MAX_DIMENSION,
        });
        // Null resize = decoder refused; fall back to raw bytes with the
        // detected mime type so the model still receives the image.
        const base64 = resized
          ? resized.data
          : Buffer.from(bytes).toString("base64");
        attached.push({ type: "image", data: base64, mimeType });
        seen.add(abs);

        const n = ++labelCounter;
        replacements.set(token, makeLabel(n, abs));
        imageCache.set(makeLabel(n, abs), {
          path: abs,
          mimeType,
          base64,
          width: resized ? resized.width : 0,
          height: resized ? resized.height : 0,
          imageId: stableImageId(makeLabel(n, abs)),
        });
        // Evict oldest entries (Map iteration = insertion order) once over cap.
        while (imageCache.size > MAX_CACHE_ENTRIES) {
          const oldest = imageCache.keys().next().value;
          if (oldest === undefined) break;
          imageCache.delete(oldest);
        }
        const note = resized ? formatDimensionNote(resized) : undefined;
        if (note) dimensionNotes.push(note);
      }

      if (attached.length === 0) return { action: "continue" };

      // Rewrite only matched tokens; everything else stays byte-identical.
      let newText = text;
      for (const [token, label] of replacements) {
        newText = newText.split(token).join(label);
      }
      if (dimensionNotes.length > 0) {
        newText = `${newText}\n${dimensionNotes.join("\n")}`;
      }

      // Preserve pre-existing attachments first, then newly discovered ones.
      return {
        action: "transform",
        text: newText,
        images: [...(event.images ?? []), ...attached],
      };
    } catch {
      // Never break the user's prompt — any failure passes through untouched.
      return { action: "continue" };
    }
  });

  pi.registerMarkdownTransformer((markdown, ctx) => {
    if (ctx.messageType !== "user") return markdown;
    try {
      const caps = getCapabilities();
      const lines: string[] = [];
      for (const match of markdown.matchAll(/\[Image #\d+: [^\]]+\]/g)) {
        const label = match[0];
        const entry = imageCache.get(label);
        if (!entry) continue; // e.g. session reload lost the cache
        if (caps.images) {
          const image = new Image(entry.base64, entry.mimeType, {
            fallbackColor: (s: string) => s,
          }, {
            maxWidthCells: ctx.availableWidth,
            filename: entry.path,
            imageId: entry.imageId,
          });
          lines.push(...image.render(ctx.availableWidth));
        } else {
          // Graceful degradation: plain text, no escape junk on this terminal.
          lines.push(`🖼 ${basename(entry.path)} · ${entry.mimeType} · ${entry.width}x${entry.height}`);
        }
      }
      if (lines.length === 0) return markdown;
      return `${markdown}\n${lines.join("\n")}`;
    } catch {
      return markdown; // never break rendering
    }
  });
}
