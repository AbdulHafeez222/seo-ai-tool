import axios from "axios";

const MODELS = [
  "openai/gpt-oss-120b",
  "meta-llama/llama-3.1-8b-instruct:free",
  "mistralai/mistral-7b-instruct:free"
];

async function callModel(model, data) {
  const prompt = `
SEO ANALYSIS:

URL: ${data.url}
Title: ${data.title}
Meta: ${data.metaDescription}
Word Count: ${data.wordCount}
Score: ${data.score}

Give:
- Strengths
- Weaknesses
- Improvements
- Final Recommendation
`;

  return axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model,
      messages: [{ role: "user", content: prompt }]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );
}

export async function getAIReport(data) {
  for (let model of MODELS) {
    try {
      const res = await callModel(model, data);
      return res.data.choices[0].message.content;
    } catch (err) {
      console.log(`Model failed: ${model}`);
    }
  }

  return "AI report not available (all models failed)";
}
