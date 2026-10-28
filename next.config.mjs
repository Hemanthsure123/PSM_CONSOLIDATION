/** @type {import('next').NextConfig} */
const nextConfig = {
  // Puppeteer, the BigQuery SDK, and googleapis are heavy native/Node-only
  // packages. Keeping them external prevents Next from trying to bundle them
  // into the server build (which breaks Chromium resolution and bloats output).
  experimental: {
    // instrumentation.ts: starts the sheet automation's background worker when the server boots.
    instrumentationHook: true,
    serverComponentsExternalPackages: [
      "puppeteer",
      "puppeteer-core",
      "@google-cloud/bigquery",
      "googleapis",
      "tar-stream",
      // Candidate Bucketing's LangGraph workflow — Node-only, loaded as-is at runtime.
      "@langchain/langgraph",
      "@langchain/core",
    ],
    // Assignment Evaluation uploads the assignment PDF through a server action.
    serverActions: {
      bodySizeLimit: "20mb",
    },
  },
};

export default nextConfig;
