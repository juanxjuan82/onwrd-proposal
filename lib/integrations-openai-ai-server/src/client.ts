import OpenAI from "openai";

const openaiKey = process.env.OPENAI_API_KEY;

if (!openaiKey) {
  throw new Error("OPENAI_API_KEY must be set.");
}

export const openai = new OpenAI({ apiKey: openaiKey });

export const AI_MODEL = "gpt-4o-mini";
