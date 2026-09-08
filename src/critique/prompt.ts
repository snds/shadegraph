// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Reference critique: default rubric prompt
// ═══════════════════════════════════════════════════════════════════════════

/** Instructs the model to end its reply with a fenced JSON object so
 *  `parseCritique.ts` has something reliable to extract — while still
 *  asking for free-text reasoning a human can read directly, in case the
 *  JSON block is malformed or missing. */
export const DEFAULT_CRITIQUE_PROMPT = `You are reviewing a rendered shader/material output against reference media, as a visual QA check. The first image is the CURRENT RENDER. Every image after it is REFERENCE media it should resemble in composition, color, lighting character, and (for a reference video's sampled frames) motion/behavior over time.

Judge whether the render is a reasonably faithful match to the reference — not pixel-identical, but capturing the same visual character. Then respond with a short paragraph of reasoning, and end your reply with exactly one fenced JSON block in this shape:

\`\`\`json
{"verdict": "pass" | "fail" | "unclear", "reasoning": "one or two sentences summarizing why"}
\`\`\`

Use "unclear" only if the reference itself is too ambiguous to judge against, not as a hedge.`;
