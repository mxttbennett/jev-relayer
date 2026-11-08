import { heuristicVerdict } from "./heuristics.mjs";
import { classifierPrompt, jevQuestions, parseVerdict, toVerdict } from "./prompt.mjs";

async function request(fetchFn, url, { body, headers, timeoutMs }) {
  const res = await fetchFn(url, {
    method: body ? "POST" : "GET",
    timeoutMs,
    headers: { "Content-Type": "application/json", ...headers },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

const FACTORIES = {
  heuristics: (_cfg, ctx) => async (input) => heuristicVerdict(input, ctx.config.gate),

  ollama: (cfg, ctx) => async (input) => {
    const json = await request(ctx.fetch, `${cfg.baseUrl}/api/chat`, {
      timeoutMs: cfg.timeoutMs,
      body: {
        model: cfg.model,
        messages: [{ role: "user", content: classifierPrompt(input) }],
        think: true,
        stream: false,
        options: { temperature: 0.2, num_predict: cfg.numPredict ?? 4096 },
      },
    });
    return parseVerdict(json.message?.content ?? "", input.models, input.efforts, input.toolsets);
  },

  "openai-compat": (cfg, ctx) => async (input) => {
    const headers = cfg.apiKeyEnv ? { Authorization: `Bearer ${ctx.env[cfg.apiKeyEnv]}` } : {};
    let model = cfg.model;
    if (!model) {
      const models = await request(ctx.fetch, `${cfg.baseUrl}/models`, {
        timeoutMs: cfg.timeoutMs,
        headers,
      });
      const pattern = new RegExp(cfg.modelMatch ?? ".", "i");
      model = models.data?.map((m) => m.id).find((id) => pattern.test(id));
      if (!model) throw new Error("no matching model loaded");
    }
    const json = await request(ctx.fetch, `${cfg.baseUrl}/chat/completions`, {
      timeoutMs: cfg.timeoutMs,
      headers,
      body: {
        model,
        messages: [{ role: "user", content: classifierPrompt(input) }],
        temperature: 0.1,
        max_tokens: 256,
        reasoning_effort: "none",
      },
    });
    return parseVerdict(json.choices?.[0]?.message?.content ?? "", input.models, input.efforts, input.toolsets);
  },

  jev: (cfg, ctx) => async (input) => {
    const env = { ...ctx.readJevEnv?.(), ...ctx.env };
    const backends = {
      openrouter: {
        key: env.OPENROUTER_API_KEY,
        url: "https://openrouter.ai/api/v1/systemone",
        model: "~typesafe/jev-latest",
      },
      typesafe: {
        key: env.TYPESAFE_API_KEY || env.JEV_API_KEY,
        url: "https://api.typesafe.ai/v1/systemone",
        model: "jev-latest",
      },
    };
    const order = (cfg.order ?? ["openrouter", "typesafe"]).filter((name) => backends[name]?.key);
    if (!order.length) throw new Error("no Jev key (OPENROUTER_API_KEY, TYPESAFE_API_KEY or JEV_API_KEY)");
    let lastError;
    for (const name of order) {
      const { key, url, model } = backends[name];
      try {
        const json = await request(ctx.fetch, url, {
          timeoutMs: cfg.timeoutMs,
          headers: { Authorization: `Bearer ${key}` },
          body: { state: { query: input.text }, model, questions: jevQuestions(input.models, input.efforts, input.toolsets) },
        });
        return toVerdict(
          {
            placement: json.answers?.placement?.choice,
            model: json.answers?.model_choice?.choice,
            effort: json.answers?.effort_choice?.choice,
            toolset: json.answers?.toolset_choice?.choice,
            agent: json.answers?.agent_choice?.choice,
            confidence: json.answers?.placement?.confidence,
          },
          input.models,
          input.efforts,
          input.toolsets,
        );
      } catch (err) {
        lastError = new Error(`${name}: ${err.message}`);
      }
    }
    throw lastError;
  },
};

export function createProviders(config, ctx) {
  const providers = {};
  for (const [name, cfg] of Object.entries(config.providers)) {
    const factory = FACTORIES[cfg.type];
    if (!factory) continue;
    providers[name] = {
      remote: cfg.remote ?? cfg.type === "jev",
      heuristic: cfg.type === "heuristics",
      run: factory(cfg, ctx),
    };
  }
  return providers;
}
