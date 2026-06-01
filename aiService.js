import axios from "axios";

export async function getAIReport(data) {
  try {
    const prompt = `
Analyze this website SEO:

URL: ${data.url}
Title: ${data.title}
Meta: ${data.metaDescription}
Word Count: ${data.wordCount}
Score: ${data.score}

Give:
1. Strengths
2. Weaknesses
3. Improvements
4. Final recommendation
`;

    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "mistralai/mistral-7b-instruct:free",
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

  } catch (e) {
    console.error("AI ERROR:", e.response?.data || e.message);
    return "AI report not available";
  }
}
