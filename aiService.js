import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export async function getAIReport(data) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash"
  });

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

  const result = await model.generateContent(prompt);

  return result.response.text();
}
