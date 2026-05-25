const express = require("express");


app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");

const app = express();

// Static folder
app.use(express.static("public"));

// Home route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Test route
app.get("/test", (req, res) => {
  res.send("Test working ✔️");
});


// SEO SCAN API
app.get("/scan", async (req, res) => {

  const url = req.query.url;

  if (!url) {
    return res.json({ error: "Please provide URL" });
  }

  try {

    const response = await axios.get(url);
    const $ = cheerio.load(response.data);

    const title = $("title").text();
    const h1 = $("h1").first().text();
    const metaDescription = $('meta[name="description"]').attr("content") || "";

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

  } catch (error) {
    res.json({ error: "Website fetch failed" });
  }
});


// SERVER
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});p.get("/test", (req, res) => {
  res.send("Test working ✔️");
});

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});