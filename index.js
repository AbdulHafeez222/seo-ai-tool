const express = require("express");
const app = express();

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.get("/test", (req, res) => {
  res.send("Test working ✔️");
});

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});