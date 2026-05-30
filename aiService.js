import { GoogleGenerativeAI }
from "@google/generative-ai";

const genAI =
new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY
);

export async function getAIReport(data) {

  const model =
  genAI.getGenerativeModel({
    model: "gemini-1.5-flash"
  });

  const prompt = `
Analyze this website SEO:

Title: ${data.title}
H1: ${data.h1}
Meta Description: ${data.metaDescription}
Word Count: ${data.wordCount}
Score: ${data.score}

Give SEO improvements and problems.
`;

  const result =
  await model.generateContent(prompt);

  return result.response.text();
}