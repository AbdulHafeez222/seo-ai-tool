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

    // Technical Checks
    mobileFriendly: Boolean,
    isHttps: Boolean,
    loadTime: Number,
    brokenLinks: Number,
    brokenLinksList: [String],
    hasSchemaMarkup: Boolean,
    robotsExists: Boolean,
    sitemapExists: Boolean,
    hasCanonical: Boolean,
    canonical: String,
    hasFavicon: Boolean,
    favicon: String,

    // READABILITY
    readabilityScore: Number,
    readabilityStatus: String,

    // SOCIAL MEDIA
    hasFacebook: Boolean,
    hasLinkedIn: Boolean,
    hasYouTube: Boolean,
    hasTwitter: Boolean,

    // CONTACT INFO
    hasEmail: Boolean,
    hasPhone: Boolean,
    email: String,
    phone: String,

    // AI CITATION
    hasAuthor: Boolean,
    aiExtractedAnswer: String,
    citationChatGPT: Number,
    citationGemini: Number,
    citationPerplexity: Number,
    aeoSimulation: String,

    // AEO Fields
    aeoScore: Number,
    aeoStatus: String,
    schemas: [String],
    hasFAQ: Boolean,
    hasHowTo: Boolean,
    hasDirectAnswer: Boolean,
    lastModified: String,

    // AI TRUST SCORE
    hasPrivacyPolicy: Boolean,
    hasAboutPage: Boolean,
    hasContactPage: Boolean,
    aiTrustScore: Number,
    aiTrustSignals: [String],

    // FEATURED SNIPPET
    featuredSnippetChance: Number,
    snippetReasons: [String],

    // CONTENT STRUCTURE
    h3Count: Number,
    listCount: Number,
    tableCount: Number,
    contentStructureScore: Number,

    // PRIORITY FIXES
    criticalIssues: [String],
    importantIssues: [String],
    minorIssues: [String],

    // OVERALL AI VISIBILITY
    overallAIVisibility: Number,
    schemaCoverage: Number,

    // NEW FINAL UPGRADE FEATURES
    aiVisibilityScore: Number,
    aiVisibilityLevel: String,
    citationSimulator: String,
    competitorGap: Object,
    topicAuthority: Object,
    answerQuality: Number,
    answerQualityChecks: [String],
    autoFAQ: [Object],
    serpPreview: Object,
    mobileScore: Number,
    desktopScore: Number,
    businessValue: Object,
    instantFixes: [String],

    // AI Report
    aiReport: String
  },
  { timestamps: true }
);

export default mongoose.model("Report", reportSchema);
