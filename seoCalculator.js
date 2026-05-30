export function calculateScore(data) {

  let score = 0;

  let tips = [];

  if (data.title.length > 10)
    score += 25;
  else
    tips.push("Improve title");

  if (data.h1)
    score += 25;
  else
    tips.push("Add H1 heading");

  if (data.metaDescription.length > 50)
    score += 25;
  else
    tips.push("Improve meta description");

  if (data.wordCount > 500)
    score += 25;
  else
    tips.push("Increase content length");

  let status = "";

  if (score >= 80)
    status = "Excellent SEO";
  else if (score >= 50)
    status = "Good SEO";
  else
    status = "Poor SEO";

  return {
    ...data,
    score,
    status,
    tips
  };
}