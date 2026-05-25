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
    if (!url) return res.json({ error: "No URL" });

    const response = await axios.get(url);
    const $ = cheerio.load(response.data);

    res.json({
      title: $("title").text(),
      h1: $("h1").first().text()
    });

  } catch (err) {
    res.json({ error: "Scan failed" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running");
});
