import OpenAI from "openai";

const geminiKey = process.env.GEMINI_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

if (!geminiKey && !openaiKey) {
  throw new Error("Either GEMINI_API_KEY or OPENAI_API_KEY must be set.");
}

export const openai = geminiKey
  ? new OpenAI({
      apiKey: geminiKey,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    })
  : new OpenAI({
      apiKey: openaiKey!,
    });

export const AI_MODEL = geminiKey ? "gemini-2.0-flash" : "gpt-5.2";
