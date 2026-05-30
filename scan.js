import express from "express";
import { getSEOData } from "../services/seoService.js";
import { getAIReport } from "../services/aiService.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const url = req.query.url;

    if (!url) {
      return res.json({ error: "URL required" });
    }

    const data = await getSEOData(url);

    const aiReport = await getAIReport(data);

    res.json({
      ...data,
      aiReport
    });

  } catch (err) {
    res.json({ error: "Scan failed" });
  }
});

export default router;