import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

// 🚀 1. AI MULTI-MODEL SYSTEM - Auto Fallback Chain
const AI_MODELS = [
  "openai/gpt-4o-mini", // Primary - Best quality + speed
  "meta-llama/llama-3.1-8b-instruct", // Backup 1 - Meta model
  "mistralai/mistral-7b-instruct" // Backup 2 - Free tier fallback
];

// Core function with retry + fallback
async function callOpenRouter(prompt, maxTokens = 1500) {
  for (let i = 0; i < AI_MODELS.length; i++) {
    const model = AI_MODELS[i];
    try {
      const res = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.7
        },
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://aeo-tool.com", // Optional: for OpenRouter analytics
            "X-Title": "AEO Visibility Platform"
          },
          timeout: 30000
        }
      );

      if (res.data?.choices?.[0]?.message?.content) {
        console.log(`✅ AI Success: ${model}`);
        return res.data.choices[0].message.content;
      }
      throw new Error("Empty response");
    } catch (err) {
      console.log(`❌ Model failed: ${model} - ${err.message}`);
      if (i === AI_MODELS.length - 1) {
        console.log("🚨 All AI models failed");
        throw new Error("All AI models unavailable");
      }
    }
  }
}

// 🚀 MAIN AI REPORT - Enhanced Prompt
export async function getAIReport(data) {
  const prompt = `You are an AEO + SEO expert analyzing a website for AI search visibility.

WEBSITE DATA:
URL: ${data.url}
Title: ${data.title}
H1: ${data.h1}
Meta Description: ${data.metaDescription}
SEO Score: ${data.score}/100 (${data.status})
AEO Score: ${data.aeoScore}/100 (${data.aeoStatus})
Word Count: ${data.wordCount}
Readability: ${data.readability.score}/100
Schemas Found: ${data.schemas.join(', ') || 'None'}
Issues: ${data.issues.join('; ')}
Keywords: ${data.keywords.slice(0,5).join(', ')}

TASK: Give a professional analysis in 4 sections:

1. STRENGTHS (2-3 points): What is working well for AI citations?
2. CRITICAL ISSUES (2-3 points): What is blocking ChatGPT/Gemini citations?
3. ACTIONABLE FIXES: Give exact code/steps for top 3 fixes. Include JSON-LD examples if schema missing.
4. AI CITATION STRATEGY: How to make ChatGPT quote this site? 1 specific tip.

Keep response under 350 words. Be specific, not generic. Use technical terms.`;

  try {
    return await callOpenRouter(prompt, 1500);
  } catch (err) {
    // Fallback report if all AI fails
    return `📊 AUTOMATED AEO ANALYSIS (AI Unavailable)

STRENGTHS:
${data.score > 70? '- Strong technical SEO foundation' : '- Basic SEO structure present'}
${data.hasFAQ? '- FAQ Schema detected for AI citations' : ''}

CRITICAL ISSUES:
${data.issues.slice(0,3).map(i => `- ${i}`).join('\n')}

ACTIONABLE FIXES:
1. ${!data.hasFAQ? 'Add FAQ Schema: <script type="application/ld+json">{"@type":"FAQPage"}</script>' : 'Optimize existing FAQ with 40-60 word answers'}
2. ${data.readability.score < 60? 'Improve readability: Use shorter sentences, aim for 60+ score' : 'Add more question-based H2 headings'}
3. ${!data.lastModified? 'Add last updated date: <meta property="article:modified_time" content="2026-01-15">' : 'Update content freshness monthly'}

AI CITATION STRATEGY: Add direct 50-word answers under H2 questions to increase ChatGPT citation probability by 35%.`;
  }
}

// 🚀 6. AI SEARCH SIMULATOR - VIRAL HERO FEATURE
export async function getAISearchSimulation({ url, title, h1, metaDescription, aiExtractedAnswer, brandName }) {
  const brand = brandName || new URL(url).hostname.replace('www.', '').split('.')[0];
  const brandCapitalized = brand.charAt(0).toUpperCase() + brand.slice(1);

  const prompt = `You are simulating how 3 different AI search engines would answer: "What is ${brandCapitalized}?"

Website Context:
- Title: ${title}
- H1: ${h1}
- Meta: ${metaDescription}
- Best Extracted Answer: ${aiExtractedAnswer}

Rules:
1. ChatGPT: Prefers FAQ schema + direct answers. Quote format: "According to ${brandCapitalized},..."
2. Gemini: Prefers HowTo schema + step-by-step lists. Factual tone.
3. Perplexity: Prefers research data + citations. Academic tone.

Generate 3 responses, max 140 characters each:

CHATGPT: [response]
GEMINI: [response]
PERPLEXITY: [response]`;

  try {
    const result = await callOpenRouter(prompt, 600);
    return result;
  } catch (err) {
    // Fallback simulation without AI
    const answer = metaDescription || h1 || title || 'professional services';
    const short = answer.substring(0, 100);
    return `CHATGPT: According to ${brandCapitalized}, ${short}...
GEMINI: ${brandCapitalized} provides ${short}...
PERPLEXITY: Based on data from ${brandCapitalized}: ${short}...`;
  }
}

// 🚀 BONUS: Schema Generator for Fixes
export async function generateSchemaCode(type, data) {
  const prompts = {
    FAQ: `Generate JSON-LD FAQ Schema for: ${data.questions.join(', ')}. Return only valid JSON code.`,
    HowTo: `Generate JSON-LD HowTo Schema for: ${data.title}. Steps: ${data.steps.join(', ')}. Return only JSON.`,
    Article: `Generate JSON-LD Article Schema for: ${data.title}, author: ${data.author}, date: ${data.date}. Return only JSON.`
  };

  try {
    return await callOpenRouter(prompts[type], 800);
  } catch (err) {
    return `{"@context":"https://schema.org","@type":"${type}","name":"${data.title}"}`;
  }
}
