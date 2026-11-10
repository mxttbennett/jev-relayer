const PLACEMENTS = {
  inline: "Needs the earlier reasoning or edits in this conversation, or is a small follow-up",
  subagent:
    "Self-contained, read-heavy work (searching or reviewing many files) where only the conclusion matters",
  sibling:
    "Independent of this conversation, long-running, or would bloat it with output nobody needs later",
};

const SUBAGENT_TYPES = {
  "general-purpose": "Edits files, runs commands, or the task is unclear",
  Explore: "Only reads: searching or reading code and reporting what it found",
  Plan: "Only designs: produces an implementation plan without changing anything",
};

const OFFERED_CHOICES = [
  {
    key: "model",
    heading: "model: which model should handle it",
    instructions: "Given `query`, which model should handle the latest prompt?",
  },
  {
    key: "effort",
    heading: "effort: how much reasoning it needs",
    instructions: "Given `query`, how much reasoning effort does the latest prompt need?",
  },
  {
    key: "toolset",
    heading: "toolset: which tools it needs if it runs apart from this conversation",
    instructions: "Given `query`, which tool toolset does the latest prompt need if it runs apart from this conversation?",
  },
];

const list = (criteria) =>
  Object.entries(criteria)
    .map(([name, why]) => `- ${name}: ${why}`)
    .join("\n");

const choicesIn = (offered) => OFFERED_CHOICES.filter(({ key }) => Object.keys(offered[key] ?? {}).length > 0);

export const emptyVerdict = (placement, confidence = null) => ({
  placement,
  model: null,
  effort: null,
  toolset: null,
  confidence,
});

export function jevQuestions(offered = {}) {
  const questions = {
    placement: {
      type: "choice",
      instructions:
        "Given `query` (recent turns, then the latest user prompt), where should the latest prompt run?",
      criteria: PLACEMENTS,
    },
    agent_choice: {
      type: "choice",
      instructions: "Given `query`, if the latest prompt runs in a subagent, which agent type fits it?",
      criteria: SUBAGENT_TYPES,
    },
  };
  for (const { key, instructions } of choicesIn(offered)) {
    questions[`${key}_choice`] = { type: "choice", instructions, criteria: offered[key] };
  }
  return questions;
}

export function classifierPrompt(text, offered = {}) {
  const choices = choicesIn(offered);
  const fields = ['"placement":"..."', '"agent":"..."', ...choices.map(({ key }) => `"${key}":"..."`)];
  return [
    "Classify the latest user prompt in this conversation excerpt.",
    "",
    "placement: where it should run",
    list(PLACEMENTS),
    "",
    "agent: which agent type it needs if it runs in a subagent",
    list(SUBAGENT_TYPES),
    "",
    ...choices.flatMap(({ key, heading }) => [heading, list(offered[key]), ""]),
    "title: a 3-5 word label for the task, as a short imperative phrase",
    "",
    `Reply with only JSON: {${fields.join(",")},"title":"...","confidence":0.0-1.0}`,
    "",
    "Excerpt:",
    text,
  ].join("\n");
}

export function toVerdict(answer, offered = {}) {
  if (!Object.hasOwn(PLACEMENTS, answer.placement)) throw new Error(`bad placement: ${answer.placement}`);
  const { confidence, ...verdict } = emptyVerdict(answer.placement);
  for (const { key } of choicesIn(offered)) {
    if (!Object.hasOwn(offered[key], answer[key])) throw new Error(`bad ${key}: ${answer[key]}`);
    verdict[key] = answer[key];
  }
  const title = typeof answer.title === "string" ? answer.title.trim() : "";
  return {
    ...verdict,
    ...(Object.hasOwn(SUBAGENT_TYPES, answer.agent) && { agent: answer.agent }),
    ...(title && { title }),
    confidence: typeof answer.confidence === "number" ? answer.confidence : null,
  };
}

export function parseVerdict(text, offered = {}) {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error("no JSON in reply");
  return toVerdict(JSON.parse(match[0]), offered);
}
