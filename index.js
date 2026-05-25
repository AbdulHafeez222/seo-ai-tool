const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");

const app = express();

// static folder
app.use(express.static("public"));

// home route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// test route
app.get("/test", (req, res) => {
  res.send("Test working ✔️");
});

// SEO scan route
app.get("/scan", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.json({ error: "No URL provided" });

    const response = await axios.get(url);
    const $ = cheerio.load(response.data);

    const title = $("title").text() || "N/A";
    const h1 = $("h1").first().text() || "N/A";
    const metaDescription =
      $('meta[name="description"]').attr("content") || "N/A";

    const text = $("body").text() || "";
    const wordCount = text.trim().split(/\s+/).length;

    // SEO SCORE (smarter)
    let seoScore = 0;
    let suggestions = [];

    if (title !== "N/A") {
      seoScore += 25;
    } else {
      suggestions.push("Add a title tag");
    }

    if (h1 !== "N/A") {
      seoScore += 25;
    } else {
      suggestions.push("Add H1 heading");
    }

    if (metaDescription !== "N/A") {
      seoScore += 25;
    } else {
      suggestions.push("Add meta description");
    }

    if (wordCount > 300) {
      seoScore += 25;
    } else {
      suggestions.push("Increase content length");
    }

    // AI-style summary
    let aiSummary =
      seoScore >= 75
        ? "Good SEO structure but can be improved."
        : "Weak SEO, needs optimization.";

    res.json({
      title,
      h1,
      metaDescription,
      wordCount,
      seoScore,
      aiSummary,
      suggestions
    });

  } catch (error) {
    res.json({ error: "Scan failed" });
  }
});
