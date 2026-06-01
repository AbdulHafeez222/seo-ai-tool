import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

export async function getAIReport(data) {
  const prompt = `
Analyze this website SEO:

URL: ${data.url}
Title: ${data.title}
Meta Description: ${data.metaDescription}
Word Count: ${data.wordCount}
SEO Score: ${data.score}

Give:
1. Strengths
2. Weaknesses
3. SEO Improvements
4. Final Recommendation
`;

  const completion = await client.chat.completions.create({
    model: "openai/gpt-oss-120b",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.7,
  });

  return completion.choices[0].message.content;
}
