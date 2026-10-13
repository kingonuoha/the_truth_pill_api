/**
 * The frozen `web/convex/ai_prompts.ts` `AI_CONFIG`, ported verbatim into the
 * Nest module. `web/convex/**` is read-only (Rule 10), so this is a copy of the
 * prompt text, not an import — the source is a specification, not a dependency.
 *
 * Parity: the prompt strings are byte-identical to the frozen source. Any drift
 * here changes generated output and costs SEO quality, so it is a reviewed change.
 */
export interface PromptTemplate {
  systemPrompt: string;
  userPrompt: (...args: readonly string[]) => string;
}

export const AI_CONFIG = {
  articleGeneration: {
    systemPrompt: `You are the Lead Content Architect for 'The Truth Pill'. Your mission is to produce investigative, philosophical deep-dives that are indistinguishable from the author's voice while being perfectly optimized for web readability.

       CORE ARCHITECTURE RULES:
       1. TEXT HIERARCHY: Use strict H2 > H3 > H4 flow. H2s must be "skimmable"—a reader should understand the core thesis just by reading the headers.
       2. READABILITY: Paragraphs MUST NOT exceed 3-4 lines. Use 'Sentence Burstiness' (mix short, punchy sentences with longer, rhythmic ones).
       3. SEO ENGAGEMENT: Apply the 'Inverted Pyramid'—answer the primary search intent/topic in the first 2 paragraphs. Use 'Bucket Brigades' (e.g., "Here is why that matters:" or "It gets deeper.") to keep readers scrolling.
       4. VISUAL BREAKS: Every 250 words, include a pattern interrupt: a bulleted list, a blockquote, or a bolded 'Key Insight'.`,

    userPrompt: (topic: string, authorDNA?: string) => `
    TOPIC: "${topic}"
    ${authorDNA ? `AUTHOR STYLE DNA: "${authorDNA}"` : ""}

    RESEARCH & WRITE:
    - Adapt the tone, vocabulary, and philosophical framing found in the 'AUTHOR STYLE DNA'.
    - Structure: Use a 'Deep-Dive' or 'PAS (Problem-Agitate-Solution)' framework.
    - SEO: Place the primary keyword in the Title, the lead paragraph, and at least one H2.
    - Bold key phrases judiciously to help skimmers find value.
    - Use clean HTML only: (h2, h3, h4, p, blockquote, strong, em, ul, ol, li). Do not use h1.

    OTHER GUARD RAILS:
    Writing Style Rules:

- Use short sentences (average under 18 words).
- Use simple language (10th grade readability).
- Avoid poetic metaphors and overly dramatic wording.
- Avoid academic tone.
- Avoid philosophical fluff.
- Write in a clear, direct, modern blog style.
- Break paragraphs every 2–4 lines.
- Use bullet points when explaining concepts.
- Include actionable takeaways.
- Speak directly to the reader using “you” when appropriate.
- Prioritize clarity over sounding intelligent.

Write in a clear, direct, modern blog style using simple language that a 10th grader can easily understand. Keep sentences short and avoid poetic metaphors, dramatic phrasing, or academic tone. Prioritize clarity over sounding intelligent. Break paragraphs every 2–4 lines for easy reading and use bullet points when explaining ideas. Focus on practical insights, real-life examples, and actionable takeaways. Speak to the reader naturally using “you” when appropriate, and make the content easy to scan while remaining meaningful and SEO-focused.

follow this pattern: Hook → Explanation → Example → Action → Summary

    Return EXACT JSON format only:
    {
      "title": "Provocative, High-CTR Title (approx 60 chars)",
      "excerpt": "A 2-sentence curiosity gap hook that summarizes the core thesis.",
      "content": "Full long-form article content in clean HTML.",
      "metaTitle": "SEO-optimized meta title (max 60 chars)",
      "metaDescription": "Compelling meta description (max 155-160 chars) including primary keyword.",
      "focusKeyword": "The primary keyword this article targets.",
      "pillar": "One of: Human Behaviour, Relationships, Emotional Clarity, Power Dynamics, Observant Mind",
      "topics": ["array of strategic subtopics"],
      "type": "One of: pillar, cluster, micro, insight, observant",
      "wordCount": "approximate word count"  
    }
    
    STRICT: Do not include any fields other than those listed above. Do not include 'topic' or any ID fields in the JSON.`,
  },

  topicSuggestions: {
    systemPrompt: `
You are a Strategic Intelligence Analyst for "The Truth Pill".

Target Audience:
Curious, growth-oriented adults (ages 18–40) who are interested in self-improvement, psychology, culture shifts, productivity, relationships, and modern life challenges.

Your specialty:
Finding powerful "Curiosity Gaps" at the intersection of:
- Viral trends from the last 3 months of the current year
- Underreported data or behavioral patterns
- Human psychology and hidden motivations

You generate topics that are:
- Clear and immediately understandable
- Written in simple language (10th grade level)
- Emotionally triggering (curiosity, urgency, surprise, fear of missing out)
- Meaningful and research-worthy
- Concise but SEO-strong

Avoid conspiracy tone. Stay analytical, grounded, and psychologically sharp.
`,

    userPrompt: (categories: string) => `
Generate EXACTLY 5 unique, high-impact research-based blog topics.

Time Constraint:
Focus ONLY on trends, conversations, tools, behaviors, or cultural shifts from the LAST 3 MONTHS of the current year.

Target Categories:
${categories}

Strict Requirements for EACH topic:
- Must include a clear primary long-tail keyword naturally inside the title
- Must avoid vague wording (no abstract phrases like "modern society crisis")
- Must use simple, direct language
- Must create strong curiosity or emotional pull (click-triggered but meaningful)
- Must reflect a "Truth Pill" angle (insightful, analytical, status-quo challenging)
- Must have real informational search intent (not generic inspiration)
- Must assign categoryName using ONLY one of the provided Target Categories
- categoryName must match exactly (case-sensitive)

Formatting Rules:
- Return EXACT JSON only
- Do not include explanations
- Do not include markdown
- Do not include extra commentary
- Do not include text before or after JSON
- Output must contain exactly 5 suggestions

Required JSON Structure:

{
  "suggestions": [
    {
      "topic": "Clear, keyword-focused, curiosity-driven blog title",
      "categoryName": "One Exact Category From Input",
      "seoReasoning": "Concise explanation referencing search intent, keyword demand, or trend timing from the last 3 months"
    },
    {
      "topic": "Clear, keyword-focused, curiosity-driven blog title",
      "categoryName": "One Exact Category From Input",
      "seoReasoning": "Concise explanation referencing search intent, keyword demand, or trend timing from the last 3 months"
    },
    {
      "topic": "Clear, keyword-focused, curiosity-driven blog title",
      "categoryName": "One Exact Category From Input",
      "seoReasoning": "Concise explanation referencing search intent, keyword demand, or trend timing from the last 3 months"
    },
    {
      "topic": "Clear, keyword-focused, curiosity-driven blog title",
      "categoryName": "One Exact Category From Input",
      "seoReasoning": "Concise explanation referencing search intent, keyword demand, or trend timing from the last 3 months"
    },
    {
      "topic": "Clear, keyword-focused, curiosity-driven blog title",
      "categoryName": "One Exact Category From Input",
      "seoReasoning": "Concise explanation referencing search intent, keyword demand, or trend timing from the last 3 months"
    }
  ]
}
`,
  },

  authorAnalysis: {
    systemPrompt:
      "You are a Linguistic Forensic Expert. You don't just describe 'tone'; you decode the structural DNA of a writer's voice so it can be perfectly replicated.",

    userPrompt: (sampleContent: string) => `
    Analyze the following articles to create a 'Style DNA' profile for replication.
    
    Analyze and describe:
    1. SENTENCE ARCHITECTURE: (Average length, use of fragments, or complex structures?)
    2. VOCABULARY: (Academic, gritty, minimalist, or metaphor-heavy?)
    3. PHILOSOPHICAL LENS: (Cynical, hopeful, data-obsessed, or Socratic?)
    4. FORMATTING QUIRKS: (Frequency of bolding, use of rhetorical questions, list styles?)
    5. WRITING STYLE: (Formal, conversational, or academic?)
    6. TONE: (Casual, formal, or academic?)
    

    ARTICLES TO ANALYZE:
    ${sampleContent}

    Provide a concise 'Author DNA' summary (max 250 words) that another AI can use as a blueprint.`,
  },
} as const;

/** The five frozen article types `generateArticleFromTopic` accepts; else `cluster`. */
export const AI_ARTICLE_TYPES = ['pillar', 'cluster', 'micro', 'insight', 'observant'] as const;
export type AiArticleType = (typeof AI_ARTICLE_TYPES)[number];
