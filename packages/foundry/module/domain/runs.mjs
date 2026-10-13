const TEXT_MARKS = ["bold", "italic", "underline", "strike", "code", "sub", "sup"];

export function isRun(run) {
  if (!run || typeof run !== "object" || Array.isArray(run)) return false;
  if (run.break === true) return Object.keys(run).length === 1;
  if (run.mention && typeof run.mention === "object" && typeof run.mention.resourceId === "string") return true;
  return typeof run.text === "string";
}

export function isRunArray(content) {
  return Array.isArray(content) && content.length > 0 && content.every(isRun);
}

function marksOf(run) {
  const marks = {};
  for (const mark of TEXT_MARKS) {
    if (run?.[mark]) marks[mark] = true;
  }
  return marks;
}

/** Identity of a run ignoring the editable text. */
export function runStructure(run) {
  if (run?.break === true) return { break: true };
  const marks = marksOf(run);
  if (run?.link) marks.link = run.link;
  if (run?.mention) return { mention: { resourceId: run.mention.resourceId }, marks };
  return { text: true, marks };
}

export function collapsesFormatting(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  const formatted = before.length > 1 || before.some((run) => {
    if (!run) return false;
    if (run.mention || run.break || run.link) return true;
    return TEXT_MARKS.some((mark) => run[mark]);
  });
  if (!formatted || after.length !== 1) return false;
  const only = after[0];
  return Boolean(only) && typeof only.text === "string" && Object.keys(only).length === 1;
}

/**
 * A paragraph save may change run text. It may not add, delete, or merge runs,
 * and it may not drop marks, mention ids, or link targets.
 */
export function runEditProblem(before, after) {
  if (!isRunArray(after)) return "INVALID_CONTENT";
  if (!Array.isArray(before)) return "INVALID_CONTENT";
  if (collapsesFormatting(before, after)) return "FORMAT_LOSS";
  if (before.length !== after.length) return "RUN_STRUCTURE";
  for (let index = 0; index < before.length; index += 1) {
    if (JSON.stringify(runStructure(before[index])) !== JSON.stringify(runStructure(after[index]))) return "RUN_STRUCTURE";
  }
  return null;
}

export function editRunText(content, runIndex, text) {
  if (!Array.isArray(content) || !content[runIndex]) {
    const error = new Error("That run does not exist");
    error.code = "NO_RUN";
    throw error;
  }
  const next = content.map((run) => {
    if (run?.mention) return { ...run, mention: { ...run.mention } };
    return { ...run };
  });
  const run = next[runIndex];
  if (run.break === true) {
    const error = new Error("A line break has no text to edit");
    error.code = "BREAK_RUN";
    throw error;
  }
  if (run.mention) run.mention.text = text;
  else run.text = text;
  return next;
}

export function contentFromRunEdits(content, textsByIndex) {
  if (!Array.isArray(content)) {
    const error = new Error("Paragraph content is missing");
    error.code = "INVALID_CONTENT";
    throw error;
  }
  return content.map((run, index) => {
    if (run?.break === true) return { break: true };
    const text = textsByIndex?.[index];
    if (text === undefined || text === null) {
      return run?.mention ? { ...run, mention: { ...run.mention } } : { ...run };
    }
    return editRunText(content, index, String(text))[index];
  });
}

/** Copy baseline runs and take only the edited text from the submitted runs. */
export function applyTextEdits(before, after) {
  return before.map((run, index) => {
    const next = after[index];
    const copy = run?.mention ? { ...run, mention: { ...run.mention } } : { ...run };
    if (copy.break === true) return copy;
    if (copy.mention) copy.mention.text = next?.mention?.text ?? copy.mention.text;
    else if (typeof next?.text === "string") copy.text = next.text;
    return copy;
  });
}

export function describeRuns(content) {
  return (content ?? []).map((run, index) => ({
    index,
    text: run?.mention ? (run.mention.text ?? "") : (run?.text ?? ""),
    locked: run?.break === true,
    kind: run?.break ? "break" : run?.mention ? "mention" : "text",
    marks: TEXT_MARKS.filter((mark) => run?.[mark]).join(" "),
    link: run?.link ?? "",
    mentionId: run?.mention?.resourceId ?? ""
  }));
}
