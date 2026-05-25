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

    const title = $("title").text();
    const h1 = $("h1").first().text();
    const metaDescription =
      $('meta[name="description"]').attr("content") || "";

    const text = $("body").text();
    const wordCount = text.split(/\s+/).length;

    let seoScore = 0;

    if (title) seoScore += 25;
    if (h1) seoScore += 25;
    if (metaDescription) seoScore += 25;
    if (wordCount > 300) seoScore += 25;

    res.json({
      title,
      h1,
      metaDescription,
      wordCount,
      seoScore
    });

  } catch (err) {
    res.json({ error: "Scan failed" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
