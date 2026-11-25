import { describe, expect, it } from "vitest";
import { modeSelectOf, modelSelectOf, parseConfigOptions } from "./acp-config-options";

describe("modeSelectOf", () => {
  // The official Claude adapter's only live mode signal: `config_option_update`
  // with its `mode` select (`id: "mode"`, `category: "mode"`) — never
  // `current_mode_update`.
  it("reads the Claude adapter's mode select", () => {
    const got = modeSelectOf([
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "auto",
        options: [
          { value: "default", name: "Manual" },
          { value: "auto", name: "Auto" },
        ],
      },
    ]);
    expect(got?.currentMode).toBe("auto");
    expect(got?.availableModes.map((m) => m.id)).toEqual(["default", "auto"]);
  });

  it("reads a category-keyed mode select and ignores other knobs", () => {
    const got = modeSelectOf([
      {
        id: "thinking",
        type: "select",
        currentValue: "low",
        options: [{ value: "low", name: "Low" }],
      },
      {
        id: "approval",
        category: "mode",
        type: "select",
        currentValue: "full",
        options: [{ value: "full", name: "Full" }],
      },
    ]);
    expect(got?.currentMode).toBe("full");
    expect(modeSelectOf([{ id: "thinking", type: "boolean", currentValue: true }])).toBeNull();
  });

  // #58: matched by id alone, an option an agent merely NAMED "mode" became
  // the mode pill's list and overwrote its current mode, while
  // `parseConfigOptions` (which goes by category) also showed it as a knob.
  // ACP says what a select is with its category (`SessionConfigOptionCategory`).
  it("ignores a select named `mode` that the agent did not categorise as one", () => {
    const raw = [
      {
        id: "mode",
        name: "Output mode",
        type: "select",
        currentValue: "terse",
        options: [
          { value: "terse", name: "Terse" },
          { value: "verbose", name: "Verbose" },
        ],
      },
    ];
    expect(modeSelectOf(raw)).toBeNull();
    expect(parseConfigOptions(raw).map((o) => o.id)).toEqual(["mode"]);
  });
});

describe("parseConfigOptions", () => {
  it("reads a boolean knob", () => {
    const [opt] = parseConfigOptions([
      { id: "web-search", name: "Web search", type: "boolean", currentValue: true },
    ]);
    expect(opt).toEqual({
      kind: "boolean",
      id: "web-search",
      name: "Web search",
      description: null,
      value: true,
    });
  });

  it("reads a select knob with its choices", () => {
    const [opt] = parseConfigOptions([
      {
        id: "thinking",
        name: "Thinking",
        description: "How long to reason",
        type: "select",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium", description: "Balanced" },
        ],
      },
    ]);
    expect(opt.kind).toBe("select");
    if (opt.kind !== "select") throw new Error("unreachable");
    expect(opt.currentValue).toBe("medium");
    expect(opt.choices).toHaveLength(2);
    expect(opt.choices[1].description).toBe("Balanced");
  });

  /// Mode and model already have dedicated composer pickers, normalised
  /// upstream. Rendering them here too would give the user two controls for one
  /// setting that could visibly disagree.
  it("skips categories that already own a composer surface", () => {
    const parsed = parseConfigOptions([
      {
        id: "m",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "a",
        options: [{ value: "a", name: "A" }],
      },
      {
        id: "mo",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "b",
        options: [{ value: "b", name: "B" }],
      },
      {
        id: "t",
        name: "Thinking",
        category: "thought_level",
        type: "boolean",
        currentValue: false,
      },
    ]);
    expect(parsed.map((o) => o.id)).toEqual(["t"]);
  });

  /// #42: each pill holds the FIRST select of its category. A second model
  /// (or mode) select — a "small model" beside the main one — is its own
  /// knob, keyed by its own option id, or it sits on no control at all. The
  /// pills read the first, so a single-select agent looks exactly as before.
  it("offers every mode/model select after the first as a knob of its own", () => {
    const select = (id: string, category: string, value: string) => ({
      id,
      name: id,
      category,
      type: "select",
      currentValue: value,
      options: [
        { value: "a", name: "A" },
        { value: "b", name: "B" },
      ],
    });
    const raw = [
      select("model", "model", "a"),
      select("mode", "mode", "a"),
      select("small_model", "model", "b"),
      select("review_mode", "mode", "b"),
    ];
    const parsed = parseConfigOptions(raw);
    expect(parsed.map((o) => o.id)).toEqual(["small_model", "review_mode"]);
    expect(parsed[0]).toMatchObject({ kind: "select", currentValue: "b" });
    // The pills keep the first of each.
    expect(modelSelectOf(raw)?.currentModel).toBe("a");
    expect(modeSelectOf(raw)?.currentMode).toBe("a");
    // A lone select per category is still the pill's alone.
    expect(parseConfigOptions(raw.slice(0, 2))).toEqual([]);
  });

  /// ...but only when the owning surface can actually render it. The mode and
  /// model pickers are selects; a model-category knob of any other kind is
  /// claimed by nobody, and skipping it here would make it invisible AND
  /// unsettable — the same hole that hid model selection in the first place.
  it("keeps an owned-category option the dedicated picker cannot render", () => {
    const parsed = parseConfigOptions([
      {
        id: "model-thinking",
        name: "Extended thinking",
        category: "model",
        type: "boolean",
        currentValue: true,
      },
      {
        id: "mo",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "b",
        options: [{ value: "b", name: "B" }],
      },
    ]);
    expect(parsed.map((o) => o.id)).toEqual(["model-thinking"]);
  });

  /// The wire allows grouped select options; the composer popover is one flat
  /// list, and a nested menu would be a new visual pattern.
  it("flattens grouped select options", () => {
    const [opt] = parseConfigOptions([
      {
        id: "g",
        name: "Grouped",
        type: "select",
        currentValue: "b",
        options: [
          { group: "first", name: "First", options: [{ value: "a", name: "A" }] },
          { group: "second", name: "Second", options: [{ value: "b", name: "B" }] },
        ],
      },
    ]);
    if (opt.kind !== "select") throw new Error("unreachable");
    expect(opt.choices.map((c) => c.id)).toEqual(["a", "b"]);
  });

  /// A select with nothing to pick is a dead control — a menu that opens onto
  /// nothing is worse than no menu.
  it("drops a select with no choices", () => {
    expect(
      parseConfigOptions([{ id: "x", name: "X", type: "select", currentValue: "", options: [] }]),
    ).toEqual([]);
  });

  /// The shape is `#[non_exhaustive]` and the whole feature is unstable, so one
  /// bad entry must not blank every control in the composer.
  it("skips malformed entries without dropping the good ones", () => {
    const parsed = parseConfigOptions([
      null,
      "nonsense",
      { name: "no id", type: "boolean", currentValue: true },
      { id: "no-name", type: "boolean", currentValue: true },
      { id: "unknown-kind", name: "Unknown" },
      { id: "future-kind", name: "Future", type: "_colour", currentValue: "red" },
      { id: "ok", name: "OK", type: "boolean", currentValue: false },
    ]);
    expect(parsed.map((o) => o.id)).toEqual(["ok"]);
  });

  it("returns nothing for a non-array blob", () => {
    expect(parseConfigOptions(undefined)).toEqual([]);
    expect(parseConfigOptions({})).toEqual([]);
  });

  /// A missing `currentValue` must read as false, not as "unknown/on".
  it("treats an absent boolean value as off", () => {
    const [opt] = parseConfigOptions([{ id: "b", name: "B", type: "boolean" }]);
    expect(opt.kind === "boolean" && opt.value).toBe(false);
  });
});

describe("modelSelectOf", () => {
  const modelOption = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "sonnet",
    options: [
      { value: "sonnet", name: "Sonnet", description: "Fast" },
      { value: "opus", name: "Opus" },
    ],
  };

  /// ACP has no `models` field: model selection IS a `category: "model"`
  /// select, and this is what fills the composer's model pill from a live
  /// `config_options_updated` delta.
  it("projects the model-category select into the picker's shape", () => {
    const select = modelSelectOf([
      { id: "t", name: "Thinking", type: "boolean", currentValue: true },
      modelOption,
    ]);
    expect(select).toEqual({
      currentModel: "sonnet",
      availableModels: [
        { id: "sonnet", name: "Sonnet", description: "Fast" },
        { id: "opus", name: "Opus", description: undefined },
      ],
    });
  });

  /// Gating is on the advertised category, never on which agent this is
  /// (ADR-0002). An agent that advertises no model select has no model pill.
  it("is null when no option advertises the model category", () => {
    expect(modelSelectOf([])).toBeNull();
    expect(modelSelectOf(undefined)).toBeNull();
    expect(
      modelSelectOf([
        { id: "t", name: "Thinking", category: "thought_level", type: "boolean" },
        // The right category, but not a select — nothing to list.
        { id: "model", name: "Model", category: "model", type: "boolean", currentValue: true },
        // A select with no category is unknowable, so not the model pill.
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "a",
          options: [{ value: "a", name: "A" }],
        },
      ]),
    ).toBeNull();
  });

  /// A grouped list is read the way the backend's snapshot reads it: the
  /// group's name is each model's provider, and the picker's rail is built on
  /// it.
  it("keeps a group's name as the provider of each model in it", () => {
    const select = modelSelectOf([
      {
        ...modelOption,
        currentValue: "gpt-5",
        options: [
          { group: "openai", name: "OpenAI", options: [{ value: "gpt-5", name: "GPT-5" }] },
          { group: "local", name: "Local", options: [{ value: "qwen", name: "Qwen" }] },
        ],
      },
    ]);
    expect(select?.availableModels).toEqual([
      { id: "gpt-5", name: "GPT-5", description: undefined, provider: "OpenAI" },
      { id: "qwen", name: "Qwen", description: undefined, provider: "Local" },
    ]);
  });

  /// An empty list is a dead picker, same rule as the generic knobs.
  it("is null when the model select offers nothing", () => {
    expect(modelSelectOf([{ ...modelOption, currentValue: "", options: [] }])).toBeNull();
  });
});
