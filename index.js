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

    if (!url) {
      return res.json({ error: "No URL provided" });
    }

    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const $ = cheerio.load(response.data);

    const title = $("title").text() || "N/A";
    const h1 = $("h1").first().text() || "N/A";

    const metaDescription =
      $('meta[name="description"]').attr("content") || "N/A";

    const text = $("body").text() || "";
    const wordCount = text.trim().split(/\s+/).length;

    let seoScore = 0;

    if (title !== "N/A") seoScore += 25;
    if (h1 !== "N/A") seoScore += 25;
    if (metaDescription !== "N/A") seoScore += 25;
    if (wordCount > 300) seoScore += 25;

    res.json({
      title,
      h1,
      metaDescription,
      wordCount,
      seoScore
    });

  } catch (error) {
    res.json({ error: "Website fetch failed" });
  }
});

// server start
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});
