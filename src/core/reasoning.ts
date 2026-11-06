const KNOWN_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function deriveReasoningInfo(
  entry: unknown,
  template?: string,
): { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> } {
  const obj = (entry && typeof entry === "object" ? entry : {}) as Record<string, any>;

  // 1. Explicit thinkingLevelMap from payload (gateway or extension)
  const explicitMap =
    obj.thinkingLevelMap ||
    obj.thinking_level_map ||
    obj.reasoning_config?.thinkingLevelMap ||
    obj.reasoning_config?.thinking_level_map ||
    obj.thinking?.thinkingLevelMap ||
    obj.thinking?.thinking_level_map ||
    obj.capabilities?.thinkingLevelMap ||
    obj.capabilities?.thinking_level_map;

  if (explicitMap && typeof explicitMap === "object" && !Array.isArray(explicitMap)) {
    return {
      reasoning: true,
      thinkingLevelMap: explicitMap as Record<string, string | null>,
    };
  }

  // Check reasoning boolean / indicator
  const hasReasoningIndicator = Boolean(
    obj.reasoning === true ||
    obj.supports_reasoning === true ||
    obj.supports_thinking === true ||
    obj.capabilities?.reasoning === true ||
    obj.capabilities?.thinking === true ||
    (obj.thinking && typeof obj.thinking === "object") ||
    (obj.reasoning_config && typeof obj.reasoning_config === "object")
  );

  const tmpl =
    typeof template === "string" && template.trim().length > 0
      ? template
      : typeof obj.chat_template === "string" && obj.chat_template.trim().length > 0
        ? obj.chat_template
        : typeof obj.template === "string" && obj.template.trim().length > 0
          ? obj.template
          : undefined;

  if (tmpl) {
    const lower = tmpl.toLowerCase();
    const hasTemplateReasoning =
      lower.includes("<think>") ||
      lower.includes("</think>") ||
      lower.includes("<thought>") ||
      lower.includes("</thought>") ||
      lower.includes("<|thought|>") ||
      lower.includes("<|endofthought|>") ||
      lower.includes("[think]") ||
      lower.includes("[/think]") ||
      lower.includes("[thought]") ||
      lower.includes("[/thought]") ||
      lower.includes("enable_thinking") ||
      lower.includes("reasoning_content") ||
      lower.includes("reasoning_effort") ||
      lower.includes("thinking_effort") ||
      lower.includes("reasoning_budget") ||
      lower.includes("thinking_token_budget");

    if (hasTemplateReasoning || hasReasoningIndicator) {
      // Dynamic ladder extraction:
      // Pattern 1: (not in | in) ('high', 'low') or ['low', 'high']
      // Pattern 2: supported (types|levels|efforts|values) (are|include|:) high (default) and low
      const ladderLevels: string[] = [];

      const checkMatch = tmpl.match(
        /(?:[a-z0-9_]*reasoning|[a-z0-9_]*thinking|[a-z0-9_]*effort)[a-z0-9_]*[^\r\n]{0,80}?(?:not\s+in|in)\s*[\(\[]([^\(\)\]]{0,240})[\)\]]/i,
      );
      if (checkMatch && checkMatch[1]) {
        for (const token of checkMatch[1].split(/['",\s]+/)) {
          const clean = token.trim().toLowerCase();
          if (
            (KNOWN_LEVELS as readonly string[]).includes(clean) &&
            !ladderLevels.includes(clean)
          ) {
            ladderLevels.push(clean);
          }
        }
      }

      if (ladderLevels.length < 2) {
        const msgMatch = tmpl.match(
          /supported\s+(?:types|levels|efforts|values)\s+(?:are|include|:)\s+([^\.\n]{2,100})/i,
        );
        if (msgMatch && msgMatch[1]) {
          for (const token of msgMatch[1].split(/[^a-zA-Z0-9_-]+/)) {
            const clean = token.trim().toLowerCase();
            if (
              (KNOWN_LEVELS as readonly string[]).includes(clean) &&
              !ladderLevels.includes(clean)
            ) {
              ladderLevels.push(clean);
            }
          }
        }
      }

      if (ladderLevels.length >= 2) {
        // Explicit ladder from template
        const canTurnOff =
          lower.includes("enable_thinking") ||
          lower.includes("reasoning_effort") ||
          lower.includes("off");
        const map: Record<string, string | null> = {
          off: canTurnOff ? "off" : null,
          minimal: ladderLevels.includes("minimal") ? "minimal" : null,
          low: ladderLevels.includes("low") ? "low" : null,
          medium: ladderLevels.includes("medium") ? "medium" : null,
          high: ladderLevels.includes("high") ? "high" : null,
          xhigh: ladderLevels.includes("xhigh") ? "xhigh" : null,
          max: ladderLevels.includes("max") ? "max" : null,
        };
        return { reasoning: true, thinkingLevelMap: map };
      }

      // Check if toggle-only (e.g. enable_thinking or <think> tags, but no reasoning_effort / thinking_effort)
      const isToggleOnly =
        (lower.includes("enable_thinking") ||
          lower.includes("<think>") ||
          lower.includes("</think>")) &&
        !lower.includes("reasoning_effort") &&
        !lower.includes("thinking_effort");

      if (isToggleOnly) {
        const map: Record<string, string | null> = {
          off: "off",
          minimal: null,
          low: null,
          medium: "medium", // In Pi, 'medium' represents the active toggle state
          high: null,
          xhigh: null,
          max: null,
        };
        return { reasoning: true, thinkingLevelMap: map };
      }

      // If template uses reasoning_effort / thinking_effort without a custom ladder, standard OpenAI effort levels
      const map: Record<string, string | null> = {
        off: "off",
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      };
      return { reasoning: true, thinkingLevelMap: map };
    }
  }

  if (hasReasoningIndicator) {
    const levels = obj.reasoning_config?.levels || obj.thinking?.levels;
    if (Array.isArray(levels) && levels.length > 0) {
      const map: Record<string, string | null> = {
        off: "off",
        minimal: levels.includes("minimal") ? "minimal" : null,
        low: levels.includes("low") ? "low" : null,
        medium: levels.includes("medium") ? "medium" : null,
        high: levels.includes("high") ? "high" : null,
        xhigh: levels.includes("xhigh") ? "xhigh" : null,
        max: levels.includes("max") ? "max" : null,
      };
      return { reasoning: true, thinkingLevelMap: map };
    }
    const map: Record<string, string | null> = {
      off: "off",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    };
    return { reasoning: true, thinkingLevelMap: map };
  }

  return { reasoning: false };
}
