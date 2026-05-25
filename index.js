const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");

const app = express();

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/test", (req, res) => {
  res.send("Test working ✔️");
});

app.get("/scan", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.json({ error: "No URL provided" });

    const response = await axios.get(url);
    const $ = cheerio.load(response.data);

    const title = $("title").text() || "";
    const h1 = $("h1").first().text() || "";
    const metaDescription =
      $('meta[name="description"]').attr("content") || "";

    const text = $("body").text().toLowerCase();
    const wordCount = text.trim().split(/\s+/).length;

    const images = $("img").length;
    let imagesWithAlt = 0;

    $("img").each((i, el) => {
      if ($(el).attr("alt")) imagesWithAlt++;
    });

    // SEO SCORE (SMART VERSION)
    let seoScore = 0;
    let issues = [];
    let suggestions = [];

    // Title check
    if (title.length > 10) seoScore += 20;
    else issues.push("Weak or missing title");

    // H1 check
    if (h1) seoScore += 20;
    else issues.push("Missing H1 tag");

    // Meta description
    if (metaDescription.length > 50) seoScore += 20;
    else issues.push("Missing or short meta description");

    // Content length
    if (wordCount > 500) seoScore += 20;
    else suggestions.push("Increase content length");

    // Images alt check
    if (images > 0 && imagesWithAlt === images) {
      seoScore += 20;
    } else {
      suggestions.push("Add alt text to images");
    }

    // AI style summary
    let aiReport = "";

    if (seoScore >= 80) {
      aiReport = "Excellent SEO structure with minor improvements needed.";
    } else if (seoScore >= 50) {
      aiReport = "Average SEO. Needs optimization.";
    } else {
      aiReport = "Poor SEO. Major improvements required.";
    }

    res.json({
      title,
      h1,
      metaDescription,
      wordCount,
      images,
      imagesWithAlt,
      seoScore,
      aiReport,
      issues,
      suggestions
    });

  } catch (error) {
    res.json({ error: "Scan failed" });
  }
});
