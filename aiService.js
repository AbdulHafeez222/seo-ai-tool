import axios from "axios";

export async function getAIReport(data) {
  try {
    const prompt = `
Analyze SEO:

URL: ${data.url}
Title: ${data.title}
Meta: ${data.metaDescription}
WordCount: ${data.wordCount}
Score: ${data.score}

Give:
- Strengths
- Weaknesses
- Improvements
- Final SEO advice
`;

    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "openai/gpt-oss-120b",
        messages: [
          { role: "user", content: prompt }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return response.data.choices[0].message.content;

  } catch (error) {
    console.error("AI ERROR:", error.message);
    return "AI report not available";
  }
}
