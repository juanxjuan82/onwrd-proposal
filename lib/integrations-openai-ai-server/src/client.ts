import OpenAI from "openai";

const openaiKey = process.env.OPENAI_API_KEY;
const geminiKey = process.env.GEMINI_API_KEY;

if (!openaiKey && !geminiKey) {
  throw new Error("Either OPENAI_API_KEY or GEMINI_API_KEY must be set.");
}

export const openai = openaiKey
  ? new OpenAI({ apiKey: openaiKey })
  : new OpenAI({
      apiKey: geminiKey!,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    });

export const AI_MODEL = openaiKey ? "gpt-4o-mini" : "gemini-2.0-flash";
