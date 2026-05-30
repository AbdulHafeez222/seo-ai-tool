import express from "express";
import { createPDF } from "../services/pdfService.js";

const router = express.Router();

router.post("/pdf", async (req, res) => {
  try {
    const filePath = "./report.pdf";

    await createPDF(req.body, filePath);

    res.download(filePath);

  } catch (err) {
    res.json({ error: "PDF failed" });
  }
});

export default router;