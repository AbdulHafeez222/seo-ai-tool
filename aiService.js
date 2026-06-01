import axios from "axios";

const MODELS = [
  "openai/gpt-oss-120b",
  "mistralai/mistral-7b-instruct",
];

export async function getAIReport(data) {
  const prompt = `
SEO Analysis Report:

URL: ${data.url}
Title: ${data.title}
Meta: ${data.metaDescription}
Word Count: ${data.wordCount}
Score: ${data.score}

Give:
- Strengths
- Weaknesses
- Improvements
- Final SEO Recommendation
`;

  for (const model of MODELS) {
    try {
      const res = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model,
          messages: [{ role: "user", content: prompt }],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      return res.data.choices[0].message.content;
    } catch (err) {
      console.log("Model failed:", model);
    }
  }

  return "AI report not available (all models failed)";
}
