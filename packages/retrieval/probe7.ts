import { LexicalEntailmentBackend, renderStatement, scanForInstructions, tokenize } from "@veritymem/gate";

const cases = [
  "I approved the Sunday 02:00 UTC deploy window.",
  "I approved the Friday 04:00 UTC deploy window.",
  "Rival approved the Tuesday window.",
];
const backend = new LexicalEntailmentBackend({ floor: 0.6 });
for (const content of cases) {
  // What the decision-statement extractor produces.
  const m = /\bI\s+approv(?:e|ed)\s+(?:the\s+)?([^.;\n]{3,120})/i.exec(content);
  const object = m?.[1]?.trim();
  const proposition = renderStatement("", "approved", object);
  const verification = await backend.entails({ premise: content, proposition, hypothesis: proposition });
  console.log(JSON.stringify(content));
  console.log("   object:", JSON.stringify(object));
  console.log("   proposition:", JSON.stringify(proposition));
  console.log("   verdict:", verification.result, verification.score);
  console.log("   instruction-like:", scanForInstructions(content).flagged, "tokens:", tokenize(content).join(","));
}
