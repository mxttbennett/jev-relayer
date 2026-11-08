export const PLACEMENTS = ["inline", "subagent", "sibling"];
const PLACEMENT_CRITERIA = {
  inline: "Needs the earlier reasoning or edits in this conversation, or is a small follow-up",
  subagent:
    "Self-contained, read-heavy work (searching or reviewing many files) where only the conclusion matters",
  sibling:
    "Independent of this conversation, long-running, or would bloat it with output nobody needs later",
};

export const SUBAGENT_TYPES = {
  "general-purpose": "Edits files, runs commands, or the task is unclear",
  Explore: "Only reads: searching or reading code and reporting what it found",
  Plan: "Only designs: produces an implementation plan without changing anything",
};

const list = (criteria) =>
  Object.entries(criteria)
    .map(([name, why]) => `- ${name}: ${why}`)
    .join("\n");

const hasModels = (models) => Object.keys(models).length > 0;
const hasEfforts = (efforts) => Object.keys(efforts).length > 0;
const hasToolsets = (toolsets) => Object.keys(toolsets).length > 0;

export function jevQuestions(models = {}, efforts = {}, toolsets = {}) {
  const questions = {
    placement: {
      type: "choice",
      instructions:
        "Given `query` (recent turns, then the latest user prompt), where should the latest prompt run?",
      criteria: PLACEMENT_CRITERIA,
    },
  };
  questions.agent_choice = {
    type: "choice",
    instructions: "Given `query`, if the latest prompt runs in a subagent, which agent type fits it?",
    criteria: SUBAGENT_TYPES,
  };
  if (hasModels(models)) {
    questions.model_choice = {
      type: "choice",
      instructions: "Given `query`, which model should handle the latest prompt?",
      criteria: models,
    };
  }
  if (hasEfforts(efforts)) {
    questions.effort_choice = {
      type: "choice",
      instructions: "Given `query`, how much reasoning effort does the latest prompt need?",
      criteria: efforts,
    };
  }
  if (hasToolsets(toolsets)) {
    questions.toolset_choice = {
      type: "choice",
      instructions: "Given `query`, which tool toolset does the latest prompt need if it runs apart from this conversation?",
      criteria: toolsets,
    };
  }
  return questions;
}

export function classifierPrompt({ text, models = {}, efforts = {}, toolsets = {} }) {
  const modelSection = hasModels(models)
    ? ["model: which model should handle it", list(models), ""]
    : [];
  const effortSection = hasEfforts(efforts)
    ? ["effort: how much reasoning it needs", list(efforts), ""]
    : [];
  const toolsetSection = hasToolsets(toolsets)
    ? ["toolset: which tools it needs if it runs apart from this conversation", list(toolsets), ""]
    : [];
  const fields = ['"placement":"..."', '"agent":"..."'];
  if (hasModels(models)) fields.push('"model":"..."');
  if (hasEfforts(efforts)) fields.push('"effort":"..."');
  if (hasToolsets(toolsets)) fields.push('"toolset":"..."');
  const reply = `{${fields.join(",")},"title":"...","confidence":0.0-1.0}`;
  return [
    "Classify the latest user prompt in this conversation excerpt.",
    "",
    "placement: where it should run",
    list(PLACEMENT_CRITERIA),
    "",
    "agent: which agent type it needs if it runs in a subagent",
    list(SUBAGENT_TYPES),
    "",
    ...modelSection,
    ...effortSection,
    ...toolsetSection,
    "title: a 3-5 word label for the task, as a short imperative phrase",
    "",
    `Reply with only JSON: ${reply}`,
    "",
    "Excerpt:",
    text,
  ].join("\n");
}

export function toVerdict({ placement, model, effort, toolset, agent, title, confidence }, models = {}, efforts = {}, toolsets = {}) {
  if (!PLACEMENTS.includes(placement)) throw new Error(`bad placement: ${placement}`);
  if (hasModels(models) && !Object.hasOwn(models, model)) throw new Error(`bad model: ${model}`);
  if (hasEfforts(efforts) && !Object.hasOwn(efforts, effort)) throw new Error(`bad effort: ${effort}`);
  if (hasToolsets(toolsets) && !Object.hasOwn(toolsets, toolset)) throw new Error(`bad toolset: ${toolset}`);
  return {
    placement,
    model: hasModels(models) ? model : null,
    effort: hasEfforts(efforts) ? effort : null,
    ...(hasToolsets(toolsets) && { toolset }),
    ...(Object.hasOwn(SUBAGENT_TYPES, agent) && { agent }),
    ...(typeof title === "string" && title.trim() && { title: title.trim() }),
    confidence: typeof confidence === "number" ? confidence : null,
  };
}

export function parseVerdict(text, models = {}, efforts = {}, toolsets = {}) {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error("no JSON in reply");
  return toVerdict(JSON.parse(match[0]), models, efforts, toolsets);
}
