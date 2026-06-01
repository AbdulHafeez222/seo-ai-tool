import axios from "axios";

export async function getAIReport(data) {
  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "meta-llama/llama-3.1-8b-instruct:free",
        messages: [
          {
            role: "user",
            content: `
SEO Analysis:
URL: ${data.url}
Title: ${data.title}
Meta: ${data.metaDescription}
WordCount: ${data.wordCount}
Score: ${data.score}

Give simple SEO report.
`
          }
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
    console.log("AI ERROR:", error.response?.data || error.message);
    return "AI report not available";
  }
}
