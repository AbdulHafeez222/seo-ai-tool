import mongoose from "mongoose";

const reportSchema = new mongoose.Schema(
  {
    url: String,
    title: String,
    h1: String,
    metaDescription: String,
    wordCount: Number,

    // SEO Fields
    score: Number,
    status: String,
    tips: [String],
    issues: [String],
    keywords: [String],
    internalLinks: Number,
    externalLinks: Number,

    // Images Fields
    totalImages: Number,
    imagesWithoutAlt: Number,

    // Open Graph Fields
    hasOGTags: Boolean,
    ogTitle: String,
    ogDescription: String,
    ogImage: String,

    // Technical Checks - NEW FIELDS
    mobileFriendly: Boolean,
    isHttps: Boolean,
    loadTime: Number,
    brokenLinks: Number,
    brokenLinksList: [String],
    hasSchemaMarkup: Boolean,
    robotsExists: Boolean,
    sitemapExists: Boolean,

    // AEO Fields
    aeoScore: Number,
    aeoStatus: String,
    schemas: [String],
    hasFAQ: Boolean,
    hasHowTo: Boolean,
    hasDirectAnswer: Boolean,
    lastModified: String,

    // AI Report
    aiReport: String
  },
  { timestamps: true }
);

export default mongoose.model("Report", reportSchema);
