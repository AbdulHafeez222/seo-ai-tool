// Legacy export compatibility. Free-only build: external model requests are disabled.
// Do not add automatic model/provider fallbacks or enable billing through environment variables.
const notice = "AI writing is unavailable in this free-only build. No external model was called and no actual AI citations were measured.";
export async function getAIReport(_data) { return notice; }
export async function getAISearchSimulation(_data) { return notice; }
export async function generateSchemaCode(type, data = {}) {
  const supported = {FAQ:"FAQPage",HowTo:"HowTo",Article:"Article"};
  if (!supported[type]) throw new Error("Unsupported schema draft type.");
  return JSON.stringify({"@context":"https://schema.org","@type":supported[type],
    ...(typeof data.title === "string" && data.title.trim() ? {name:data.title.trim().slice(0,200)} : {})});
}
